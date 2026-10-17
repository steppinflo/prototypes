// HTTP API. Read endpoints combine live records with model output; write endpoints
// call actions.mjs and invalidate the model cache.

import { runModels, invalidateModels, readSettings } from '../models/index.mjs';
import { ACTIVE_ORDER_STATUSES } from '../models/inventoryPlan.mjs';
import { recreateDb, getSetting } from '../db/index.mjs';
import { seedDatabase } from '../seed/index.mjs';
import { transitDays, sum, addDays } from '../lib/util.mjs';
import { partsPerformance } from '../models/partsPerformance.mjs';
import { costReport } from '../analytics/costs.mjs';
import { qualityTrends } from '../analytics/quality.mjs';
import * as actions from './actions.mjs';

/** ?from=&to= with defaults (last 12 months); dates are clamped to today. */
function rangeOf(query, today, defaultDays = 365) {
  const valid = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');
  let to = valid(query.get('to')) ? query.get('to') : today;
  if (to > today) to = today;
  let from = valid(query.get('from')) ? query.get('from') : addDays(to, -defaultDays + 1);
  if (from > to) from = to;
  return { from, to };
}

const { ApiError } = actions;
const routes = [];
const get = (path, fn) => routes.push({ method: 'GET', path, fn });
const post = (path, fn) => routes.push({ method: 'POST', path, fn });

function compile(path) {
  const keys = [];
  const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  })}$`);
  return { re, keys };
}

export function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    r.compiled ??= compile(r.path);
    const m = r.compiled.re.exec(pathname);
    if (m) return { fn: r.fn, params: Object.fromEntries(r.compiled.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

const placeholders = (arr) => arr.map(() => '?').join(',');
const limitOf = (q, def = 200) => Math.min(Number(q.get('limit')) || def, 2000);

// ---- Meta & dashboard -------------------------------------------------------------

get('/api/meta', ({ db, today }) => {
  const m = runModels(db, today);
  return {
    today,
    seedDate: getSetting(db, 'seed_date'),
    datasetYearShift: Number(getSetting(db, 'dataset_year_shift')),
    datasetRowsUsed: Number(getSetting(db, 'dataset_rows_used')),
    settings: readSettings(db),
    modelsComputedMs: m.computedMs,
    openTasks: m.tasks.length,
    urgentTasks: m.tasks.filter((t) => t.severity === 'critical' || t.overdueDays > 0).length,
  };
});

get('/api/dashboard', ({ db, today }) => {
  const { tasks, plan, forecast } = runModels(db, today);
  const partStatus = new Map(plan.parts.map((p) => [p.partNumber, p]));
  const parts = db.prepare('SELECT * FROM v_part_balances ORDER BY category, part_number').all().map((b) => ({
    ...b,
    status: partStatus.get(b.part_number)?.status ?? 'ok',
    requirement90: partStatus.get(b.part_number)?.grossRequirement ?? 0,
  }));
  const tractorRows = db.prepare(`SELECT model_number, status, COUNT(*) AS n FROM tractors
    WHERE status != 'delivered' GROUP BY 1, 2`).all();
  const models = db.prepare('SELECT model_number, name FROM tractor_models ORDER BY model_number').all();
  const tractors = models.map((m) => {
    const row = { model: m.model_number, name: m.name };
    for (const s of ['in_production', 'qc_hold', 'inventoried', 'earmarked', 'shipping']) {
      row[s] = tractorRows.find((r) => r.model_number === m.model_number && r.status === s)?.n ?? 0;
    }
    return row;
  });
  const risk = new Map(plan.orderRisks.map((r) => [r.orderId, r]));
  const orders = db.prepare(`
    SELECT o.id, o.model_number, o.quantity, o.status, o.submission_date, o.expected_delivery_date, c.id AS customer_id, c.name AS customer_name,
      (SELECT COUNT(*) FROM tractors t WHERE t.customer_order_id = o.id AND t.status IN ('earmarked','shipping','delivered')) AS built,
      (SELECT COUNT(*) FROM tractors t WHERE t.customer_order_id = o.id AND t.status IN ('in_production','qc_hold')) AS building,
      (SELECT COUNT(*) FROM tractors t WHERE t.customer_order_id = o.id AND t.status IN ('shipping','delivered')) AS shipped
    FROM customer_orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.status IN (${placeholders(ACTIVE_ORDER_STATUSES)}) ORDER BY o.expected_delivery_date`).all(...ACTIVE_ORDER_STATUSES)
    .map((o) => ({ ...o, risk: risk.get(o.id) ?? null }));
  return {
    today,
    tasks,
    parts,
    tractors,
    orders,
    demand: { weekly: plan.demandWeekly, forecastTotals: forecast.totals, horizonDays: plan.horizonDays },
    summary: plan.summary,
  };
});

// ---- Planning (models) --------------------------------------------------------------

get('/api/forecast', ({ db, today }) => {
  const { forecast } = runModels(db, today);
  return { ...forecast, models: forecast.models.map(({ daily, ...m }) => m) };
});

get('/api/plan', ({ db, today }) => runModels(db, today).plan);

get('/api/performance', ({ db, today }) => runModels(db, today).performance);

get('/api/tasks', ({ db, today }) => runModels(db, today).tasks);

get('/api/settings', ({ db }) => readSettings(db));

post('/api/settings', ({ db, body }) => {
  const changed = actions.updateSettings(db, body);
  invalidateModels();
  return changed;
});

// ---- Customer orders --------------------------------------------------------------

get('/api/orders', ({ db, today, query }) => {
  const status = query.get('status');
  const q = query.get('q');
  const where = [];
  const args = [];
  if (status === 'active') {
    where.push(`o.status IN (${placeholders(ACTIVE_ORDER_STATUSES)})`);
    args.push(...ACTIVE_ORDER_STATUSES);
  } else if (status) {
    where.push('o.status = ?');
    args.push(status);
  }
  if (q) {
    where.push('(o.id LIKE ? OR c.name LIKE ? OR o.model_number LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const sql = `FROM customer_orders o JOIN customers c ON c.id = o.customer_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args).n;
  const rows = db.prepare(`SELECT o.*, c.name AS customer_name,
      (SELECT COUNT(*) FROM tractors t WHERE t.customer_order_id = o.id) AS assigned
    ${sql} ORDER BY o.submission_date DESC, o.id DESC LIMIT ?`).all(...args, limitOf(query));
  const risk = new Map(runModels(db, today).plan.orderRisks.map((r) => [r.orderId, r]));
  return { total, rows: rows.map((r) => ({ ...r, risk: risk.get(r.id) ?? null })) };
});

