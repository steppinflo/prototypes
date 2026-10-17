import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT, SCHEMA_VERSION, insertMany, tx, setSetting, logActivity } from '../db/index.mjs';
import { parseCsv, isoDay, makeRng, pad, transitDays } from '../lib/util.mjs';
import { haulLeg, repairLabor } from '../lib/costs.mjs';
import { simulate, deriveOrderStatus } from './simulate.mjs';
import {
  WAREHOUSES, PLANT, TRACTOR_MODELS, SUPPLIERS, PART_TYPES, BOM, CARRIERS_INBOUND, CARRIERS_OUTBOUND,
} from './catalog.mjs';

export const DATASET_PATH = process.env.RKB_DATASET_PATH
  || resolve(PROJECT_ROOT, 'docs', 'synthetic_supply_chain_dataset.csv');

export const DEFAULT_SETTINGS = {
  build_bays: 3,                // tractors that can be built per working day (1 day per tractor per bay)
  planning_horizon_days: 90,
  forecast_service_level: 'p75', // plan to the 75th percentile of forecast demand
  safety_stock_days: 10,
  receiving_days: 2,            // dock-to-stock time after a parts delivery arrives
  earmark_window_days: 45,
};

/**
 * Hand-placed scenarios layered on top of the simulated history so the demo always
 * has something to act on: a dealer fleet order that outruns flagship engine supply,
 * and a tractor stuck on QC hold waiting for a replacement control unit.
 */
function injectScenarios(sim) {
  const { todayN, orders, tractors, failures, customers } = sim;
  const dealer = customers.find((c) => c.name === 'Corn Belt Equipment Dealers');
  const year = isoDay(todayN).slice(0, 4);
  const seq = orders.filter((o) => o.id.startsWith(`SO-${year}`)).length + 1;
  orders.push({
    id: `SO-${year}-${pad(seq, 4)}`,
    customer: dealer,
    model: 'TX-500',
    qty: 6,
    subN: todayN - 1,
    expN: todayN + 38,
    actN: null,
    delivery_address: dealer.primary_address,
    region: dealer.region,
    unit_price: 205000,
    failMult: 1,
    cancelN: null,
    notes: 'Fleet order — dealer stocking program for spring planting',
    tractors: [],
    cancelled: false,
    deliveredCount: 0,
  });

  // Most recently completed tractor fails QC on its ECU.
  const t = [...tractors].reverse().find((x) => x.status === 'earmarked' && x.completeN);
  if (t) {
    const tp = t.parts.find((p) => p.part_number === 'ECU-01');
    tp.ip.status = 'scrapped';
    tp.ip.tractor_id = null;
    t.parts.splice(t.parts.indexOf(tp), 1);
    sim.tractorParts.splice(sim.tractorParts.indexOf(tp), 1);
    t.status = 'qc_hold';
    t.hold = 'ECU-01';
    t.completeN = null;
    failures.push({
      dayN: todayN - 1, stage: 'manufacturing', failure_class: 'Electrical', severity: 'high',
      part_number: 'ECU-01', supplier_id: tp.ip.supplier_id, inventory_part_id: tp.ip.id,
      inventory_order_id: tp.ip.inventory_order_id, tractor_id: t.id, customer_id: null, quantity: 1,
      description: `ECU intermittent shutdown during end-of-line test of ${t.serial_number}; unit scrapped, tractor on QC hold`,
      forceStatus: 'open',
    });
  }
}

/**
 * Repair history: serious field failures were usually handled by collecting the tractor
 * from the customer, repairing it at the plant and trucking it back. One recent job is
 * left mid-repair so the workflow has something in progress.
 */
