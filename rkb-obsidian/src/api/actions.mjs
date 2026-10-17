// Write operations behind the portal's buttons. Each keeps inventory accounting
// consistent (parts are allocated to tractors, tractors to orders, shipments to both)
// and records an activity log entry.

import { tx, logActivity, getSetting } from '../db/index.mjs';
import { dayNum, isoDay, addDays, isoWeek, transitDays, pad } from '../lib/util.mjs';
import { CARRIERS_INBOUND, CARRIERS_OUTBOUND } from '../seed/catalog.mjs';
import { ACTIVE_ORDER_STATUSES } from '../models/inventoryPlan.mjs';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const notFound = (what, id) => new ApiError(404, `${what} ${id} not found`);

function nextId(db, table, prefix, width) {
  const row = db.prepare(`SELECT id FROM ${table} WHERE id LIKE ? ORDER BY id DESC LIMIT 1`).get(`${prefix}%`);
  const n = row ? Number(row.id.slice(prefix.length)) + 1 : 1;
  return `${prefix}${pad(n, width)}`;
}

function nextGlobalSeq(db, table, column, prefixLen) {
  const row = db.prepare(`SELECT MAX(CAST(substr(${column}, ${prefixLen + 1}) AS INTEGER)) AS n FROM ${table}`).get();
  return (row.n ?? 0) + 1;
}

const trackingNumber = (prefix) => `${prefix}${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`;
const plantOf = (db) => db.prepare('SELECT * FROM warehouses WHERE is_plant = 1').get();

export function refreshOrderStatus(db, orderId, today) {
  const o = db.prepare('SELECT * FROM customer_orders WHERE id = ?').get(orderId);
  if (!o || o.status === 'cancelled') return;
  const ts = db.prepare('SELECT status, delivered_date FROM tractors WHERE customer_order_id = ?').all(orderId);
  const delivered = ts.filter((t) => t.status === 'delivered').length;
  let status = 'received';
  if (delivered >= o.quantity) status = 'delivered';
  else if (delivered > 0) status = 'partially_delivered';
  else if (ts.some((t) => t.status === 'shipping')) status = 'shipping';
  else if (ts.length >= o.quantity && ts.every((t) => t.status === 'earmarked')) status = 'ready';
  else if (ts.length > 0) status = 'in_production';
  db.prepare('UPDATE customer_orders SET status = ?, actual_delivery_date = ? WHERE id = ?')
    .run(status, status === 'delivered' ? (o.actual_delivery_date ?? today) : null, orderId);
}

// ---- Purchasing --------------------------------------------------------------------

export function placeInventoryOrder(db, today, { partNumber, supplierId, quantity, source = 'manual', notes = null }) {
  const qty = Number(quantity);
  if (!partNumber || !supplierId || !(qty > 0)) throw new ApiError(400, 'partNumber, supplierId and a positive quantity are required');
  const sp = db.prepare('SELECT * FROM supplier_parts WHERE part_number = ? AND supplier_id = ?').get(partNumber, supplierId);
  if (!sp) throw new ApiError(400, `${supplierId} does not supply ${partNumber}`);
  const plant = plantOf(db);
  return tx(db, () => {
    const id = `PO-${today.slice(0, 4)}-${pad(nextGlobalSeq(db, 'inventory_orders', 'id', 8), 5)}`;
    db.prepare(`INSERT INTO inventory_orders (id, part_number, supplier_id, quantity, unit_cost, status, submission_date,
      expected_delivery_date, delivery_address, warehouse_id, source, notes) VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?)`)
      .run(id, partNumber, supplierId, qty, sp.unit_cost, today, addDays(today, sp.quoted_lead_days), plant.address, plant.id, source, notes);
    logActivity(db, 'place_po', 'inventory_order', id, `Placed ${id}: ${qty} × ${partNumber} from ${supplierId}${source === 'model_recommendation' ? ' (model recommendation)' : ''}`);
    return { id };
  });
}

