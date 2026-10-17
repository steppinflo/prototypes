import { recreateDb } from '../src/db/index.mjs';
import { seedDatabase } from '../src/seed/index.mjs';

export const TODAY = '2026-10-16';

/** Fresh in-memory database seeded as of TODAY. */
export function seededDb(today = TODAY) {
  const db = recreateDb(':memory:');
  seedDatabase(db, { today });
  return db;
}
