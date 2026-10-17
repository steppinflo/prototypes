// "What do you need to do today" - turns the plan and the live state into a ranked task
// list. Each task has a due date, what it's blocking, the customers impacted, and (where
// the portal can do it) a one-click action.

import { dayNum, isoDay, isWorkday, transitDays, addDays } from '../lib/util.mjs';

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function nextWorkday(n) {
  let d = n + 1;
  while (!isWorkday(d)) d += 1;
  return d;
}

export function generateTasks(db, { today, plan, performance }) {
  const todayN = dayNum(today);
  const tasks = [];
  const add = (t) => tasks.push({ customers: [], orders: [], links: [], action: null, ...t });
  const plant = db.prepare('SELECT * FROM warehouses WHERE is_plant = 1').get();
  const fmtCustomers = (list) => [...new Map(list.filter((c) => c.customerId).map((c) => [c.customerId, { id: c.customerId, name: c.customerName }])).values()];

  // Orders blocked by a part (from the plan's build list).
  const blockedByPart = (pn) => {
    const bs = plan.builds.filter((b) => b.source === 'firm' && b.shortParts.includes(pn));
    return { builds: bs.length, orders: [...new Set(bs.map((b) => b.orderId))], customers: fmtCustomers(bs) };
  };

  // 1. Purchase recommendations that need action now.
  for (const r of plan.recommendations.filter((x) => x.urgency !== 'upcoming')) {
    const firm = r.impactedOrders.length;
    add({
      key: `place_po:${r.key}`,
      type: 'place_po',
      category: 'Purchasing',
      severity: r.urgency === 'overdue' ? (firm ? 'critical' : 'high') : (firm ? 'high' : 'medium'),
      title: `Order ${r.quantity} × ${r.partName} (${r.partNumber}) from ${r.supplierName}`,
      detail: `Needed in stock by ${r.needDate}. Order by ${r.orderBy} to make it (${r.effectiveLeadDays}-day effective lead).`
        + (r.daysLate ? ` Even ordered today it lands ${r.daysLate} days after it's needed — expedite.` : ''),
      blocking: r.buildsBlocked
        ? `${r.buildsBlocked} planned build${r.buildsBlocked > 1 ? 's' : ''}${firm ? ` incl. ${r.firmBuildsBlocked} for ${firm} customer order${firm > 1 ? 's' : ''}` : ' (forecast demand)'}`
        : 'Keeps stock above safety level for forecast demand',
      due: r.orderBy,
      customers: r.impactedOrders.map((o) => ({ id: o.customerId, name: o.customerName })),
      orders: r.impactedOrders.map((o) => o.orderId),
      links: [{ label: r.partNumber, href: `#/parts/${r.partNumber}` }, { label: 'Planning', href: '#/planning' }],
      action: { label: `Place PO · $${Math.round(r.cost).toLocaleString('en-US')}`, method: 'POST', url: '/inventory-orders',
        body: { partNumber: r.partNumber, supplierId: r.supplierId, quantity: r.quantity, source: 'model_recommendation' } },
    });
  }

  // 2. Inbound parts: receive what has arrived, chase what is late.
  for (const r of plan.scheduledReceipts) {
    const blocked = blockedByPart(r.partNumber);
    if (r.status === 'in_transit' && r.predictedArrival <= today) {
      add({
        key: `receive:${r.poId}`, type: 'receive_po', category: 'Receiving', severity: blocked.builds ? 'high' : 'medium',
        title: `Receive & inspect ${r.poId}: ${r.quantity} × ${r.partNumber} from ${r.supplierName}`,
        detail: `Carrier ETA ${r.predictedArrival}. Inspect on arrival and log any damaged or out-of-spec units.`,
        blocking: blocked.builds ? `${blocked.builds} builds waiting on ${r.partNumber}` : 'Restocks inventory',
        due: r.predictedArrival, customers: blocked.customers, orders: blocked.orders,
        links: [{ label: r.poId, href: `#/purchasing/${r.poId}` }],
        action: { label: 'Mark received', method: 'POST', url: `/inventory-orders/${r.poId}/receive`, body: {} },
      });
    } else if (r.overdue && r.status !== 'in_transit') {
      const late = todayN - dayNum(r.expectedDelivery);
      add({
        key: `expedite:${r.poId}`, type: 'expedite_po', category: 'Purchasing', severity: blocked.builds ? 'high' : 'medium',
        title: `Chase ${r.supplierName} on ${r.poId}: ${r.quantity} × ${r.partNumber}, ${late} day${late === 1 ? '' : 's'} late`,
        detail: `Quoted for ${r.expectedDelivery}; no ship notice yet. Planner is assuming ${r.predictedArrival}.`,
        blocking: blocked.builds ? `${blocked.builds} builds short on ${r.partNumber}` : 'Not yet blocking builds',
        due: r.expectedDelivery, customers: blocked.customers, orders: blocked.orders,
        links: [{ label: r.poId, href: `#/purchasing/${r.poId}` }, { label: 'Supplier', href: `#/suppliers/${r.supplierId}` }],
        action: { label: 'Mark shipped', method: 'POST', url: `/inventory-orders/${r.poId}/ship`, body: {} },
      });
    }
  }

  // 3. Production floor.
  const holds = db.prepare(`
    SELECT t.*, o.customer_id, c.name AS customer_name, pt.name AS part_name, b.available
    FROM tractors t LEFT JOIN customer_orders o ON o.id = t.customer_order_id LEFT JOIN customers c ON c.id = o.customer_id
    JOIN part_types pt ON pt.part_number = t.hold_part_number JOIN v_part_balances b ON b.part_number = t.hold_part_number
    WHERE t.status = 'qc_hold'`).all();
  for (const t of holds) {
    add({
      key: `qc_hold:${t.id}`, type: 'qc_hold', category: 'Production', severity: 'high',
      title: `Clear QC hold on ${t.serial_number}: replace ${t.part_name}`,
      detail: t.available > 0 ? `${t.available} × ${t.hold_part_number} on hand — install a replacement and re-test.`
        : `No ${t.hold_part_number} on hand; waiting on inbound stock.`,
      blocking: t.customer_order_id ? `Order ${t.customer_order_id}` : 'Finished-goods stock',
      due: today,
      customers: t.customer_id ? [{ id: t.customer_id, name: t.customer_name }] : [],
      orders: t.customer_order_id ? [t.customer_order_id] : [],
      links: [{ label: t.serial_number, href: `#/tractors/${t.id}` }],
      action: t.available > 0 ? { label: 'Install replacement & release', method: 'POST', url: `/tractors/${t.id}/clear-hold`, body: {} } : null,
    });
  }
  const building = db.prepare(`
    SELECT t.*, o.customer_id, c.name AS customer_name FROM tractors t
    LEFT JOIN customer_orders o ON o.id = t.customer_order_id LEFT JOIN customers c ON c.id = o.customer_id
    WHERE t.status = 'in_production' AND t.build_start_date < ?`).all(today);
  for (const t of building) {
    add({
      key: `complete:${t.id}`, type: 'complete_build', category: 'Production', severity: 'medium',
      title: `Finish build & QC: ${t.serial_number} (${t.model_number})`,
      detail: `Build started ${t.build_start_date}; tractors take one day once parts are on hand.`,
      blocking: t.customer_order_id ? `Order ${t.customer_order_id}` : 'Finished-goods stock',
      due: isoDay(nextWorkday(dayNum(t.build_start_date))),
      customers: t.customer_id ? [{ id: t.customer_id, name: t.customer_name }] : [],
      orders: t.customer_order_id ? [t.customer_order_id] : [],
      links: [{ label: t.serial_number, href: `#/tractors/${t.id}` }],
      action: { label: 'Pass QC', method: 'POST', url: `/tractors/${t.id}/complete`, body: {} },
    });
  }

  // Builds the plan schedules for today / the next working day that have parts.
  const horizonN = isWorkday(todayN) ? todayN : nextWorkday(todayN);
  const startable = plan.builds.filter((b) => dayNum(b.buildDate) <= horizonN && b.startableNow);
  const byOrder = new Map();
  for (const b of startable) {
    const k = b.orderId ?? `stock:${b.model}`;
    if (!byOrder.has(k)) byOrder.set(k, []);
    byOrder.get(k).push(b);
  }
  const kitsLeft = { ...plan.kitsOnHand };
  for (const [k, all] of byOrder) {
    const bs = all.slice(0, kitsLeft[all[0].model]);
    if (!bs.length) continue;
    kitsLeft[all[0].model] -= bs.length;
    const b = bs[0];
    const firm = b.source === 'firm';
    add({
      key: `build:${k}:${b.buildDate}`, type: 'start_build', category: 'Production', severity: firm ? (b.status === 'late' ? 'high' : 'medium') : 'low',
      title: firm ? `Start build: ${bs.length} × ${b.model} for ${b.orderId}` : `Build ${bs.length} × ${b.model} ahead of forecast demand`,
      detail: firm
        ? `Ship by ${b.needBy} to deliver on ${b.expectedDelivery}. All parts on hand.`
        : `Forecast expects new ${b.model} orders needing delivery around ${addDays(b.needBy, 3)}. All parts on hand.`,
      blocking: firm ? `Delivery to ${b.customerName}` : 'Forecast demand',
      due: b.buildDate,
      customers: firm ? [{ id: b.customerId, name: b.customerName }] : [],
      orders: firm ? [b.orderId] : [],
      links: firm ? [{ label: b.orderId, href: `#/orders/${b.orderId}` }] : [{ label: 'Planning', href: '#/planning' }],
      action: { label: `Start ${bs.length} build${bs.length > 1 ? 's' : ''}`, method: 'POST', url: '/builds',
        body: firm ? { orderId: b.orderId, count: bs.length } : { model: b.model, count: bs.length } },
    });
  }

  // 4. Use stock we already have (don't double count) - earmark it to firm orders.
  for (const a of plan.stockAllocations.filter((x) => x.orderId)) {
    const o = db.prepare('SELECT o.customer_id, c.name FROM customer_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?').get(a.orderId);
    add({
      key: `earmark:${a.tractorId}:${a.orderId}`, type: 'earmark', category: 'Fulfilment', severity: 'medium',
      title: `Earmark ${a.serialNumber} (${a.model}, ${a.tractorStatus.replace('_', ' ')}) to ${a.orderId}`,
      detail: `Unassigned ${a.model} already ${a.tractorStatus === 'inventoried' ? 'in stock' : 'on the line'} — covers this order instead of building another.`,
      blocking: `Delivery to ${o.name}`,
      due: addDays(a.needBy, -30) < today ? today : addDays(a.needBy, -30),
      customers: [{ id: o.customer_id, name: o.name }], orders: [a.orderId],
      links: [{ label: a.serialNumber, href: `#/tractors/${a.tractorId}` }, { label: a.orderId, href: `#/orders/${a.orderId}` }],
      action: { label: 'Earmark', method: 'POST', url: `/tractors/${a.tractorId}/earmark`, body: { orderId: a.orderId } },
    });
  }

  // 5. Outbound: ship ready orders, confirm deliveries.
  const shippable = db.prepare(`
    SELECT o.*, c.name AS customer_name, c.lat, c.lng,
      (SELECT COUNT(*) FROM tractors t WHERE t.customer_order_id = o.id AND t.status = 'earmarked') AS ready_units
    FROM customer_orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.status IN ('ready', 'in_production', 'partially_delivered', 'shipping')`).all();
  for (const o of shippable) {
    if (!o.ready_units) continue;
    const shipBy = addDays(o.expected_delivery_date, -transitDays(plant.lat, plant.lng, o.lat, o.lng));
    const full = o.status === 'ready';
    if (!(full ? shipBy <= addDays(today, 7) : shipBy <= today)) continue;
    add({
      key: `ship:${o.id}`, type: 'ship_order', category: 'Fulfilment', severity: shipBy < today ? 'high' : 'medium',
      title: `Ship ${o.id} to ${o.customer_name}: ${o.ready_units} × ${o.model_number}${full ? '' : ' (partial)'}`,
      detail: `Expected delivery ${o.expected_delivery_date}; ship by ${shipBy} to arrive on time.`,
      blocking: `Delivery to ${o.customer_name}`,
      due: shipBy,
      customers: [{ id: o.customer_id, name: o.customer_name }], orders: [o.id],
      links: [{ label: o.id, href: `#/orders/${o.id}` }],
      action: { label: 'Book shipment', method: 'POST', url: `/orders/${o.id}/ship`, body: {} },
    });
  }
  const arriving = db.prepare(`
    SELECT sh.*, o.customer_id, c.name AS customer_name FROM shipments sh
    JOIN customer_orders o ON o.id = sh.customer_order_id JOIN customers c ON c.id = o.customer_id
    WHERE sh.direction = 'outbound' AND sh.status = 'in_transit' AND sh.expected_arrival_date <= ?`).all(today);
  for (const sh of arriving) {
    add({
      key: `deliver:${sh.id}`, type: 'confirm_delivery', category: 'Fulfilment', severity: 'low',
      title: `Confirm delivery of ${sh.id} to ${sh.customer_name}`,
      detail: `${sh.carrier} ${sh.tracking_number}, ETA ${sh.expected_arrival_date}.`,
      blocking: `Closing ${sh.customer_order_id}`,
      due: sh.expected_arrival_date,
      customers: [{ id: sh.customer_id, name: sh.customer_name }], orders: [sh.customer_order_id],
      links: [{ label: sh.customer_order_id, href: `#/orders/${sh.customer_order_id}` }],
      action: { label: 'Mark delivered', method: 'POST', url: `/shipments/${sh.id}/deliver`, body: {} },
    });
  }

  // 6. Orders the plan says will be late.
  for (const r of plan.orderRisks.filter((x) => x.severity === 'late')) {
    const why = [r.shortParts.length ? `short on ${r.shortParts.join(', ')}` : null, r.capacityConstrained ? 'build capacity' : null].filter(Boolean).join(' and ');
    add({
      key: `risk:${r.orderId}`, type: 'order_risk', category: 'Customer', severity: 'high',
      title: `${r.orderId} for ${r.customerName} projected ${r.daysLate} day${r.daysLate === 1 ? '' : 's'} late`,
      detail: `${r.unitsAtRisk} of ${r.quantity} × ${r.model} at risk (${why || 'schedule'}). Expected delivery ${r.expectedDelivery}. Re-prioritise or update the customer.`,
      blocking: `Delivery to ${r.customerName}`,
      due: today,
      customers: [{ id: r.customerId, name: r.customerName }], orders: [r.orderId],
      links: [{ label: r.orderId, href: `#/orders/${r.orderId}` }, { label: 'Planning', href: '#/planning' }],
    });
  }

  // 7. Quality: open failures that need triage.
  const openFailures = db.prepare(`
    SELECT f.*, t.serial_number, c.name AS customer_name, s.name AS supplier_name, pt.name AS part_name
    FROM failure_reports f LEFT JOIN tractors t ON t.id = f.tractor_id LEFT JOIN customers c ON c.id = f.customer_id
    JOIN suppliers s ON s.id = f.supplier_id JOIN part_types pt ON pt.part_number = f.part_number
    WHERE f.status = 'open'`).all();
  for (const f of openFailures) {
    const receiving = f.stage === 'receiving';
    add({
      key: `failure:${f.id}`, type: 'failure', category: 'Quality',
      severity: receiving ? 'low' : f.severity,
      title: receiving
        ? `Return ${f.quantity} rejected × ${f.part_number} to ${f.supplier_name} (${f.id})`
        : `Triage ${f.stage} failure ${f.id}: ${f.part_name}${f.serial_number ? ` on ${f.serial_number}` : ''}`,
      detail: f.description,
      blocking: f.customer_name ? `${f.customer_name}'s tractor (${f.severity})` : receiving ? 'Supplier credit' : 'Root cause for supplier performance',
      due: addDays(f.reported_date, f.severity === 'critical' ? 1 : 3),
      customers: f.customer_id ? [{ id: f.customer_id, name: f.customer_name }] : [],
      links: [{ label: f.id, href: `#/quality/${f.id}` }],
      action: receiving
        ? { label: 'Mark returned', method: 'POST', url: `/failures/${f.id}/status`, body: { status: 'resolved', resolution: 'Rejected units returned to supplier for credit' } }
        : { label: 'Start investigation', method: 'POST', url: `/failures/${f.id}/status`, body: { status: 'investigating' } },
    });
  }

  // 8. Supplier quality reviews from the parts performance tracker.
  for (const fl of performance.flags.filter((x) => x.type === 'quality_review')) {
    add({
      key: `quality:${fl.partNumber}:${fl.supplierId}`, type: 'supplier_review', category: 'Quality', severity: 'low',
      title: `Review ${fl.partNumber} quality with ${fl.supplierId}`,
      detail: fl.message,
      blocking: 'Field reliability & warranty cost',
      due: isoDay(todayN + ((8 - new Date(todayN * 86400000).getUTCDay()) % 7 || 7)),
      links: [{ label: 'Supplier', href: `#/suppliers/${fl.supplierId}` }, { label: fl.partNumber, href: `#/parts/${fl.partNumber}` }],
    });
  }

  // Apply done / snoozed state.
  const state = new Map(db.prepare('SELECT * FROM task_state').all().map((s) => [s.task_key, s]));
  const visible = tasks.filter((t) => {
    const s = state.get(t.key);
    if (!s) return true;
    if (s.status === 'done') return false;
    return s.status === 'snoozed' && s.until_date && s.until_date <= today;
  });
  for (const t of visible) {
    t.overdueDays = Math.max(0, todayN - dayNum(t.due));
    t.dueToday = t.due <= today;
  }
  visible.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.due.localeCompare(b.due));
  return visible;
}
