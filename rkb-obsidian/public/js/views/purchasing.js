// Parts orders (inventory orders): what's been ordered from suppliers and when it lands.

import {
  api, html, fmtNum, fmtMoney, fmtDate, seg, qs, table, statusBadge, pageHead, partLink, poLink, supplierLink,
  actionBtn, today, daysBetween, DIALOGS, openDialog, toast, severityBadge,
} from '../lib.js';

export async function purchasingView() {
  const q = qs();
  const status = q.get('status') ?? 'open';
  const data = await api(`/inventory-orders?status=${status === 'all' ? '' : status}&limit=${status === 'open' ? 500 : 300}`);
  const late = data.rows.filter((r) => r.status !== 'received' && r.expected_delivery_date < today()).length;
  return html`
    ${pageHead({ title: 'Parts orders', sub: 'Inventory orders placed with suppliers, with predicted arrival from supplier history.', actions: html`<button class="btn primary" data-dialog="new-po">+ New parts order</button>` })}
    <section class="card">
      <div class="card-head">${seg('status', [['open', 'Open'], ['submitted', 'Submitted'], ['confirmed', 'Confirmed'], ['in_transit', 'In transit'], ['received', 'Received'], ['all', 'All']], status)}
        <div class="right">${late ? html`<span class="badge critical">${late} past quoted date</span>` : ''}</div></div>
      ${table([
        { label: 'PO', key: 'id', render: (r) => poLink(r.id) },
        { label: 'Part', key: 'part_number', render: (r) => html`${partLink(r.part_number)} <span class="muted">${r.part_name}</span>` },
        { label: 'Supplier', key: 'supplier_name', render: (r) => supplierLink(r.supplier_id, r.supplier_name) },
        { label: 'Qty', key: 'quantity', num: true },
        { label: 'Value', key: 'v', num: true, sort: (r) => r.quantity * r.unit_cost, render: (r) => fmtMoney(r.quantity * r.unit_cost) },
        { label: 'Submitted', key: 'submission_date', render: (r) => fmtDate(r.submission_date) },
        { label: 'Quoted delivery', key: 'expected_delivery_date', render: (r) => html`${fmtDate(r.expected_delivery_date)}${r.status !== 'received' && r.expected_delivery_date < today() ? html` <span class="due over small">${daysBetween(r.expected_delivery_date, today())}d late</span>` : ''}` },
        { label: r0(status), key: 'actual_delivery_date', render: (r) => (r.status === 'received'
          ? html`${fmtDate(r.actual_delivery_date)}${r.actual_delivery_date > r.expected_delivery_date ? html` <span class="due over small">+${daysBetween(r.expected_delivery_date, r.actual_delivery_date)}d</span>` : ''}`
          : r.prediction ? html`${fmtDate(r.prediction.predictedArrival)}<div class="muted small">${r.prediction.basis}</div>` : '—') },
        { label: 'Source', key: 'source', render: (r) => (r.source === 'model_recommendation' ? html`<span class="badge info">Model</span>` : r.source === 'manual' ? html`<span class="badge plain">Manual</span>` : html`<span class="muted small">History</span>`) },
        { label: 'Status', key: 'status', render: (r) => html`${statusBadge(r.status)}${r.quantity_rejected ? html` <span class="badge critical">${r.quantity_rejected} rejected</span>` : ''}` },
        { label: '', nosort: true, render: (r) => poActions(r) },
      ], data.rows, { empty: 'No parts orders here' })}
      <div class="card-note">${data.rows.length} of ${data.total} orders</div>
    </section>`;
}
const r0 = (status) => (status === 'received' ? 'Delivered' : 'Arrival (predicted / actual)');

function poActions(r) {
  if (r.status === 'submitted' || r.status === 'confirmed') {
    return html`<div class="row">${actionBtn({ label: 'Mark shipped', url: `/inventory-orders/${r.id}/ship`, body: {} })}
      <button class="btn small" data-dialog="receive-po" data-po="${r.id}" data-qty="${r.quantity}">Receive…</button></div>`;
  }
  if (r.status === 'in_transit') return html`<button class="btn small primary" data-dialog="receive-po" data-po="${r.id}" data-qty="${r.quantity}">Receive…</button>`;
  return '';
}

