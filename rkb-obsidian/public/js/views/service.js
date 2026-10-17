// Service & repairs: damaged tractors collected from customer sites, repaired at the plant, returned.

import {
  api, html, fmtDate, fmtMoney, seg, qs, table, statusBadge, pageHead, tractorLink, customerLink, partLink, kpi, fmtNum, actionBtn, severityBadge,
} from '../lib.js';

const STEPS = [['scheduled', 'Pickup scheduled'], ['in_transit_to_plant', 'On the way to plant'], ['in_repair', 'In repair'], ['returning', 'Returning'], ['completed', 'Back with customer']];
const LABEL = Object.fromEntries(STEPS);
const jobBadge = (s) => html`<span class="badge ${s === 'completed' ? 'good' : s === 'in_repair' ? 'warning' : 'info'}">${LABEL[s] ?? s}</span>`;
const total = (j) => j.haul_cost + j.repair_labor_cost + j.repair_parts_cost;

function nextAction(j) {
  if (j.status === 'scheduled') return { label: 'Picked up', url: `/service-jobs/${j.id}/pickup`, body: {} };
  if (j.status === 'in_transit_to_plant') return { label: 'Arrived at plant', url: `/service-jobs/${j.id}/arrive`, body: {} };
  if (j.status === 'in_repair') return { label: 'Repair done — ship back', url: `/service-jobs/${j.id}/repair`, body: {} };
  if (j.status === 'returning') return { label: 'Returned to customer', url: `/service-jobs/${j.id}/return`, body: {} };
  return null;
}

export async function serviceView() {
  const status = qs().get('status') ?? 'active';
  const jobs = await api(`/service-jobs?status=${status === 'all' ? '' : status}&limit=300`);
  const active = status === 'active' ? jobs : (await api('/service-jobs?status=active'));
  return html`
    ${pageHead({ title: 'Service & repairs', sub: 'Tractors collected from customer sites for repair at the plant. Arrange a pickup from any serious field failure.',
      actions: html`<a class="btn" href="#/quality?stage=field&fstatus=unresolved">Open field failures →</a>` })}
    <div class="kpis">
      ${kpi('Active jobs', fmtNum(active.length), `${active.filter((j) => j.rush).length} rush`)}
      ${kpi('At the plant', fmtNum(active.filter((j) => j.status === 'in_repair').length), 'awaiting or in repair')}
      ${kpi('On the road', fmtNum(active.filter((j) => ['in_transit_to_plant', 'returning'].includes(j.status)).length), 'to or from customers')}
    </div>
    <section class="card">
      <div class="card-head">${seg('status', [['active', 'Active'], ['completed', 'Completed'], ['all', 'All']], status)}</div>
      ${table([
        { label: 'Job', key: 'id', render: (j) => html`<a class="mono" href="#/service/${j.id}">${j.id}</a>${j.rush ? html` <span class="badge high">Rush</span>` : ''}` },
        { label: 'Tractor', key: 'serial_number', render: (j) => tractorLink(j.tractor_id, j.serial_number) },
        { label: 'Customer', key: 'customer_name', render: (j) => customerLink(j.customer_id, j.customer_name) },
        { label: 'Repair', key: 'part_number', render: (j) => (j.part_number ? partLink(j.part_number) : '—') },
        { label: 'Pickup', key: 'scheduled_pickup_date', render: (j) => fmtDate(j.picked_up_date ?? j.scheduled_pickup_date) },
        { label: 'Back by', key: 'expected_return_date', render: (j) => fmtDate(j.returned_date ?? j.expected_return_date) },
        { label: 'Cost', key: 'cost', num: true, sort: total, render: (j) => fmtMoney(total(j)) },
        { label: 'Status', key: 'status', render: (j) => jobBadge(j.status) },
        { label: '', nosort: true, render: (j) => actionBtn(nextAction(j)) },
      ], jobs, { empty: 'No service jobs', scroll: true })}</section>`;
}

