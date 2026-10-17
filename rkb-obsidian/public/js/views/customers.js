// Customers: who orders tractors, their open orders, fleet in the field and open issues.

import {
  api, html, fmtNum, fmtDate, table, statusBadge, pageHead, orderLink, tractorLink, partLink, modelSwatch, severityBadge,
} from '../lib.js';

export async function customersView() {
  const list = await api('/customers');
  return html`
    ${pageHead({ title: 'Customers', sub: `${list.length} customers across five fulfilment regions.`, actions: html`<button class="btn primary" data-dialog="new-order">+ New order</button>` })}
    <section class="card">${table([
      { label: 'Customer', key: 'name', render: (c) => html`<a href="#/customers/${c.id}">${c.name}</a>` },
      { label: 'Type', key: 'segment' },
      { label: 'Location', key: 'city', render: (c) => `${c.city}, ${c.state}` },
      { label: 'Region', key: 'region' },
      { label: 'Orders', key: 'orders', num: true },
      { label: 'Open orders', key: 'open_orders', num: true },
      { label: 'Tractors in field', key: 'fleet', num: true },
      { label: 'Open issues', key: 'open_issues', num: true, render: (c) => (c.open_issues ? html`<span class="badge critical">${c.open_issues}</span>` : '0') },
    ], list)}</section>`;
}

export async function customerView(id) {
  const c = await api(`/customers/${encodeURIComponent(id)}`);
  const open = c.orders.filter((o) => !['delivered', 'cancelled'].includes(o.status));
  return html`
    ${pageHead({
      crumbs: html`<a href="#/customers">Customers</a> /`,
      title: c.name,
      sub: html`${c.segment} · ${c.primary_address} · region ${c.region}`,
      actions: html`<button class="btn primary" data-dialog="new-order">+ New order</button>`,
    })}
    <div class="kpis">
      <div class="kpi"><div class="label">Open orders</div><div class="value">${fmtNum(open.length)}</div><div class="hint">${open.reduce((s, o) => s + o.quantity, 0)} tractors</div></div>
      <div class="kpi"><div class="label">Tractors in the field</div><div class="value">${fmtNum(c.fleet.length)}</div><div class="hint">delivered by RKB Obsidian</div></div>
      <div class="kpi"><div class="label">Lifetime orders</div><div class="value">${fmtNum(c.orders.length)}</div><div class="hint">since ${fmtDate(c.orders.at(-1)?.submission_date, { year: true })}</div></div>
      <div class="kpi ${c.failures.some((f) => f.status !== 'resolved') ? 'alert' : ''}"><div class="label">Open issues</div><div class="value">${fmtNum(c.failures.filter((f) => f.status !== 'resolved').length)}</div><div class="hint">${c.failures.length} failures reported all time</div></div>
    </div>
    <section class="card" style="margin-bottom:16px"><div class="card-head"><h2>Orders</h2></div>${table([
      { label: 'Order', key: 'id', render: (o) => orderLink(o.id) },
      { label: 'Tractors', key: 'quantity', render: (o) => html`${modelSwatch(o.model_number)}${o.quantity} × ${o.model_number}` },
      { label: 'Submitted', key: 'submission_date', render: (o) => fmtDate(o.submission_date) },
      { label: 'Expected', key: 'expected_delivery_date', render: (o) => fmtDate(o.expected_delivery_date) },
      { label: 'Delivered', key: 'actual_delivery_date', render: (o) => fmtDate(o.actual_delivery_date) },
      { label: 'Status', key: 'status', render: (o) => statusBadge(o.status) },
    ], c.orders, { scroll: true })}</section>
    <div class="grid cols-2">
      <section class="card"><div class="card-head"><h2>Fleet</h2></div>${table([
        { label: 'Tractor', key: 'serial_number', render: (t) => tractorLink(t.id, t.serial_number) },
        { label: 'Model', key: 'model_number', render: (t) => html`${modelSwatch(t.model_number)}${t.model_number}` },
        { label: 'Delivered', key: 'delivered_date', render: (t) => fmtDate(t.delivered_date) },
        { label: 'Order', key: 'customer_order_id', render: (t) => orderLink(t.customer_order_id) },
      ], c.fleet, { scroll: true, empty: 'No tractors delivered yet' })}</section>
      <section class="card"><div class="card-head"><h2>Field issues</h2></div>${table([
        { label: 'Report', key: 'id', render: (f) => html`<a class="mono" href="#/quality/${f.id}">${f.id}</a>` },
        { label: 'Date', key: 'reported_date', render: (f) => fmtDate(f.reported_date) },
        { label: 'Tractor', key: 'serial_number', render: (f) => tractorLink(f.tractor_id, f.serial_number) },
        { label: 'Part', key: 'part_number', render: (f) => partLink(f.part_number) },
        { label: 'Severity', key: 'severity', render: (f) => severityBadge(f.severity) },
        { label: 'Status', key: 'status', render: (f) => statusBadge(f.status) },
      ], c.failures, { scroll: true, empty: 'No issues reported' })}</section>
    </div>`;
}