get('/api/orders/:id', ({ db, today, params }) => {
  const o = db.prepare(`SELECT o.*, c.name AS customer_name, c.primary_address, c.lat, c.lng, c.segment
    FROM customer_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`).get(params.id);
  if (!o) throw new ApiError(404, `Order ${params.id} not found`);
  const { plan } = runModels(db, today);
  const plant = db.prepare('SELECT * FROM warehouses WHERE is_plant = 1').get();
  return {
    ...o,
    transitDays: transitDays(plant.lat, plant.lng, o.lat, o.lng),
    tractors: db.prepare('SELECT * FROM tractors WHERE customer_order_id = ? ORDER BY id').all(o.id),
    shipments: db.prepare('SELECT * FROM shipments WHERE customer_order_id = ? ORDER BY shipped_date').all(o.id),
    plannedBuilds: plan.builds.filter((b) => b.orderId === o.id),
    stockSuggestions: plan.stockAllocations.filter((a) => a.orderId === o.id),
    risk: plan.orderRisks.find((r) => r.orderId === o.id) ?? null,
    failures: db.prepare(`SELECT f.* FROM failure_reports f JOIN tractors t ON t.id = f.tractor_id
      WHERE t.customer_order_id = ? ORDER BY f.reported_date DESC`).all(o.id),
    notifications: db.prepare("SELECT * FROM notifications WHERE entity = 'customer_order' AND entity_id = ? ORDER BY id DESC").all(o.id),
  };
});

post('/api/orders', ({ db, today, body }) => mutate(() => actions.createOrder(db, today, body)));
post('/api/orders/:id/ship', ({ db, today, params }) => mutate(() => actions.shipOrder(db, today, params.id)));
post('/api/orders/:id/rush', ({ db, today, params }) => mutate(() => actions.rushOrder(db, today, params.id)));
post('/api/orders/:id/cancel', ({ db, today, params }) => mutate(() => actions.cancelOrder(db, today, params.id)));

// ---- Tractors -----------------------------------------------------------------------