export function markInventoryOrderShipped(db, today, id) {
  const po = db.prepare('SELECT * FROM inventory_orders WHERE id = ?').get(id);
  if (!po) throw notFound('Inventory order', id);
  if (!['submitted', 'confirmed'].includes(po.status)) throw new ApiError(409, `${id} is ${po.status}`);
  const sup = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(po.supplier_id);
  const plant = plantOf(db);
  return tx(db, () => {
    const shId = nextId(db, 'shipments', 'SH-', 5);
    const eta = addDays(today, transitDays(sup.lat, sup.lng, plant.lat, plant.lng));
    db.prepare(`INSERT INTO shipments (id, direction, inventory_order_id, carrier, tracking_number, origin, origin_lat, origin_lng,
      destination, destination_lat, destination_lng, shipped_date, expected_arrival_date, status)
      VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_transit')`)
      .run(shId, id, CARRIERS_INBOUND[Math.floor(Math.random() * CARRIERS_INBOUND.length)], trackingNumber('IL'),
        `${sup.name}, ${sup.city}, ${sup.state}`, sup.lat, sup.lng, plant.name, plant.lat, plant.lng, today, eta);
    db.prepare("UPDATE inventory_orders SET status = 'in_transit' WHERE id = ?").run(id);
    logActivity(db, 'ship_po', 'inventory_order', id, `${sup.name} shipped ${id} (${shId}), ETA ${eta}`);
    return { id, shipmentId: shId, eta };
  });
}

