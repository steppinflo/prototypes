// Runs the mocked models in dependency order and caches the result until data changes:
//   forecast ─┐
//             ├─> inventory plan ─> tasks
//   parts performance ─┘

import { forecastDemand } from './forecast.mjs';
import { partsPerformance, storeReliabilityScores } from './partsPerformance.mjs';
import { inventoryPlan } from './inventoryPlan.mjs';
import { generateTasks } from './tasks.mjs';

let cache = null;
let version = 0;

/** Call after any write so the next read re-runs the models. */
export function invalidateModels() {
  version += 1;
  cache = null;
}

export function readSettings(db) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
}

export function runModels(db, today) {
  if (cache && cache.today === today && cache.version === version) return cache;
  const started = Date.now();
  const settings = readSettings(db);
  const forecast = forecastDemand(db, { today, horizonDays: Number(settings.planning_horizon_days) });
  const performance = partsPerformance(db);
  storeReliabilityScores(db, performance);
  const plan = inventoryPlan(db, { today, forecast, performance, settings });
  const tasks = generateTasks(db, { today, plan, performance });
  cache = { today, version, settings, forecast, performance, plan, tasks, computedMs: Date.now() - started };
  return cache;
}
