// Write operations behind the portal's buttons. Each keeps inventory accounting
// consistent (parts are allocated to tractors, tractors to orders, shipments to both)
// and records an activity log entry.

import { tx, logActivity, getSetting } from '../db/index.mjs';
import { dayNum, isoDay, addDays, isoWeek, transitDays, pad } from '../lib/util.mjs';
import { CARRIERS_INBOUND, CARRIERS_OUTBOUND } from '../seed/catalog.mjs';
import { RUSH_PREMIUM, rushLeadDays, tractorFreight, haulLeg, repairLabor } from '../lib/costs.mjs';
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

export function placeInventoryOrder(db, today, { partNumber, supplierId, quantity, source = 'manual', notes = null, rush = false }) {
  const qty = Number(quantity);
  if (!partNumber || !supplierId || !(qty > 0)) throw new ApiError(400, 'partNumber, supplierId and a positive quantity are required');
  const sp = db.prepare('SELECT * FROM supplier_parts WHERE part_number = ? AND supplier_id = ?').get(partNumber, supplierId);
  if (!sp) throw new ApiError(400, `${supplierId} does not supply ${partNumber}`);
  const plant = plantOf(db);
  return tx(db, () => {
    const id = `PO-${today.slice(0, 4)}-${pad(nextGlobalSeq(db, 'inventory_orders', 'id', 8), 5)}`;
    const lead = rush ? rushLeadDays(sp.quoted_lead_days) : sp.quoted_lead_days;
    const premium = rush ? Math.round(qty * sp.unit_cost * RUSH_PREMIUM * 100) / 100 : 0;
    db.prepare(`INSERT INTO inventory_orders (id, part_number, supplier_id, quantity, unit_cost, status, submission_date,
      expected_delivery_date, delivery_address, warehouse_id, source, rush, rush_premium, notes)
      VALUES (?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, partNumber, supplierId, qty, sp.unit_cost, today, addDays(today, lead), plant.address, plant.id, source, rush ? 1 : 0, premium, notes);
    logActivity(db, 'place_po', 'inventory_order', id, `Placed ${rush ? 'RUSH ' : ''}${id}: ${qty} × ${partNumber} from ${supplierId}`
      + `${source === 'model_recommendation' ? ' (model recommendation)' : ''}${rush ? `, +$${premium.toLocaleString('en-US')} premium` : ''}`);
    return { id, rush: !!rush, premium, expected: addDays(today, lead) };
  });
}

/** Convert an open order that hasn't shipped yet into a rush order (15% premium on what's outstanding). */
export function expediteInventoryOrder(db, today, id) {
  const po = db.prepare('SELECT * FROM inventory_orders WHERE id = ?').get(id);
  if (!po) throw notFound('Inventory order', id);
  if (!['submitted', 'confirmed'].includes(po.status)) throw new ApiError(409, `${id} is ${po.status}; only orders that haven't shipped can be expedited`);
  if (po.rush) throw new ApiError(409, `${id} is already a rush order`);
  const sp = db.prepare('SELECT * FROM supplier_parts WHERE part_number = ? AND supplier_id = ?').get(po.part_number, po.supplier_id);
  const rushDate = addDays(today, Math.max(3, Math.ceil(rushLeadDays(sp.quoted_lead_days) / 2)));
  const expected = rushDate < po.expected_delivery_date || po.expected_delivery_date < today ? rushDate : po.expected_delivery_date;
  const remaining = po.quantity - po.quantity_received - po.quantity_rejected;
  const premium = Math.round(remaining * po.unit_cost * RUSH_PREMIUM * 100) / 100;
  return tx(db, () => {
    db.prepare("UPDATE inventory_orders SET rush = 1, rush_premium = ?, expected_delivery_date = ?, status = 'confirmed' WHERE id = ?").run(premium, expected, id);
    logActivity(db, 'expedite_po', 'inventory_order', id, `Expedited ${id}: now due ${expected}, +$${premium.toLocaleString('en-US')} premium`);
    return { id, expected, premium };
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
  const used = [];
  const lots = db.prepare(`SELECT * FROM inventory_parts WHERE part_number = ? AND status = 'in_stock' AND quantity_on_hand > 0
    ORDER BY received_date, id`).all(partNumber);
  let need = qty;
  const upsert = db.prepare(`INSERT INTO tractor_parts (tractor_id, inventory_part_id, part_number, quantity, installed_date)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(tractor_id, inventory_part_id, installed_date) DO UPDATE SET quantity = quantity + excluded.quantity`);
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
    used.push(ip.id);
  }
  if (need > 0) throw new ApiError(409, `Not enough ${partNumber} on hand`);
  return used;
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
    const rush = o.priority === 'rush';
    const eta = addDays(today, Math.max(1, transitDays(plant.lat, plant.lng, o.lat, o.lng) - (rush ? 1 : 0)));
    const freight = tractorFreight(plant.lat, plant.lng, o.lat, o.lng, ready.length, rush);
    db.prepare(`INSERT INTO shipments (id, direction, customer_order_id, carrier, tracking_number, origin, origin_lat, origin_lng,
      destination, destination_lat, destination_lng, shipped_date, expected_arrival_date, status)
      VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_transit')`)
      .run(shId, orderId, CARRIERS_OUTBOUND[Math.floor(Math.random() * CARRIERS_OUTBOUND.length)], trackingNumber('HF'),
        plant.name, plant.lat, plant.lng, `${o.customer_name} — ${o.delivery_address}`, o.lat, o.lng, today, eta);
    db.prepare('UPDATE shipments SET rush = ?, freight_cost = ? WHERE id = ?').run(rush ? 1 : 0, freight, shId);
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
  if (sh.direction === 'service_pickup') return serviceArrive(db, today, sh.service_job_id);
  if (sh.direction === 'service_return') return serviceReturn(db, today, sh.service_job_id);
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

/** Mark a customer order as a rush job: its builds jump the queue and it ships with expedited freight. */
export function rushOrder(db, today, orderId) {
  const o = db.prepare('SELECT * FROM customer_orders WHERE id = ?').get(orderId);
  if (!o) throw notFound('Order', orderId);
  if (!ACTIVE_ORDER_STATUSES.includes(o.status)) throw new ApiError(409, `${orderId} is ${o.status}`);
  if (o.priority === 'rush') throw new ApiError(409, `${orderId} is already a rush order`);
  return tx(db, () => {
    db.prepare("UPDATE customer_orders SET priority = 'rush' WHERE id = ?").run(orderId);
    logActivity(db, 'rush_order', 'customer_order', orderId, `${orderId} marked rush: builds move to the front of the queue, expedited freight (+15%)`);
    return { id: orderId, priority: 'rush' };
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
        WHERE tp.tractor_id = ? AND tp.part_number = ? AND tp.removed_date IS NULL LIMIT 1`).get(tractor.id, partNumber);
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

// ---- Notifications -----------------------------------------------------------------

export function sendNotification(db, today, { recipientType, recipientId, subject, body, urgency = 'normal', entity = null, entityId = null }) {
  const lookup = {
    site: 'SELECT name FROM warehouses WHERE id = ?',
    supplier: 'SELECT name FROM suppliers WHERE id = ?',
    customer: 'SELECT name FROM customers WHERE id = ?',
  }[recipientType];
  if (!lookup) throw new ApiError(400, 'recipientType must be site, supplier or customer');
  const r = db.prepare(lookup).get(recipientId);
  if (!r) throw new ApiError(400, `Unknown ${recipientType} ${recipientId}`);
  if (!subject || !body) throw new ApiError(400, 'Subject and message are required');
  return tx(db, () => {
    const id = nextId(db, 'notifications', 'NT-', 5);
    db.prepare(`INSERT INTO notifications (id, created_date, recipient_type, recipient_id, recipient_name, subject, body, urgency, entity, entity_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent')`).run(id, today, recipientType, recipientId, r.name, subject, body, urgency, entity, entityId);
    logActivity(db, 'notify', entity ?? 'notification', entityId ?? id, `${urgency === 'urgent' ? 'URGENT ' : ''}notice to ${r.name}: ${subject}`);
    return { id, recipient: r.name };
  });
}

export function acknowledgeNotification(db, today, id) {
  const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
  if (!n) throw notFound('Notification', id);
  db.prepare("UPDATE notifications SET status = 'acknowledged', acknowledged_date = ? WHERE id = ?").run(today, id);
  return { id, status: 'acknowledged' };
}

// ---- Service jobs: pickup, repair at the plant, return ------------------------------

const jobOf = (db, id) => {
  const j = db.prepare(`SELECT j.*, c.name AS customer_name, c.lat, c.lng, t.serial_number
    FROM service_jobs j JOIN customers c ON c.id = j.customer_id JOIN tractors t ON t.id = j.tractor_id WHERE j.id = ?`).get(id);
  if (!j) throw notFound('Service job', id);
  return j;
};

function serviceShipment(db, today, j, toPlant) {
  const plant = plantOf(db);
  const shId = nextId(db, 'shipments', 'SH-', 5);
  const days = Math.max(1, transitDays(j.lat, j.lng, plant.lat, plant.lng) - (j.rush ? 1 : 0));
  const site = `${j.customer_name} — ${j.pickup_address}`;
  db.prepare(`INSERT INTO shipments (id, direction, service_job_id, rush, freight_cost, carrier, tracking_number, origin, origin_lat, origin_lng,
    destination, destination_lat, destination_lng, shipped_date, expected_arrival_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_transit')`)
    .run(shId, toPlant ? 'service_pickup' : 'service_return', j.id, j.rush, haulLeg(j.lat, j.lng, plant.lat, plant.lng, !!j.rush),
      CARRIERS_OUTBOUND[Math.floor(Math.random() * CARRIERS_OUTBOUND.length)], trackingNumber('SV'),
      toPlant ? site : plant.name, toPlant ? j.lat : plant.lat, toPlant ? j.lng : plant.lng,
      toPlant ? plant.name : site, toPlant ? plant.lat : j.lat, toPlant ? plant.lng : j.lng, today, addDays(today, days));
  db.prepare('INSERT INTO shipment_tractors (shipment_id, tractor_id) VALUES (?, ?)').run(shId, j.tractor_id);
  return { shId, days, eta: addDays(today, days) };
}

/** Book a carrier to collect a damaged tractor from the customer's site for repair at the plant. */
export function scheduleServiceJob(db, today, { failureId = null, tractorId = null, partNumber = null, rush = false, pickupDate = null, notes = null }) {
  const f = failureId ? db.prepare('SELECT * FROM failure_reports WHERE id = ?').get(failureId) : null;
  if (failureId && !f) throw notFound('Failure report', failureId);
  const tid = f?.tractor_id ?? tractorId;
  const t = tid ? db.prepare(`SELECT t.*, o.customer_id, c.primary_address, c.lat, c.lng FROM tractors t
    JOIN customer_orders o ON o.id = t.customer_order_id JOIN customers c ON c.id = o.customer_id WHERE t.id = ? OR t.serial_number = ?`).get(tid, tid) : null;
  if (!t) throw new ApiError(400, 'A delivered tractor is required for a pickup');
  if (t.status !== 'delivered') throw new ApiError(409, `${t.serial_number} is ${t.status}, not at a customer site`);
  const active = db.prepare("SELECT id FROM service_jobs WHERE tractor_id = ? AND status != 'completed'").get(t.id);
  if (active) throw new ApiError(409, `${t.serial_number} already has service job ${active.id}`);
  const pickup = pickupDate && pickupDate >= today ? pickupDate : addDays(today, rush ? 0 : 1);
  const plant = plantOf(db);
  const days = Math.max(1, transitDays(t.lat, t.lng, plant.lat, plant.lng) - (rush ? 1 : 0));
  const pn = partNumber ?? f?.part_number ?? null;
  const cat = pn ? db.prepare('SELECT category FROM part_types WHERE part_number = ?').get(pn)?.category : null;
  const repairDays = ['engine', 'transmission', 'cab'].includes(cat) ? 4 : 2;
  return tx(db, () => {
    const id = nextId(db, 'service_jobs', 'SJ-', 5);
    const haul = 2 * haulLeg(t.lat, t.lng, plant.lat, plant.lng, !!rush);
    const ret = addDays(pickup, 2 * days + repairDays);
    db.prepare(`INSERT INTO service_jobs (id, tractor_id, customer_id, failure_report_id, part_number, status, rush, pickup_address,
      scheduled_pickup_date, expected_return_date, haul_cost, notes, created_date) VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, t.id, t.customer_id, f?.id ?? null, pn, rush ? 1 : 0, t.primary_address, pickup, ret, haul, notes, today);
    if (f && f.status === 'open') db.prepare("UPDATE failure_reports SET status = 'investigating' WHERE id = ?").run(f.id);
    logActivity(db, 'schedule_pickup', 'service_job', id, `${rush ? 'Rush ' : ''}pickup of ${t.serial_number} scheduled ${pickup} for repair (${id}); back by ${ret}`);
    return { id, pickupDate: pickup, expectedReturn: ret, haulCost: haul };
  });
}

export function servicePickup(db, today, id) {
  const j = jobOf(db, id);
  if (j.status !== 'scheduled') throw new ApiError(409, `${id} is ${j.status}`);
  return tx(db, () => {
    const { shId, eta } = serviceShipment(db, today, j, true);
    db.prepare("UPDATE service_jobs SET status = 'in_transit_to_plant', picked_up_date = ? WHERE id = ?").run(today, id);
    db.prepare("UPDATE tractors SET status = 'in_repair' WHERE id = ?").run(j.tractor_id);
    logActivity(db, 'service_pickup', 'service_job', id, `${j.serial_number} collected from ${j.customer_name} (${shId}), at plant ${eta}`);
    return { id, shipmentId: shId, eta };
  });
}

export function serviceArrive(db, today, id) {
  const j = jobOf(db, id);
  if (j.status !== 'in_transit_to_plant') throw new ApiError(409, `${id} is ${j.status}`);
  return tx(db, () => {
    db.prepare("UPDATE shipments SET status = 'delivered', actual_arrival_date = ? WHERE service_job_id = ? AND direction = 'service_pickup' AND status = 'in_transit'").run(today, id);
    db.prepare("UPDATE service_jobs SET status = 'in_repair' WHERE id = ?").run(id);
    logActivity(db, 'service_arrive', 'service_job', id, `${j.serial_number} arrived at the plant for repair`);
    return { id, status: 'in_repair' };
  });
}

/** Replace the failed part from stock (keeping traceability), then truck the tractor back. */
export function serviceRepair(db, today, id) {
  const j = jobOf(db, id);
  if (j.status !== 'in_repair') throw new ApiError(409, `${id} is ${j.status}`);
  const part = j.part_number ? db.prepare('SELECT * FROM part_types WHERE part_number = ?').get(j.part_number) : null;
  if (part) {
    const avail = db.prepare('SELECT available FROM v_part_balances WHERE part_number = ?').get(part.part_number).available;
    if (avail < 1) throw new ApiError(409, `No ${part.part_number} on hand for the repair — order one (rush) first`, { short: [{ partNumber: part.part_number, need: 1, available: 0 }] });
  }
  return tx(db, () => {
    let replacement = null;
    let partsCost = 0;
    if (part) {
      if (part.serialized) {
        const old = db.prepare('SELECT inventory_part_id FROM tractor_parts WHERE tractor_id = ? AND part_number = ? AND removed_date IS NULL LIMIT 1').get(j.tractor_id, part.part_number);
        if (old) {
          db.prepare("UPDATE inventory_parts SET status = 'scrapped', tractor_id = NULL WHERE id = ?").run(old.inventory_part_id);
          db.prepare('UPDATE tractor_parts SET removed_date = ? WHERE tractor_id = ? AND inventory_part_id = ?').run(today, j.tractor_id, old.inventory_part_id);
        }
      }
      replacement = installPart(db, j.tractor_id, part.part_number, 1, today)[0];
      partsCost = db.prepare(`SELECT io.unit_cost FROM inventory_parts ip LEFT JOIN inventory_orders io ON io.id = ip.inventory_order_id
        WHERE ip.id = ?`).get(replacement)?.unit_cost ?? part.unit_cost;
    }
    const labor = repairLabor(part?.category);
    const { shId, eta } = serviceShipment(db, today, j, false);
    db.prepare(`UPDATE service_jobs SET status = 'returning', repair_complete_date = ?, expected_return_date = ?, repair_labor_cost = ?,
      repair_parts_cost = ?, replacement_part_id = ? WHERE id = ?`).run(today, eta, labor, partsCost, replacement ?? null, id);
    logActivity(db, 'service_repair', 'service_job', id, `Repaired ${j.serial_number}${part ? ` (new ${part.part_number})` : ''}; returning to ${j.customer_name} (${shId}), ETA ${eta}`);
    return { id, shipmentId: shId, eta, replacementPartId: replacement ?? null };
  });
}

export function serviceReturn(db, today, id) {
  const j = jobOf(db, id);
  if (j.status !== 'returning') throw new ApiError(409, `${id} is ${j.status}`);
  return tx(db, () => {
    db.prepare("UPDATE shipments SET status = 'delivered', actual_arrival_date = ? WHERE service_job_id = ? AND direction = 'service_return' AND status = 'in_transit'").run(today, id);
    db.prepare("UPDATE service_jobs SET status = 'completed', returned_date = ? WHERE id = ?").run(today, id);
    db.prepare("UPDATE tractors SET status = 'delivered' WHERE id = ?").run(j.tractor_id);
    if (j.failure_report_id) {
      db.prepare("UPDATE failure_reports SET status = 'resolved', resolved_date = ?, resolution = ? WHERE id = ?")
        .run(today, `Collected from site and repaired at plant (${id})`, j.failure_report_id);
    }
    logActivity(db, 'service_return', 'service_job', id, `${j.serial_number} returned to ${j.customer_name}; ${id} complete`);
    return { id, status: 'completed' };
  });
}
