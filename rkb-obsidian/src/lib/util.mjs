// Small shared helpers: dates as day numbers, deterministic randomness, CSV, geo.

const DAY_MS = 86_400_000;

/** ISO 'YYYY-MM-DD' -> integer days since the Unix epoch (UTC). */
export function dayNum(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** Integer day number -> ISO 'YYYY-MM-DD'. */
export function isoDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(iso, days) {
  return isoDay(dayNum(iso) + days);
}

export function diffDays(a, b) {
  return dayNum(a) - dayNum(b);
}

/** Day of week for a day number: 0 = Sunday ... 6 = Saturday. */
export function weekday(n) {
  return (new Date(n * DAY_MS).getUTCDay());
}

export function isWorkday(n) {
  const w = weekday(n);
  return w !== 0 && w !== 6;
}

/** Monday of the week containing day n. */
export function weekStart(n) {
  return n - ((weekday(n) + 6) % 7);
}

export function monthKey(iso) {
  return iso.slice(0, 7);
}

/** ISO week number (1-53). */
export function isoWeek(n) {
  const d = new Date(n * DAY_MS);
  const thursday = n + 3 - ((d.getUTCDay() + 6) % 7);
  const yearStart = Math.round(Date.UTC(new Date(thursday * DAY_MS).getUTCFullYear(), 0, 1) / DAY_MS);
  return 1 + Math.floor((thursday - yearStart) / 7);
}

/**
 * The portal's notion of "today". RKB_TODAY pins it (tests, demos); otherwise the
 * machine's local calendar date.
 */
export function todayIso() {
  if (process.env.RKB_TODAY) return process.env.RKB_TODAY;
  const now = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** mulberry32: small, fast, deterministic PRNG. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.weighted = (items, weightOf) => {
    const total = items.reduce((s, it) => s + weightOf(it), 0);
    let r = rng() * total;
    for (const it of items) {
      r -= weightOf(it);
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  };
  return rng;
}

/** Minimal CSV parser for the (unquoted) source dataset. */
export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.shift().split(',').map((h) => h.trim());
  return lines.map((line) => {
    const cells = line.split(',');
    const row = {};
    header.forEach((h, i) => {
      const raw = (cells[i] ?? '').trim();
      const num = Number(raw);
      row[h] = raw !== '' && !Number.isNaN(num) && !/^\d{4}-\d{2}-\d{2}$/.test(raw) ? num : raw;
    });
    return row;
  });
}

/** Great-circle distance in km. */
export function distanceKm(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** Truck transit estimate in days between two points. */
export function transitDays(lat1, lng1, lat2, lng2) {
  return 1 + Math.ceil(distanceKm(lat1, lng1, lat2, lng2) / 650);
}

export function round(v, digits = 0) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function sum(arr, fn = (x) => x) {
  return arr.reduce((s, x) => s + fn(x), 0);
}

export function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

export function pad(n, width) {
  return String(n).padStart(width, '0');
}