export function receiveInventoryOrder(db, today, id, { rejected = 0, note = null } = {}) {
  const po = db.prepare('SELECT * FROM inventory_orders WHERE id = ?').get(id);
  if (!po) throw notFound('Inventory order', id);
  if (!['submitted', 'confirmed', 'in_transit'].includes(po.status)) throw new ApiError(409, `${id} is already ${po.status}`);
  const part = db.prepare('SELECT * FROM part_types WHERE part_number = ?').get(po.part_number);
  const remaining = po.quantity - po.quantity_received - po.quantity_rejected;
  const bad = Math.min(remaining, Math.max(0, Number(rejected) || 0));
  const good = remaining - bad;
  return tx(db, () => {
    const lot = `${po.supplier_id.slice(-1)}${today.slice(2).replaceAll('-', '')}-${po.part_number.replace('-', '')}`;
    let ipSeq = nextGlobalSeq(db, 'inventory_parts', 'id', 3);
    const insert = db.prepare(`INSERT INTO inventory_parts (id, part_number, serial_number, lot_number, supplier_id, inventory_order_id,
      warehouse_id, quantity, quantity_on_hand, status, received_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const created = [];
    let firstRejected = null;
    if (part.serialized) {
      let serialSeq = db.prepare('SELECT COUNT(*) AS n FROM inventory_parts WHERE part_number = ? AND supplier_id = ?').get(po.part_number, po.supplier_id).n;
      for (let i = 0; i < remaining; i++) {
        serialSeq += 1;
        const ipId = `IP-${pad(ipSeq++, 6)}`;
        const isBad = i >= good;
        const serial = `${po.supplier_id.slice(-1)}${po.part_number.replace('-', '')}-${today.slice(2, 4)}${pad(serialSeq, 5)}`;
        insert.run(ipId, po.part_number, serial, lot, po.supplier_id, id, po.warehouse_id, 1, isBad ? 0 : 1, isBad ? 'rejected' : 'in_stock', today);
        created.push(ipId);
        if (isBad) firstRejected ??= ipId;
      }
    } else {
      const ipId = `IP-${pad(ipSeq++, 6)}`;
      insert.run(ipId, po.part_number, null, lot, po.supplier_id, id, po.warehouse_id, remaining, good, good ? 'in_stock' : 'rejected', today);
      created.push(ipId);
      if (bad) firstRejected = ipId;
    }
    db.prepare(`UPDATE inventory_orders SET status = 'received', quantity_received = quantity_received + ?,
      quantity_rejected = quantity_rejected + ?, actual_delivery_date = ? WHERE id = ?`).run(good, bad, today, id);
    db.prepare("UPDATE shipments SET status = 'delivered', actual_arrival_date = ? WHERE inventory_order_id = ? AND status = 'in_transit'").run(today, id);
    if (bad) {
      const frId = nextId(db, 'failure_reports', 'FR-', 5);
      db.prepare(`INSERT INTO failure_reports (id, reported_date, stage, failure_class, severity, part_number, supplier_id,
        inventory_part_id, inventory_order_id, quantity, description, status) VALUES (?, ?, 'receiving', 'Failed Inspection', ?, ?, ?, ?, ?, ?, ?, 'open')`)
        .run(frId, today, bad > 3 ? 'medium' : 'low', po.part_number, po.supplier_id, firstRejected, id, bad,
          note || `${bad} of ${remaining} units rejected at receiving inspection (${id})`);
    }
    logActivity(db, 'receive_po', 'inventory_order', id, `Received ${id}: ${good} × ${po.part_number} into stock${bad ? `, ${bad} rejected` : ''}`);
    return { id, received: good, rejected: bad, inventoryParts: created };
  });
}

// ---- Production --------------------------------------------------------------------

/** FIFO allocation plan for a set of BOM lines; returns { ok, short: [{partNumber, need, available}] }. */
function checkParts(db, model, count) {
  const lines = db.prepare(`SELECT b.part_number, b.quantity, v.available FROM bom_items b
    JOIN v_part_balances v ON v.part_number = b.part_number WHERE b.model_number = ?`).all(model);
  const short = lines.filter((l) => l.available < l.quantity * count)
    .map((l) => ({ partNumber: l.part_number, need: l.quantity * count, available: l.available }));
  return { lines, short };
}

function installPart(db, tractorId, partNumber, qty, today) {
  const lots = db.prepare(`SELECT * FROM inventory_parts WHERE part_number = ? AND status = 'in_stock' AND quantity_on_hand > 0
    ORDER BY received_date, id`).all(partNumber);
  let need = qty;
  const upsert = db.prepare(`INSERT INTO tractor_parts (tractor_id, inventory_part_id, part_number, quantity, installed_date)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(tractor_id, inventory_part_id) DO UPDATE SET quantity = quantity + excluded.quantity`);
  for (const ip of lots) {
    if (need === 0) break;
    const take = Math.min(need, ip.quantity_on_hand);
    need -= take;
    const left = ip.quantity_on_hand - take;
    if (ip.serial_number) {
      db.prepare("UPDATE inventory_parts SET quantity_on_hand = 0, status = 'installed', tractor_id = ? WHERE id = ?").run(tractorId, ip.id);
    } else {
      db.prepare('UPDATE inventory_parts SET quantity_on_hand = ?, status = ? WHERE id = ?').run(left, left ? 'in_stock' : 'consumed', ip.id);
    }
    upsert.run(tractorId, ip.id, partNumber, take, today);
  }
  if (need > 0) throw new ApiError(409, `Not enough ${partNumber} on hand`);
}

export function startBuilds(db, today, { orderId = null, model = null, count = 1 }) {
  let n = Number(count) || 1;
  let order = null;
  if (orderId) {
    order = db.prepare('SELECT * FROM customer_orders WHERE id = ?').get(orderId);
    if (!order) throw notFound('Order', orderId);
    if (!ACTIVE_ORDER_STATUSES.includes(order.status)) throw new ApiError(409, `${orderId} is ${order.status}`);
    model = order.model_number;
    const assigned = db.prepare('SELECT COUNT(*) AS n FROM tractors WHERE customer_order_id = ?').get(orderId).n;
    n = Math.min(n, order.quantity - assigned);
    if (n <= 0) throw new ApiError(409, `${orderId} already has all its tractors assigned`);
  }
  if (!db.prepare('SELECT 1 FROM tractor_models WHERE model_number = ?').get(model)) throw new ApiError(400, `Unknown model ${model}`);
  const bays = Number(getSetting(db, 'build_bays', 3));
  const busy = db.prepare('SELECT COUNT(*) AS n FROM tractors WHERE build_start_date = ?').get(today).n;
  if (busy + n > bays) throw new ApiError(409, `Only ${Math.max(0, bays - busy)} of ${bays} build bays free today`);
  const { lines, short } = checkParts(db, model, n);
  if (short.length) throw new ApiError(409, `Not enough parts to build ${n} × ${model}`, { short });

  return tx(db, () => {
    const created = [];
    const yy = today.slice(2, 4);
    const ww = pad(isoWeek(dayNum(today)), 2);
    for (let i = 0; i < n; i++) {
      const seq = nextGlobalSeq(db, 'tractors', 'id', 2);
      const id = `T-${pad(seq, 5)}`;
      const serial = `RKB-${model.replace('-', '')}-${yy}${ww}-${pad(seq, 5)}`;
      db.prepare(`INSERT INTO tractors (id, serial_number, model_number, lot_number, status, customer_order_id, warehouse_id, build_start_date)
        VALUES (?, ?, ?, ?, 'in_production', ?, ?, ?)`)
        .run(id, serial, model, `B${yy}W${ww}-${model.replace('-', '')}`, orderId, plantOf(db).id, today);
      for (const l of lines) installPart(db, id, l.part_number, l.quantity, today);
      created.push({ id, serial });
    }
    if (orderId) refreshOrderStatus(db, orderId, today);
    logActivity(db, 'start_build', 'tractor', created.map((c) => c.id).join(','),
      `Started ${n} × ${model} build${n > 1 ? 's' : ''}${orderId ? ` for ${orderId}` : ' to stock'}: ${created.map((c) => c.serial).join(', ')}`);
    return { tractors: created };
  });
}

export function completeBuild(db, today, tractorId) {
  const t = db.prepare('SELECT * FROM tractors WHERE id = ?').get(tractorId);
  if (!t) throw notFound('Tractor', tractorId);
  if (t.status !== 'in_production') throw new ApiError(409, `${t.serial_number} is ${t.status}`);
  return tx(db, () => {
    db.prepare('UPDATE tractors SET status = ?, build_complete_date = ? WHERE id = ?')
      .run(t.customer_order_id ? 'earmarked' : 'inventoried', today, tractorId);
    if (t.customer_order_id) refreshOrderStatus(db, t.customer_order_id, today);
    logActivity(db, 'complete_build', 'tractor', tractorId, `${t.serial_number} passed QC`);
    return { id: tractorId };
  });
}

export function clearHold(db, today, tractorId) {
  const t = db.prepare('SELECT * FROM tractors WHERE id = ?').get(tractorId);
  if (!t) throw notFound('Tractor', tractorId);
  if (t.status !== 'qc_hold') throw new ApiError(409, `${t.serial_number} is not on QC hold`);
  return tx(db, () => {
    installPart(db, tractorId, t.hold_part_number, 1, today);
    db.prepare('UPDATE tractors SET status = ?, hold_part_number = NULL, build_complete_date = ? WHERE id = ?')
      .run(t.customer_order_id ? 'earmarked' : 'inventoried', today, tractorId);
    db.prepare(`UPDATE failure_reports SET status = 'resolved', resolved_date = ?, resolution = 'Replacement installed and re-tested'
      WHERE tractor_id = ? AND part_number = ? AND stage = 'manufacturing' AND status != 'resolved'`).run(today, tractorId, t.hold_part_number);
    if (t.customer_order_id) refreshOrderStatus(db, t.customer_order_id, today);
    logActivity(db, 'clear_hold', 'tractor', tractorId, `Installed replacement ${t.hold_part_number} in ${t.serial_number}; released from QC hold`);
    return { id: tractorId };
  });
}

export function earmarkTractor(db, today, tractorId, { orderId }) {
  const t = db.prepare('SELECT * FROM tractors WHERE id = ?').get(tractorId);
  if (!t) throw notFound('Tractor', tractorId);
  const o = db.prepare('SELECT * FROM customer_orders WHERE id = ?').get(orderId);
  if (!o) throw notFound('Order', orderId);
  if (t.customer_order_id) throw new ApiError(409, `${t.serial_number} is already earmarked to ${t.customer_order_id}`);
  if (!['inventoried', 'in_production', 'qc_hold'].includes(t.status)) throw new ApiError(409, `${t.serial_number} is ${t.status}`);
  if (t.model_number !== o.model_number) throw new ApiError(400, `${orderId} is for ${o.model_number}, tractor is ${t.model_number}`);
  if (!ACTIVE_ORDER_STATUSES.includes(o.status)) throw new ApiError(409, `${orderId} is ${o.status}`);
  const assigned = db.prepare('SELECT COUNT(*) AS n FROM tractors WHERE customer_order_id = ?').get(orderId).n;
  if (assigned >= o.quantity) throw new ApiError(409, `${orderId} already has all ${o.quantity} tractors`);
  return tx(db, () => {
    db.prepare('UPDATE tractors SET customer_order_id = ?, status = ? WHERE id = ?')
      .run(orderId, t.status === 'inventoried' ? 'earmarked' : t.status, tractorId);
    refreshOrderStatus(db, orderId, today);
    logActivity(db, 'earmark', 'tractor', tractorId, `Earmarked ${t.serial_number} to ${orderId}`);
    return { id: tractorId, orderId };
  });
}

// ---- Fulfilment --------------------------------------------------------------------

export function shipOrder(db, today, orderId) {
  const o = db.prepare('SELECT o.*, c.name AS customer_name, c.lat, c.lng FROM customer_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?').get(orderId);
  if (!o) throw notFound('Order', orderId);
  const ready = db.prepare("SELECT * FROM tractors WHERE customer_order_id = ? AND status = 'earmarked'").all(orderId);
  if (!ready.length) throw new ApiError(409, `${orderId} has no finished tractors ready to ship`);
  const plant = plantOf(db);
  return tx(db, () => {
    const shId = nextId(db, 'shipments', 'SH-', 5);
    const eta = addDays(today, transitDays(plant.lat, plant.lng, o.lat, o.lng));
    db.prepare(`INSERT INTO shipments (id, direction, customer_order_id, carrier, tracking_number, origin, origin_lat, origin_lng,
      destination, destination_lat, destination_lng, shipped_date, expected_arrival_date, status)
      VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_transit')`)
      .run(shId, orderId, CARRIERS_OUTBOUND[Math.floor(Math.random() * CARRIERS_OUTBOUND.length)], trackingNumber('HF'),
        plant.name, plant.lat, plant.lng, `${o.customer_name} — ${o.delivery_address}`, o.lat, o.lng, today, eta);
    for (const t of ready) {
      db.prepare("UPDATE tractors SET status = 'shipping', ship_date = ? WHERE id = ?").run(today, t.id);
      db.prepare('INSERT INTO shipment_tractors (shipment_id, tractor_id) VALUES (?, ?)').run(shId, t.id);
    }
    refreshOrderStatus(db, orderId, today);
    logActivity(db, 'ship_order', 'customer_order', orderId, `Shipped ${ready.length} tractor(s) on ${orderId} to ${o.customer_name} (${shId}), ETA ${eta}`);
    return { shipmentId: shId, eta, tractors: ready.map((t) => t.id) };
  });
}

export function deliverShipment(db, today, shipmentId) {
  const sh = db.prepare('SELECT * FROM shipments WHERE id = ?').get(shipmentId);
  if (!sh) throw notFound('Shipment', shipmentId);
  if (sh.status !== 'in_transit') throw new ApiError(409, `${shipmentId} is ${sh.status}`);
  if (sh.direction === 'inbound') return receiveInventoryOrder(db, today, sh.inventory_order_id);
  return tx(db, () => {
    db.prepare("UPDATE shipments SET status = 'delivered', actual_arrival_date = ? WHERE id = ?").run(today, shipmentId);
    db.prepare(`UPDATE tractors SET status = 'delivered', delivered_date = ?
      WHERE id IN (SELECT tractor_id FROM shipment_tractors WHERE shipment_id = ?)`).run(today, shipmentId);
    refreshOrderStatus(db, sh.customer_order_id, today);
    logActivity(db, 'deliver', 'shipment', shipmentId, `${shipmentId} delivered (${sh.customer_order_id})`);
    return { id: shipmentId };
  });
}

export function createOrder(db, today, { customerId, model, quantity, expectedDeliveryDate, deliveryAddress, notes }) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!c) throw new ApiError(400, 'Choose a customer');
  const m = db.prepare('SELECT * FROM tractor_models WHERE model_number = ?').get(model);
  if (!m) throw new ApiError(400, 'Choose a tractor model');
  const qty = Number(quantity);
  if (!(qty >= 1 && qty <= 50)) throw new ApiError(400, 'Quantity must be 1-50');
  if (!expectedDeliveryDate || expectedDeliveryDate <= today) throw new ApiError(400, 'Expected delivery date must be in the future');
  return tx(db, () => {
    const id = nextId(db, 'customer_orders', `SO-${today.slice(0, 4)}-`, 4);
    db.prepare(`INSERT INTO customer_orders (id, customer_id, model_number, quantity, status, submission_date, expected_delivery_date,
      delivery_address, region, unit_price, notes) VALUES (?, ?, ?, ?, 'received', ?, ?, ?, ?, ?, ?)`)
      .run(id, customerId, model, qty, today, expectedDeliveryDate, deliveryAddress || c.primary_address, c.region, m.list_price, notes || null);
    logActivity(db, 'create_order', 'customer_order', id, `New order ${id}: ${qty} × ${model} for ${c.name}, due ${expectedDeliveryDate}`);
    return { id };
  });
}

