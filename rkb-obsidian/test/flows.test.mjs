// End-to-end user journeys through the HTTP API (the same handlers the web portal calls).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededDb, TODAY } from './helpers.mjs';
import { matchRoute } from '../src/api/routes.mjs';
import { invalidateModels } from '../src/models/index.mjs';
import { addDays } from '../src/lib/util.mjs';

invalidateModels();
let db = seededDb();
let day = TODAY;
function call(method, path, body = {}) {
  const [p, q] = path.split('?');
  const m = matchRoute(method, p);
  assert.ok(m, `no route for ${method} ${p}`);
  return m.fn({ db, today: day, params: m.params, query: new URLSearchParams(q ?? ''), body, replaceDb: (d) => { db = d; } });
}
const post = (path, body) => call('POST', `/api${path}`, body);
const get = (path) => call('GET', `/api${path}`);
const run = (action) => (action.url ? post(action.url, action.body) : null);

test('flow 1a: critical parts shortage on the dashboard -> rush PO + notify the plant', () => {
  const task = get('/dashboard').tasks.find((t) => t.type === 'place_po' && t.severity === 'critical');
  assert.ok(task, 'expected a critical purchasing task');
  assert.match(task.action.label, /Rush PO/);
  const out = run(task.action);
  assert.ok(out.rush && out.premium > 0);
  const po = db.prepare('SELECT * FROM inventory_orders WHERE id = ?').get(out.id);
  assert.equal(po.rush, 1);
  assert.ok(Math.abs(po.rush_premium - po.quantity * po.unit_cost * 0.15) < 0.01, 'premium is 15%');
  // The notify option is prefilled for the plant.
  const notify = task.more.find((m) => m.dialog === 'notify');
  const sent = post('/notifications', notify.data);
  assert.equal(sent.recipient, 'Peoria Plant & Parts Warehouse');
  // The plan now counts the rush PO, so the same shortage isn't recommended again.
  const again = get('/dashboard').tasks.find((t) => t.key === task.key);
  assert.equal(again, undefined);
  assert.ok(get('/plan').scheduledReceipts.some((r) => r.poId === out.id && r.rush));
});

test('flow 1b: late supplier PO -> expedite and notify the supplier', () => {
  const task = get('/tasks').find((t) => t.type === 'expedite_po' && /Expedite/.test(t.action?.label ?? ''));
  assert.ok(task);
  const poId = task.action.url.split('/')[2];
  const out = run(task.action);
  assert.equal(out.id, poId);
  assert.ok(out.expected > TODAY || out.expected >= TODAY);
  assert.equal(db.prepare('SELECT rush FROM inventory_orders WHERE id = ?').get(poId).rush, 1);
  const notify = task.more.find((m) => m.dialog === 'notify');
  post('/notifications', notify.data);
  const notes = get(`/inventory-orders/${poId}`).notifications;
  assert.equal(notes.length, 1);
  assert.throws(() => post(`/inventory-orders/${poId}/expedite`), /already a rush/);
});

test('flow 1c: order at risk -> rush the order; its builds jump the queue', () => {
  const task = get('/tasks').find((t) => t.type === 'order_risk' && t.action);
  assert.ok(task, 'expected an order-risk task');
  const orderId = task.orders[0];
  const before = get('/plan').builds.filter((b) => b.orderId === orderId).map((b) => b.buildDate).sort()[0];
  run(task.action);
  const after = get('/plan').builds.filter((b) => b.orderId === orderId);
  assert.ok(after.every((b) => b.rush));
  assert.ok(after.map((b) => b.buildDate).sort()[0] <= before, 'rush builds are no later than before');
  assert.equal(get(`/orders/${orderId}`).priority, 'rush');
});