function planServiceJobs(sim, failureRows, rng) {
  const { todayN } = sim;
  const tractorById = new Map(sim.tractors.map((t) => [t.id, t]));
  const partCat = new Map(PART_TYPES.map((p) => [p.part_number, p]));
  const jobs = [];
  let seq = 0;
  const leg = (cust, toPlant, dayN, days, rush, jobId, tractorId, delivered, eta) => ({
    direction: toPlant ? 'service_pickup' : 'service_return', inventory_order_id: null, customer_order_id: null,
    service_job_id: jobId, rush, freight_cost: haulLeg(cust.lat, cust.lng, PLANT.lat, PLANT.lng, !!rush),
    carrier: CARRIERS_OUTBOUND[seq % CARRIERS_OUTBOUND.length],
    tracking_number: `SV${String(Math.floor(rng() * 1e10)).padStart(10, '0')}`,
    origin: toPlant ? `${cust.name} — ${cust.primary_address}` : PLANT.name,
    origin_lat: toPlant ? cust.lat : PLANT.lat, origin_lng: toPlant ? cust.lng : PLANT.lng,
    destination: toPlant ? PLANT.name : `${cust.name} — ${cust.primary_address}`,
    destination_lat: toPlant ? PLANT.lat : cust.lat, destination_lng: toPlant ? PLANT.lng : cust.lng,
    shipped_date: isoDay(dayN), expected_arrival_date: isoDay(eta ?? dayN + days),
    actual_arrival_date: delivered ? isoDay(dayN + days) : null, status: delivered ? 'delivered' : 'in_transit',
    tractor_id: tractorId,
  });
  const job = (f, status, startN) => {
    const t = tractorById.get(f.tractor_id);
    const cust = sim.customers.find((c) => c.id === f.customer_id);
    if (!t || !cust) return null;
    const part = partCat.get(f.part_number);
    const rush = f.severity === 'critical' && rng() < 0.35 ? 1 : 0;
    const days = transitDays(cust.lat, cust.lng, PLANT.lat, PLANT.lng) - (rush ? 1 : 0);
    const repairDays = ['engine', 'transmission', 'cab'].includes(part.category) ? 4 : 2;
    const pickupN = startN + (rush ? 0 : 1);
    const pickedN = pickupN + rng.int(0, 1);
    const repairedN = pickedN + days + repairDays;
    const returnedN = repairedN + days;
    const arrivedN = pickedN + days;
    if (status !== 'completed') status = arrivedN <= todayN ? 'in_repair' : 'in_transit_to_plant';
    seq += 1;
    const id = `SJ-${pad(seq, 5)}`;
    const j = {
      id, tractor_id: t.id, customer_id: cust.id, failure_report_id: f.id, part_number: f.part_number, status, rush,
      pickup_address: cust.primary_address, scheduled_pickup_date: isoDay(pickupN), picked_up_date: isoDay(pickedN),
      repair_complete_date: status === 'completed' ? isoDay(repairedN) : null,
      expected_return_date: isoDay(returnedN), returned_date: status === 'completed' ? isoDay(returnedN) : null,
      haul_cost: 2 * haulLeg(cust.lat, cust.lng, PLANT.lat, PLANT.lng, !!rush),
      repair_labor_cost: status === 'completed' ? repairLabor(part.category) : 0,
      repair_parts_cost: status === 'completed' ? part.unit_cost : 0,
      replacement_part_id: null,
      notes: rush ? 'Rush pickup — customer down during season' : null,
      created_date: f.reported_date,
      shipments: [leg(cust, true, pickedN, days, rush, id, t.id, status === 'completed' || arrivedN <= todayN)],
    };
    if (status === 'completed') j.shipments.push(leg(cust, false, repairedN, days, rush, id, t.id, true));
    return { j, returnedN, startN };
  };
  for (const f of failureRows) {
    if (f.stage !== 'field' || f.status !== 'resolved') continue;
    if (!(f.severity === 'critical' || (f.severity === 'high' && rng() < 0.5))) continue;
    const out = job(f, 'completed', dayNumOf(f.reported_date));
    if (!out || out.returnedN >= todayN) {
      if (out) seq -= 1;
      continue;
    }
    f.resolution = `Collected from site and repaired at plant (${out.j.id})`;
    f.resolved_date = out.j.returned_date;
    jobs.push(out.j);
  }
  // One job currently at the plant for repair.
  const current = [...failureRows].reverse().find((f) => f.stage === 'field' && f.status === 'investigating'
    && ['high', 'critical'].includes(f.severity) && tractorById.get(f.tractor_id)?.status === 'delivered');
  if (current) {
    const out = job(current, 'in_repair', todayN - 6);
    if (out) jobs.push(out.j);
  }
  return jobs;
}

const dayNumOf = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);

const FIELD_RESOLUTIONS = [
  'Replaced under warranty; failed unit returned to supplier for teardown',
  'Field technician repaired on site; root cause logged with supplier',
  'Replaced under warranty; supplier issued credit',
  'Adjusted and re-tested; no part replacement required',
];