get('/api/tractors', ({ db, query }) => {
  const where = [];
  const args = [];
  const status = query.get('status');
  if (status === 'current') where.push("t.status != 'delivered'");
  else if (status) {
    where.push('t.status = ?');
    args.push(status);
  }
  if (query.get('model')) {
    where.push('t.model_number = ?');
    args.push(query.get('model'));
  }
  if (query.get('q')) {
    where.push('(t.serial_number LIKE ? OR t.id LIKE ? OR t.customer_order_id LIKE ? OR c.name LIKE ?)');
    args.push(...Array(4).fill(`%${query.get('q')}%`));
  }
  const sql = `FROM tractors t LEFT JOIN customer_orders o ON o.id = t.customer_order_id LEFT JOIN customers c ON c.id = o.customer_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  return {
    total: db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args).n,
    rows: db.prepare(`SELECT t.*, c.id AS customer_id, c.name AS customer_name ${sql}
      ORDER BY t.build_start_date DESC, t.id DESC LIMIT ?`).all(...args, limitOf(query)),
  };
});

get('/api/tractors/:id', ({ db, params }) => {
  const t = db.prepare(`SELECT t.*, m.name AS model_name, o.expected_delivery_date, o.customer_id, c.name AS customer_name
    FROM tractors t JOIN tractor_models m ON m.model_number = t.model_number
    LEFT JOIN customer_orders o ON o.id = t.customer_order_id LEFT JOIN customers c ON c.id = o.customer_id
    WHERE t.id = ? OR t.serial_number = ?`).get(params.id, params.id);
  if (!t) throw new ApiError(404, `Tractor ${params.id} not found`);
  return {
    ...t,
    parts: db.prepare(`SELECT tp.*, pt.name AS part_name, pt.category, ip.serial_number, ip.lot_number, ip.supplier_id,
        s.name AS supplier_name, ip.inventory_order_id, ip.received_date
      FROM tractor_parts tp JOIN inventory_parts ip ON ip.id = tp.inventory_part_id
      JOIN part_types pt ON pt.part_number = tp.part_number JOIN suppliers s ON s.id = ip.supplier_id
      WHERE tp.tractor_id = ? ORDER BY pt.category, tp.part_number`).all(t.id),
    shipments: db.prepare(`SELECT sh.* FROM shipments sh JOIN shipment_tractors st ON st.shipment_id = sh.id WHERE st.tractor_id = ?`).all(t.id),
    failures: db.prepare('SELECT * FROM failure_reports WHERE tractor_id = ? ORDER BY reported_date DESC').all(t.id),
    serviceJobs: db.prepare('SELECT * FROM service_jobs WHERE tractor_id = ? ORDER BY created_date DESC').all(t.id),
    openOrdersForModel: t.customer_order_id ? [] : db.prepare(`SELECT o.id, c.name AS customer_name, o.quantity, o.expected_delivery_date,
        (SELECT COUNT(*) FROM tractors x WHERE x.customer_order_id = o.id) AS assigned
      FROM customer_orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.model_number = ? AND o.status IN (${placeholders(ACTIVE_ORDER_STATUSES)}) ORDER BY o.expected_delivery_date`)
      .all(t.model_number, ...ACTIVE_ORDER_STATUSES).filter((o) => o.assigned < o.quantity),
  };
});

post('/api/builds', ({ db, today, body }) => mutate(() => actions.startBuilds(db, today, body)));
post('/api/tractors/:id/complete', ({ db, today, params }) => mutate(() => actions.completeBuild(db, today, params.id)));
post('/api/tractors/:id/clear-hold', ({ db, today, params }) => mutate(() => actions.clearHold(db, today, params.id)));
post('/api/tractors/:id/earmark', ({ db, today, params, body }) => mutate(() => actions.earmarkTractor(db, today, params.id, body)));

// ---- Parts --------------------------------------------------------------------------

get('/api/parts', ({ db, today }) => {
  const { plan, performance } = runModels(db, today);
  const planBy = new Map(plan.parts.map((p) => [p.partNumber, p]));
  const recs = plan.recommendations;
  return db.prepare(`SELECT v.*, pt.pack_size, pt.min_order_qty,
      (SELECT sp.supplier_id FROM supplier_parts sp WHERE sp.part_number = v.part_number AND sp.is_primary = 1) AS primary_supplier
    FROM v_part_balances v JOIN part_types pt ON pt.part_number = v.part_number ORDER BY v.category, v.part_number`).all().map((p) => ({
    ...p,
    plan: planBy.get(p.part_number),
    nextRecommendation: recs.find((r) => r.partNumber === p.part_number) ?? null,
    suppliers: performance.parts.filter((r) => r.partNumber === p.part_number)
      .map((r) => ({ supplierId: r.supplierId, score: r.score, isPrimary: r.isPrimary })),
  }));
});

get('/api/parts/:pn', ({ db, today, params }) => {
  const part = db.prepare('SELECT pt.*, v.available, v.pending FROM part_types pt JOIN v_part_balances v ON v.part_number = pt.part_number WHERE pt.part_number = ?').get(params.pn);
  if (!part) throw new ApiError(404, `Part ${params.pn} not found`);
  const { plan, performance } = runModels(db, today);
  return {
    ...part,
    usedIn: db.prepare('SELECT b.model_number, b.quantity, m.name FROM bom_items b JOIN tractor_models m ON m.model_number = b.model_number WHERE b.part_number = ?').all(part.part_number),
    suppliers: db.prepare('SELECT sp.*, s.name, s.code FROM supplier_parts sp JOIN suppliers s ON s.id = sp.supplier_id WHERE sp.part_number = ? ORDER BY sp.is_primary DESC').all(part.part_number)
      .map((s) => ({ ...s, performance: performance.parts.find((r) => r.partNumber === part.part_number && r.supplierId === s.supplier_id) })),
    stock: db.prepare(`SELECT ip.*, s.name AS supplier_name FROM inventory_parts ip JOIN suppliers s ON s.id = ip.supplier_id
      WHERE ip.part_number = ? AND ip.status = 'in_stock' ORDER BY ip.received_date, ip.id`).all(part.part_number),
    openOrders: plan.scheduledReceipts.filter((r) => r.partNumber === part.part_number),
    plan: plan.parts.find((p) => p.partNumber === part.part_number),
    recommendations: plan.recommendations.filter((r) => r.partNumber === part.part_number),
    projection: plan.projections[part.part_number],
    recentInstalls: db.prepare(`SELECT tp.*, t.serial_number, t.model_number, ip.serial_number AS part_serial, ip.lot_number, ip.supplier_id
      FROM tractor_parts tp JOIN tractors t ON t.id = tp.tractor_id JOIN inventory_parts ip ON ip.id = tp.inventory_part_id
      WHERE tp.part_number = ? ORDER BY tp.installed_date DESC LIMIT 25`).all(part.part_number),
    failures: db.prepare('SELECT * FROM failure_reports WHERE part_number = ? ORDER BY reported_date DESC LIMIT 25').all(part.part_number),
  };
});

get('/api/inventory-parts/:id', ({ db, params }) => {
  const ip = db.prepare(`SELECT ip.*, pt.name AS part_name, pt.category, s.name AS supplier_name
    FROM inventory_parts ip JOIN part_types pt ON pt.part_number = ip.part_number JOIN suppliers s ON s.id = ip.supplier_id
    WHERE ip.id = ? OR ip.serial_number = ?`).get(params.id, params.id);
  if (!ip) throw new ApiError(404, `Inventory part ${params.id} not found`);
  return {
    ...ip,
    inventoryOrder: ip.inventory_order_id ? db.prepare('SELECT * FROM inventory_orders WHERE id = ?').get(ip.inventory_order_id) : null,
    installedIn: db.prepare(`SELECT tp.*, t.serial_number, t.model_number, t.status AS tractor_status, c.name AS customer_name
      FROM tractor_parts tp JOIN tractors t ON t.id = tp.tractor_id
      LEFT JOIN customer_orders o ON o.id = t.customer_order_id LEFT JOIN customers c ON c.id = o.customer_id
      WHERE tp.inventory_part_id = ? ORDER BY tp.installed_date`).all(ip.id),
    failures: db.prepare('SELECT * FROM failure_reports WHERE inventory_part_id = ? ORDER BY reported_date DESC').all(ip.id),
  };
});

// ---- Purchasing (inventory orders) ---------------------------------------------------

get('/api/inventory-orders', ({ db, today, query }) => {
  const where = [];
  const args = [];
  const status = query.get('status');
  if (status === 'open') where.push("io.status IN ('submitted','confirmed','in_transit')");
  else if (status) {
    where.push('io.status = ?');
    args.push(status);
  }
  for (const [param, col] of [['part', 'io.part_number'], ['supplier', 'io.supplier_id']]) {
    if (query.get(param)) {
      where.push(`${col} = ?`);
      args.push(query.get(param));
    }
  }
  const sql = `FROM inventory_orders io JOIN suppliers s ON s.id = io.supplier_id JOIN part_types pt ON pt.part_number = io.part_number
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const predicted = new Map(runModels(db, today).plan.scheduledReceipts.map((r) => [r.poId, r]));
  return {
    total: db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args).n,
    rows: db.prepare(`SELECT io.*, s.name AS supplier_name, pt.name AS part_name ${sql}
      ORDER BY io.submission_date DESC, io.id DESC LIMIT ?`).all(...args, limitOf(query))
      .map((r) => ({ ...r, prediction: predicted.get(r.id) ?? null })),
  };
});

