import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededDb, TODAY } from './helpers.mjs';
import * as actions from '../src/api/actions.mjs';

const db = seededDb();
const balance = (pn) => db.prepare('SELECT available, pending FROM v_part_balances WHERE part_number = ?').get(pn);

/** Receive enough of every short part to build `count` of a model. */
function stockKit(model, count) {
  for (const b of db.prepare('SELECT * FROM bom_items WHERE model_number = ?').all(model)) {
    const short = b.quantity * count - balance(b.part_number).available;
    if (short <= 0) continue;
    const sup = db.prepare('SELECT supplier_id FROM supplier_parts WHERE part_number = ? AND is_primary = 1').get(b.part_number).supplier_id;
    const { id } = actions.placeInventoryOrder(db, TODAY, { partNumber: b.part_number, supplierId: sup, quantity: short });
    actions.receiveInventoryOrder(db, TODAY, id);
  }
}

test('placing and receiving a parts order moves units from pending to available', () => {
  const before = balance('HRN-01');
  const { id } = actions.placeInventoryOrder(db, TODAY, { partNumber: 'HRN-01', supplierId: 'SUP-D', quantity: 20 });
  assert.equal(balance('HRN-01').pending, before.pending + 20);
  actions.markInventoryOrderShipped(db, TODAY, id);
  const out = actions.receiveInventoryOrder(db, TODAY, id, { rejected: 2 });
  assert.equal(out.received, 18);
  const after = balance('HRN-01');
  assert.equal(after.available, before.available + 18);
  assert.equal(after.pending, before.pending);
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM failure_reports WHERE inventory_order_id = ? AND stage = 'receiving'").get(id).n === 1);
});

test('a supplier cannot be ordered a part it does not supply', () => {
  assert.throws(() => actions.placeInventoryOrder(db, TODAY, { partNumber: 'ENG-180', supplierId: 'SUP-E', quantity: 1 }), /does not supply/);
});

test('build -> complete -> ship -> deliver keeps order and parts consistent', () => {
  const order = actions.createOrder(db, TODAY, { customerId: 'CUS-001', model: 'TX-100', quantity: 1, expectedDeliveryDate: '2026-12-01' });
  stockKit('TX-100', 1);
  const before = balance('ENG-25').available;
  const { tractors } = actions.startBuilds(db, '2026-10-19', { orderId: order.id, count: 1 });
  assert.equal(balance('ENG-25').available, before - 1);
  const t = tractors[0];
  const engine = db.prepare("SELECT ip.* FROM tractor_parts tp JOIN inventory_parts ip ON ip.id = tp.inventory_part_id WHERE tp.tractor_id = ? AND tp.part_number = 'ENG-25'").get(t.id);
  assert.equal(engine.tractor_id, t.id);
  assert.equal(engine.status, 'installed');

  actions.completeBuild(db, '2026-10-20', t.id);
  assert.equal(db.prepare('SELECT status FROM customer_orders WHERE id = ?').get(order.id).status, 'ready');
  const { shipmentId } = actions.shipOrder(db, '2026-10-20', order.id);
  assert.equal(db.prepare('SELECT status FROM customer_orders WHERE id = ?').get(order.id).status, 'shipping');
  actions.deliverShipment(db, '2026-10-23', shipmentId);
  const o = db.prepare('SELECT * FROM customer_orders WHERE id = ?').get(order.id);
  assert.equal(o.status, 'delivered');
  assert.equal(o.actual_delivery_date, '2026-10-23');
});

test('builds are refused when parts or bays run out', () => {
  assert.throws(() => actions.startBuilds(db, '2026-10-21', { model: 'TX-500', count: 50 }), /bays|parts/);
});

test('clearing a QC hold installs a replacement and resolves the failure', () => {
  const t = db.prepare("SELECT * FROM tractors WHERE status = 'qc_hold'").get();
  actions.clearHold(db, TODAY, t.id);
  const after = db.prepare('SELECT * FROM tractors WHERE id = ?').get(t.id);
  assert.equal(after.status, after.customer_order_id ? 'earmarked' : 'inventoried');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM failure_reports WHERE tractor_id = ? AND stage = 'manufacturing' AND status != 'resolved'").get(t.id).n, 0);
});

test('earmarking checks model and order capacity', () => {
  stockKit('TX-200', 1);
  const { tractors } = actions.startBuilds(db, '2026-10-22', { model: 'TX-200', count: 1 });
  actions.completeBuild(db, '2026-10-23', tractors[0].id);
  const stock = db.prepare('SELECT * FROM tractors WHERE id = ?').get(tractors[0].id);
  assert.equal(stock.status, 'inventoried');
  const wrong = db.prepare("SELECT id FROM customer_orders WHERE status = 'received' AND model_number != ?").get(stock.model_number);
  assert.throws(() => actions.earmarkTractor(db, TODAY, stock.id, { orderId: wrong.id }), /is for/);
});

test('logging a field failure links it to the installed unit, supplier and customer', () => {
  const t = db.prepare("SELECT t.id FROM tractors t WHERE t.status = 'delivered' LIMIT 1").get();
  const { id } = actions.createFailure(db, TODAY, { stage: 'field', tractorId: t.id, partNumber: 'ECU-01', severity: 'high', description: 'test' });
  const f = db.prepare('SELECT * FROM failure_reports WHERE id = ?').get(id);
  assert.ok(f.inventory_part_id && f.supplier_id && f.customer_id);
});
