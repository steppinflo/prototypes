// Customer orders: list, detail, new order.

import {
  api, html, fmtMoney, fmtDate, seg, qs, table, statusBadge, pageHead, orderLink, customerLink,
  tractorLink, modelSwatch, actionBtn, DIALOGS, openDialog, toast, addDays, today, setQuery, daysBetween,
} from '../lib.js';

const ORDER_STEPS = [['received', 'Received'], ['in_production', 'In production'], ['ready', 'Ready'], ['shipping', 'Shipping'], ['delivered', 'Delivered']];

export async function ordersView() {
  const q = qs();
  const status = q.get('status') ?? 'active';
  const search = q.get('q') ?? '';
  const data = await api(`/orders?status=${status === 'all' ? '' : status}&q=${encodeURIComponent(search)}&limit=500`);
  return html`
    ${pageHead({ title: 'Customer orders', sub: 'Tractor orders from customers, with build and delivery progress.', actions: html`<button class="btn primary" data-dialog="new-order">+ New order</button>` })}
    <section class="card">
      <div class="card-head">${seg('status', [['active', 'Open'], ['received', 'Received'], ['in_production', 'In production'], ['ready', 'Ready'], ['shipping', 'Shipping'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled'], ['all', 'All']], status)}
        <div class="right"><form id="order-search" onsubmit="return false"><input type="search" name="q" placeholder="Search id, customer, model" value="${search}" data-query="q"></form></div></div>
      ${table([
        { label: 'Order', key: 'id', render: (o) => orderLink(o.id) },
        { label: 'Customer', key: 'customer_name', render: (o) => customerLink(o.customer_id, o.customer_name) },
        { label: 'Tractors', key: 'quantity', render: (o) => html`${modelSwatch(o.model_number)}${o.quantity} × ${o.model_number}` },
        { label: 'Assigned', key: 'assigned', num: true, render: (o) => `${o.assigned}/${o.quantity}` },
        { label: 'Submitted', key: 'submission_date', render: (o) => fmtDate(o.submission_date) },
        { label: 'Expected delivery', key: 'expected_delivery_date', render: (o) => fmtDate(o.expected_delivery_date) },
        { label: 'Delivered', key: 'actual_delivery_date', render: (o) => html`${fmtDate(o.actual_delivery_date)}${o.actual_delivery_date && o.actual_delivery_date > o.expected_delivery_date ? html` <span class="due over small">+${daysBetween(o.expected_delivery_date, o.actual_delivery_date)}d</span>` : ''}` },
        { label: 'Value', key: 'unit_price', num: true, sort: (o) => o.unit_price * o.quantity, render: (o) => fmtMoney(o.unit_price * o.quantity) },
        { label: 'Status', key: 'status', render: (o) => html`${statusBadge(o.status)} ${o.risk ? statusBadge(o.risk.severity) : ''}` },
      ], data.rows, { empty: 'No orders match' })}
      <div class="card-note">${data.rows.length} of ${data.total} orders</div>
    </section>`;
}

// Search box: update the URL query on input (debounced).
let searchTimer;
document.addEventListener('input', (e) => {
  const el = e.target.closest('input[data-query]');
  if (!el) return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    setQuery({ [el.dataset.query]: el.value });
    setTimeout(() => {
      const again = document.querySelector(`input[data-query="${el.dataset.query}"]`);
      if (again) {
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      }
    }, 60);
  }, 300);
});