export async function purchaseOrderView(id) {
  const po = await api(`/inventory-orders/${encodeURIComponent(id)}`);
  return html`
    ${pageHead({
      crumbs: html`<a href="#/purchasing">Parts orders</a> /`,
      title: html`<span class="mono">${po.id}</span> · ${po.quantity} × ${po.part_number}`,
      sub: html`${po.part_name} from ${supplierLink(po.supplier_id, po.supplier_name)} · ${statusBadge(po.status)}`,
      actions: poActions(po),
    })}
    <div class="grid cols-2" style="margin-bottom:16px">
      <section class="card"><div class="card-head"><h2>Inventory order</h2></div><div class="card-body"><dl class="dl">
        <dt>Part</dt><dd>${partLink(po.part_number)} ${po.part_name}</dd>
        <dt>Supplier</dt><dd>${supplierLink(po.supplier_id, po.supplier_name)}</dd>
        <dt>Quantity</dt><dd>${fmtNum(po.quantity)} ordered · ${fmtNum(po.quantity_received)} received · ${fmtNum(po.quantity_rejected)} rejected</dd>
        <dt>Unit cost</dt><dd>${fmtMoney(po.unit_cost)} · total ${fmtMoney(po.unit_cost * po.quantity)}</dd>
        <dt>Submitted</dt><dd>${fmtDate(po.submission_date, { year: true })}</dd>
        <dt>Expected delivery</dt><dd>${fmtDate(po.expected_delivery_date, { year: true })} <span class="muted">(supplier quote)</span></dd>
        ${po.prediction ? html`<dt>Predicted arrival</dt><dd>${fmtDate(po.prediction.predictedArrival, { year: true })} <span class="muted">— ${po.prediction.basis}</span></dd>` : ''}
        <dt>Actual delivery</dt><dd>${fmtDate(po.actual_delivery_date, { year: true })}</dd>
        <dt>Delivery address</dt><dd>${po.delivery_address}</dd>
        <dt>Source</dt><dd>${po.source === 'model_recommendation' ? 'Inventory model recommendation' : po.source === 'manual' ? 'Placed manually' : 'Historical record'}</dd>
      </dl></div></section>
      <section class="card"><div class="card-head"><h2>Shipping</h2></div>
        ${table([
          { label: 'Shipment', key: 'id', render: (s) => html`<span class="mono">${s.id}</span>` },
          { label: 'Carrier', key: 'carrier', render: (s) => html`${s.carrier}<div class="mono small muted">${s.tracking_number}</div>` },
          { label: 'Shipped', key: 'shipped_date', render: (s) => fmtDate(s.shipped_date) },
          { label: 'ETA', key: 'expected_arrival_date', render: (s) => fmtDate(s.expected_arrival_date) },
          { label: 'Arrived', key: 'actual_arrival_date', render: (s) => fmtDate(s.actual_arrival_date) },
        ], po.shipments, { empty: 'Supplier has not shipped yet' })}
        <div class="card-head"><h2>Receiving issues</h2></div>
        ${table([
          { label: 'Report', key: 'id', render: (f) => html`<a class="mono" href="#/quality/${f.id}">${f.id}</a>` },
          { label: 'Class', key: 'failure_class' },
          { label: 'Qty', key: 'quantity', num: true },
          { label: 'Severity', key: 'severity', render: (f) => severityBadge(f.severity) },
          { label: 'Status', key: 'status', render: (f) => statusBadge(f.status) },
        ], po.failures, { empty: 'No issues' })}
      </section>
    </div>
    <section class="card"><div class="card-head"><h2>Received into inventory</h2></div>
      ${table([
        { label: 'Record', key: 'id', render: (ip) => html`<a class="mono" href="#/inventory-parts/${ip.id}">${ip.serial_number ?? ip.lot_number}</a>` },
        { label: 'Lot', key: 'lot_number', render: (ip) => html`<span class="mono">${ip.lot_number}</span>` },
        { label: 'Qty', key: 'quantity', num: true },
        { label: 'On hand', key: 'quantity_on_hand', num: true },
        { label: 'Status', key: 'status', render: (ip) => statusBadge(ip.status) },
      ], po.inventoryParts, { empty: 'Nothing received yet', scroll: true })}</section>`;
}

DIALOGS['receive-po'] = (data, done) => {
  openDialog(`Receive ${data.po}`, String(html`
    <p class="ink2" style="margin-top:0">Inspect the delivery and record any units that fail inspection. Accepted units go into stock immediately.</p>
    <label class="field">Units rejected at inspection<input name="rejected" type="number" min="0" max="${data.qty}" value="0"></label>
    <label class="field" style="margin-top:10px">Inspection note (optional)<input name="note"></label>
    <div class="form-actions"><button class="btn primary">Receive into stock</button></div>`), async (body) => {
    const out = await api(`/inventory-orders/${data.po}/receive`, { method: 'POST', body: { rejected: Number(body.rejected), note: body.note || null } });
    toast(`Received ${out.received} into stock${out.rejected ? `, ${out.rejected} rejected` : ''}`);
    done();
  });
};
