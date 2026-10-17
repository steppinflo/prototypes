// Parts Performance Tracking (a formula, per the solutions doc - not a trained model).
//
// For every part x supplier it combines failure history (receiving inspection,
// manufacturing/QC and field failures, normalised by units installed) with delivery
// history (on-time rate and average days late) into a 0-100 score:
//
//   score = 100 x (0.5 x quality + 0.3 x on-time rate + 0.2 x timeliness)
//     quality    = 1 - failure rate / (2 x average failure rate for that part category), floored at 0
//     timeliness = 1 - average days late / 15, floored at 0
//
// Supplier reliability (the diagram's "Reliability Score") is the PO-weighted average of
// its part scores. The tracker also outputs what the planner needs: expected scrap
// rate per part (manufacturing + receiving losses) and predicted delivery slip per supplier.

import { clamp, round, sum } from '../lib/util.mjs';

const MIN_SAMPLE = 15;

export function partsPerformance(db) {
  const parts = db.prepare('SELECT part_number, name, category FROM part_types').all();
  const suppliers = db.prepare('SELECT id, code, name, quoted_lead_days FROM suppliers').all();
  const pairs = db.prepare(`
    SELECT sp.supplier_id, sp.part_number, sp.is_primary, sp.unit_cost, sp.quoted_lead_days
    FROM supplier_parts sp`).all();

  const installs = new Map(db.prepare(`
    SELECT ip.part_number || '|' || ip.supplier_id AS k, SUM(tp.quantity) AS n
    FROM tractor_parts tp JOIN inventory_parts ip ON ip.id = tp.inventory_part_id GROUP BY 1`).all().map((r) => [r.k, r.n]));
  const failures = db.prepare(`
    SELECT part_number || '|' || supplier_id AS k, stage, SUM(quantity) AS n
    FROM failure_reports GROUP BY 1, 2`).all();
  const fail = (k, stage) => failures.find((f) => f.k === k && f.stage === stage)?.n ?? 0;
  const received = new Map(db.prepare(`
    SELECT part_number || '|' || supplier_id AS k, SUM(quantity_received + quantity_rejected) AS n, COUNT(*) AS pos,
           SUM(CASE WHEN actual_delivery_date <= expected_delivery_date THEN 1 ELSE 0 END) AS on_time,
           AVG(MAX(0, julianday(actual_delivery_date) - julianday(expected_delivery_date))) AS avg_late,
           AVG(julianday(actual_delivery_date) - julianday(expected_delivery_date)) AS avg_slip
    FROM inventory_orders WHERE status = 'received' GROUP BY 1`).all().map((r) => [r.k, r]));

  const rows = pairs.map((p) => {
    const k = `${p.part_number}|${p.supplier_id}`;
    const part = parts.find((x) => x.part_number === p.part_number);
    const mfg = fail(k, 'manufacturing');
    const field = fail(k, 'field');
    const recv = fail(k, 'receiving');
    const inst = (installs.get(k) ?? 0) + mfg; // scrapped units were installed once too
    const rec = received.get(k) ?? { n: 0, pos: 0, on_time: 0, avg_late: 0, avg_slip: 0 };
    return {
      partNumber: p.part_number,
      partName: part.name,
      category: part.category,
      supplierId: p.supplier_id,
      isPrimary: !!p.is_primary,
      unitCost: p.unit_cost,
      quotedLeadDays: p.quoted_lead_days,
      unitsInstalled: inst,
      unitsReceived: rec.n,
      purchaseOrders: rec.pos,
      failures: { receiving: recv, manufacturing: mfg, field, total: recv + mfg + field },
      failureRate: inst ? (mfg + field) / inst : null,
      mfgScrapRate: inst ? mfg / inst : null,
      receivingRejectRate: rec.n ? recv / rec.n : null,
      onTimeRate: rec.pos ? rec.on_time / rec.pos : null,
      avgDaysLate: rec.pos ? rec.avg_late : null,
      avgSlipDays: rec.pos ? rec.avg_slip : null,
    };
  });

  // Category baselines for normalising failure rates.
  const catRate = new Map();
  for (const cat of new Set(rows.map((r) => r.category))) {
    const rs = rows.filter((r) => r.category === cat);
    const inst = sum(rs, (r) => r.unitsInstalled);
    catRate.set(cat, inst ? sum(rs, (r) => r.failures.manufacturing + r.failures.field) / inst : 0);
  }

  // Supplier-level delivery behaviour (used to shrink small part samples).
  const supDelivery = new Map(db.prepare(`
    SELECT supplier_id, COUNT(*) AS pos,
           AVG(CASE WHEN actual_delivery_date <= expected_delivery_date THEN 1.0 ELSE 0 END) AS on_time,
           AVG(MAX(0, julianday(actual_delivery_date) - julianday(expected_delivery_date))) AS avg_late,
           AVG(julianday(actual_delivery_date) - julianday(expected_delivery_date)) AS avg_slip
    FROM inventory_orders WHERE status = 'received' GROUP BY 1`).all().map((r) => [r.supplier_id, r]));

  for (const r of rows) {
    const sup = supDelivery.get(r.supplierId) ?? { on_time: 0.5, avg_late: 5, avg_slip: 0 };
    const w = r.purchaseOrders / (r.purchaseOrders + 5);
    const onTime = w * (r.onTimeRate ?? 0) + (1 - w) * sup.on_time;
    const late = w * (r.avgDaysLate ?? 0) + (1 - w) * sup.avg_late;
    const base = catRate.get(r.category) || 0.01;
    const quality = r.unitsInstalled >= MIN_SAMPLE ? clamp(1 - (r.failureRate ?? 0) / (2 * base), 0, 1) : 0.5;
    r.score = round(100 * (0.5 * quality + 0.3 * onTime + 0.2 * clamp(1 - late / 15, 0, 1)), 1);
    r.qualityScore = round(quality * 100, 0);
    r.lowSample = r.unitsInstalled < MIN_SAMPLE;
    r.predictedSlipDays = round(Math.max(0, w * (r.avgSlipDays ?? 0) + (1 - w) * sup.avg_slip), 1);
    r.categoryFailureRate = base;
  }

  const supplierScores = suppliers.map((s) => {
    const rs = rows.filter((r) => r.supplierId === s.id && r.purchaseOrders > 0);
    const weight = sum(rs, (r) => r.purchaseOrders);
    const del = supDelivery.get(s.id);
    const score = weight ? sum(rs, (r) => r.score * r.purchaseOrders) / weight : null;
    const failures = sum(rs, (r) => r.failures.total);
    const installed = sum(rs, (r) => r.unitsInstalled);
    return {
      supplierId: s.id,
      code: s.code,
      name: s.name,
      reliabilityScore: score === null ? null : round(score, 1),
      partsSupplied: rows.filter((r) => r.supplierId === s.id).length,
      purchaseOrders: del?.pos ?? 0,
      onTimeRate: del ? round(del.on_time, 3) : null,
      avgDaysLate: del ? round(del.avg_late, 1) : null,
      predictedSlipDays: del ? round(Math.max(0, del.avg_slip), 1) : 0,
      failures,
      failuresPer100Installed: installed ? round((100 * failures) / installed, 2) : null,
    };
  });

  // Actionable flags.
  const flags = [];
  for (const part of parts) {
    const rs = rows.filter((r) => r.partNumber === part.part_number && !r.lowSample);
    const primary = rs.find((r) => r.isPrimary);
    for (const alt of rs.filter((r) => !r.isPrimary)) {
      if (primary && alt.score - primary.score >= 8) {
        flags.push({ type: 'shift_volume', partNumber: part.part_number, supplierId: alt.supplierId,
          message: `${alt.supplierId} outperforms primary ${primary.supplierId} on ${part.part_number} (${alt.score} vs ${primary.score}); consider shifting volume` });
      }
    }
    for (const r of rs) {
      if (r.failureRate > 2 * r.categoryFailureRate && r.failures.field + r.failures.manufacturing >= 5) {
        flags.push({ type: 'quality_review', partNumber: r.partNumber, supplierId: r.supplierId,
          message: `${r.partNumber} from ${r.supplierId} fails at ${round(r.failureRate * 100, 1)}% vs ${round(r.categoryFailureRate * 100, 1)}% for ${r.category} parts` });
      }
    }
  }

  return {
    method: 'score = 100 x (0.5 x quality + 0.3 x on-time rate + 0.2 x timeliness); quality = 1 - failure rate / (2 x category average)',
    parts: rows.map((r) => ({
      ...r,
      failureRate: r.failureRate === null ? null : round(r.failureRate, 4),
      mfgScrapRate: r.mfgScrapRate === null ? null : round(r.mfgScrapRate, 4),
      receivingRejectRate: r.receivingRejectRate === null ? null : round(r.receivingRejectRate, 4),
      onTimeRate: r.onTimeRate === null ? null : round(r.onTimeRate, 3),
      avgDaysLate: r.avgDaysLate === null ? null : round(r.avgDaysLate, 1),
      avgSlipDays: r.avgSlipDays === null ? null : round(r.avgSlipDays, 1),
      categoryFailureRate: round(r.categoryFailureRate, 4),
    })),
    suppliers: supplierScores,
    flags,
  };
}

/** Persist supplier reliability scores (the diagram's Supplier.Reliability Score). */
export function storeReliabilityScores(db, perf) {
  const stmt = db.prepare('UPDATE suppliers SET reliability_score = ? WHERE id = ?');
  for (const s of perf.suppliers) stmt.run(s.reliabilityScore, s.supplierId);
}

/** Expected planning yield loss for a part: QC scrap + receiving rejects (PO-weighted across suppliers). */
export function expectedLossRate(perf, partNumber) {
  const rs = perf.parts.filter((r) => r.partNumber === partNumber && r.unitsInstalled > 0);
  const inst = sum(rs, (r) => r.unitsInstalled);
  if (!inst) return 0;
  const scrap = sum(rs, (r) => (r.mfgScrapRate ?? 0) * r.unitsInstalled) / inst;
  const reject = sum(rs, (r) => (r.receivingRejectRate ?? 0) * r.unitsInstalled) / inst;
  return round(scrap + reject, 4);
}