export function seedDatabase(db, { today, csvText = readFileSync(DATASET_PATH, 'utf8') } = {}) {
  const sim = simulate({ csvRows: parseCsv(csvText), today, buildBays: DEFAULT_SETTINGS.build_bays });
  injectScenarios(sim);
  const { todayN } = sim;
  const rng = makeRng(99);
  const d = (n) => (n === null || n === undefined ? null : isoDay(n));

  const failures = [...sim.failures].sort((a, b) => a.dayN - b.dayN);
  const failureRows = failures.map((f, i) => {
    const age = todayN - f.dayN;
    let status = 'resolved';
    if (f.forceStatus) status = f.forceStatus;
    else if (f.stage === 'field') status = age <= 14 ? 'open' : age <= 45 ? (rng() < 0.6 ? 'investigating' : 'resolved') : 'resolved';
    else if (f.stage === 'receiving') status = age <= 10 ? 'open' : 'resolved';
    else status = age <= 5 ? 'investigating' : 'resolved';
    const resolvedN = status === 'resolved' ? Math.min(todayN - 1, f.dayN + (f.stage === 'field' ? rng.int(2, 21) : rng.int(0, 3))) : null;
    const resolution = status !== 'resolved' ? null
      : f.stage === 'field' ? rng.pick(FIELD_RESOLUTIONS)
        : f.stage === 'receiving' ? 'Rejected units returned to supplier for credit'
          : 'Unit scrapped; replacement installed on the line';
    return {
      id: `FR-${pad(i + 1, 5)}`, reported_date: d(f.dayN), stage: f.stage, failure_class: f.failure_class,
      severity: f.severity, part_number: f.part_number, supplier_id: f.supplier_id,
      inventory_part_id: f.inventory_part_id, inventory_order_id: f.inventory_order_id,
      tractor_id: f.tractor_id, customer_id: f.customer_id, quantity: f.quantity, description: f.description,
      status, resolution, resolved_date: d(resolvedN),
    };
  });
  const serviceJobs = planServiceJobs(sim, failureRows, rng);

  tx(db, () => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setSetting(db, k, v);
    setSetting(db, 'seed_date', today);
    setSetting(db, 'schema_version', SCHEMA_VERSION);
    setSetting(db, 'dataset_year_shift', sim.yearShift);
    setSetting(db, 'dataset_rows_used', sim.rows.length);

    insertMany(db, 'warehouses', WAREHOUSES);
    insertMany(db, 'customers', sim.customers.map(({ weight, ...c }) => c));
    insertMany(db, 'suppliers', SUPPLIERS.map(({ delayFactor, failureFactor, ...s }) => ({ ...s, reliability_score: null })));
    insertMany(db, 'tractor_models', TRACTOR_MODELS);
    insertMany(db, 'part_types', PART_TYPES.map(({ failureRate, suppliers, ...p }) => p));
    insertMany(db, 'bom_items', Object.entries(BOM).flatMap(([model_number, items]) =>
      items.map(([part_number, quantity]) => ({ model_number, part_number, quantity }))));
    insertMany(db, 'supplier_parts', PART_TYPES.flatMap((p) => p.suppliers.map((sid, i) => ({
      supplier_id: sid,
      part_number: p.part_number,
      is_primary: i === 0 ? 1 : 0,
      unit_cost: Math.round(p.unit_cost * (i === 0 ? 1 : 1.06) * 1.11 * 100) / 100,
      quoted_lead_days: SUPPLIERS.find((s) => s.id === sid).quoted_lead_days,
    }))));

    insertMany(db, 'customer_orders', sim.orders.map((o) => ({
      id: o.id,
      customer_id: o.customer.id,
      model_number: o.model,
      quantity: o.qty,
      status: deriveOrderStatus(o, o.tractors),
      submission_date: d(o.subN),
      expected_delivery_date: d(o.expN),
      actual_delivery_date: d(o.actN),
      delivery_address: o.delivery_address,
      region: o.region,
      unit_price: o.unit_price,
      priority: o.priority ?? 'normal',
      notes: o.notes,
    })));

    insertMany(db, 'inventory_orders', sim.pos.map((po) => ({
      id: po.id,
      part_number: po.part_number,
      supplier_id: po.supplier_id,
      quantity: po.quantity,
      quantity_received: po.quantity_received,
      quantity_rejected: po.quantity_rejected,
      unit_cost: po.unit_cost,
      status: po.arrived ? 'received' : po.shippedN < todayN ? 'in_transit' : po.subN + 2 <= todayN ? 'confirmed' : 'submitted',
      submission_date: d(po.subN),
      expected_delivery_date: d(po.expN),
      actual_delivery_date: po.arrived ? d(po.actN) : null,
      delivery_address: PLANT.address,
      warehouse_id: PLANT.id,
      source: po.source,
      rush: po.rush ?? 0,
      rush_premium: po.rush_premium ?? 0,
      notes: null,
    })));

    insertMany(db, 'tractors', sim.tractors.map((t) => ({
      id: t.id,
      serial_number: t.serial_number,
      model_number: t.model_number,
      lot_number: t.lot_number,
      status: serviceJobs.find((j) => j.tractor_id === t.id && j.status !== 'completed') ? 'in_repair' : t.status,
      customer_order_id: t.order ? t.order.id : null,
      warehouse_id: PLANT.id,
      build_start_date: d(t.buildN),
      build_complete_date: d(t.completeN),
      ship_date: d(t.shipN),
      delivered_date: d(t.deliveredN),
      hold_part_number: t.hold,
      failure_factor: Math.round(t.failMult * 100) / 100,
    })));

    insertMany(db, 'inventory_parts', sim.inventoryParts.map((ip) => ({
      id: ip.id,
      part_number: ip.part_number,
      serial_number: ip.serial_number,
      lot_number: ip.lot_number,
      supplier_id: ip.supplier_id,
      inventory_order_id: ip.inventory_order_id,
      warehouse_id: PLANT.id,
      quantity: ip.quantity,
      quantity_on_hand: ip.quantity_on_hand,
      status: ip.status,
      tractor_id: ip.tractor_id,
      received_date: d(ip.receivedN),
    })));

    insertMany(db, 'tractor_parts', sim.tractorParts.map((tp) => ({
      tractor_id: tp.tractor_id,
      inventory_part_id: tp.inventory_part_id,
      part_number: tp.part_number,
      quantity: tp.quantity,
      installed_date: d(tp.installedN),
    })));

    // Shipments: outbound tractors, plus inbound parts for every PO that has left the supplier.
    let shipSeq = sim.shipments.length;
    const inbound = [];
    for (const po of sim.pos) {
      if (po.shippedN >= todayN) continue;
      const sup = SUPPLIERS.find((s) => s.id === po.supplier_id);
      shipSeq += 1;
      inbound.push({
        id: `SH-${pad(shipSeq, 5)}`, direction: 'inbound', inventory_order_id: po.id, customer_order_id: null,
        carrier: rng.pick(CARRIERS_INBOUND),
        tracking_number: `${rng.pick(['IL', 'CF', 'NS'])}${Math.floor(rng() * 1e10).toString().padStart(10, '0')}`,
        origin: `${sup.name}, ${sup.city}, ${sup.state}`, origin_lat: sup.lat, origin_lng: sup.lng,
        destination: PLANT.name, destination_lat: PLANT.lat, destination_lng: PLANT.lng,
        shipped_date: d(po.shippedN), expected_arrival_date: d(po.arrivalN),
        actual_arrival_date: po.arrived ? d(po.actN) : null,
        status: po.arrived ? 'delivered' : 'in_transit',
        rush: po.rush, freight_cost: 0,
      });
    }
    const outbound = sim.shipments.map((sh) => ({
      id: sh.id, direction: 'outbound', inventory_order_id: null, customer_order_id: sh.customer_order_id,
      carrier: sh.carrier, tracking_number: sh.tracking_number,
      origin: sh.origin, origin_lat: sh.origin_lat, origin_lng: sh.origin_lng,
      destination: sh.destination, destination_lat: sh.destination_lat, destination_lng: sh.destination_lng,
      shipped_date: d(sh.shippedN), expected_arrival_date: d(sh.etaN),
      actual_arrival_date: sh.delivered ? d(sh.arrivalN) : null,
      status: sh.delivered ? 'delivered' : 'in_transit',
      rush: sh.rush,
      freight_cost: sh.freight_cost,
    }));
    insertMany(db, 'shipments', [...outbound, ...inbound]);
    insertMany(db, 'shipment_tractors', sim.shipments.flatMap((sh) => sh.tractors.map((t) => ({ shipment_id: sh.id, tractor_id: t.id }))));

    insertMany(db, 'failure_reports', failureRows);
    insertMany(db, 'service_jobs', serviceJobs.map(({ shipments, ...j }) => j));
    let svcSeq = shipSeq;
    const svcShipments = serviceJobs.flatMap((j) => j.shipments.map((sh) => ({ ...sh, id: `SH-${pad(++svcSeq, 5)}` })));
    insertMany(db, 'shipments', svcShipments.map(({ tractor_id, ...sh }) => sh));
    insertMany(db, 'shipment_tractors', svcShipments.map((sh) => ({ shipment_id: sh.id, tractor_id: sh.tractor_id })));

    insertMany(db, 'market_signals', sim.signals);
    logActivity(db, 'seed', 'system', 'seed', `Seeded prototype data as of ${today} from ${sim.rows.length} dataset rows (shifted +${sim.yearShift}y)`);
  });

  return {
    orders: sim.orders.length, tractors: sim.tractors.length, inventoryOrders: sim.pos.length,
    inventoryParts: sim.inventoryParts.length, failures: sim.failures.length, shipments: sim.shipments.length,
  };
}