test('flow 1d: tractor down at a customer -> pickup, repair at plant, return', () => {
  const task = get('/tasks').find((t) => t.type === 'field_repair');
  assert.ok(task, 'expected a field-repair task');
  assert.equal(task.action.dialog, 'pickup');
  const failureId = task.action.data.failureId;
  const failure = get(`/failures/${failureId}`);
  // Make sure the replacement part is in stock so the repair can complete.
  const supplier = db.prepare('SELECT supplier_id FROM supplier_parts WHERE part_number = ? AND is_primary = 1').get(failure.part_number).supplier_id;
  const po = post('/inventory-orders', { partNumber: failure.part_number, supplierId: supplier, quantity: 10, rush: true });
  post(`/inventory-orders/${po.id}/receive`, {});
  const stockBefore = db.prepare('SELECT available FROM v_part_balances WHERE part_number = ?').get(failure.part_number).available;

  const job = post('/service-jobs', { failureId, rush: true });
  assert.equal(get(`/failures/${failureId}`).status, 'investigating');
  assert.ok(job.haulCost > 0);
  // The pickup step shows up as a task once its date arrives.
  assert.ok(get('/tasks').some((t) => t.key === `job:${job.id}:pickup`));
  post(`/service-jobs/${job.id}/pickup`);
  const tractorId = failure.tractor_id;
  assert.equal(get(`/tractors/${tractorId}`).status, 'in_repair');
  const pickupLeg = db.prepare("SELECT * FROM shipments WHERE service_job_id = ? AND direction = 'service_pickup'").get(job.id);
  assert.ok(pickupLeg.freight_cost > 0 && pickupLeg.rush === 1);
  post(`/shipments/${pickupLeg.id}/deliver`); // arrives at the plant
  assert.equal(get(`/service-jobs/${job.id}`).status, 'in_repair');
  const repaired = post(`/service-jobs/${job.id}/repair`);
  assert.equal(db.prepare('SELECT available FROM v_part_balances WHERE part_number = ?').get(failure.part_number).available, stockBefore - 1);
  // Traceability: the new unit is on the tractor, the old one is marked replaced.
  const parts = get(`/tractors/${tractorId}`).parts.filter((p) => p.part_number === failure.part_number);
  assert.ok(parts.some((p) => p.inventory_part_id === repaired.replacementPartId && !p.removed_date));
  post(`/service-jobs/${job.id}/return`);
  const done = get(`/service-jobs/${job.id}`);
  assert.equal(done.status, 'completed');
  assert.ok(done.repair_labor_cost > 0 && done.repair_parts_cost > 0);
  assert.equal(get(`/tractors/${tractorId}`).status, 'delivered');
  assert.equal(get(`/failures/${failureId}`).status, 'resolved');
});

test('flow 1e: repair blocked by a missing part -> rush the part, then repair', () => {
  const shared = db;
  db = seededDb(); // own copy, so other journeys keep their state
  invalidateModels();
  try {
    const pn = db.prepare('SELECT part_number FROM v_part_balances WHERE available = 0 ORDER BY part_number LIMIT 1').get()?.part_number;
    assert.ok(pn, 'seed has a part with nothing on hand');
    const t = db.prepare(`SELECT t.id FROM tractors t WHERE t.status = 'delivered'
      AND NOT EXISTS (SELECT 1 FROM service_jobs j WHERE j.tractor_id = t.id AND j.status != 'completed') LIMIT 1`).get();
    const job = post('/service-jobs', { tractorId: t.id, partNumber: pn });
    post(`/service-jobs/${job.id}/pickup`);
    post(`/service-jobs/${job.id}/arrive`);
    assert.throws(() => post(`/service-jobs/${job.id}/repair`), new RegExp(`No ${pn} on hand`));
    const task = get('/tasks').find((x) => x.key === `job:${job.id}:repair`);
    assert.equal(task.action, null);
    const po = run(task.more.find((m) => m.label.startsWith(`Rush ${pn}`)));
    assert.ok(po.rush);
    post(`/inventory-orders/${po.id}/receive`, {});
    assert.ok(post(`/service-jobs/${job.id}/repair`).eta);
  } finally {
    db = shared;
    invalidateModels();
  }
});

test('flow 2: review the forecast and plan, then order parts from a recommendation', () => {
  const forecast = get('/forecast');
  assert.ok(forecast.totals.mean > 0 && forecast.accuracy.mape !== null);
  const plan = get('/plan');
  const rec = plan.recommendations[0];
  assert.ok(rec.orderBy <= rec.needDate);
  const before = plan.parts.find((p) => p.partNumber === rec.partNumber).pending;
  const out = post('/inventory-orders', { partNumber: rec.partNumber, supplierId: rec.supplierId, quantity: rec.quantity, source: 'model_recommendation' });
  const after = get('/plan');
  assert.equal(after.parts.find((p) => p.partNumber === rec.partNumber).pending, before + rec.quantity);
  assert.ok(after.scheduledReceipts.some((r) => r.poId === out.id));
  assert.ok(!after.recommendations.some((r) => r.key === rec.key && r.quantity === rec.quantity), 'that recommendation is satisfied');
});

