// Tractors: every tractor built, its status, and full part traceability.

import {
  api, html, fmtDate, seg, qs, table, statusBadge, pageHead, orderLink, customerLink, tractorLink, partLink,
  poLink, supplierLink, modelSwatch, actionBtn, DIALOGS, openDialog, toast, severityBadge,
} from '../lib.js';

const STATUSES = [['current', 'Current'], ['in_production', 'Building'], ['qc_hold', 'QC hold'], ['inventoried', 'In stock'],
  ['earmarked', 'Earmarked'], ['shipping', 'Shipping'], ['delivered', 'Delivered'], ['in_repair', 'In repair'], ['all', 'All']];

export async function tractorsView() {
  const q = qs();
  const status = q.get('status') ?? 'current';
  const model = q.get('model') ?? '';
  const search = q.get('q') ?? '';
  const data = await api(`/tractors?status=${status === 'all' ? '' : status}&model=${model}&q=${encodeURIComponent(search)}&limit=500`);
  return html`
    ${pageHead({ title: 'Tractors', sub: 'Every tractor built: where it is, who it is for, and what went into it.' })}
    <section class="card">
      <div class="card-head">${seg('status', STATUSES, status)}
        <div class="right">${seg('model', [['', 'All models'], ...['TX-100', 'TX-200', 'TX-300', 'TX-400', 'TX-500'].map((m) => [m, m])], model)}
          <input type="search" placeholder="Serial, order, customer" value="${search}" data-query="q"></div></div>
      ${table([
        { label: 'Serial number', key: 'serial_number', render: (t) => tractorLink(t.id, t.serial_number) },
        { label: 'Model', key: 'model_number', render: (t) => html`${modelSwatch(t.model_number)}${t.model_number}` },
        { label: 'Build lot', key: 'lot_number', render: (t) => html`<span class="mono small">${t.lot_number}</span>` },
        { label: 'Status', key: 'status', render: (t) => statusBadge(t.status) },
        { label: 'Order', key: 'customer_order_id', render: (t) => orderLink(t.customer_order_id) },
        { label: 'Customer', key: 'customer_name', render: (t) => customerLink(t.customer_id, t.customer_name) },
        { label: 'Built', key: 'build_start_date', render: (t) => fmtDate(t.build_start_date) },
        { label: 'Shipped', key: 'ship_date', render: (t) => fmtDate(t.ship_date) },
        { label: 'Delivered', key: 'delivered_date', render: (t) => fmtDate(t.delivered_date) },
      ], data.rows, { empty: 'No tractors match' })}
      <div class="card-note">${data.rows.length} of ${data.total} tractors</div>
    </section>`;
}

