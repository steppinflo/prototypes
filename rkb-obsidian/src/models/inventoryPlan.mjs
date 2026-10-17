// Inventory Prediction Model (MOCK).
//
// Answers "how many of all the parts do we need at any time to meet our forecast?"
// using the forecast, the parts performance tracker, current orders and supplier delays.
// It is a deterministic MRP-style planner standing in for the ML model:
//
// 1. Tractor demand over the horizon = firm demand (open customer orders, minus tractors
//    already built/building/earmarked for them) + forecast demand (new orders the forecast
//    expects, shifted by the typical order-to-delivery lead time).
// 2. Don't double count: unassigned tractors already in stock or on the line are netted
//    against that demand first (earliest need first) and become earmark suggestions.
// 3. Remaining tractors are scheduled into build capacity (bays x 1 tractor/day).
// 4. Each build pulls its bill of materials, grossed up by the expected scrap/reject rate.
// 5. Per part, projected on-hand = on hand + open POs at their *predicted* arrival (carrier
//    ETA, or quoted date + the supplier's historical slip) - requirements. Whenever it would
//    fall below safety stock, a purchase is recommended, sized to cover the next 30 days,
//    with an order-by date from the chosen supplier's effective lead time.
// 6. Builds that can't get parts in time are flagged, along with the orders and customers they block.

import { dayNum, isoDay, isWorkday, weekStart, transitDays, round, sum } from '../lib/util.mjs';
import { expectedLossRate } from './partsPerformance.mjs';
import { RUSH_PREMIUM, RUSH_SLIP_FACTOR, rushLeadDays } from '../lib/costs.mjs';

export const ACTIVE_ORDER_STATUSES = ['received', 'in_production', 'ready', 'shipping', 'partially_delivered'];
const COVER_DAYS = 30;
const BUFFER_DAYS = 7;       // forecast builds finish about a week before their ship-by date
const FIRM_BUILD_AHEAD = 21;  // firm orders may be built up to 3 weeks ahead of their latest start

const prevWorkday = (n) => {
  let d = n;
  while (!isWorkday(d)) d -= 1;
  return d;
};

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

