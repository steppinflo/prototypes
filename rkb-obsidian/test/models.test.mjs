import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededDb, TODAY } from './helpers.mjs';
import { runModels, invalidateModels } from '../src/models/index.mjs';

const db = seededDb();
invalidateModels();
const { forecast, performance, plan, tasks } = runModels(db, TODAY);

test('forecast covers every model over the horizon with ordered quantiles', () => {
  assert.equal(forecast.models.length, 5);
  for (const m of forecast.models) {
    assert.equal(m.daily.length, 90);
    assert.ok(m.total.p10 <= m.total.mean && m.total.mean <= m.total.p90, m.model);
    for (const w of m.weekly) assert.ok(w.p10 <= w.mean && w.mean <= w.p90);
  }
  assert.equal(forecast.seasonality.length, 12);
});

test('parts performance scores are bounded and every supplier is scored', () => {
  for (const r of performance.parts) assert.ok(r.score >= 0 && r.score <= 100, `${r.partNumber}/${r.supplierId}`);
  assert.equal(performance.suppliers.filter((s) => s.reliabilityScore !== null).length, 5);
  // Seeded supplier quality differs: Supplier A should outscore Supplier E.
  const score = (id) => performance.suppliers.find((s) => s.supplierId === id).reliabilityScore;
  assert.ok(score('SUP-A') > score('SUP-E'));
});

test('firm demand is not double counted against tractors already assigned', () => {
  const expected = db.prepare(`
    SELECT COALESCE(SUM(o.quantity - (SELECT COUNT(*) FROM tractors t WHERE t.customer_order_id = o.id)), 0) AS n
    FROM customer_orders o WHERE o.status IN ('received','in_production','ready','shipping','partially_delivered')`).get().n;
  assert.equal(plan.summary.firmUnits, expected);
  // Stock allocations never reuse a tractor.
  const ids = plan.stockAllocations.map((a) => a.tractorId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(plan.summary.buildsPlanned, plan.summary.firmUnits + plan.summary.forecastUnits - plan.summary.coveredByStock);
});

test('build schedule respects capacity', () => {
  const perDay = new Map();
  for (const b of plan.builds) perDay.set(b.buildDate, (perDay.get(b.buildDate) ?? 0) + 1);
  for (const [, n] of perDay) assert.ok(n <= plan.settings.buildBays);
});

test('recommendations are well formed', () => {
  assert.ok(plan.recommendations.length > 0);
  for (const r of plan.recommendations) {
    assert.ok(r.quantity > 0 && r.orderBy <= r.needDate && r.cost > 0, r.key);
  }
});

test('the fleet-order scenario produces an urgent flagship-engine purchase', () => {
  const rec = plan.recommendations.find((r) => r.partNumber === 'ENG-180' && r.urgency !== 'upcoming');
  assert.ok(rec, 'expected an act-now ENG-180 recommendation');
  assert.ok(rec.impactedOrders.length >= 1);
  assert.ok(tasks.some((t) => t.type === 'place_po' && t.title.includes('ENG-180')));
});

test('tasks have unique keys, due dates and context', () => {
  const keys = tasks.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const t of tasks) assert.ok(t.due && t.title && t.blocking, t.key);
  assert.ok(tasks.some((t) => t.type === 'qc_hold'));
});

test('builds are only offered to start now when a full parts kit is on hand', () => {
  const kits = (model) => db.prepare(`SELECT MIN(v.available / b.quantity) AS n FROM bom_items b
    JOIN v_part_balances v ON v.part_number = b.part_number WHERE b.model_number = ?`).get(model).n;
  for (const b of plan.builds) assert.equal(b.startableNow, kits(b.model) > 0, `${b.model} build #${b.seq}`);
  for (const t of tasks.filter((x) => x.type === 'start_build')) assert.ok(t.action.body.count <= kits(t.action.body.model ?? db.prepare('SELECT model_number FROM customer_orders WHERE id = ?').get(t.action.body.orderId).model_number));
});