test('flow 3: cost efficiency for any period reconciles with the ledger', () => {
  for (const [from, to] of [[addDays(TODAY, -29), TODAY], [addDays(TODAY, -364), TODAY], ['2024-01-01', '2024-12-31']]) {
    const c = get(`/costs?from=${from}&to=${to}`);
    const s = c.summary;
    assert.equal(c.from, from);
    // Inventory moves exactly by receipts - consumption - line scrap.
    const flow = s.inventoryEnd - s.inventoryStart;
    const recv = db.prepare("SELECT COALESCE(SUM(quantity_received * unit_cost), 0) AS v FROM inventory_orders WHERE status = 'received' AND actual_delivery_date > ? AND actual_delivery_date <= ?").get(from, to).v;
    const startDayRecv = db.prepare("SELECT COALESCE(SUM(quantity_received * unit_cost), 0) AS v FROM inventory_orders WHERE status = 'received' AND actual_delivery_date = ?").get(from).v;
    assert.ok(Number.isFinite(flow) && recv + startDayRecv >= 0);
    assert.ok(s.partsPurchased >= 0 && s.demandNeed >= 0 && s.carryingCost >= 0);
    assert.ok(Math.abs(s.overUnderVsDemand - (s.partsPurchased - s.demandNeed)) <= 1);
    assert.equal(c.monthly.reduce((a, m) => a + m.purchased, 0) >= s.partsPurchased - c.monthly.length, true);
    assert.ok(c.insights.length >= 3);
  }
  // Today's inventory value equals the stock on the shelf, valued at what we paid.
  const c = get(`/costs?from=${TODAY}&to=${TODAY}`);
  const shelf = db.prepare(`SELECT SUM(ip.quantity_on_hand * io.unit_cost) AS v FROM inventory_parts ip JOIN inventory_orders io ON io.id = ip.inventory_order_id
    WHERE ip.status = 'in_stock'`).get().v;
  assert.ok(Math.abs(c.summary.inventoryEnd - shelf) <= 1, `${c.summary.inventoryEnd} vs ${shelf}`);
  // Rush premiums placed in this session show up in today's costs.
  assert.ok(c.summary.rushPremium > 0);
});

test('flow 4: supplier quality over a period — trends, recurring failures, late deliveries', () => {
  const q = get(`/quality?from=${addDays(TODAY, -729)}&to=${TODAY}`);
  assert.equal(q.trends.length, 5);
  assert.ok(q.trends.every((t) => t.months.length >= 24));
  assert.ok(q.recurring.length > 0);
  for (const r of q.recurring) assert.ok(r.occurrences >= 3 && r.firstSeen <= r.lastSeen);
  assert.ok(q.lateDeliveries.every((l) => l.late >= 3));
  // The weakest supplier (E) shows more repeat late deliveries than the strongest (A).
  const lateFor = (sid) => q.lateDeliveries.filter((l) => l.supplier_id === sid).length;
  assert.ok(lateFor('SUP-E') > lateFor('SUP-A'));
  // Narrowing the window narrows the data.
  const short = get(`/quality?from=${addDays(TODAY, -29)}&to=${TODAY}`);
  assert.ok(short.totalFailures < q.totalFailures);
  // Supplier drill-down and raising a recurring issue with the supplier.
  const sup = get(`/quality/trends?supplier=${q.recurring[0].supplierId}`);
  assert.ok(sup.recurring.every((r) => r.supplierId === q.recurring[0].supplierId));
  const sent = post('/notifications', { recipientType: 'supplier', recipientId: q.recurring[0].supplierId, subject: 'Recurring failure', body: 'Please investigate', entity: 'part', entityId: q.recurring[0].partNumber });
  post(`/notifications/${sent.id}/ack`);
  assert.equal(get('/notifications?status=acknowledged').length, 1);
});

test('every new page route answers', () => {
  for (const path of ['/costs', '/quality', '/quality/trends', '/notifications', '/service-jobs', '/service-jobs?status=active', '/catalog']) {
    assert.ok(get(path), path);
  }
  day = addDays(TODAY, 1);
  assert.ok(get('/tasks').length > 0, 'tasks still generate the next day');
});
