import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(here, '..', '..');
// Bump when schema.sql changes; the server rebuilds older databases on start.
export const SCHEMA_VERSION = 3;
export const DEFAULT_DB_PATH = process.env.RKB_DB_PATH || resolve(PROJECT_ROOT, 'data', 'rkb-obsidian.db');

export function openDb(path = DEFAULT_DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  return db;
}

/** Drop the database file (and WAL side files) and return a fresh, empty-schema connection. */
export function recreateDb(path = DEFAULT_DB_PATH) {
  if (path !== ':memory:') {
    for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) rmSync(f);
  }
  const db = openDb(path);
  db.exec(readFileSync(resolve(here, 'schema.sql'), 'utf8'));
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function logActivity(db, action, entity, entityId, message) {
  db.prepare('INSERT INTO activity_log (ts, action, entity, entity_id, message) VALUES (?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), action, entity, entityId, message);
}

/** Insert an array of plain objects into a table using the keys of the first row. */
export function insertMany(db, table, rows, columns = rows[0] && Object.keys(rows[0])) {
  if (!rows.length) return;
  const stmt = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
  for (const r of rows) stmt.run(...columns.map((c) => (r[c] === undefined ? null : r[c])));
}