get('/api/inventory-orders/:id', ({ db, today, params }) => {
  const po = db.prepare(`SELECT io.*, s.name AS supplier_name, pt.name AS part_name, pt.serialized
    FROM inventory_orders io JOIN suppliers s ON s.id = io.supplier_id JOIN part_types pt ON pt.part_number = io.part_number
    WHERE io.id = ?`).get(params.id);
  if (!po) throw new ApiError(404, `Inventory order ${params.id} not found`);
  return {
    ...po,
    prediction: runModels(db, today).plan.scheduledReceipts.find((r) => r.poId === po.id) ?? null,
    shipments: db.prepare('SELECT * FROM shipments WHERE inventory_order_id = ?').all(po.id),
    inventoryParts: db.prepare('SELECT * FROM inventory_parts WHERE inventory_order_id = ? ORDER BY id LIMIT 200').all(po.id),
    failures: db.prepare('SELECT * FROM failure_reports WHERE inventory_order_id = ? ORDER BY reported_date DESC').all(po.id),
    notifications: db.prepare("SELECT * FROM notifications WHERE entity = 'inventory_order' AND entity_id = ? ORDER BY id DESC").all(po.id),
  };
});

post('/api/inventory-orders', ({ db, today, body }) => mutate(() => actions.placeInventoryOrder(db, today, body)));
post('/api/inventory-orders/:id/ship', ({ db, today, params }) => mutate(() => actions.markInventoryOrderShipped(db, today, params.id)));
post('/api/inventory-orders/:id/expedite', ({ db, today, params }) => mutate(() => actions.expediteInventoryOrder(db, today, params.id)));
post('/api/inventory-orders/:id/receive', ({ db, today, params, body }) => mutate(() => actions.receiveInventoryOrder(db, today, params.id, body)));