export function inventoryPlan(db, { today, forecast, performance, settings }) {
  const H = Number(settings.planning_horizon_days);
  const bays = Number(settings.build_bays);
  const level = settings.forecast_service_level;
  const safetyDays = Number(settings.safety_stock_days);
  const recvDays = Number(settings.receiving_days);
  const todayN = dayNum(today);
  const endN = todayN + H;

  const plant = db.prepare('SELECT * FROM warehouses WHERE is_plant = 1').get();
  const partTypes = db.prepare('SELECT * FROM part_types ORDER BY part_number').all();
  const partMap = new Map(partTypes.map((p) => [p.part_number, p]));
  const bom = new Map();
  for (const b of db.prepare('SELECT * FROM bom_items').all()) {
    if (!bom.has(b.model_number)) bom.set(b.model_number, []);
    bom.get(b.model_number).push(b);
  }
  const suppliers = new Map(db.prepare('SELECT * FROM suppliers').all().map((s) => [s.id, s]));

  // ---- 1. Firm demand ---------------------------------------------------------------
  const orders = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.lat, c.lng
    FROM customer_orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.status IN (${ACTIVE_ORDER_STATUSES.map(() => '?').join(',')})
    ORDER BY o.expected_delivery_date, o.id`).all(...ACTIVE_ORDER_STATUSES);
  const tractorsByOrder = new Map();
  for (const t of db.prepare('SELECT id, customer_order_id, status FROM tractors WHERE customer_order_id IS NOT NULL').all()) {
    if (!tractorsByOrder.has(t.customer_order_id)) tractorsByOrder.set(t.customer_order_id, []);
    tractorsByOrder.get(t.customer_order_id).push(t);
  }

  const items = [];
  const demandWeeks = new Map();
  const bumpWeek = (n, key, v = 1) => {
    const ws = Math.max(weekStart(todayN), weekStart(n));
    if (n > endN) return;
    if (!demandWeeks.has(ws)) demandWeeks.set(ws, { firmBuilt: 0, firmToBuild: 0, forecast: 0 });
    demandWeeks.get(ws)[key] += v;
  };

  for (const o of orders) {
    const ts = tractorsByOrder.get(o.id) ?? [];
    const transit = transitDays(plant.lat, plant.lng, o.lat, o.lng);
    const shipByN = dayNum(o.expected_delivery_date) - transit;
    const unshippedBuilt = ts.filter((t) => ['in_production', 'qc_hold', 'earmarked'].includes(t.status)).length;
    bumpWeek(dayNum(o.expected_delivery_date), 'firmBuilt', unshippedBuilt);
    const unbuilt = o.quantity - ts.length;
    for (let i = 0; i < unbuilt; i++) {
      bumpWeek(dayNum(o.expected_delivery_date), 'firmToBuild');
      items.push({
        source: 'firm', model: o.model_number, orderId: o.id, customerId: o.customer_id, rush: o.priority === 'rush',
        customerName: o.customer_name, expectedDelivery: o.expected_delivery_date, transit, needByN: shipByN,
      });
    }
  }

  // ---- 2. Forecast demand (new orders not yet received) -------------------------------
  const leads = db.prepare(`
    SELECT julianday(expected_delivery_date) - julianday(submission_date) AS lead
    FROM customer_orders WHERE submission_date >= ? AND status != 'cancelled'`).all(isoDay(todayN - 365)).map((r) => r.lead);
  const leadDays = Math.round(median(leads)) || 55;
  const avgTransit = 3;
  for (const m of forecast.models) {
    const scale = level === 'p50' || !m.total.mean ? 1 : m.total[level] / m.total.mean;
    let acc = 0;
    for (const d of m.daily) {
      const needByN = dayNum(d.date) + leadDays - avgTransit;
      if (needByN > endN) break;
      acc += d.mean * scale;
      while (acc >= 1) {
        acc -= 1;
        bumpWeek(needByN + avgTransit, 'forecast');
        items.push({ source: 'forecast', model: m.model, needByN, expectedSubmission: d.date, transit: avgTransit });
      }
    }
  }
  items.sort((a, b) => a.needByN - b.needByN || (a.source === 'firm' ? -1 : 1));

  // ---- 3. Net unassigned stock against demand (don't double count) --------------------
  const stock = db.prepare(`
    SELECT id, serial_number, model_number, status FROM tractors
    WHERE customer_order_id IS NULL AND status IN ('inventoried', 'in_production', 'qc_hold')
    ORDER BY CASE status WHEN 'inventoried' THEN 0 WHEN 'in_production' THEN 1 ELSE 2 END, build_start_date`).all();
  const stockAllocations = [];
  const unusedStock = [...stock];
  for (const it of items) {
    const idx = unusedStock.findIndex((t) => t.model_number === it.model);
    if (idx === -1) continue;
    const [t] = unusedStock.splice(idx, 1);
    it.coveredBy = t.id;
    stockAllocations.push({
      tractorId: t.id, serialNumber: t.serial_number, model: t.model_number, tractorStatus: t.status, source: it.source,
      orderId: it.orderId ?? null, customerName: it.customerName ?? null, needBy: isoDay(it.needByN),
    });
  }

  // ---- 4. Capacity-constrained build schedule ---------------------------------------
  const used = new Map();
  used.set(todayN, db.prepare('SELECT COUNT(*) AS n FROM tractors WHERE build_start_date = ?').get(today).n);
  // Firm orders are committed: build them as early as capacity allows within a
  // FIRM_BUILD_AHEAD window of their latest start. Forecast demand is built just in time
  // (latest start minus a buffer) so parts aren't pulled for orders that may not come.
  const free = (n) => isWorkday(n) && (used.get(n) ?? 0) < bays;
  const take = (n) => used.set(n, (used.get(n) ?? 0) + 1);
  const toBuild = items.filter((x) => !x.coveredBy).map((it) => {
    const latestStartN = prevWorkday(it.needByN - 1);
    return { ...it, latestStartN, shortParts: [] };
  });
  // Rush orders jump the queue: built at the first free slot from today.
  const firmBuilds = toBuild.filter((x) => x.source === 'firm').sort((a, b) => (b.rush ? 1 : 0) - (a.rush ? 1 : 0) || a.needByN - b.needByN);
  for (const b of firmBuilds) {
    let slot = Math.max(todayN, b.rush ? todayN : b.latestStartN - FIRM_BUILD_AHEAD);
    while (!free(slot)) slot += 1;
    take(slot);
    b.buildN = slot;
  }
  const forecastBuilds = toBuild.filter((x) => x.source === 'forecast').sort((a, b) => b.needByN - a.needByN);
  for (const b of forecastBuilds) {
    const targetN = prevWorkday(b.latestStartN - BUFFER_DAYS);
    let slot = targetN;
    while (slot >= todayN && !free(slot)) slot -= 1;
    if (slot < todayN) {
      slot = Math.max(todayN, targetN);
      while (!free(slot)) slot += 1;
    }
    take(slot);
    b.buildN = slot;
  }
  const builds = toBuild.sort((a, b) => a.buildN - b.buildN || a.needByN - b.needByN);
  builds.forEach((b, i) => { b.seq = i + 1; });

  // ---- 5. Parts: requirements, supply, projection, recommendations --------------------
  const perfBy = new Map(performance.parts.map((r) => [`${r.partNumber}|${r.supplierId}`, r]));
  const supplierOptions = new Map();
  for (const sp of db.prepare('SELECT * FROM supplier_parts').all()) {
    if (!supplierOptions.has(sp.part_number)) supplierOptions.set(sp.part_number, []);
    supplierOptions.get(sp.part_number).push(sp);
  }
  const balances = new Map(db.prepare('SELECT * FROM v_part_balances').all().map((b) => [b.part_number, b]));
  // Complete parts kits on hand right now, per model: how many tractors could start today.
  const kitsOnHand = Object.fromEntries([...bom].map(([model, lines]) =>
    [model, Math.min(...lines.map((l) => Math.floor((balances.get(l.part_number)?.available ?? 0) / l.quantity)))]));
  const openPos = db.prepare(`
    SELECT io.*, s.name AS supplier_name,
      (SELECT sh.expected_arrival_date FROM shipments sh WHERE sh.inventory_order_id = io.id AND sh.status = 'in_transit') AS eta
    FROM inventory_orders io JOIN suppliers s ON s.id = io.supplier_id
    WHERE io.status IN ('submitted', 'confirmed', 'in_transit')`).all();

  const scheduledReceipts = openPos.map((po) => {
    const perf = perfBy.get(`${po.part_number}|${po.supplier_id}`);
    const slip = Math.round((perf?.predictedSlipDays ?? 0) * (po.rush ? RUSH_SLIP_FACTOR : 1));
    let arrivalN;
    let basis;
    if (po.eta) {
      arrivalN = Math.max(todayN, dayNum(po.eta));
      basis = 'carrier ETA';
    } else {
      arrivalN = dayNum(po.expected_delivery_date) + slip;
      basis = slip ? `quoted date + ${slip}d typical slip` : 'quoted date';
      if (arrivalN <= todayN) {
        arrivalN = todayN + 3;
        basis = 'overdue, no ship notice — assumed 3 days out';
      }
    }
    return {
      poId: po.id, partNumber: po.part_number, supplierId: po.supplier_id, supplierName: po.supplier_name,
      quantity: po.quantity - po.quantity_received - po.quantity_rejected, status: po.status, rush: !!po.rush,
      expectedDelivery: po.expected_delivery_date, predictedArrival: isoDay(arrivalN), basis,
      overdue: po.expected_delivery_date < today, availableN: arrivalN + recvDays,
    };
  });

  const lastN = Math.max(endN, ...builds.map((b) => b.buildN));
  const recommendations = [];
  const partsOut = [];
  const projections = {};

  for (const part of partTypes) {
    const pn = part.part_number;
    const loss = expectedLossRate(performance, pn);
    const reqByDay = new Map();
    const consumers = []; // [{build, qty}] in build order
    for (const b of builds) {
      const line = bom.get(b.model).find((x) => x.part_number === pn);
      if (!line) continue;
      const q = line.quantity * (1 + loss);
      reqByDay.set(b.buildN, (reqByDay.get(b.buildN) ?? 0) + q);
      consumers.push({ build: b, qty: q });
    }
    consumers.sort((a, b) => a.build.buildN - b.build.buildN);
    const receipts = scheduledReceipts.filter((r) => r.partNumber === pn);
    const recByDay = new Map();
    for (const r of receipts) recByDay.set(r.availableN, (recByDay.get(r.availableN) ?? 0) + r.quantity);

    const totalReq = sum([...reqByDay.values()]);
    const firmReq = sum(consumers.filter((c) => c.build.source === 'firm'), (c) => c.qty);
    const safety = Math.ceil((totalReq / H) * safetyDays);
    const onHand = balances.get(pn).available;

    // Projection with existing supply only, and with recommended orders.
    let proj = onHand;
    let projR = onHand;
    let minProj = onHand;
    let shortageN = null;
    const planned = [];
    const plannedByDay = new Map();
    const weekly = new Map();
    for (let d = todayN; d <= lastN; d++) {
      const rec = recByDay.get(d) ?? 0;
      const req = reqByDay.get(d) ?? 0;
      proj += rec - req;
      projR += rec + (plannedByDay.get(d) ?? 0) - req;
      if (proj < minProj) minProj = proj;
      if (proj < 0 && shortageN === null) shortageN = d;
      if (projR < safety && req > 0 && d <= endN && !planned.some((p) => p.arriveN > d)) {
        // Size the order to restore safety stock and cover the next COVER_DAYS of requirements,
        // net of POs already on their way (a late PO is chased, not re-bought) —
        // net of POs already on their way that land no later than a new order could.
        const choice = chooseSupplier(supplierOptions.get(pn), perfBy, suppliers, d, todayN, recvDays);
        const arriveN = Math.max(d, todayN + choice.effectiveLead);
        let ahead = 0;
        let incoming = 0;
        for (let k = d + 1; k <= d + COVER_DAYS; k++) ahead += reqByDay.get(k) ?? 0;
        for (let k = d + 1; k <= Math.max(d + COVER_DAYS, arriveN); k++) incoming += recByDay.get(k) ?? 0;
        const deficit = safety - projR + ahead - incoming;
        if (deficit > 0) {
          const qty = Math.max(part.min_order_qty, Math.ceil(deficit / part.pack_size) * part.pack_size);
          planned.push({ needN: d, qty, choice, arriveN });
          plannedByDay.set(arriveN, (plannedByDay.get(arriveN) ?? 0) + qty);
          if (arriveN === d) projR += qty;
        }
      }
      const ws = weekStart(d);
      if (d <= endN) weekly.set(ws, { weekStart: isoDay(ws), existingSupply: round(proj, 1), withRecommendations: round(projR, 1), safetyStock: safety });
    }
    projections[pn] = [...weekly.values()];

    // Which builds are short with existing supply, and when do parts become available (with recs)?
    const supplyBy = (n, withPlanned) => onHand
      + sum(receipts.filter((r) => r.availableN <= n), (r) => r.quantity)
      + (withPlanned ? sum(planned.filter((p) => p.arriveN <= n), (p) => p.qty) : 0);
    let cum = 0;
    for (const c of consumers) {
      cum += c.qty;
      if (cum > supplyBy(c.build.buildN, false) + 1e-9) {
        c.build.shortParts.push(pn);
        let readyN = c.build.buildN;
        while (cum > supplyBy(readyN, true) + 1e-9 && readyN < lastN + 120) readyN += 1;
        c.build.partsReadyN = Math.max(c.build.partsReadyN ?? 0, readyN);
        const p = [...planned].reverse().find((x) => x.needN <= c.build.buildN) ?? planned[0];
        if (p) (p.blocking ??= []).push(c.build);
      }
    }

    for (const p of planned) {
      const { choice } = p;
      const orderByN = p.needN - choice.effectiveLead;
      const blocking = p.blocking ?? [];
      const firmBlocked = blocking.filter((b) => b.source === 'firm');
      const impacted = [...new Map(firmBlocked.map((b) => [b.orderId, { orderId: b.orderId, customerId: b.customerId, customerName: b.customerName, expectedDelivery: b.expectedDelivery }])).values()];
      // When the normal order lands late, offer the fastest expedited alternative.
      let rushOption = null;
      if (p.arriveN > p.needN) {
        const fastest = rushChoice(supplierOptions.get(pn), perfBy, suppliers, recvDays);
        const rushArriveN = todayN + fastest.effectiveLead;
        if (rushArriveN < p.arriveN) {
          rushOption = {
            supplierId: fastest.supplierId, supplierName: fastest.supplierName, effectiveLeadDays: fastest.effectiveLead,
            expectedAvailable: isoDay(rushArriveN), daysLate: Math.max(0, rushArriveN - p.needN),
            premium: round(p.qty * fastest.unitCost * RUSH_PREMIUM, 2), cost: round(p.qty * fastest.unitCost * (1 + RUSH_PREMIUM), 2),
          };
        }
      }
      recommendations.push({
        key: `${pn}|${isoDay(p.needN)}`,
        partNumber: pn,
        partName: part.name,
        quantity: p.qty,
        supplierId: choice.supplierId,
        supplierName: choice.supplierName,
        supplierScore: choice.score,
        unitCost: choice.unitCost,
        cost: round(p.qty * choice.unitCost, 2),
        effectiveLeadDays: choice.effectiveLead,
        needDate: isoDay(p.needN),
        orderBy: isoDay(orderByN),
        expectedAvailable: isoDay(p.arriveN),
        daysLate: Math.max(0, p.arriveN - p.needN),
        urgency: orderByN < todayN ? 'overdue' : orderByN <= todayN + 7 ? 'this_week' : 'upcoming',
        reason: choice.reason,
        buildsBlocked: blocking.length,
        firmBuildsBlocked: firmBlocked.length,
        impactedOrders: impacted,
        rushOption,
      });
    }

    partsOut.push({
      partNumber: pn,
      partName: part.name,
      category: part.category,
      onHand,
      pending: balances.get(pn).pending,
      grossRequirement: Math.ceil(totalReq),
      firmRequirement: Math.ceil(firmReq),
      forecastRequirement: Math.ceil(totalReq - firmReq),
      expectedLossRate: loss,
      safetyStock: safety,
      projectedMinWithExistingSupply: Math.floor(minProj),
      firstShortageDate: shortageN === null ? null : isoDay(shortageN),
      recommendedQuantity: sum(planned, (p) => p.qty),
      recommendedCost: round(sum(planned, (p) => p.qty * p.choice.unitCost), 2),
      status: partStatus(planned, todayN),
    });
  }

  // ---- 6. Build status & order risk ---------------------------------------------------
  for (const b of builds) {
    const readyN = Math.max(b.buildN, b.partsReadyN ?? b.buildN);
    b.projectedShipN = readyN + 1;
    b.daysLate = Math.max(0, b.projectedShipN - b.needByN);
    b.status = b.daysLate > 0 ? 'late' : b.shortParts.length ? 'parts_risk' : 'ok';
  }
  const orderRisks = [];
  for (const o of orders) {
    const bs = builds.filter((b) => b.orderId === o.id && b.status !== 'ok');
    if (!bs.length) continue;
    const worst = Math.max(...bs.map((b) => b.daysLate));
    orderRisks.push({
      orderId: o.id, customerId: o.customer_id, customerName: o.customer_name, model: o.model_number,
      quantity: o.quantity, expectedDelivery: o.expected_delivery_date,
      unitsAtRisk: bs.length, daysLate: worst, severity: worst > 0 ? 'late' : 'at_risk',
      shortParts: [...new Set(bs.flatMap((b) => b.shortParts))],
      capacityConstrained: bs.some((b) => b.buildN > b.latestStartN), priority: o.priority,
    });
  }

  // Weekly views.
  const weekKeys = [];
  for (let w = weekStart(todayN); w <= endN; w += 7) weekKeys.push(w);
  const buildWeeks = weekKeys.map((w) => {
    const bs = builds.filter((b) => weekStart(b.buildN) === w);
    const byModel = {};
    for (const b of bs) byModel[b.model] = (byModel[b.model] ?? 0) + 1;
    let workdays = 0;
    for (let d = Math.max(w, todayN); d < w + 7; d++) if (isWorkday(d)) workdays += 1;
    return { weekStart: isoDay(w), total: bs.length, firm: bs.filter((b) => b.source === 'firm').length, byModel, capacity: workdays * bays };
  });
  const demandWeekly = weekKeys.map((w) => ({ weekStart: isoDay(w), ...(demandWeeks.get(w) ?? { firmBuilt: 0, firmToBuild: 0, forecast: 0 }) }));

  const urgencyRank = { overdue: 0, this_week: 1, upcoming: 2 };
  recommendations.sort((a, b) => urgencyRank[a.urgency] - urgencyRank[b.urgency] || a.orderBy.localeCompare(b.orderBy));
  const capacityTotal = sum(buildWeeks, (w) => w.capacity);
  const buildsInHorizon = builds.filter((b) => b.buildN <= endN);

  return {
    asOf: today,
    horizonDays: H,
    settings: { buildBays: bays, serviceLevel: level, safetyStockDays: safetyDays, receivingDays: recvDays, orderToDeliveryLeadDays: leadDays },
    summary: {
      firmUnits: items.filter((i) => i.source === 'firm').length,
      forecastUnits: items.filter((i) => i.source === 'forecast').length,
      coveredByStock: stockAllocations.length,
      buildsPlanned: builds.length,
      buildsAtRisk: builds.filter((b) => b.status !== 'ok').length,
      lateBuilds: builds.filter((b) => b.status === 'late').length,
      ordersAtRisk: orderRisks.length,
      recommendedPurchaseOrders: recommendations.length,
      recommendedSpend: round(sum(recommendations, (r) => r.cost), 0),
      actNowPurchaseOrders: recommendations.filter((r) => r.urgency !== 'upcoming').length,
      capacityUtilization: capacityTotal ? round(buildsInHorizon.length / capacityTotal, 3) : 0,
    },
    demandWeekly,
    buildWeeks,
    builds: builds.map((b) => ({
      seq: b.seq, model: b.model, source: b.source, rush: !!b.rush, orderId: b.orderId ?? null, customerId: b.customerId ?? null,
      customerName: b.customerName ?? null, expectedDelivery: b.expectedDelivery ?? null,
      expectedSubmission: b.expectedSubmission ?? null,
      needBy: isoDay(b.needByN), latestStart: isoDay(b.latestStartN), buildDate: isoDay(b.buildN),
      partsReady: b.partsReadyN ? isoDay(b.partsReadyN) : null, projectedShip: isoDay(b.projectedShipN),
      daysLate: b.daysLate, status: b.status, shortParts: b.shortParts, startableNow: kitsOnHand[b.model] > 0,
    })),
    stockAllocations,
    kitsOnHand,
    parts: partsOut,
    scheduledReceipts: scheduledReceipts.map(({ availableN, ...r }) => ({ ...r, availableForBuild: isoDay(availableN) })),
    recommendations,
    projections,
    orderRisks,
  };
}

/** critical: can't be fixed in time by ordering · order_now: order this week · planned: future order · ok */
function partStatus(planned, todayN) {
  if (planned.some((p) => p.arriveN > p.needN)) return 'critical';
  if (planned.some((p) => p.needN - p.choice.effectiveLead <= todayN + 7)) return 'order_now';
  return planned.length ? 'planned' : 'ok';
}

/** Fastest expedited source for a part: half the quoted lead, a fraction of the usual slip. */
function rushChoice(options, perfBy, suppliers, recvDays) {
  return options.map((sp) => {
    const slip = Math.round((perfBy.get(`${sp.part_number}|${sp.supplier_id}`)?.predictedSlipDays ?? 0) * RUSH_SLIP_FACTOR);
    return {
      supplierId: sp.supplier_id, supplierName: suppliers.get(sp.supplier_id).name, unitCost: sp.unit_cost,
      effectiveLead: rushLeadDays(sp.quoted_lead_days) + slip + recvDays,
    };
  }).sort((a, b) => a.effectiveLead - b.effectiveLead || a.unitCost - b.unitCost)[0];
}

/**
 * Pick a supplier for a recommended purchase: the best-scoring source that can still
 * deliver by the need date; if none can, the fastest one (and the order is flagged late).
 */
function chooseSupplier(options, perfBy, suppliers, needN, todayN, recvDays) {
  const scored = options.map((sp) => {
    const perf = perfBy.get(`${sp.part_number}|${sp.supplier_id}`);
    const slip = Math.round(perf?.predictedSlipDays ?? 0);
    return {
      supplierId: sp.supplier_id,
      supplierName: suppliers.get(sp.supplier_id).name,
      unitCost: sp.unit_cost,
      score: perf?.score ?? null,
      effectiveLead: sp.quoted_lead_days + slip + recvDays,
      quoted: sp.quoted_lead_days,
      slip,
      isPrimary: !!sp.is_primary,
    };
  });
  const feasible = scored.filter((s) => needN - s.effectiveLead >= todayN)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (feasible.length) {
    const c = feasible[0];
    return { ...c, reason: `Best performance score that can arrive in time (${c.quoted}d quoted + ${c.slip}d typical slip + ${recvDays}d receiving)` };
  }
  const fastest = [...scored].sort((a, b) => a.effectiveLead - b.effectiveLead || (b.score ?? 0) - (a.score ?? 0))[0];
  return { ...fastest, reason: `No supplier can meet the need date; fastest source (${fastest.effectiveLead}d effective lead) — expedite` };
}
