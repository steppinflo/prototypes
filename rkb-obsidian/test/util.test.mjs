import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayNum, isoDay, addDays, weekStart, isWorkday, makeRng, parseCsv, transitDays } from '../src/lib/util.mjs';

test('day numbers round-trip and weeks start on Monday', () => {
  assert.equal(isoDay(dayNum('2026-10-16')), '2026-10-16');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(isoDay(weekStart(dayNum('2026-10-18'))), '2026-10-12'); // Sunday -> previous Monday
  assert.equal(isWorkday(dayNum('2026-10-17')), false); // Saturday
  assert.equal(isWorkday(dayNum('2026-10-16')), true);
});

test('rng is deterministic for a seed', () => {
  const a = makeRng(42);
  const b = makeRng(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
});

test('csv parser keeps dates as strings and numbers as numbers', () => {
  const [row] = parseCsv('Date,Tractor_Model,Demand_Units\n2023-01-31,TX-500,225\n');
  assert.deepEqual(row, { Date: '2023-01-31', Tractor_Model: 'TX-500', Demand_Units: 225 });
});

test('transit estimate grows with distance', () => {
  const near = transitDays(40.69, -89.59, 40.12, -88.24);
  const far = transitDays(40.69, -89.59, 37.64, -120.99);
  assert.ok(near >= 1 && far > near);
});