// ---- Shipping -----------------------------------------------------------------------

get('/api/shipments', ({ db, today, query }) => {
  const where = [];
  const args = [];
  if (query.get('direction')) {
    where.push('sh.direction = ?');
    args.push(query.get('direction'));
  }
  const status = query.get('status') ?? 'in_transit';
  if (status !== 'all') {
    where.push('sh.status = ?');
    args.push(status);
  }
  const rows = db.prepare(`
    SELECT sh.*, io.part_number, io.quantity AS po_quantity, io.expected_delivery_date AS po_expected, io.supplier_id,
      o.customer_id, c.name AS customer_name, o.expected_delivery_date AS order_expected, o.model_number,
      (SELECT COUNT(*) FROM shipment_tractors st WHERE st.shipment_id = sh.id) AS tractor_count
    FROM shipments sh LEFT JOIN inventory_orders io ON io.id = sh.inventory_order_id
    LEFT JOIN customer_orders o ON o.id = sh.customer_order_id LEFT JOIN customers c ON c.id = o.customer_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY sh.shipped_date DESC LIMIT ?`).all(...args, limitOf(query, 300));
  return rows.map((r) => ({
    ...r,
    late: r.status === 'in_transit' ? r.expected_arrival_date < today
      || (r.direction === 'inbound' ? r.expected_arrival_date > r.po_expected : r.expected_arrival_date > r.order_expected) : false,
  }));
});

post('/api/shipments/:id/deliver', ({ db, today, params }) => mutate(() => actions.deliverShipment(db, today, params.id)));

// ---- Quality ------------------------------------------------------------------------

