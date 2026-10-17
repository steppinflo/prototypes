// Cost & efficiency of the supply chain over any date range: what we spent on parts,
// what actual demand needed, what we consumed, what sat in inventory (and what that
// cost to hold), and the price of getting it wrong (rush premiums, scrap, late deliveries).

import { dayNum, isoDay, round, sum } from '../lib/util.mjs';
import { CARRYING_COST_RATE, RUSH_PREMIUM } from '../lib/costs.mjs';
import { seasonalityIndex, fitSeries } from '../models/forecast.mjs';

const monthOf = (iso) => iso.slice(0, 7);

function monthsIn(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** Inventory value movements per day: accepted receipts in, installs and line scrap out. */
function inventoryEvents(db) {
  const receipts = db.prepare(`SELECT actual_delivery_date AS d, SUM(quantity_received * unit_cost) AS v
    FROM inventory_orders WHERE status = 'received' GROUP BY 1`).all();
  const installs = db.prepare(`SELECT tp.installed_date AS d, SUM(tp.quantity * COALESCE(io.unit_cost, pt.unit_cost)) AS v
    FROM tractor_parts tp JOIN inventory_parts ip ON ip.id = tp.inventory_part_id
    JOIN part_types pt ON pt.part_number = tp.part_number LEFT JOIN inventory_orders io ON io.id = ip.inventory_order_id
    GROUP BY 1`).all();
  const scrap = db.prepare(`SELECT f.reported_date AS d, SUM(f.quantity * COALESCE(io.unit_cost, pt.unit_cost)) AS v
    FROM failure_reports f JOIN part_types pt ON pt.part_number = f.part_number
    LEFT JOIN inventory_parts ip ON ip.id = f.inventory_part_id LEFT JOIN inventory_orders io ON io.id = ip.inventory_order_id
    WHERE f.stage = 'manufacturing' GROUP BY 1`).all();
  const delta = new Map();
  const add = (rows, sign) => rows.forEach((r) => delta.set(r.d, (delta.get(r.d) ?? 0) + sign * r.v));
  add(receipts, 1);
  add(installs, -1);
  add(scrap, -1);
  return delta;
}

/** Daily inventory value between from and to (inclusive). */
export function inventoryValueSeries(db, from, to) {
  const delta = inventoryEvents(db);
  let value = 0;
  for (const [d, v] of delta) if (d < from) value += v;
  const out = [];
  for (let n = dayNum(from); n <= dayNum(to); n++) {
    const d = isoDay(n);
    value += delta.get(d) ?? 0;
    out.push({ date: d, value });
  }
  return out;
}

/** One-month-ahead forecast vs actual tractors ordered, for each complete month in range. */
function forecastVsActual(db, from, to, today) {
  const rows = db.prepare(`SELECT substr(submission_date, 1, 7) AS month, SUM(quantity) AS qty FROM customer_orders
    WHERE status != 'cancelled' GROUP BY 1 ORDER BY 1`).all();
  const series = rows.map((r) => ({ month: r.month, value: r.qty })).filter((r) => r.month < monthOf(today));
  const season = seasonalityIndex(series);
  const out = [];
  series.forEach((pt, i) => {
    if (i < 12 || pt.month < monthOf(from) || pt.month > monthOf(to)) return;
    const fit = fitSeries(series.slice(0, i), season);
    const predicted = Math.max(0, (fit.level + fit.trend) * season[Number(pt.month.slice(5, 7)) - 1]);
    out.push({ month: pt.month, forecast: round(predicted, 1), actual: pt.value });
  });
  return out;
}

/** Cost of one tractor's parts kit per model, at the average price paid per part in the window. */
function kitCosts(db, from, to) {
  const avg = new Map(db.prepare(`SELECT pt.part_number,
      COALESCE((SELECT SUM(quantity * unit_cost) / SUM(quantity) FROM inventory_orders io WHERE io.part_number = pt.part_number AND io.submission_date BETWEEN ? AND ?),
               (SELECT SUM(quantity * unit_cost) / SUM(quantity) FROM inventory_orders io WHERE io.part_number = pt.part_number AND io.submission_date <= ?),
               pt.unit_cost) AS cost
    FROM part_types pt`).all(from, to, to).map((x) => [x.part_number, x.cost]));
  const kits = new Map();
  for (const b of db.prepare('SELECT * FROM bom_items').all()) kits.set(b.model_number, (kits.get(b.model_number) ?? 0) + b.quantity * avg.get(b.part_number));
  return kits;
}

export function costReport(db, { from, to, today, plan }) {
  const between = (col) => `${col} BETWEEN ? AND ?`;
  const r = [from, to];
  const purchases = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(quantity * unit_cost), 0) AS value,
      COALESCE(SUM(rush_premium), 0) AS rush_premium, COALESCE(SUM(rush), 0) AS rush_count
    FROM inventory_orders WHERE ${between('submission_date')}`).get(...r);
  const received = db.prepare(`SELECT COALESCE(SUM(quantity_received * unit_cost), 0) AS value,
      COALESCE(SUM(quantity_rejected * unit_cost), 0) AS rejected_value
    FROM inventory_orders WHERE status = 'received' AND ${between('actual_delivery_date')}`).get(...r);
  const consumed = db.prepare(`SELECT COALESCE(SUM(tp.quantity * COALESCE(io.unit_cost, pt.unit_cost)), 0) AS value
    FROM tractor_parts tp JOIN inventory_parts ip ON ip.id = tp.inventory_part_id JOIN part_types pt ON pt.part_number = tp.part_number
    LEFT JOIN inventory_orders io ON io.id = ip.inventory_order_id WHERE ${between('tp.installed_date')}`).get(...r).value;
  const lineScrap = db.prepare(`SELECT COALESCE(SUM(f.quantity * COALESCE(io.unit_cost, pt.unit_cost)), 0) AS value
    FROM failure_reports f JOIN part_types pt ON pt.part_number = f.part_number
    LEFT JOIN inventory_parts ip ON ip.id = f.inventory_part_id LEFT JOIN inventory_orders io ON io.id = ip.inventory_order_id
    WHERE f.stage = 'manufacturing' AND ${between('f.reported_date')}`).get(...r).value;
  const built = db.prepare(`SELECT COUNT(*) AS n FROM tractors WHERE ${between('build_start_date')}`).get(...r).n;

  // What actual demand needed: a parts kit for every tractor customers ordered in the period,
  // priced at what we actually paid per part in the period (so it compares like for like).
  const kitCost = kitCosts(db, from, to);
  const ordered = db.prepare(`SELECT substr(submission_date, 1, 7) AS m, model_number, SUM(quantity) AS qty FROM customer_orders
    WHERE status != 'cancelled' AND ${between('submission_date')} GROUP BY 1, 2`).all(...r);
  const demand = { tractors: sum(ordered, (o) => o.qty), parts_value: sum(ordered, (o) => o.qty * kitCost.get(o.model_number)) };

  const freight = db.prepare(`SELECT direction, COALESCE(SUM(freight_cost), 0) AS cost, COALESCE(SUM(CASE WHEN rush = 1 THEN freight_cost END), 0) AS rush_cost, COUNT(*) AS n
    FROM shipments WHERE direction != 'inbound' AND ${between('shipped_date')} GROUP BY 1`).all(...r);
  const outbound = freight.find((f) => f.direction === 'outbound') ?? { cost: 0, rush_cost: 0, n: 0 };
  const serviceHaul = sum(freight.filter((f) => f.direction.startsWith('service')), (f) => f.cost);
  const repairs = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(repair_labor_cost + repair_parts_cost), 0) AS repair_cost,
      COALESCE(SUM(rush), 0) AS rush_count
    FROM service_jobs WHERE ${between('created_date')}`).get(...r);

  const deliveries = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(quantity), 0) AS tractors, COALESCE(SUM(quantity * unit_price), 0) AS revenue,
      SUM(CASE WHEN actual_delivery_date > expected_delivery_date THEN 1 ELSE 0 END) AS late,
      COALESCE(SUM(CASE WHEN actual_delivery_date > expected_delivery_date THEN quantity * unit_price END), 0) AS late_value,
      AVG(CASE WHEN actual_delivery_date > expected_delivery_date THEN julianday(actual_delivery_date) - julianday(expected_delivery_date) END) AS avg_days_late
    FROM customer_orders WHERE status = 'delivered' AND ${between('actual_delivery_date')}`).get(...r);

  const series = inventoryValueSeries(db, from, to);
  const days = series.length;
  const avgInventory = days ? sum(series, (s) => s.value) / days : 0;
  const carrying = avgInventory * CARRYING_COST_RATE * (days / 365);
  const startValue = series[0]?.value ?? 0;
  const endValue = series[series.length - 1]?.value ?? 0;
  const turns = avgInventory ? (consumed / avgInventory) * (365 / Math.max(days, 1)) : null;

  // Monthly breakdown.
  const months = monthsIn(from, to);
  const monthly = (sql, col = 'v') => new Map(db.prepare(sql).all(...r).map((x) => [x.m, x[col]]));
  const mPurch = monthly(`SELECT substr(submission_date, 1, 7) AS m, SUM(quantity * unit_cost) AS v FROM inventory_orders WHERE ${between('submission_date')} GROUP BY 1`);
  const mRush = monthly(`SELECT substr(submission_date, 1, 7) AS m, SUM(rush_premium) AS v FROM inventory_orders WHERE ${between('submission_date')} GROUP BY 1`);
  const mCons = monthly(`SELECT substr(tp.installed_date, 1, 7) AS m, SUM(tp.quantity * COALESCE(io.unit_cost, pt.unit_cost)) AS v
    FROM tractor_parts tp JOIN inventory_parts ip ON ip.id = tp.inventory_part_id JOIN part_types pt ON pt.part_number = tp.part_number
    LEFT JOIN inventory_orders io ON io.id = ip.inventory_order_id WHERE ${between('tp.installed_date')} GROUP BY 1`);
  const mNeed = new Map();
  for (const o of ordered) mNeed.set(o.m, (mNeed.get(o.m) ?? 0) + o.qty * kitCost.get(o.model_number));
  const mFreight = monthly(`SELECT substr(shipped_date, 1, 7) AS m, SUM(freight_cost) AS v FROM shipments WHERE direction != 'inbound' AND ${between('shipped_date')} GROUP BY 1`);
  const endOfMonth = new Map();
  for (const s of series) endOfMonth.set(monthOf(s.date), s.value);
  const monthlyRows = months.map((m) => ({
    month: m,
    purchased: round(mPurch.get(m) ?? 0, 0),
    consumed: round(mCons.get(m) ?? 0, 0),
    demandNeed: round(mNeed.get(m) ?? 0, 0),
    rushPremium: round(mRush.get(m) ?? 0, 0),
    freight: round(mFreight.get(m) ?? 0, 0),
    inventoryEnd: round(endOfMonth.get(m) ?? 0, 0),
  }));

  // By part and supplier.
  const byPart = db.prepare(`SELECT pt.part_number, pt.name, pt.unit_cost,
      (SELECT COALESCE(SUM(quantity), 0) FROM inventory_orders io WHERE io.part_number = pt.part_number AND io.submission_date BETWEEN ? AND ?) AS bought_qty,
      (SELECT COALESCE(SUM(quantity * unit_cost), 0) FROM inventory_orders io WHERE io.part_number = pt.part_number AND io.submission_date BETWEEN ? AND ?) AS bought_value,
      (SELECT COALESCE(SUM(rush_premium), 0) FROM inventory_orders io WHERE io.part_number = pt.part_number AND io.submission_date BETWEEN ? AND ?) AS rush_premium,
      (SELECT COALESCE(SUM(tp.quantity), 0) FROM tractor_parts tp WHERE tp.part_number = pt.part_number AND tp.installed_date BETWEEN ? AND ?) AS used_qty,
      (SELECT COALESCE(SUM(f.quantity), 0) FROM failure_reports f WHERE f.part_number = pt.part_number AND f.stage != 'field' AND f.reported_date BETWEEN ? AND ?) AS lost_qty
    FROM part_types pt ORDER BY pt.part_number`).all(...r, ...r, ...r, ...r, ...r);
  const planParts = new Map((plan?.parts ?? []).map((p) => [p.partNumber, p]));
  const parts = byPart.map((p) => {
    const pl = planParts.get(p.part_number);
    const onHand = pl?.onHand ?? 0;
    const needed = pl ? pl.grossRequirement + pl.safetyStock : 0;
    const excess = Math.max(0, onHand - needed);
    return {
      partNumber: p.part_number, name: p.name, boughtQty: p.bought_qty, boughtValue: round(p.bought_value, 0),
      usedQty: p.used_qty, lostQty: p.lost_qty, rushPremium: round(p.rush_premium, 0),
      buyToUseRatio: p.used_qty ? round(p.bought_qty / p.used_qty, 2) : null,
      onHand, need90: pl?.grossRequirement ?? 0, excessUnits: excess, excessValue: round(excess * p.unit_cost, 0),
    };
  });
  const suppliers = db.prepare(`SELECT s.id, s.name, COUNT(io.id) AS pos, COALESCE(SUM(io.quantity * io.unit_cost), 0) AS spend,
      COALESCE(SUM(io.rush_premium), 0) AS rush_premium, COALESCE(SUM(io.rush), 0) AS rush_count
    FROM suppliers s LEFT JOIN inventory_orders io ON io.supplier_id = s.id AND io.submission_date BETWEEN ? AND ?
    GROUP BY s.id ORDER BY spend DESC`).all(...r).map((s) => ({ ...s, spend: round(s.spend, 0), rush_premium: round(s.rush_premium, 0) }));

  const fva = forecastVsActual(db, from, to, today);
  const fvaErr = fva.filter((x) => x.actual > 0);
  const forecastMape = fvaErr.length ? round((100 * sum(fvaErr, (x) => Math.abs(x.forecast - x.actual) / x.actual)) / fvaErr.length, 1) : null;

  const overspend = purchases.value - demand.parts_value;
  const excessValue = sum(parts, (p) => p.excessValue);
  const totalSupplyCost = purchases.value + purchases.rush_premium + outbound.cost + serviceHaul + repairs.repair_cost + carrying;
  const summary = {
    partsPurchased: round(purchases.value, 0),
    purchaseOrders: purchases.n,
    partsReceived: round(received.value, 0),
    partsConsumed: round(consumed, 0),
    demandNeed: round(demand.parts_value, 0),
    demandTractors: demand.tractors,
    tractorsBuilt: built,
    overUnderVsDemand: round(overspend, 0),
    overUnderPct: demand.parts_value ? round(overspend / demand.parts_value, 3) : null,
    rushPremium: round(purchases.rush_premium, 0),
    rushOrders: purchases.rush_count,
    rushShare: purchases.value ? round(purchases.rush_premium / purchases.value, 4) : 0,
    scrapValue: round(lineScrap, 0),
    rejectedValue: round(received.rejected_value, 0),
    outboundFreight: round(outbound.cost, 0),
    rushFreightPremium: round(outbound.rush_cost - outbound.rush_cost / (1 + RUSH_PREMIUM), 0),
    serviceHaul: round(serviceHaul, 0),
    repairCost: round(repairs.repair_cost, 0),
    repairJobs: repairs.n,
    inventoryStart: round(startValue, 0),
    inventoryEnd: round(endValue, 0),
    inventoryAvg: round(avgInventory, 0),
    carryingCost: round(carrying, 0),
    inventoryTurns: turns === null ? null : round(turns, 2),
    daysOfSupply: consumed ? round(avgInventory / (consumed / Math.max(days, 1)), 1) : null,
    revenueDelivered: round(deliveries.revenue, 0),
    tractorsDelivered: deliveries.tractors,
    lateDeliveries: deliveries.late ?? 0,
    deliveredOrders: deliveries.orders,
    lateDeliveryValue: round(deliveries.late_value, 0),
    avgDaysLate: deliveries.avg_days_late === null ? null : round(deliveries.avg_days_late, 1),
    partsCostPerTractor: built ? round(consumed / built, 0) : null,
    excessStockValue: round(excessValue, 0),
    totalSupplyCost: round(totalSupplyCost, 0),
    forecastMape,
  };

  return {
    from, to, days,
    assumptions: { carryingCostRate: CARRYING_COST_RATE, rushPremium: RUSH_PREMIUM },
    summary,
    insights: insights(summary, parts, suppliers),
    monthly: monthlyRows,
    inventory: series.filter((_, i) => i % Math.max(1, Math.ceil(series.length / 120)) === 0 || i === series.length - 1)
      .map((s) => ({ date: s.date, value: round(s.value, 0) })),
    forecastVsActual: fva,
    parts,
    suppliers,
  };
}

const money = (v) => `$${Math.round(v).toLocaleString('en-US')}`;

function insights(s, parts, suppliers) {
  const out = [];
  if (s.overUnderPct !== null) {
    if (s.overUnderPct > 0.05) out.push({ tone: 'warn', text: `Bought ${Math.round(s.overUnderPct * 100)}% more parts (${money(s.overUnderVsDemand)}) than the tractors customers ordered in this period needed.` });
    else if (s.overUnderPct < -0.05) out.push({ tone: 'warn', text: `Bought ${Math.round(-s.overUnderPct * 100)}% less (${money(-s.overUnderVsDemand)}) than actual demand needed — shortages and rush orders follow.` });
    else out.push({ tone: 'good', text: `Parts purchases were within 5% of what actual demand needed (${s.overUnderVsDemand >= 0 ? 'over' : 'under'} by ${money(Math.abs(s.overUnderVsDemand))}).` });
  }
  if (s.rushPremium > 0) out.push({ tone: s.rushShare > 0.01 ? 'warn' : 'info', text: `${s.rushOrders} rush parts orders cost ${money(s.rushPremium)} in premiums (${(s.rushShare * 100).toFixed(1)}% of parts spend).` });
  const topRush = [...suppliers].sort((a, b) => b.rush_premium - a.rush_premium)[0];
  if (topRush?.rush_premium > 0) out.push({ tone: 'info', text: `Most expediting was with ${topRush.name}: ${topRush.rush_count} rush orders, ${money(topRush.rush_premium)}.` });
  out.push({ tone: 'info', text: `Holding ${money(s.inventoryAvg)} of parts on average cost about ${money(s.carryingCost)} (${Math.round(CARRYING_COST_RATE * 100)}%/yr carrying rate); stock turned ${s.inventoryTurns ?? '—'}× a year, ${s.daysOfSupply ?? '—'} days of supply.` });
  if (s.excessStockValue > 0) {
    const top = [...parts].sort((a, b) => b.excessValue - a.excessValue).slice(0, 3).filter((p) => p.excessValue > 0);
    out.push({ tone: 'warn', text: `${money(s.excessStockValue)} of stock on hand today is beyond the next 90 days' need plus safety stock${top.length ? ` (mostly ${top.map((p) => p.partNumber).join(', ')})` : ''}.` });
  }
  if (s.lateDeliveries > 0) out.push({ tone: 'warn', text: `${s.lateDeliveries} of ${s.deliveredOrders} orders delivered late (avg ${s.avgDaysLate} days), ${money(s.lateDeliveryValue)} of revenue.` });
  if (s.scrapValue + s.rejectedValue > 0) out.push({ tone: 'info', text: `Quality losses: ${money(s.scrapValue)} scrapped on the line and ${money(s.rejectedValue)} rejected at receiving.` });
  if (s.repairJobs) out.push({ tone: 'info', text: `${s.repairJobs} pickup-and-repair jobs: ${money(s.serviceHaul)} hauling and ${money(s.repairCost)} repair labour and parts.` });
  return out;
}