export async function tractorView(id) {
  const t = await api(`/tractors/${encodeURIComponent(id)}`);
  const actions = [];
  if (t.status === 'in_production') actions.push(actionBtn({ label: 'Pass QC & complete', url: `/tractors/${t.id}/complete`, body: {} }, 'btn primary'));
  if (t.status === 'qc_hold') actions.push(actionBtn({ label: `Install replacement ${t.hold_part_number} & release`, url: `/tractors/${t.id}/clear-hold`, body: {} }, 'btn primary'));
  if (!t.customer_order_id && t.openOrdersForModel.length) actions.push(html`<button class="btn" data-dialog="earmark" data-tractor="${t.id}" data-orders="${JSON.stringify(t.openOrdersForModel)}">Earmark to order…</button>`);
  if (t.status === 'delivered' && !t.serviceJobs.some((j) => j.status !== 'completed')) actions.push(actionBtn({ label: 'Arrange pickup & repair…', dialog: 'pickup', data: { tractorId: t.id } }, 'btn'));
  const activeJob = t.serviceJobs.find((j) => j.status !== 'completed');
  if (activeJob) actions.push(html`<a class="btn" href="#/service/${activeJob.id}">Service job ${activeJob.id} →</a>`);
  actions.push(html`<button class="btn" data-dialog="log-failure" data-tractor="${t.id}" data-stage="${t.status === 'delivered' || t.status === 'shipping' ? 'field' : 'manufacturing'}" data-parts="${JSON.stringify([...new Set(t.parts.map((p) => p.part_number))])}">Log failure…</button>`);
  return html`
    ${pageHead({
      crumbs: html`<a href="#/tractors">Tractors</a> /`,
      title: html`<span class="mono">${t.serial_number}</span>`,
      sub: html`${modelSwatch(t.model_number)}${t.model_number} ${t.model_name} · build lot <span class="mono">${t.lot_number}</span> · ${statusBadge(t.status)}`,
      actions: html`${actions}`,
    })}
    ${t.status === 'qc_hold' ? html`<div class="callout bad" style="margin-bottom:16px">On QC hold: needs a replacement ${partLink(t.hold_part_number)} before it can be released.</div>` : ''}
    <div class="grid cols-2" style="margin-bottom:16px">
      <section class="card"><div class="card-head"><h2>Tractor</h2></div><div class="card-body"><dl class="dl">
        <dt>Internal id</dt><dd class="mono">${t.id}</dd>
        <dt>Status</dt><dd>${statusBadge(t.status)}</dd>
        <dt>Customer order</dt><dd>${t.customer_order_id ? html`${orderLink(t.customer_order_id)} · ${customerLink(t.customer_id, t.customer_name)} · due ${fmtDate(t.expected_delivery_date)}` : html`<span class="muted">Unassigned stock</span>`}</dd>
        <dt>Build started</dt><dd>${fmtDate(t.build_start_date, { year: true })}</dd>
        <dt>Build completed</dt><dd>${fmtDate(t.build_complete_date, { year: true })}</dd>
        <dt>Shipped</dt><dd>${fmtDate(t.ship_date, { year: true })}</dd>
        <dt>Delivered</dt><dd>${fmtDate(t.delivered_date, { year: true })}</dd>
      </dl></div></section>
      <section class="card"><div class="card-head"><h2>Failures &amp; issues</h2></div>
        ${table([
          { label: 'Report', key: 'id', render: (f) => html`<a class="mono" href="#/quality/${f.id}">${f.id}</a>` },
          { label: 'Date', key: 'reported_date', render: (f) => fmtDate(f.reported_date) },
          { label: 'Stage', key: 'stage' },
          { label: 'Part', key: 'part_number', render: (f) => partLink(f.part_number) },
          { label: 'Severity', key: 'severity', render: (f) => severityBadge(f.severity) },
          { label: 'Status', key: 'status', render: (f) => statusBadge(f.status) },
        ], t.failures, { empty: 'No failures recorded' })}
        ${t.shipments.length ? html`<div class="card-head"><h2>Shipping</h2></div>${table([
          { label: 'Shipment', key: 'id', render: (s) => html`<span class="mono">${s.id}</span>` },
          { label: 'Carrier', key: 'carrier' },
          { label: 'Shipped', key: 'shipped_date', render: (s) => fmtDate(s.shipped_date) },
          { label: 'ETA / arrived', key: 'expected_arrival_date', render: (s) => fmtDate(s.actual_arrival_date ?? s.expected_arrival_date) },
          { label: 'Status', key: 'status', render: (s) => statusBadge(s.status) },
        ], t.shipments)}` : ''}
      </section>
    </div>
    <section class="card"><div class="card-head"><h2>Parts installed (traceability)</h2><span class="muted small">${t.parts.length} part records · serialized units and lot-tracked parts</span></div>
      ${table([
        { label: 'Part', key: 'part_number', render: (p) => html`${partLink(p.part_number)} <span class="muted">${p.part_name}</span>` },
        { label: 'Type', key: 'category' },
        { label: 'Qty', key: 'quantity', num: true },
        { label: 'Serial / lot', key: 'serial_number', render: (p) => html`<a class="mono" href="#/inventory-parts/${p.inventory_part_id}">${p.serial_number ?? `lot ${p.lot_number}`}</a>` },
        { label: 'Supplier', key: 'supplier_name', render: (p) => supplierLink(p.supplier_id, p.supplier_name) },
        { label: 'Parts order', key: 'inventory_order_id', render: (p) => poLink(p.inventory_order_id) },
        { label: 'Received', key: 'received_date', render: (p) => fmtDate(p.received_date) },
        { label: 'Installed', key: 'installed_date', render: (p) => html`${fmtDate(p.installed_date)}${p.removed_date ? html`<div class="small due over">replaced ${fmtDate(p.removed_date)}</div>` : ''}` },
      ], t.parts, { empty: 'No parts installed' })}</section>
    ${t.serviceJobs.length ? html`<section class="card" style="margin-top:16px"><div class="card-head"><h2>Service history</h2></div>${table([
      { label: 'Job', key: 'id', render: (j) => html`<a class="mono" href="#/service/${j.id}">${j.id}</a>` },
      { label: 'Failure', key: 'failure_report_id', render: (j) => (j.failure_report_id ? html`<a class="mono" href="#/quality/${j.failure_report_id}">${j.failure_report_id}</a>` : '—') },
      { label: 'Part replaced', key: 'part_number', render: (j) => (j.part_number ? partLink(j.part_number) : '—') },
      { label: 'Picked up', key: 'picked_up_date', render: (j) => fmtDate(j.picked_up_date ?? j.scheduled_pickup_date) },
      { label: 'Returned', key: 'returned_date', render: (j) => fmtDate(j.returned_date) },
      { label: 'Status', key: 'status' },
    ], t.serviceJobs)}</section>` : ''}`;
}

DIALOGS.earmark = (data, done) => {
  const orders = JSON.parse(data.orders);
  openDialog('Earmark tractor to a customer order', String(html`
    <label class="field">Open order for this model<select name="orderId">${orders.map((o) =>
      html`<option value="${o.id}">${o.id} — ${o.customer_name} (${o.assigned}/${o.quantity} assigned, due ${fmtDate(o.expected_delivery_date)})</option>`)}</select></label>
    <div class="form-actions"><button class="btn primary">Earmark</button></div>`), async (body) => {
    await api(`/tractors/${data.tractor}/earmark`, { method: 'POST', body });
    toast(`Earmarked to ${body.orderId}`);
    done();
  });
};