get('/api/failures', ({ db, query }) => {
  const where = [];
  const args = [];
  for (const [param, col] of [['stage', 'f.stage'], ['part', 'f.part_number'], ['supplier', 'f.supplier_id'], ['severity', 'f.severity'], ['class', 'f.failure_class']]) {
    if (query.get(param)) {
      where.push(`${col} = ?`);
      args.push(query.get(param));
    }
  }
  if (query.get('from')) {
    where.push('f.reported_date >= ?');
    args.push(query.get('from'));
  }
  if (query.get('to')) {
    where.push('f.reported_date <= ?');
    args.push(query.get('to'));
  }
  const status = query.get('status');
  if (status === 'unresolved') where.push("f.status != 'resolved'");
  else if (status) {
    where.push('f.status = ?');
    args.push(status);
  }
  const sql = `FROM failure_reports f JOIN part_types pt ON pt.part_number = f.part_number JOIN suppliers s ON s.id = f.supplier_id
    LEFT JOIN tractors t ON t.id = f.tractor_id LEFT JOIN customers c ON c.id = f.customer_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  return {
    total: db.prepare(`SELECT COUNT(*) AS n ${sql}`).get(...args).n,
    rows: db.prepare(`SELECT f.*, pt.name AS part_name, s.name AS supplier_name, t.serial_number, c.name AS customer_name ${sql}
      ORDER BY f.reported_date DESC, f.id DESC LIMIT ?`).all(...args, limitOf(query)),
  };
});

get('/api/failures/:id', ({ db, params }) => {
  const f = db.prepare(`SELECT f.*, pt.name AS part_name, s.name AS supplier_name, t.serial_number, t.model_number, c.name AS customer_name,
      ip.serial_number AS part_serial, ip.lot_number
    FROM failure_reports f JOIN part_types pt ON pt.part_number = f.part_number JOIN suppliers s ON s.id = f.supplier_id
    LEFT JOIN tractors t ON t.id = f.tractor_id LEFT JOIN customers c ON c.id = f.customer_id
    LEFT JOIN inventory_parts ip ON ip.id = f.inventory_part_id WHERE f.id = ?`).get(params.id);
  if (!f) throw new ApiError(404, `Failure ${params.id} not found`);
  const sameLot = f.lot_number ? db.prepare(`SELECT f2.id, f2.reported_date, f2.stage, f2.description FROM failure_reports f2
    JOIN inventory_parts ip ON ip.id = f2.inventory_part_id WHERE ip.lot_number = ? AND f2.id != ?`).all(f.lot_number, f.id) : [];
  return {
    ...f,
    sameLotFailures: sameLot,
    serviceJobs: db.prepare('SELECT * FROM service_jobs WHERE failure_report_id = ? ORDER BY created_date DESC').all(f.id),
    notifications: db.prepare("SELECT * FROM notifications WHERE entity = 'failure' AND entity_id = ? ORDER BY id DESC").all(f.id),
    tractorStatus: f.tractor_id ? db.prepare('SELECT status FROM tractors WHERE id = ?').get(f.tractor_id).status : null,
    activeJob: f.tractor_id ? db.prepare("SELECT id, status FROM service_jobs WHERE tractor_id = ? AND status != 'completed'").get(f.tractor_id) ?? null : null,
  };
});

get('/api/quality', ({ db, today, query }) => {
  const { from, to } = rangeOf(query, today);
  const r = [from, to];
  const performance = partsPerformance(db, { from, to });
  const byStage = db.prepare(`SELECT stage, status, SUM(quantity) AS n FROM failure_reports WHERE reported_date BETWEEN ? AND ? GROUP BY 1, 2`).all(...r);
  const byClass = db.prepare(`SELECT failure_class, stage, SUM(quantity) AS n FROM failure_reports WHERE reported_date BETWEEN ? AND ? GROUP BY 1, 2 ORDER BY 3 DESC`).all(...r);
  const byMonth = db.prepare(`SELECT substr(reported_date, 1, 7) AS month, stage, SUM(quantity) AS n FROM failure_reports
    WHERE reported_date BETWEEN ? AND ? GROUP BY 1, 2 ORDER BY 1`).all(...r);
  const byPart = db.prepare(`SELECT f.part_number, pt.name, SUM(f.quantity) AS n,
      SUM(CASE WHEN f.stage = 'field' THEN f.quantity ELSE 0 END) AS field
    FROM failure_reports f JOIN part_types pt ON pt.part_number = f.part_number WHERE f.reported_date BETWEEN ? AND ? GROUP BY 1 ORDER BY 3 DESC`).all(...r);
  const lateOrders = db.prepare(`SELECT COUNT(*) AS n FROM inventory_orders
    WHERE status IN ('submitted','confirmed','in_transit') AND expected_delivery_date < ?`).get(today).n;
  const trends = qualityTrends(db, { from, to, today });
  return { from, to, performance, byStage, byClass, byMonth, byPart, lateOrders, totalFailures: sum(byStage, (x) => x.n), ...trends };
});

get('/api/quality/trends', ({ db, today, query }) => {
  const { from, to } = rangeOf(query, today);
  return qualityTrends(db, { from, to, today, supplierId: query.get('supplier') || null });
});

get('/api/costs', ({ db, today, query }) => {
  const { from, to } = rangeOf(query, today);
  return costReport(db, { from, to, today, plan: runModels(db, today).plan });
});

post('/api/failures', ({ db, today, body }) => mutate(() => actions.createFailure(db, today, body)));
post('/api/failures/:id/status', ({ db, today, params, body }) => mutate(() => actions.setFailureStatus(db, today, params.id, body)));

// ---- Suppliers & customers ---------------------------------------------------------

get('/api/suppliers', ({ db, today }) => {
  const { performance } = runModels(db, today);
  return db.prepare('SELECT * FROM suppliers ORDER BY id').all().map((s) => ({
    ...s,
    performance: performance.suppliers.find((p) => p.supplierId === s.id),
    parts: db.prepare('SELECT sp.part_number, sp.is_primary, pt.name FROM supplier_parts sp JOIN part_types pt ON pt.part_number = sp.part_number WHERE sp.supplier_id = ?').all(s.id),
    openOrders: db.prepare("SELECT COUNT(*) AS n FROM inventory_orders WHERE supplier_id = ? AND status IN ('submitted','confirmed','in_transit')").get(s.id).n,
  }));
});

get('/api/suppliers/:id', ({ db, today, params }) => {
  const s = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(params.id);
  if (!s) throw new ApiError(404, `Supplier ${params.id} not found`);
  const { performance, plan } = runModels(db, today);
  return {
    ...s,
    performance: performance.suppliers.find((p) => p.supplierId === s.id),
    parts: performance.parts.filter((p) => p.supplierId === s.id),
    flags: performance.flags.filter((f) => f.supplierId === s.id),
    openOrders: plan.scheduledReceipts.filter((r) => r.supplierId === s.id),
    recentOrders: db.prepare(`SELECT * FROM inventory_orders WHERE supplier_id = ? AND status = 'received'
      ORDER BY actual_delivery_date DESC LIMIT 20`).all(s.id),
    monthlyDelivery: db.prepare(`SELECT substr(actual_delivery_date, 1, 7) AS month, COUNT(*) AS pos,
        AVG(CASE WHEN actual_delivery_date <= expected_delivery_date THEN 1.0 ELSE 0 END) AS on_time
      FROM inventory_orders WHERE supplier_id = ? AND status = 'received' AND actual_delivery_date >= date(?, '-12 months')
      GROUP BY 1 ORDER BY 1`).all(s.id, today),
    failures: db.prepare('SELECT * FROM failure_reports WHERE supplier_id = ? ORDER BY reported_date DESC LIMIT 25').all(s.id),
  };
});

get('/api/customers', ({ db }) => db.prepare(`
  SELECT c.*,
    (SELECT COUNT(*) FROM customer_orders o WHERE o.customer_id = c.id AND o.status != 'cancelled') AS orders,
    (SELECT COUNT(*) FROM customer_orders o WHERE o.customer_id = c.id AND o.status IN (${placeholders(ACTIVE_ORDER_STATUSES)})) AS open_orders,
    (SELECT COUNT(*) FROM tractors t JOIN customer_orders o ON o.id = t.customer_order_id WHERE o.customer_id = c.id AND t.status = 'delivered') AS fleet,
    (SELECT COUNT(*) FROM failure_reports f WHERE f.customer_id = c.id AND f.status != 'resolved') AS open_issues
  FROM customers c ORDER BY c.name`).all(...ACTIVE_ORDER_STATUSES));

get('/api/customers/:id', ({ db, params }) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(params.id);
  if (!c) throw new ApiError(404, `Customer ${params.id} not found`);
  return {
    ...c,
    orders: db.prepare('SELECT * FROM customer_orders WHERE customer_id = ? ORDER BY submission_date DESC').all(c.id),
    fleet: db.prepare(`SELECT t.* FROM tractors t JOIN customer_orders o ON o.id = t.customer_order_id
      WHERE o.customer_id = ? AND t.status = 'delivered' ORDER BY t.delivered_date DESC`).all(c.id),
    failures: db.prepare(`SELECT f.*, pt.name AS part_name, t.serial_number FROM failure_reports f
      JOIN part_types pt ON pt.part_number = f.part_number LEFT JOIN tractors t ON t.id = f.tractor_id
      WHERE f.customer_id = ? ORDER BY f.reported_date DESC`).all(c.id),
  };
});

// ---- Notifications & service jobs ---------------------------------------------------

get('/api/notifications', ({ db, query }) => db.prepare(`SELECT * FROM notifications ${query.get('status') ? 'WHERE status = ?' : ''}
  ORDER BY id DESC LIMIT ?`).all(...(query.get('status') ? [query.get('status')] : []), limitOf(query, 200)));
post('/api/notifications', ({ db, today, body }) => mutate(() => actions.sendNotification(db, today, body)));
post('/api/notifications/:id/ack', ({ db, today, params }) => mutate(() => actions.acknowledgeNotification(db, today, params.id)));

const JOB_SQL = `SELECT j.*, t.serial_number, t.model_number, c.name AS customer_name, f.description AS failure_description, f.severity,
    (SELECT sh.expected_arrival_date FROM shipments sh WHERE sh.service_job_id = j.id AND sh.status = 'in_transit') AS leg_eta
  FROM service_jobs j JOIN tractors t ON t.id = j.tractor_id JOIN customers c ON c.id = j.customer_id
  LEFT JOIN failure_reports f ON f.id = j.failure_report_id`;
get('/api/service-jobs', ({ db, query }) => {
  const status = query.get('status');
  const where = status === 'active' ? "WHERE j.status != 'completed'" : status ? 'WHERE j.status = ?' : '';
  return db.prepare(`${JOB_SQL} ${where} ORDER BY j.created_date DESC, j.id DESC LIMIT ?`)
    .all(...(status && status !== 'active' ? [status] : []), limitOf(query, 200));
});
get('/api/service-jobs/:id', ({ db, params }) => {
  const j = db.prepare(`${JOB_SQL} WHERE j.id = ?`).get(params.id);
  if (!j) throw new ApiError(404, `Service job ${params.id} not found`);
  return {
    ...j,
    shipments: db.prepare('SELECT * FROM shipments WHERE service_job_id = ? ORDER BY shipped_date').all(j.id),
    partOnHand: j.part_number ? db.prepare('SELECT available FROM v_part_balances WHERE part_number = ?').get(j.part_number).available : null,
  };
});
post('/api/service-jobs', ({ db, today, body }) => mutate(() => actions.scheduleServiceJob(db, today, body)));
post('/api/service-jobs/:id/pickup', ({ db, today, params }) => mutate(() => actions.servicePickup(db, today, params.id)));
post('/api/service-jobs/:id/arrive', ({ db, today, params }) => mutate(() => actions.serviceArrive(db, today, params.id)));
post('/api/service-jobs/:id/repair', ({ db, today, params }) => mutate(() => actions.serviceRepair(db, today, params.id)));
post('/api/service-jobs/:id/return', ({ db, today, params }) => mutate(() => actions.serviceReturn(db, today, params.id)));

get('/api/catalog', ({ db }) => ({
  sites: db.prepare('SELECT id, name, city, state, is_plant FROM warehouses ORDER BY is_plant DESC, id').all(),
  models: db.prepare('SELECT * FROM tractor_models ORDER BY model_number').all(),
  bom: db.prepare('SELECT * FROM bom_items ORDER BY model_number, part_number').all(),
  parts: db.prepare('SELECT * FROM part_types ORDER BY part_number').all(),
  customers: db.prepare('SELECT id, name, primary_address FROM customers ORDER BY name').all(),
  suppliers: db.prepare('SELECT id, name, code FROM suppliers ORDER BY id').all(),
  supplierParts: db.prepare('SELECT * FROM supplier_parts').all(),
}));

get('/api/activity', ({ db, query }) => db.prepare('SELECT * FROM activity_log ORDER BY id DESC LIMIT ?').all(limitOf(query, 50)));

// ---- Tasks & admin ------------------------------------------------------------------

post('/api/tasks/state', ({ db, today, body }) => mutate(() => actions.setTaskState(db, today, body.key, body)));

post('/api/admin/reseed', (ctx) => {
  ctx.db.close();
  const db = recreateDb(ctx.dbPath);
  const counts = seedDatabase(db, { today: ctx.today });
  ctx.replaceDb(db);
  invalidateModels();
  return { reseeded: true, today: ctx.today, counts };
});

function mutate(fn) {
  const out = fn();
  invalidateModels();
  return out;
}
