// Shipping: parts on their way in, tractors on their way out.

import {
  api, html, fmtDate, seg, qs, table, statusBadge, pageHead, partLink, poLink, orderLink, customerLink,
  supplierLink, actionBtn, today, daysBetween, kpi, fmtNum, fmtMoney,
} from '../lib.js';

function progress(s) {
  const total = Math.max(1, daysBetween(s.shipped_date, s.expected_arrival_date));
  const done = Math.min(total, Math.max(0, daysBetween(s.shipped_date, today())));
  const pct = s.status === 'delivered' ? 100 : (100 * done) / total;
  return html`<div class="progress"><div class="meter"><span style="width:${pct}%;background:${s.late ? 'var(--critical)' : 'var(--s1)'}"></span></div>
    <span class="small muted nowrap">${s.status === 'delivered' ? 'arrived' : `day ${done}/${total}`}</span></div>`;
}

const etaCell = (s) => {
  const d = daysBetween(today(), s.expected_arrival_date);
  return html`${fmtDate(s.expected_arrival_date)} ${s.status === 'in_transit' ? html`<span class="small ${d < 0 ? 'due over' : 'muted'}">${d < 0 ? `${-d}d overdue` : d === 0 ? 'today' : `in ${d}d`}</span>` : ''}`;
};

export async function shippingView() {
  const q = qs();
  const status = q.get('status') ?? 'in_transit';
  const rows = await api(`/shipments?status=${status}&limit=${status === 'in_transit' ? 300 : 120}`);
  const inbound = rows.filter((r) => r.direction === 'inbound');
  const outbound = rows.filter((r) => r.direction === 'outbound');
  const service = rows.filter((r) => r.direction.startsWith('service'));
  const lateIn = inbound.filter((r) => r.late).length;
  const lateOut = outbound.filter((r) => r.late).length;
  return html`
    ${pageHead({ title: 'Shipping', sub: 'Parts orders in transit from suppliers and tractors in transit to customers.', actions: seg('status', [['in_transit', 'In transit'], ['delivered', 'Recently delivered']], status) })}
    ${status === 'in_transit' ? html`<div class="kpis">
      ${kpi('Inbound parts shipments', fmtNum(inbound.length), `${lateIn} late vs. supplier quote`, lateIn > 0)}
      ${kpi('Outbound tractor shipments', fmtNum(outbound.length), `${outbound.reduce((s, r) => s + r.tractor_count, 0)} tractors on the road`)}
      ${kpi('Arriving today or overdue', fmtNum(rows.filter((r) => r.expected_arrival_date <= today()).length), 'need receiving or delivery confirmation', rows.some((r) => r.expected_arrival_date < today()))}
    </div>` : ''}
    <section class="card" style="margin-bottom:16px"><div class="card-head"><h2>Inbound — parts from suppliers</h2></div>
      ${table([
        { label: 'Shipment', key: 'id', render: (s) => html`<span class="mono">${s.id}</span>` },
        { label: 'PO', key: 'inventory_order_id', render: (s) => poLink(s.inventory_order_id) },
        { label: 'Part', key: 'part_number', render: (s) => html`${partLink(s.part_number)} × ${s.po_quantity}` },
        { label: 'From', key: 'origin', render: (s) => supplierLink(s.supplier_id, s.origin) },
        { label: 'Carrier', key: 'carrier', render: (s) => html`${s.carrier}<div class="mono small muted">${s.tracking_number}</div>` },
        { label: 'Shipped', key: 'shipped_date', render: (s) => fmtDate(s.shipped_date) },
        { label: 'ETA', key: 'expected_arrival_date', render: etaCell },
        { label: 'Quoted', key: 'po_expected', render: (s) => html`${fmtDate(s.po_expected)}${s.late ? html` <span class="badge critical">Late</span>` : ''}` },
        { label: 'Progress', key: 'p', nosort: true, render: progress },
        { label: '', nosort: true, render: (s) => (s.status === 'in_transit' ? actionBtn({ label: 'Receive', url: `/inventory-orders/${s.inventory_order_id}/receive`, body: {} }) : statusBadge(s.status)) },
      ], inbound, { empty: 'No inbound shipments' })}</section>
    <section class="card"><div class="card-head"><h2>Outbound — tractors to customers</h2></div>
      ${table([
        { label: 'Shipment', key: 'id', render: (s) => html`<span class="mono">${s.id}</span>` },
        { label: 'Order', key: 'customer_order_id', render: (s) => orderLink(s.customer_order_id) },
        { label: 'Customer', key: 'customer_name', render: (s) => customerLink(s.customer_id, s.customer_name) },
        { label: 'Tractors', key: 'tractor_count', num: true, render: (s) => `${s.tractor_count} × ${s.model_number}` },
        { label: 'Carrier', key: 'carrier', render: (s) => html`${s.carrier}<div class="mono small muted">${s.tracking_number}</div>` },
        { label: 'Shipped', key: 'shipped_date', render: (s) => fmtDate(s.shipped_date) },
        { label: 'ETA', key: 'expected_arrival_date', render: etaCell },
        { label: 'Customer expects', key: 'order_expected', render: (s) => html`${fmtDate(s.order_expected)}${s.late ? html` <span class="badge critical">Late</span>` : ''}` },
        { label: 'Freight', key: 'freight_cost', num: true, render: (s) => html`${fmtMoney(s.freight_cost)}${s.rush ? html` <span class="badge high">Rush</span>` : ''}` },
        { label: 'Progress', key: 'p', nosort: true, render: progress },
        { label: '', nosort: true, render: (s) => (s.status === 'in_transit' ? actionBtn({ label: 'Mark delivered', url: `/shipments/${s.id}/deliver`, body: {} }) : statusBadge(s.status)) },
      ], outbound, { empty: 'No tractors in transit' })}</section>
    <section class="card" style="margin-top:16px"><div class="card-head"><h2>Service hauls — tractors to and from repair</h2></div>
      ${table([
        { label: 'Shipment', key: 'id', render: (s) => html`<span class="mono">${s.id}</span>` },
        { label: 'Job', key: 'service_job_id', render: (s) => html`<a class="mono" href="#/service/${s.service_job_id}">${s.service_job_id}</a>` },
        { label: 'Leg', key: 'direction', render: (s) => (s.direction === 'service_pickup' ? 'Customer → plant' : 'Plant → customer') },
        { label: 'From', key: 'origin' },
        { label: 'To', key: 'destination' },
        { label: 'Shipped', key: 'shipped_date', render: (s) => fmtDate(s.shipped_date) },
        { label: 'ETA', key: 'expected_arrival_date', render: etaCell },
        { label: 'Cost', key: 'freight_cost', num: true, render: (s) => html`${fmtMoney(s.freight_cost)}${s.rush ? html` <span class="badge high">Rush</span>` : ''}` },
        { label: '', nosort: true, render: (s) => (s.status === 'in_transit' ? actionBtn({ label: s.direction === 'service_pickup' ? 'Arrived at plant' : 'Returned', url: `/shipments/${s.id}/deliver`, body: {} }) : statusBadge(s.status)) },
      ], service, { empty: 'No service hauls' })}</section>`;
}
