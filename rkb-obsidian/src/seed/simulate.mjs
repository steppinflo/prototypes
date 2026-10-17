// Builds the prototype data set by replaying the source CSV as company history.
//
// The CSV (2020-2023, 10k rows) is shifted forward in whole years so it ends around
// "today", then each row is treated as a market demand observation:
//   - a seasonal, model-weighted sample of rows becomes customer orders
//     (Demand_Units -> order size, Warehouse_Location -> customer region,
//      Component_Failure_Rate -> how failure-prone that order's tractors are),
//   - Supplier_Delay_Days per supplier drives how late that supplier's parts arrive,
//   - all rows are aggregated monthly into market_signals (inflation, market trend).
// A day-by-day simulation then runs the business (purchasing, receiving, building,
// QC, shipping, delivery, field failures) so every record is consistent: each tractor
// is built from parts that were ordered, received and are traceable to a supplier.

import {
  dayNum, isoDay, isWorkday, weekday, isoWeek, makeRng, transitDays, pad, round,
} from '../lib/util.mjs';
import {
  PLANT, TRACTOR_MODELS, SUPPLIERS, PART_TYPES, BOM, FAILURE_MODES, RECEIVING_ISSUES,
  CARRIERS_INBOUND, CARRIERS_OUTBOUND, CUSTOMERS, SEASONALITY, MODEL_POPULARITY,
} from './catalog.mjs';

const TARGET_ORDERS_PER_MONTH = 13;
const STOCK_TARGET = { 'TX-100': 3, 'TX-200': 3, 'TX-300': 2, 'TX-400': 1, 'TX-500': 1 };
const EARMARK_WINDOW = 45; // stock is committed to an order once it is due within this many days
const FAILURE_SCALE = 0.6;   // overall calibration of catalog failure rates
const MFG_SHARE = 0.3;       // share of failures caught in manufacturing / QC
const FIELD_WINDOW_DAYS = 720;

export function shiftDataset(csvRows, today) {
  const maxYear = Math.max(...csvRows.map((r) => Number(r.Date.slice(0, 4))));
  const shift = Number(today.slice(0, 4)) - maxYear;
  const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const shifted = [];
  csvRows.forEach((r, index) => {
    const y = Number(r.Date.slice(0, 4)) + shift;
    let md = r.Date.slice(5);
    if (md === '02-29' && !leap(y)) md = '02-28';
    const date = `${y}-${md}`;
    if (date <= today) shifted.push({ ...r, Date: date, sourceRow: index + 2 });
  });
  shifted.sort((a, b) => (a.Date < b.Date ? -1 : a.Date > b.Date ? 1 : a.sourceRow - b.sourceRow));
  return { rows: shifted, yearShift: shift };
}

export function marketSignals(rows) {
  const agg = new Map();
  for (const r of rows) {
    const key = `${r.Date.slice(0, 7)}|${r.Tractor_Model}`;
    let a = agg.get(key);
    if (!a) {
      a = { month: r.Date.slice(0, 7), model_number: r.Tractor_Model, demand_units: 0, d: 0, f: 0, inv: 0, infl: 0, trend: 0, n: 0 };
      agg.set(key, a);
    }
    a.demand_units += r.Demand_Units;
    a.d += r.Supplier_Delay_Days;
    a.f += r.Component_Failure_Rate;
    a.inv += r.Inventory_Levels;
    a.infl += r.Inflation_Rate;
    a.trend += r.Market_Trend_Index;
    a.n += 1;
  }
  return [...agg.values()].map((a) => ({
    month: a.month,
    model_number: a.model_number,
    demand_units: a.demand_units,
    avg_supplier_delay: round(a.d / a.n, 2),
    avg_failure_rate: round(a.f / a.n, 4),
    avg_inventory: round(a.inv / a.n, 1),
    avg_inflation: round(a.infl / a.n, 3),
    avg_market_trend: round(a.trend / a.n, 3),
    observations: a.n,
  })).sort((x, y) => (x.month + x.model_number).localeCompare(y.month + y.model_number));
}

function buildCustomers() {
  const rng = makeRng(7);
  const roads = ['County Road', 'Farm Road', 'Ranch Road', 'Rural Route', 'State Highway'];
  return CUSTOMERS.map(([region, name, segment, city, state, lat, lng, weight], i) => ({
    id: `CUS-${pad(i + 1, 3)}`,
    name,
    segment,
    primary_address: `${rng.int(100, 9900)} ${rng.pick(roads)} ${rng.int(2, 240)}, ${city}, ${state}`,
    city,
    state,
    region,
    lat,
    lng,
    weight,
  }));
}

