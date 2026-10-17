// RKB Obsidian internal portal: HTTP server for the API and the static web app.
//   npm start            (Node >= 22.13)
//   docker compose up    (anything with Docker)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { openDb, recreateDb, getSetting, DEFAULT_DB_PATH, PROJECT_ROOT, SCHEMA_VERSION } from './db/index.mjs';
import { seedDatabase } from './seed/index.mjs';
import { matchRoute } from './api/routes.mjs';
import { todayIso, diffDays } from './lib/util.mjs';

const PORT = Number(process.env.PORT || 4300);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = resolve(PROJECT_ROOT, 'public');
// When to rebuild the demo data on startup: always | never | stale (missing or > N days old).
const RESEED = process.env.RKB_RESEED || 'stale';
const STALE_DAYS = Number(process.env.RKB_STALE_DAYS || 7);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function ensureDatabase() {
  const today = todayIso();
  const exists = existsSync(DEFAULT_DB_PATH);
  let db = exists ? openDb(DEFAULT_DB_PATH) : null;
  let reason = null;
  if (!exists) reason = 'no database yet';
  else if (RESEED === 'always') reason = 'RKB_RESEED=always';
  else if (RESEED === 'stale') {
    let seedDate = null;
    try {
      seedDate = getSetting(db, 'seed_date');
    } catch {
      reason = 'database schema missing';
    }
    if (!reason && (!seedDate || diffDays(today, seedDate) > STALE_DAYS)) reason = `data seeded ${seedDate ?? 'never'}, older than ${STALE_DAYS} days`;
  }
  if (!reason && exists) {
    let version = 0;
    try {
      version = Number(getSetting(db, 'schema_version', 0));
    } catch { /* no settings table */ }
    if (version !== SCHEMA_VERSION) reason = `schema changed (v${SCHEMA_VERSION})`;
  }
  if (reason) {
    db?.close();
    const started = Date.now();
    db = recreateDb(DEFAULT_DB_PATH);
    const counts = seedDatabase(db, { today });
    console.log(`Seeded prototype data (${reason}) in ${Date.now() - started} ms:`, counts);
  }
  return db;
}

let db = ensureDatabase();

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const err = new Error('Request body must be JSON');
    err.status = 400;
    throw err;
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return false;
  try {
    const s = await stat(file);
    if (!s.isFile()) return false;
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const started = Date.now();
  try {
    if (url.pathname.startsWith('/api/')) {
      const match = matchRoute(req.method, url.pathname);
      if (!match) return send(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await match.fn({
        db, today: todayIso(), params: match.params, query: url.searchParams, body,
        dbPath: DEFAULT_DB_PATH, replaceDb: (next) => { db = next; },
      });
      send(res, 200, out);
      if (req.method === 'POST') console.log(`${req.method} ${url.pathname} ${Date.now() - started}ms`);
      return;
    }
    if (req.method === 'GET' && (await serveStatic(url.pathname, res))) return;
    if (req.method === 'GET' && (await serveStatic('/', res))) return;
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    send(res, status, { error: err.message, details: err.details ?? null });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`RKB Obsidian portal running at http://localhost:${PORT}  (today = ${todayIso()})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