export async function serviceJobView(id) {
  const j = await api(`/service-jobs/${encodeURIComponent(id)}`);
  const idx = STEPS.findIndex(([k]) => k === j.status);
  const blocked = j.status === 'in_repair' && j.part_number && !(j.partOnHand > 0);
  return html`
    ${pageHead({
      crumbs: html`<a href="#/service">Service &amp; repairs</a> /`,
      title: html`<span class="mono">${j.id}</span> · ${j.serial_number}`,
      sub: html`${customerLink(j.customer_id, j.customer_name)} · ${j.rush ? html`<span class="badge high">Rush</span> ` : ''}${jobBadge(j.status)}`,
      actions: html`${blocked ? '' : actionBtn(nextAction(j), 'btn primary')}
        <button class="btn" data-dialog="notify" data-payload="${JSON.stringify({ recipientType: 'customer', recipientId: j.customer_id, urgency: 'normal', entity: 'failure', entityId: j.failure_report_id,
          subject: `Update on ${j.serial_number}`, body: `Your tractor ${j.serial_number} is ${(LABEL[j.status] ?? j.status).toLowerCase()}; we expect it back with you by ${j.expected_return_date}.` })}">Update customer…</button>`,
    })}
    <div class="card" style="margin-bottom:16px;padding:10px 14px"><div class="timeline">${STEPS.map(([k, l], i) =>
      html`<div class="step ${i < idx || j.status === 'completed' ? 'done' : i === idx ? 'now' : ''}">${l}</div>`)}</div></div>
    ${blocked ? html`<div class="callout bad" style="margin-bottom:16px">No ${partLink(j.part_number)} on hand for this repair. Rush one in from the <a href="#/parts/${j.part_number}">part page</a> or the dashboard task.</div>` : ''}
    <div class="grid cols-2">
      <section class="card"><div class="card-head"><h2>Job</h2></div><div class="card-body"><dl class="dl">
        <dt>Tractor</dt><dd>${tractorLink(j.tractor_id, j.serial_number)} (${j.model_number})</dd>
        <dt>Failure</dt><dd>${j.failure_report_id ? html`<a class="mono" href="#/quality/${j.failure_report_id}">${j.failure_report_id}</a> ${severityBadge(j.severity)} — ${j.failure_description}` : '—'}</dd>
        <dt>Replace</dt><dd>${j.part_number ? html`${partLink(j.part_number)}${j.status === 'in_repair' ? html` · ${fmtNum(j.partOnHand)} on hand` : ''}` : '—'}</dd>
        <dt>Pickup address</dt><dd>${j.pickup_address}</dd>
        <dt>Pickup</dt><dd>scheduled ${fmtDate(j.scheduled_pickup_date, { year: true })}${j.picked_up_date ? ` · collected ${fmtDate(j.picked_up_date)}` : ''}</dd>
        <dt>Repaired</dt><dd>${fmtDate(j.repair_complete_date, { year: true })}</dd>
        <dt>Back with customer</dt><dd>${j.returned_date ? fmtDate(j.returned_date, { year: true }) : `expected ${fmtDate(j.expected_return_date, { year: true })}`}</dd>
        ${j.replacement_part_id ? html`<dt>Replacement unit</dt><dd><a class="mono" href="#/inventory-parts/${j.replacement_part_id}">${j.replacement_part_id}</a></dd>` : ''}
        ${j.notes ? html`<dt>Notes</dt><dd>${j.notes}</dd>` : ''}
      </dl></div></section>
      <section class="card"><div class="card-head"><h2>Cost</h2></div><div class="card-body"><dl class="dl">
        <dt>Hauling (both legs)</dt><dd>${fmtMoney(j.haul_cost)}${j.rush ? ' (rush +15%)' : ''}</dd>
        <dt>Repair labour</dt><dd>${fmtMoney(j.repair_labor_cost)}</dd>
        <dt>Replacement parts</dt><dd>${fmtMoney(j.repair_parts_cost)}</dd>
        <dt><b>Total</b></dt><dd><b>${fmtMoney(total(j))}</b></dd>
      </dl></div>
      <div class="card-head"><h2>Hauls</h2></div>
      ${table([
        { label: 'Shipment', key: 'id', render: (s) => html`<span class="mono">${s.id}</span>` },
        { label: 'Leg', key: 'direction', render: (s) => (s.direction === 'service_pickup' ? 'Site → plant' : 'Plant → site') },
        { label: 'Carrier', key: 'carrier' },
        { label: 'Shipped', key: 'shipped_date', render: (s) => fmtDate(s.shipped_date) },
        { label: 'ETA / arrived', key: 'expected_arrival_date', render: (s) => fmtDate(s.actual_arrival_date ?? s.expected_arrival_date) },
        { label: 'Cost', key: 'freight_cost', num: true, render: (s) => fmtMoney(s.freight_cost) },
        { label: 'Status', key: 'status', render: (s) => statusBadge(s.status) },
      ], j.shipments, { empty: 'Not collected yet' })}</section>
    </div>`;
}
