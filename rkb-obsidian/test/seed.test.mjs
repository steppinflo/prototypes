import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededDb, TODAY } from './helpers.mjs';

const db = seededDb();
const one = (sql, ...args) => db.prepare(sql).get(...args);

test('seed populates every entity from the diagram', () => {
  for (const table of ['customers', 'suppliers', 'customer_orders', 'inventory_orders', 'inventory_parts', 'tractors', 'tractor_parts', 'shipments', 'failure_reports', 'market_signals']) {
    assert.ok(one(`SELECT COUNT(*) AS n FROM ${table}`).n > 0, `${table} is empty`);
  }
  assert.equal(one('SELECT COUNT(*) AS n FROM suppliers').n, 5);
  assert.equal(one('SELECT COUNT(*) AS n FROM tractor_models').n, 5);
});

test('referential integrity holds', () => {
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('nothing is dated after today except expected/ETA dates', () => {
  assert.equal(one('SELECT COUNT(*) AS n FROM customer_orders WHERE submission_date > ?', TODAY).n, 0);
  assert.equal(one('SELECT COUNT(*) AS n FROM tractors WHERE build_start_date > ?', TODAY).n, 0);
  assert.equal(one('SELECT COUNT(*) AS n FROM failure_reports WHERE reported_date > ?', TODAY).n, 0);
  assert.equal(one('SELECT COUNT(*) AS n FROM inventory_orders WHERE actual_delivery_date > ?', TODAY).n, 0);
});

test('inventory accounting is consistent', () => {
  // On-hand never negative or above what was received.
  assert.equal(one('SELECT COUNT(*) AS n FROM inventory_parts WHERE quantity_on_hand < 0 OR quantity_on_hand > quantity').n, 0);
  // Every serialized unit installed in a tractor appears in that tractor's parts list.
  assert.equal(one(`SELECT COUNT(*) AS n FROM inventory_parts ip WHERE ip.status = 'installed'
    AND NOT EXISTS (SELECT 1 FROM tractor_parts tp WHERE tp.inventory_part_id = ip.id AND tp.tractor_id = ip.tractor_id)`).n, 0);
  // Lot usage never exceeds what the lot held.
  assert.equal(one(`SELECT COUNT(*) AS n FROM inventory_parts ip
    WHERE ip.serial_number IS NULL AND ip.quantity_on_hand + (SELECT COALESCE(SUM(quantity), 0) FROM tractor_parts WHERE inventory_part_id = ip.id) > ip.quantity`).n, 0);
});

test('every finished tractor has its complete bill of materials', () => {
  const short = one(`
    SELECT COUNT(*) AS n FROM tractors t JOIN bom_items b ON b.model_number = t.model_number
    WHERE t.status NOT IN ('in_production', 'qc_hold')
      AND b.quantity > (SELECT COALESCE(SUM(tp.quantity), 0) FROM tractor_parts tp WHERE tp.tractor_id = t.id AND tp.part_number = b.part_number)`).n;
  assert.equal(short, 0);
});

test('orders never have more tractors than they asked for, and delivered orders are fully delivered', () => {
  assert.equal(one(`SELECT COUNT(*) AS n FROM customer_orders o
    WHERE (SELECT COUNT(*) FROM tractors t WHERE t.customer_order_id = o.id) > o.quantity`).n, 0);
  assert.equal(one(`SELECT COUNT(*) AS n FROM customer_orders o WHERE o.status = 'delivered'
    AND (SELECT COUNT(*) FROM tractors t WHERE t.customer_order_id = o.id AND t.status IN ('delivered', 'in_repair')) <> o.quantity`).n, 0);
});

test('demo scenarios are present', () => {
  assert.ok(one("SELECT COUNT(*) AS n FROM tractors WHERE status = 'qc_hold'").n >= 1);
  assert.ok(one("SELECT COUNT(*) AS n FROM customer_orders WHERE model_number = 'TX-500' AND quantity = 6 AND status = 'received'").n >= 1);
});

test('seeding is deterministic', () => {
  const other = seededDb();
  const sig = (d) => d.prepare('SELECT COUNT(*) AS n, SUM(quantity) AS q FROM customer_orders').get();
  assert.deepEqual(sig(other), sig(db));
});
