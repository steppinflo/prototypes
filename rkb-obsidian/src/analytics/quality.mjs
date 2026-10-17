// Supplier & parts quality over time: monthly delivery and failure trends per supplier,
// recurring failure patterns, failure clusters within a lot, and repeat late deliveries.

import { round, sum } from '../lib/util.mjs';

/** "Seal leak at pump shaft reported by X (...)" -> "Seal leak at pump shaft" */
export function symptomOf(description) {
  return description.split(/ reported by | found during | during end-of-line| \(|;/)[0].trim();
}

function monthsIn(from, to) {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export function qualityTrends(db, { from, to, today, supplierId = null }) {
  const sup = supplierId ? ' AND supplier_id = ?' : '';
  const args = (...a) => (supplierId ? [...a, supplierId] : a);
  const months = monthsIn(from, to);
  const suppliers = db.prepare(`SELECT id, code, name FROM suppliers ${supplierId ? 'WHERE id = ?' : ''} ORDER BY id`).all(...(supplierId ? [supplierId] : []));

  // Monthly delivery performance per supplier.
  const del = db.prepare(`SELECT supplier_id, substr(actual_delivery_date, 1, 7) AS month, COUNT(*) AS pos,
      AVG(CASE WHEN actual_delivery_date <= expected_delivery_date THEN 1.0 ELSE 0 END) AS on_time,
      AVG(MAX(0, julianday(actual_delivery_date) - julianday(expected_delivery_date))) AS avg_late
    FROM inventory_orders WHERE status = 'received' AND actual_delivery_date BETWEEN ? AND ?${sup} GROUP BY 1, 2`).all(...args(from, to));
  // Monthly failures per supplier, and units installed (for a rate).
  const fails = db.prepare(`SELECT supplier_id, substr(reported_date, 1, 7) AS month, stage, SUM(quantity) AS n
    FROM failure_reports WHERE reported_date BETWEEN ? AND ?${sup} GROUP BY 1, 2, 3`).all(...args(from, to));
  const installs = db.prepare(`SELECT ip.supplier_id, substr(tp.installed_date, 1, 7) AS month, SUM(tp.quantity) AS n
    FROM tractor_parts tp JOIN inventory_parts ip ON ip.id = tp.inventory_part_id
    WHERE tp.installed_date BETWEEN date(?, '-12 months') AND ?${supplierId ? ' AND ip.supplier_id = ?' : ''} GROUP BY 1, 2`).all(...args(from, to));
  const installsTrailing = (sid, month) => {
    const [y, m] = month.split('-').map(Number);
    const start = `${y - 1}-${String(m).padStart(2, '0')}`;
    return sum(installs.filter((i) => i.supplier_id === sid && i.month > start && i.month <= month), (i) => i.n);
  };
  const trends = suppliers.map((s) => ({
    supplierId: s.id, code: s.code, name: s.name,
    months: months.map((month) => {
      const d = del.find((x) => x.supplier_id === s.id && x.month === month);
      const f = fails.filter((x) => x.supplier_id === s.id && x.month === month);
      const total = sum(f, (x) => x.n);
      const base = installsTrailing(s.id, month);
      return {
        month,
        purchaseOrders: d?.pos ?? 0,
        onTimeRate: d ? round(d.on_time, 3) : null,
        avgDaysLate: d ? round(d.avg_late, 1) : null,
        failures: total,
        fieldFailures: sum(f.filter((x) => x.stage === 'field'), (x) => x.n),
        // failures per 1,000 units installed over the trailing 12 months
        failureRate: base ? round((1000 * total) / base, 2) : null,
      };
    }),
  }));
  for (const t of trends) {
    const half = Math.floor(t.months.length / 2);
    const avg = (arr, k) => {
      const v = arr.map((m) => m[k]).filter((x) => x !== null);
      return v.length ? sum(v) / v.length : null;
    };
    const early = t.months.slice(0, half);
    const late = t.months.slice(half);
    t.direction = {
      onTime: { before: round(avg(early, 'onTimeRate') ?? 0, 3), after: round(avg(late, 'onTimeRate') ?? 0, 3) },
      failureRate: { before: round(avg(early, 'failureRate') ?? 0, 2), after: round(avg(late, 'failureRate') ?? 0, 2) },
    };
    const fr = t.direction.failureRate;
    const ot = t.direction.onTime;
    // Only judge direction when there are enough months to compare halves.
    t.worsening = t.months.length >= 4 && ((fr.after > fr.before * 1.25 && fr.after - fr.before > 0.5) || ot.after < ot.before - 0.1);
  }

  // Recurring failure patterns: same part, supplier and symptom, 3+ times in the period.
  const rows = db.prepare(`SELECT f.*, ip.lot_number, pt.name AS part_name, s.name AS supplier_name
    FROM failure_reports f JOIN part_types pt ON pt.part_number = f.part_number JOIN suppliers s ON s.id = f.supplier_id
    LEFT JOIN inventory_parts ip ON ip.id = f.inventory_part_id
    WHERE f.reported_date BETWEEN ? AND ?${supplierId ? ' AND f.supplier_id = ?' : ''}`).all(...args(from, to));
  const groups = new Map();
  for (const f of rows) {
    const symptom = symptomOf(f.description);
    const key = `${f.part_number}|${f.supplier_id}|${f.failure_class}|${symptom}`;
    if (!groups.has(key)) groups.set(key, { partNumber: f.part_number, partName: f.part_name, supplierId: f.supplier_id, supplierName: f.supplier_name, failureClass: f.failure_class, symptom, reports: [] });
    groups.get(key).reports.push(f);
  }
  const mid = midpoint(from, to);
  const recurring = [...groups.values()]
    .map((g) => {
      const units = sum(g.reports, (f) => f.quantity);
      const recent = sum(g.reports.filter((f) => f.reported_date > mid), (f) => f.quantity);
      return {
        partNumber: g.partNumber, partName: g.partName, supplierId: g.supplierId, supplierName: g.supplierName,
        failureClass: g.failureClass, symptom: g.symptom, occurrences: g.reports.length, units,
        firstSeen: g.reports.map((f) => f.reported_date).sort()[0],
        lastSeen: g.reports.map((f) => f.reported_date).sort().at(-1),
        stages: [...new Set(g.reports.map((f) => f.stage))],
        open: g.reports.filter((f) => f.status !== 'resolved').length,
        customers: new Set(g.reports.map((f) => f.customer_id).filter(Boolean)).size,
        lots: new Set(g.reports.map((f) => f.lot_number).filter(Boolean)).size,
        recentHalf: recent, earlierHalf: units - recent,
        trend: recent > (units - recent) * 1.3 ? 'rising' : recent < (units - recent) * 0.7 ? 'falling' : 'steady',
        reportIds: g.reports.map((f) => f.id).slice(-8),
      };
    })
    .filter((g) => g.occurrences >= 3)
    .sort((a, b) => b.units - a.units);

  // Lots with more than one failure.
  const lotClusters = db.prepare(`SELECT ip.lot_number, f.part_number, f.supplier_id, s.name AS supplier_name, COUNT(*) AS reports, SUM(f.quantity) AS units,
      MIN(f.reported_date) AS first_seen, MAX(f.reported_date) AS last_seen, GROUP_CONCAT(DISTINCT f.stage) AS stages,
      (SELECT SUM(quantity) FROM inventory_parts x WHERE x.lot_number = ip.lot_number) AS lot_size
    FROM failure_reports f JOIN inventory_parts ip ON ip.id = f.inventory_part_id JOIN suppliers s ON s.id = f.supplier_id
    WHERE f.reported_date BETWEEN ? AND ?${supplierId ? ' AND f.supplier_id = ?' : ''}
    GROUP BY ip.lot_number, f.part_number, f.supplier_id HAVING COUNT(*) >= 2 ORDER BY units DESC, last_seen DESC LIMIT 25`).all(...args(from, to));

  // Repeat late deliveries by supplier x part.
  const lateDeliveries = db.prepare(`SELECT io.supplier_id, s.name AS supplier_name, io.part_number, COUNT(*) AS pos,
      SUM(CASE WHEN io.actual_delivery_date > io.expected_delivery_date THEN 1 ELSE 0 END) AS late,
      AVG(CASE WHEN io.actual_delivery_date > io.expected_delivery_date THEN julianday(io.actual_delivery_date) - julianday(io.expected_delivery_date) END) AS avg_late,
      MAX(julianday(io.actual_delivery_date) - julianday(io.expected_delivery_date)) AS worst
    FROM inventory_orders io JOIN suppliers s ON s.id = io.supplier_id
    WHERE io.status = 'received' AND io.actual_delivery_date BETWEEN ? AND ?${supplierId ? ' AND io.supplier_id = ?' : ''}
    GROUP BY 1, 3 HAVING late >= 3 ORDER BY CAST(late AS REAL) / pos DESC, late DESC`).all(...args(from, to))
    .map((x) => ({ ...x, lateRate: round(x.late / x.pos, 3), avg_late: round(x.avg_late ?? 0, 1), worst: Math.round(x.worst) }));

  return { from, to, today, months, trends, recurring, lotClusters, lateDeliveries };
}

function midpoint(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return new Date((a + b) / 2).toISOString().slice(0, 10);
}