export function cancelOrder(db, today, orderId) {
  const o = db.prepare('SELECT * FROM customer_orders WHERE id = ?').get(orderId);
  if (!o) throw notFound('Order', orderId);
  const moving = db.prepare("SELECT COUNT(*) AS n FROM tractors WHERE customer_order_id = ? AND status IN ('shipping', 'delivered')").get(orderId).n;
  if (moving) throw new ApiError(409, `${orderId} has tractors already shipped`);
  return tx(db, () => {
    db.prepare("UPDATE tractors SET customer_order_id = NULL, status = CASE status WHEN 'earmarked' THEN 'inventoried' ELSE status END WHERE customer_order_id = ?").run(orderId);
    db.prepare("UPDATE customer_orders SET status = 'cancelled' WHERE id = ?").run(orderId);
    logActivity(db, 'cancel_order', 'customer_order', orderId, `Cancelled ${orderId}; its tractors returned to stock`);
    return { id: orderId };
  });
}

// ---- Quality -----------------------------------------------------------------------

export function createFailure(db, today, input) {
  const { stage, failureClass, severity = 'medium', description, tractorId, inventoryPartId } = input;
  let { partNumber, supplierId } = input;
  if (!['receiving', 'manufacturing', 'field'].includes(stage)) throw new ApiError(400, 'stage must be receiving, manufacturing or field');
  if (!description) throw new ApiError(400, 'Describe the failure');
  let ip = inventoryPartId ? db.prepare('SELECT * FROM inventory_parts WHERE id = ?').get(inventoryPartId) : null;
  let tractor = null;
  let customerId = null;
  if (tractorId) {
    tractor = db.prepare('SELECT t.*, o.customer_id FROM tractors t LEFT JOIN customer_orders o ON o.id = t.customer_order_id WHERE t.id = ? OR t.serial_number = ?').get(tractorId, tractorId);
    if (!tractor) throw notFound('Tractor', tractorId);
    customerId = tractor.status === 'delivered' || tractor.status === 'shipping' ? tractor.customer_id : null;
    if (!ip && partNumber) {
      ip = db.prepare(`SELECT ip.* FROM tractor_parts tp JOIN inventory_parts ip ON ip.id = tp.inventory_part_id
        WHERE tp.tractor_id = ? AND tp.part_number = ? LIMIT 1`).get(tractor.id, partNumber);
    }
  }
  if (ip) {
    partNumber = ip.part_number;
    supplierId = ip.supplier_id;
  }
  if (!partNumber || !supplierId) throw new ApiError(400, 'Identify the part (and supplier, if not linked to a tractor or inventory part)');
  return tx(db, () => {
    const id = nextId(db, 'failure_reports', 'FR-', 5);
    db.prepare(`INSERT INTO failure_reports (id, reported_date, stage, failure_class, severity, part_number, supplier_id, inventory_part_id,
      inventory_order_id, tractor_id, customer_id, quantity, description, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'open')`)
      .run(id, today, stage, failureClass || 'Unclassified', severity, partNumber, supplierId, ip?.id ?? null,
        ip?.inventory_order_id ?? null, tractor?.id ?? null, customerId, description);
    logActivity(db, 'log_failure', 'failure_report', id, `Logged ${stage} failure ${id} on ${partNumber} (${supplierId})`);
    return { id };
  });
}

