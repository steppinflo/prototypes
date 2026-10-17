// CLI: rebuild the database from the source dataset.  `npm run seed`
import { recreateDb, DEFAULT_DB_PATH } from '../db/index.mjs';
import { todayIso } from '../lib/util.mjs';
import { seedDatabase } from './index.mjs';

const today = todayIso();
const started = Date.now();
const db = recreateDb(DEFAULT_DB_PATH);
const counts = seedDatabase(db, { today });
db.close();
console.log(`Seeded ${DEFAULT_DB_PATH} as of ${today} in ${Date.now() - started} ms`, counts);