export async function orderView(id) {
  const o = await api(`/orders/${id}`);
  const stepIdx = Math.max(0, ORDER_STEPS.findIndex(([k]) => k === (o.status === 'partially_delivered' ? 'shipping' : o.status)));
  const ready = o.tractors.filter((t) => t.status === 'earmarked').length;
  const remaining = o.quantity - o.tractors.length;
  const active = !['delivered', 'cancelled'].includes(o.status);
  return html`
    ${pageHead({
      crumbs: html`<a href="#/orders">Customer orders</a> /`,
      title: html`${o.id} · ${o.quantity} × ${o.model_number}`,
      sub: html`${customerLink(o.customer_id, o.customer_name)} · submitted ${fmtDate(o.submission_date)} · expected ${fmtDate(o.expected_delivery_date)}`,
      actions: active ? html`
        ${remaining > 0 ? actionBtn({ label: `Start ${remaining} build${remaining > 1 ? 's' : ''}`, url: '/builds', body: { orderId: o.id, count: remaining } }, 'btn') : ''}
        ${ready ? actionBtn({ label: `Ship ${ready} ready tractor${ready > 1 ? 's' : ''}`, url: `/orders/${o.id}/ship`, body: {} }, 'btn primary') : ''}
        ${!o.tractors.some((t) => ['shipping', 'delivered'].includes(t.status)) ? actionBtn({ label: 'Cancel order', url: `/orders/${o.id}/cancel`, body: {}, confirm: `Cancel ${o.id}? Its tractors return to stock.` }, 'btn danger') : ''}` : '',
    })}
    ${o.status === 'cancelled' ? html`<div class="callout warn" style="margin-bottom:16px">This order was cancelled.</div>` : html`
      <div class="card" style="margin-bottom:16px;padding:10px 14px"><div class="timeline">${ORDER_STEPS.map(([k, l], i) =>
        html`<div class="step ${i < stepIdx || o.status === 'delivered' ? 'done' : i === stepIdx ? 'now' : ''}">${l}</div>`)}</div></div>`}
    ${o.risk ? html`<div class="callout ${o.risk.daysLate ? 'bad' : 'warn'}" style="margin-bottom:16px">
      <b>${o.risk.daysLate ? `Projected ${o.risk.daysLate} days late.` : 'At risk.'}</b>
      ${o.risk.unitsAtRisk} unit(s) ${o.risk.shortParts.length ? `are short on ${o.risk.shortParts.join(', ')}` : ''}${o.risk.capacityConstrained ? ' and constrained by build capacity' : ''}.
      See <a href="#/planning">the plan</a> for recommended purchases.</div>` : ''}
    <div class="grid cols-2" style="margin-bottom:16px">
      <section class="card"><div class="card-head"><h2>Order</h2></div><div class="card-body"><dl class="dl">
        <dt>Status</dt><dd>${statusBadge(o.status)}</dd>
        <dt>Customer</dt><dd>${customerLink(o.customer_id, o.customer_name)} <span class="muted">(${o.segment})</span></dd>
        <dt>Delivery address</dt><dd>${o.delivery_address}</dd>
        <dt>Region</dt><dd>${o.region} · ~${o.transitDays} days transit from plant</dd>
        <dt>Quantity</dt><dd>${modelSwatch(o.model_number)}${o.quantity} × ${o.model_number}</dd>
        <dt>Value</dt><dd>${fmtMoney(o.unit_price * o.quantity)} <span class="muted">(${fmtMoney(o.unit_price)} each)</span></dd>
        <dt>Submitted</dt><dd>${fmtDate(o.submission_date, { year: true })}</dd>
        <dt>Expected delivery</dt><dd>${fmtDate(o.expected_delivery_date, { year: true })}</dd>
        <dt>Actual delivery</dt><dd>${fmtDate(o.actual_delivery_date, { year: true })}</dd>
        ${o.notes ? html`<dt>Notes</dt><dd>${o.notes}</dd>` : ''}
      </dl></div></section>
      <section class="card"><div class="card-head"><h2>Plan for remaining tractors</h2></div>
        ${o.stockSuggestions.length ? html`<div class="card-note">Unassigned stock can cover this order:</div>
          ${table([
            { label: 'Tractor', key: 'serialNumber', render: (r) => tractorLink(r.tractorId, r.serialNumber) },
            { label: 'Status', key: 'tractorStatus', render: (r) => statusBadge(r.tractorStatus) },
            { label: '', nosort: true, render: (r) => actionBtn({ label: 'Earmark', url: `/tractors/${r.tractorId}/earmark`, body: { orderId: o.id } }, 'btn small primary') },
          ], o.stockSuggestions)}` : ''}
        ${table([
          { label: 'Build', key: 'buildDate', render: (b) => fmtDate(b.buildDate) },
          { label: 'Ship by', key: 'needBy', render: (b) => fmtDate(b.needBy) },
          { label: 'Parts ready', key: 'partsReady', render: (b) => (b.partsReady ? fmtDate(b.partsReady) : 'on hand') },
          { label: 'Short', key: 'shortParts', render: (b) => b.shortParts.join(', ') || '—' },
          { label: 'Status', key: 'status', render: (b) => statusBadge(b.status) },
        ], o.plannedBuilds, { empty: remaining > 0 ? 'Covered by stock' : 'All tractors are assigned' })}
      </section>
    </div>
    <section class="card" style="margin-bottom:16px"><div class="card-head"><h2>Tractors on this order</h2></div>
      ${table([
        { label: 'Serial', key: 'serial_number', render: (t) => tractorLink(t.id, t.serial_number) },
        { label: 'Lot', key: 'lot_number', render: (t) => html`<span class="mono">${t.lot_number}</span>` },
        { label: 'Status', key: 'status', render: (t) => statusBadge(t.status) },
        { label: 'Build started', key: 'build_start_date', render: (t) => fmtDate(t.build_start_date) },
        { label: 'Completed', key: 'build_complete_date', render: (t) => fmtDate(t.build_complete_date) },
        { label: 'Shipped', key: 'ship_date', render: (t) => fmtDate(t.ship_date) },
        { label: 'Delivered', key: 'delivered_date', render: (t) => fmtDate(t.delivered_date) },
      ], o.tractors, { empty: 'No tractors assigned yet' })}</section>
    <div class="grid cols-2">
      <section class="card"><div class="card-head"><h2>Shipments</h2></div>
        ${table([
          { label: 'Shipment', key: 'id', render: (s) => html`<span class="mono">${s.id}</span>` },
          { label: 'Carrier', key: 'carrier', render: (s) => html`${s.carrier}<div class="muted small mono">${s.tracking_number}</div>` },
          { label: 'Shipped', key: 'shipped_date', render: (s) => fmtDate(s.shipped_date) },
          { label: 'ETA', key: 'expected_arrival_date', render: (s) => fmtDate(s.expected_arrival_date) },
          { label: 'Arrived', key: 'actual_arrival_date', render: (s) => fmtDate(s.actual_arrival_date) },
          { label: '', nosort: true, render: (s) => (s.status === 'in_transit' ? actionBtn({ label: 'Mark delivered', url: `/shipments/${s.id}/deliver`, body: {} }) : statusBadge(s.status)) },
        ], o.shipments, { empty: 'Not shipped yet' })}</section>
      <section class="card"><div class="card-head"><h2>Issues reported</h2></div>
        ${table([
          { label: 'Report', key: 'id', render: (f) => html`<a class="mono" href="#/quality/${f.id}">${f.id}</a>` },
          { label: 'Date', key: 'reported_date', render: (f) => fmtDate(f.reported_date) },
          { label: 'Part', key: 'part_number' },
          { label: 'Stage', key: 'stage' },
          { label: 'Status', key: 'status', render: (f) => statusBadge(f.status) },
        ], o.failures, { empty: 'No failures reported on these tractors' })}</section>
    </div>`;
}

DIALOGS['new-order'] = async (_data, done) => {
  const cat = await api('/catalog');
  openDialog('New customer order', String(html`
    <div class="form-grid">
      <label class="field" style="grid-column:1/-1">Customer<select name="customerId" required><option value="">Choose…</option>
        ${cat.customers.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select></label>
      <label class="field">Model<select name="model" required>${cat.models.map((m) => html`<option value="${m.model_number}">${m.model_number} · ${m.name}</option>`)}</select></label>
      <label class="field">Quantity<input name="quantity" type="number" min="1" max="50" value="1" required></label>
      <label class="field">Expected delivery<input name="expectedDeliveryDate" type="date" min="${addDays(today(), 1)}" value="${addDays(today(), 60)}" required></label>
      <label class="field" style="grid-column:1/-1">Delivery address <span class="muted">(defaults to the customer's primary address)</span><input name="deliveryAddress"></label>
      <label class="field" style="grid-column:1/-1">Notes<input name="notes"></label>
    </div>
    <div class="form-actions"><button class="btn primary">Create order</button></div>`), async (data) => {
    const out = await api('/orders', { method: 'POST', body: data });
    toast(`Created ${out.id} — the plan now includes it`);
    location.hash = `#/orders/${out.id}`;
    done();
  });
};