export function setFailureStatus(db, today, id, { status, resolution }) {
  if (!['open', 'investigating', 'resolved'].includes(status)) throw new ApiError(400, 'Invalid status');
  const f = db.prepare('SELECT * FROM failure_reports WHERE id = ?').get(id);
  if (!f) throw notFound('Failure report', id);
  return tx(db, () => {
    db.prepare('UPDATE failure_reports SET status = ?, resolution = ?, resolved_date = ? WHERE id = ?')
      .run(status, status === 'resolved' ? (resolution || f.resolution || 'Resolved') : f.resolution, status === 'resolved' ? today : null, id);
    logActivity(db, 'failure_status', 'failure_report', id, `${id} → ${status}`);
    return { id, status };
  });
}

// ---- Misc --------------------------------------------------------------------------

export function setTaskState(db, today, key, { status, days = 1 }) {
  if (!['done', 'snoozed', 'open'].includes(status)) throw new ApiError(400, 'Invalid task status');
  if (status === 'open') {
    db.prepare('DELETE FROM task_state WHERE task_key = ?').run(key);
    return { key, status };
  }
  db.prepare(`INSERT INTO task_state (task_key, status, until_date, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(task_key) DO UPDATE SET status = excluded.status, until_date = excluded.until_date, updated_at = excluded.updated_at`)
    .run(key, status, status === 'snoozed' ? isoDay(dayNum(today) + Number(days)) : null, new Date().toISOString());
  return { key, status };
}

export const EDITABLE_SETTINGS = {
  build_bays: (v) => Number.isInteger(+v) && +v >= 1 && +v <= 20,
  planning_horizon_days: (v) => Number.isInteger(+v) && +v >= 30 && +v <= 180,
  forecast_service_level: (v) => ['p50', 'p75', 'p90'].includes(v),
  safety_stock_days: (v) => Number.isInteger(+v) && +v >= 0 && +v <= 60,
  receiving_days: (v) => Number.isInteger(+v) && +v >= 0 && +v <= 14,
};

export function updateSettings(db, body) {
  const changed = {};
  for (const [k, v] of Object.entries(body)) {
    if (!EDITABLE_SETTINGS[k]) throw new ApiError(400, `Unknown setting ${k}`);
    if (!EDITABLE_SETTINGS[k](v)) throw new ApiError(400, `Invalid value for ${k}`);
    changed[k] = String(v);
  }
  tx(db, () => {
    for (const [k, v] of Object.entries(changed)) {
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(v, k);
    }
    logActivity(db, 'settings', 'settings', 'planning', `Planning settings changed: ${Object.entries(changed).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  });
  return changed;
}