export function simulate({ csvRows, today, seed = 20261016, buildBays = 3 }) {
  const rng = makeRng(seed);
  const todayN = dayNum(today);
  const { rows, yearShift } = shiftDataset(csvRows, today);
  const signals = marketSignals(rows);
  const customers = buildCustomers();
  const customersByRegion = new Map();
  for (const c of customers) {
    if (!customersByRegion.has(c.region)) customersByRegion.set(c.region, []);
    customersByRegion.get(c.region).push(c);
  }
  const partMap = new Map(PART_TYPES.map((p) => [p.part_number, p]));
  const supplierMap = new Map(SUPPLIERS.map((s) => [s.id, s]));
  const modelMap = new Map(TRACTOR_MODELS.map((m) => [m.model_number, m]));
  const delaySamples = new Map(SUPPLIERS.map((s) => [s.id, []]));
  for (const r of rows) {
    const sup = SUPPLIERS.find((s) => s.code === r.Supplier);
    if (sup) delaySamples.get(sup.id).push(r.Supplier_Delay_Days);
  }

  const startN = dayNum(rows[0].Date);
  const yearsSince = (n) => (n - startN) / 365.25;

  // ---- 1. Sample customer orders from the dataset ---------------------------------
  const weightOf = (r) => {
    const m = Number(r.Date.slice(5, 7)) - 1;
    return SEASONALITY[m] * MODEL_POPULARITY[r.Tractor_Model] * (0.75 + 0.5 * r.Market_Trend_Index)
      * (1 + 0.08 * yearsSince(dayNum(r.Date)));
  };
  const months = new Set(rows.map((r) => r.Date.slice(0, 7))).size;
  const base = (TARGET_ORDERS_PER_MONTH * months) / rows.reduce((s, r) => s + weightOf(r), 0);
  const orders = [];
  const yearSeq = new Map();
  for (const r of rows) {
    if (rng() >= base * weightOf(r)) continue;
    const subN = dayNum(r.Date);
    const year = r.Date.slice(0, 4);
    yearSeq.set(year, (yearSeq.get(year) ?? 0) + 1);
    const fleet = rng() < 0.04;
    const qty = fleet ? rng.int(5, 8) : Math.min(4, 1 + Math.floor(((r.Demand_Units - 50) / 450) * 4));
    const customer = rng.weighted(customersByRegion.get(r.Warehouse_Location), (c) => c.weight);
    const rush = rng() < 0.1;
    const lead = rush ? rng.int(18, 28) : rng.int(35, 80) + qty * 2;
    const altSite = rng() < 0.08;
    const model = modelMap.get(r.Tractor_Model);
    orders.push({
      id: `SO-${year}-${pad(yearSeq.get(year), 4)}`,
      customer,
      model: r.Tractor_Model,
      qty,
      subN,
      expN: subN + lead,
      actN: null,
      delivery_address: altSite
        ? `Field site, ${rng.int(10, 999)} Section Line Rd, ${customer.city}, ${customer.state}`
        : customer.primary_address,
      region: r.Warehouse_Location,
      unit_price: round(model.list_price * (1 - (qty >= 4 ? 0.06 : 0)) * (1 + 0.03 * yearsSince(subN)), -1),
      failMult: Math.max(0.2, r.Component_Failure_Rate / 0.05),
      cancelN: rng() < 0.025 ? subN + rng.int(5, 20) : null,
      notes: rush ? 'Rush order' : (fleet ? 'Fleet order' : null),
      sourceRow: r.sourceRow,
      tractors: [],
      cancelled: false,
      deliveredCount: 0,
    });
  }

  // ---- 2. Simulation state ------------------------------------------------------------
  const pos = [];
  const inventoryParts = [];
  const tractorParts = [];
  const tractors = [];
  const shipments = [];
  const failures = [];
  const stock = new Map(PART_TYPES.map((p) => [p.part_number, []])); // FIFO of ip with on-hand
  const usage = new Map(PART_TYPES.map((p) => [p.part_number, new Map()]));
  const arrivals = new Map(); // day -> [po]
  const deliveriesByDay = new Map(); // day -> [shipment]
  let poSeq = 0;
  let ipSeq = 0;
  let tractorSeq = 0;
  let shipSeq = 0;
  const serialSeq = new Map();
  const trackingNo = () => `${rng.pick(['1Z', 'HF', 'XL', 'NS'])}${Math.floor(rng() * 1e10).toString().padStart(10, '0')}`;

  const available = (pn) => {
    let n = 0;
    for (const ip of stock.get(pn)) n += ip.quantity_on_hand;
    return n;
  };
  const onOrder = (pn) => pos.reduce((s, po) => s + (po.part_number === pn && !po.arrived ? po.quantity : 0), 0);
  const logUsage = (pn, day, qty) => {
    const m = usage.get(pn);
    m.set(day, (m.get(day) ?? 0) + qty);
  };

  function placePo(pn, supplierId, qty, dayN, source = 'history') {
    const sup = supplierMap.get(supplierId);
    const part = partMap.get(pn);
    const year = isoDay(dayN).slice(0, 4);
    poSeq += 1;
    const samples = delaySamples.get(supplierId);
    const delay = Math.round(samples[Math.floor(rng() * samples.length)] * sup.delayFactor * 0.7);
    const arrivalN = Math.max(dayN + 7, dayN + sup.quoted_lead_days - 6 + delay);
    const isPrimary = part.suppliers[0] === supplierId;
    const po = {
      id: `PO-${year}-${pad(poSeq, 5)}`,
      part_number: pn,
      supplier_id: supplierId,
      quantity: qty,
      quantity_received: 0,
      quantity_rejected: 0,
      unit_cost: round(part.unit_cost * (isPrimary ? 1 : 1.06) * (1.035 ** yearsSince(dayN)), 2),
      subN: dayN,
      expN: dayN + sup.quoted_lead_days,
      arrivalN,
      shippedN: arrivalN - transitDays(sup.lat, sup.lng, PLANT.lat, PLANT.lng),
      arrived: false,
      source,
    };
    pos.push(po);
    if (!arrivals.has(arrivalN)) arrivals.set(arrivalN, []);
    arrivals.get(arrivalN).push(po);
    return po;
  }

  function nextSerial(pn, supplierId, dayN) {
    const key = `${pn}|${supplierId}`;
    serialSeq.set(key, (serialSeq.get(key) ?? 0) + 1);
    return `${supplierId.slice(-1)}${pn.replace('-', '')}-${isoDay(dayN).slice(2, 4)}${pad(serialSeq.get(key), 5)}`;
  }

  function receivePo(po, dayN) {
    const sup = supplierMap.get(po.supplier_id);
    const part = partMap.get(po.part_number);
    po.arrived = true;
    po.actN = dayN;
    let rejected = 0;
    if (rng() < 0.05 * sup.failureFactor) rejected = Math.max(1, Math.round(po.quantity * (0.05 + rng() * 0.15)));
    po.quantity_rejected = rejected;
    po.quantity_received = po.quantity - rejected;
    const lot = `${sup.id.slice(-1)}${isoDay(dayN).slice(2).replaceAll('-', '')}-${po.part_number.replace('-', '')}`;
    const mk = (serial, qty, onHand, status) => {
      ipSeq += 1;
      const ip = {
        id: `IP-${pad(ipSeq, 6)}`,
        part_number: po.part_number,
        serial_number: serial,
        lot_number: lot,
        supplier_id: po.supplier_id,
        inventory_order_id: po.id,
        quantity: qty,
        quantity_on_hand: onHand,
        status,
        tractor_id: null,
        receivedN: dayN,
      };
      inventoryParts.push(ip);
      return ip;
    };
    let firstRejected = null;
    if (part.serialized) {
      for (let i = 0; i < po.quantity; i++) {
        const bad = i >= po.quantity - rejected;
        const ip = mk(nextSerial(po.part_number, po.supplier_id, dayN), 1, bad ? 0 : 1, bad ? 'rejected' : 'in_stock');
        if (bad) firstRejected ??= ip;
        else stock.get(po.part_number).push(ip);
      }
    } else {
      const ip = mk(null, po.quantity, po.quantity - rejected, po.quantity - rejected > 0 ? 'in_stock' : 'rejected');
      if (ip.quantity_on_hand > 0) stock.get(po.part_number).push(ip);
      if (rejected) firstRejected = ip;
    }
    if (rejected) {
      const [cls, desc] = rng.pick(RECEIVING_ISSUES);
      failures.push({
        dayN, stage: 'receiving', failure_class: cls, severity: rejected > 3 ? 'medium' : 'low',
        part_number: po.part_number, supplier_id: po.supplier_id, inventory_part_id: firstRejected.id,
        inventory_order_id: po.id, tractor_id: null, customer_id: null, quantity: rejected,
        description: `${desc} (${rejected} of ${po.quantity} units, ${po.id})`,
      });
    }
  }

  /** Take `qty` units of a part from stock (FIFO). Returns [{ip, qty}] or null if short. */
  function take(pn, qty) {
    if (available(pn) < qty) return null;
    const out = [];
    const q = stock.get(pn);
    let need = qty;
    while (need > 0) {
      const ip = q[0];
      const t = Math.min(need, ip.quantity_on_hand);
      ip.quantity_on_hand -= t;
      need -= t;
      out.push({ ip, qty: t });
      if (ip.quantity_on_hand === 0) q.shift();
    }
    return out;
  }

  function install(tractor, pn, qty, dayN) {
    const got = take(pn, qty);
    if (!got) return false;
    logUsage(pn, dayN, qty);
    for (const { ip, qty: q } of got) {
      if (partMap.get(pn).serialized) {
        ip.status = 'installed';
        ip.tractor_id = tractor.id;
      } else if (ip.quantity_on_hand === 0) {
        ip.status = 'consumed';
      }
      const existing = tractor.parts.find((tp) => tp.inventory_part_id === ip.id);
      if (existing) existing.quantity += q;
      else tractor.parts.push({ tractor_id: tractor.id, inventory_part_id: ip.id, part_number: pn, quantity: q, installedN: dayN, ip });
    }
    return true;
  }

  const unitFailP = (pn, supplierId) => partMap.get(pn).failureRate * supplierMap.get(supplierId).failureFactor * FAILURE_SCALE;

  function failureMode(pn) {
    return rng.pick(FAILURE_MODES[partMap.get(pn).category]);
  }

  const canBuild = (model, sets = 1) => BOM[model].every(([pn, q]) => available(pn) >= q * sets);

  function startBuild(model, order, dayN) {
    tractorSeq += 1;
    const yy = isoDay(dayN).slice(2, 4);
    const ww = pad(isoWeek(dayN), 2);
    const tractor = {
      id: `T-${pad(tractorSeq, 5)}`,
      serial_number: `RKB-${model.replace('-', '')}-${yy}${ww}-${pad(tractorSeq, 5)}`,
      model_number: model,
      lot_number: `B${yy}W${ww}-${model.replace('-', '')}`,
      status: 'in_production',
      order: order ?? null,
      buildN: dayN,
      completeN: null,
      shipN: null,
      deliveredN: null,
      hold: null,
      failMult: order ? order.failMult : 1,
      parts: [],
    };
    tractors.push(tractor);
    if (order) order.tractors.push(tractor);
    for (const [pn, q] of BOM[model]) install(tractor, pn, q, dayN);

    // Manufacturing / QC failures: a failing unit is scrapped and replaced from stock;
    // if no replacement is on hand the tractor goes on QC hold.
    for (const tp of [...tractor.parts]) {
      for (let u = 0; u < tp.quantity; u++) {
        if (rng() >= unitFailP(tp.part_number, tp.ip.supplier_id) * MFG_SHARE * tractor.failMult) continue;
        const [cls, desc] = failureMode(tp.part_number);
        failures.push({
          dayN, stage: 'manufacturing', failure_class: cls, severity: rng() < 0.3 ? 'medium' : 'low',
          part_number: tp.part_number, supplier_id: tp.ip.supplier_id, inventory_part_id: tp.ip.id,
          inventory_order_id: tp.ip.inventory_order_id, tractor_id: tractor.id, customer_id: null, quantity: 1,
          description: `${desc} found during build/QC of ${tractor.serial_number}`,
        });
        if (partMap.get(tp.part_number).serialized) {
          tp.ip.status = 'scrapped';
          tp.ip.tractor_id = null;
          tp.scrapped = true;
        } else {
          tp.quantity -= 1;
        }
        if (!install(tractor, tp.part_number, 1, dayN)) tractor.hold = tp.part_number;
        break;
      }
    }
    tractor.parts = tractor.parts.filter((tp) => !tp.scrapped && tp.quantity > 0);
    return tractor;
  }

  function shipOrder(order, ready, dayN) {
    const days = transitDays(PLANT.lat, PLANT.lng, order.customer.lat, order.customer.lng);
    shipSeq += 1;
    const etaN = dayN + days;
    const arrivalN = etaN + (rng() < 0.1 ? rng.int(1, 3) : 0);
    const sh = {
      id: `SH-${pad(shipSeq, 5)}`, direction: 'outbound', inventory_order_id: null, customer_order_id: order.id,
      carrier: rng.pick(CARRIERS_OUTBOUND), tracking_number: trackingNo(),
      origin: PLANT.name, origin_lat: PLANT.lat, origin_lng: PLANT.lng,
      destination: `${order.customer.name} — ${order.delivery_address}`,
      destination_lat: order.customer.lat, destination_lng: order.customer.lng,
      shippedN: dayN, etaN, arrivalN, tractors: ready, order,
    };
    shipments.push(sh);
    for (const t of ready) {
      t.status = 'shipping';
      t.shipN = dayN;
    }
    if (!deliveriesByDay.has(arrivalN)) deliveriesByDay.set(arrivalN, []);
    deliveriesByDay.get(arrivalN).push(sh);
  }

  function deliver(sh, dayN) {
    sh.delivered = true;
    for (const t of sh.tractors) {
      t.status = 'delivered';
      t.deliveredN = dayN;
      sh.order.deliveredCount += 1;
      // Field failures over the tractor's service life (only those already in the past are recorded).
      for (const tp of t.parts) {
        for (let u = 0; u < tp.quantity; u++) {
          if (rng() >= unitFailP(tp.part_number, tp.ip.supplier_id) * (1 - MFG_SHARE) * t.failMult) continue;
          const failN = dayN + 3 + Math.floor(rng() ** 1.3 * FIELD_WINDOW_DAYS);
          if (failN > todayN) continue;
          const [cls, desc] = failureMode(tp.part_number);
          const cat = partMap.get(tp.part_number).category;
          const major = ['engine', 'transmission', 'electronics', 'hydraulics', 'axle'].includes(cat);
          failures.push({
            dayN: failN, stage: 'field', failure_class: cls,
            severity: major ? (rng() < 0.25 ? 'critical' : 'high') : (rng() < 0.3 ? 'medium' : 'low'),
            part_number: tp.part_number, supplier_id: tp.ip.supplier_id, inventory_part_id: tp.ip.id,
            inventory_order_id: tp.ip.inventory_order_id, tractor_id: t.id, customer_id: sh.order.customer.id, quantity: 1,
            description: `${desc} reported by ${sh.order.customer.name} (${t.serial_number}, ${failN - dayN < 45 ? `${failN - dayN} days` : `${Math.round((failN - dayN) / 30)} months`} in service)`,
          });
          break;
        }
      }
    }
    if (sh.order.deliveredCount >= sh.order.qty) sh.order.actN = dayN;
  }

  // ---- 3. Opening balance: ~6 weeks of parts on hand ---------------------------------
  const avgBom = new Map();
  for (const m of TRACTOR_MODELS) {
    for (const [pn, q] of BOM[m.model_number]) avgBom.set(pn, (avgBom.get(pn) ?? 0) + q * MODEL_POPULARITY[m.model_number] / 4.7);
  }
  for (const part of PART_TYPES) {
    const qty = Math.max(part.min_order_qty, Math.ceil((avgBom.get(part.part_number) ?? 0) * 40 / part.pack_size) * part.pack_size);
    const po = placePo(part.part_number, part.suppliers[0], qty, startN - 40);
    arrivals.get(po.arrivalN).splice(arrivals.get(po.arrivalN).indexOf(po), 1);
    receivePo(po, startN - 10);
  }

  // ---- 4. Day-by-day simulation (through yesterday) ----------------------------------
  const pendingOrders = [...orders];
  const open = [];
  const isOpen = (o) => !o.cancelled && o.actN === null;

  for (let d = startN; d < todayN; d++) {
    while (pendingOrders.length && pendingOrders[0].subN <= d) open.push(pendingOrders.shift());
    open.sort((a, b) => a.expN - b.expN);

    for (const o of open) {
      if (o.cancelN === d && o.tractors.length === 0) o.cancelled = true;
    }

    for (const po of arrivals.get(d) ?? []) receivePo(po, d);
    for (const sh of deliveriesByDay.get(d) ?? []) deliver(sh, d);

    // Resolve QC holds once a replacement part is on hand.
    for (const t of tractors) {
      if (!t.hold) continue;
      if (install(t, t.hold, 1, d)) {
        t.hold = null;
        if (t.status === 'qc_hold') {
          t.status = t.order ? 'earmarked' : 'inventoried';
          t.completeN = d;
        }
      }
    }

    // Builds take one working day.
    if (isWorkday(d)) {
      for (const t of tractors) {
        if (t.status !== 'in_production' || t.buildN >= d) continue;
        if (t.hold) t.status = 'qc_hold';
        else {
          t.status = t.order ? 'earmarked' : 'inventoried';
          t.completeN = d;
        }
      }
    }

    // Earmark finished or in-progress stock tractors to open orders (oldest stock first).
    for (const o of open) {
      if (!isOpen(o) || d < o.expN - EARMARK_WINDOW) continue;
      while (o.tractors.length < o.qty) {
        const t = tractors.find((x) => !x.order && x.model_number === o.model
          && (x.status === 'inventoried' || x.status === 'in_production' || x.status === 'qc_hold'));
        if (!t) break;
        t.order = o;
        if (t.status === 'inventoried') t.status = 'earmarked';
        o.tractors.push(t);
      }
    }

    if (isWorkday(d)) {
      let cap = buildBays;
      for (const window of [30, 60]) {
        for (const o of open) {
          if (cap === 0) break;
          if (!isOpen(o) || d < o.expN - window) continue;
          while (cap > 0 && o.tractors.length < o.qty && canBuild(o.model)) {
            startBuild(o.model, o, d);
            cap -= 1;
          }
        }
      }
      const stockOf = (m) => tractors.filter((t) => !t.order && t.model_number === m
        && ['inventoried', 'in_production', 'qc_hold'].includes(t.status)).length;
      for (const m of Object.keys(STOCK_TARGET)) {
        if (cap === 0) break;
        if (stockOf(m) < STOCK_TARGET[m] && canBuild(m, 2)) {
          startBuild(m, null, d);
          cap -= 1;
        }
      }
    }

    // Ship complete orders shortly before they're due; ship partials once late.
    for (const o of open) {
      if (!isOpen(o)) continue;
      const ready = o.tractors.filter((t) => t.status === 'earmarked');
      if (!ready.length) continue;
      const days = transitDays(PLANT.lat, PLANT.lng, o.customer.lat, o.customer.lng);
      const complete = o.tractors.length >= o.qty && o.tractors.every((t) => ['earmarked', 'shipping', 'delivered'].includes(t.status));
      if ((complete && d >= o.expN - days - 10) || (!complete && d >= o.expN - days)) shipOrder(o, ready, d);
    }

    // Weekly purchasing run (Mondays): reactive reorder policy covering firm orders
    // over the next ~75 days plus a month of recent average usage.
    if (weekday(d) === 1) {
      for (const part of PART_TYPES) {
        const pn = part.part_number;
        let firm = 0;
        for (const o of open) {
          if (!isOpen(o) || o.expN > d + 75) continue;
          const per = BOM[o.model].find(([p]) => p === pn);
          if (per) firm += (o.qty - o.tractors.length) * per[1];
        }
        let used = 0;
        for (const [day, q] of usage.get(pn)) if (day > d - 56) used += q;
        const target = firm + (used / 56) * 30;
        const position = available(pn) + onOrder(pn);
        if (position >= target * 0.85) continue;
        let qty = Math.ceil((target * 1.15 - position) / part.pack_size) * part.pack_size;
        qty = Math.max(qty, part.min_order_qty);
        const supplierId = part.suppliers.length > 1 && rng() > 0.72 ? part.suppliers[1] : part.suppliers[0];
        placePo(pn, supplierId, qty, d);
      }
    }
  }

  // Orders submitted today land as new, unworked orders.
  while (pendingOrders.length && pendingOrders[0].subN <= todayN) open.push(pendingOrders.shift());

  for (const t of tractors) tractorParts.push(...t.parts);

  return {
    yearShift, rows, signals, customers, orders, pos, inventoryParts, tractorParts, tractors, shipments, failures,
    today, todayN, helpers: { placePo, rng },
  };
}

export function deriveOrderStatus(order, tractors) {
  if (order.cancelled) return 'cancelled';
  const ts = tractors;
  const delivered = ts.filter((t) => t.status === 'delivered').length;
  if (delivered >= order.qty) return 'delivered';
  if (delivered > 0) return 'partially_delivered';
  if (ts.some((t) => t.status === 'shipping')) return 'shipping';
  if (ts.length >= order.qty && ts.every((t) => t.status === 'earmarked')) return 'ready';
  if (ts.length > 0) return 'in_production';
  return 'received';
}
