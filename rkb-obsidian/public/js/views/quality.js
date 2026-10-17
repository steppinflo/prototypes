// Failures & issues across receiving (parts orders), manufacturing and the field,
// plus the parts performance tracker that scores each part x supplier.

import {
  api, html, fmtNum, fmtPct, fmtDate, fmtMonth, seg, qs, table, statusBadge, severityBadge, pageHead, partLink,
  supplierLink, tractorLink, customerLink, poLink, kpi, DIALOGS, openDialog, toast, actionBtn, stageLabel,
} from '../lib.js';
import { barChart, hBars, legend, tipRows } from '../charts.js';

const STAGES = [['receiving', 'Receiving', 'var(--s1)'], ['manufacturing', 'Manufacturing', 'var(--s2)'], ['field', 'Field', 'var(--s3)']];

export async function qualityView() {
  const q = qs();
  const stage = q.get('stage') ?? '';
  const status = q.get('fstatus') ?? 'unresolved';
  const tab = q.get('tab') ?? 'perf';
  const [quality, failures] = await Promise.all([
    api('/quality'),
    api(`/failures?stage=${stage}&status=${status === 'all' ? '' : status}&limit=300`),
  ]);
  const perf = quality.performance;
  const count = (st, s) => quality.byStage.filter((r) => (!st || r.stage === st) && (!s || r.status === s)).reduce((a, r) => a + r.n, 0);
  const unresolved = quality.byStage.filter((r) => r.status !== 'resolved').reduce((a, r) => a + r.n, 0);
  const months = [...new Set(quality.byMonth.map((r) => r.month))];
  const monthSeries = STAGES.map(([k, l, c]) => ({ name: l, color: c, values: months.map((m) => quality.byMonth.find((r) => r.month === m && r.stage === k)?.n ?? 0) }));
  const classes = [...new Set(quality.byClass.map((r) => r.failure_class))];
  const classTotals = classes.map((c) => ({ c, n: quality.byClass.filter((r) => r.failure_class === c).reduce((a, r) => a + r.n, 0) })).sort((a, b) => b.n - a.n);

  return html`
    ${pageHead({ title: 'Failures & issues', sub: 'Problems at receiving inspection, on the line and in the field — and what they say about each part and supplier.', actions: html`<button class="btn primary" data-dialog="log-failure" data-stage="field">+ Log failure</button>` })}
    <div class="kpis">
      ${kpi('Unresolved issues', fmtNum(unresolved), `${count('field', 'open')} new field reports`, unresolved > 0)}
      ${kpi('Field failures', fmtNum(count('field')), 'all time, tractors in service')}
      ${kpi('Manufacturing / QC', fmtNum(count('manufacturing')), 'caught before shipping')}
      ${kpi('Receiving rejects', fmtNum(count('receiving')), 'units failing inspection')}
      ${kpi('Parts orders past quote', fmtNum(quality.lateOrders), 'open POs late vs. supplier date', quality.lateOrders > 0)}
    </div>
    <div class="grid cols-2" style="margin-bottom:16px">
      <section class="card"><div class="card-head"><h2>Failures by month, last 12 months</h2></div>
        ${legend(monthSeries)}
        <div class="card-body">${barChart({ labels: months, series: monthSeries, height: 220, fmtLabel: (m) => fmtMonth(m), labelEvery: 2 })}</div></section>
      <section class="card"><div class="card-head"><h2>Failure classes</h2></div>
        <div class="card-body">${hBars(classTotals.slice(0, 10).map((c) => ({ label: c.c, value: c.n, color: 'var(--s1)',
          tip: tipRows(c.c, STAGES.map(([k, l, col]) => [l, fmtNum(quality.byClass.find((r) => r.failure_class === c.c && r.stage === k)?.n ?? 0), col])) })))}</div></section>
    </div>

    <section class="card" style="margin-bottom:16px">
      <div class="tabs">${[['perf', 'Parts performance'], ['suppliers', 'Supplier reliability'], ['pareto', 'Worst parts']].map(([k, l]) =>
        html`<button data-seg-tab="${k}" class="${k === tab ? 'on' : ''}" onclick="location.hash='#/quality?tab=${k}'">${l}</button>`)}</div>
      ${tab === 'perf' ? perfTable(perf) : tab === 'suppliers' ? supplierBars(perf) : html`<div class="card-body" style="padding-top:12px">${hBars(quality.byPart.slice(0, 12).map((p) => ({
        label: `${p.part_number} ${p.name}`, href: `#/parts/${p.part_number}`, value: p.n, color: 'var(--s2)', note: `${p.field} in field`,
      })))}</div>`}
      ${perf.flags.length ? html`<div class="card-body"><h3 style="margin:8px 0">Tracker flags</h3>${perf.flags.map((f) =>
        html`<div class="callout ${f.type === 'quality_review' ? 'warn' : ''}" style="margin-bottom:6px">${f.type === 'quality_review' ? '⚠ Quality review: ' : '⇄ Sourcing: '}${f.message}</div>`)}</div>` : ''}
      <div class="card-note">${perf.method}. Scores need ≥15 installed units for the quality term; smaller samples are held at 50.</div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Failure reports</h2>
        <div class="right">${seg('stage', [['', 'All stages'], ...STAGES.map(([k, l]) => [k, l])], stage)}
          ${seg('fstatus', [['unresolved', 'Unresolved'], ['open', 'Open'], ['investigating', 'Investigating'], ['resolved', 'Resolved'], ['all', 'All']], status)}</div></div>
      ${failuresTable(failures.rows)}
      <div class="card-note">${failures.rows.length} of ${failures.total}</div>
    </section>`;
}

function perfTable(perf) {
  return table([
    { label: 'Part', key: 'partNumber', render: (r) => html`${partLink(r.partNumber)} <span class="muted small">${r.partName}</span>` },
    { label: 'Supplier', key: 'supplierId', render: (r) => html`${supplierLink(r.supplierId, r.supplierId)}${r.isPrimary ? ' ★' : ''}` },
    { label: 'Installed', key: 'unitsInstalled', num: true, render: (r) => fmtNum(r.unitsInstalled) },
    { label: 'Rcv', key: 'rcv', num: true, sort: (r) => r.failures.receiving, render: (r) => r.failures.receiving },
    { label: 'Mfg', key: 'mfg', num: true, sort: (r) => r.failures.manufacturing, render: (r) => r.failures.manufacturing },
    { label: 'Field', key: 'field', num: true, sort: (r) => r.failures.field, render: (r) => r.failures.field },
    { label: 'Failure rate', key: 'failureRate', num: true, render: (r) => html`<span class="${r.failureRate > 2 * r.categoryFailureRate ? 'due over' : ''}">${fmtPct(r.failureRate, 1)}</span> <span class="muted small">/ ${fmtPct(r.categoryFailureRate, 1)}</span>` },
    { label: 'On time', key: 'onTimeRate', num: true, render: (r) => fmtPct(r.onTimeRate) },
    { label: 'Avg late', key: 'avgDaysLate', num: true, render: (r) => (r.avgDaysLate === null ? '—' : `${fmtNum(r.avgDaysLate, 1)}d`) },
    { label: 'Score', key: 'score', num: true, render: (r) => html`<span class="score">${fmtNum(r.score)}</span>${r.lowSample ? html` <span class="muted small">low n</span>` : ''}` },
  ], [...perf.parts].sort((a, b) => a.score - b.score), { scroll: true });
}

function supplierBars(perf) {
  return html`<div class="card-body" style="padding-top:12px">${hBars([...perf.suppliers].sort((a, b) => b.reliabilityScore - a.reliabilityScore).map((s) => ({
    label: `${s.code} · ${s.name}`, href: `#/suppliers/${s.supplierId}`, value: s.reliabilityScore, color: 'var(--s1)',
    note: `${fmtPct(s.onTimeRate)} on time · ${fmtNum(s.avgDaysLate, 1)}d avg late · ${fmtNum(s.failuresPer100Installed, 1)} failures/100`,
  })), { max: 100, fmt: (v) => fmtNum(v, 1) })}</div>`;
}

export function failuresTable(rows) {
  return table([
    { label: 'Report', key: 'id', render: (f) => html`<a class="mono" href="#/quality/${f.id}">${f.id}</a>` },
    { label: 'Date', key: 'reported_date', render: (f) => fmtDate(f.reported_date) },
    { label: 'Stage', key: 'stage', render: (f) => stageLabel[f.stage] },
    { label: 'Severity', key: 'severity', sort: (f) => ['critical', 'high', 'medium', 'low'].indexOf(f.severity), render: (f) => severityBadge(f.severity) },
    { label: 'Part', key: 'part_number', render: (f) => partLink(f.part_number) },
    { label: 'Supplier', key: 'supplier_id', render: (f) => supplierLink(f.supplier_id, f.supplier_id) },
    { label: 'Class', key: 'failure_class' },
    { label: 'Tractor / customer', key: 'serial_number', render: (f) => html`${f.tractor_id ? tractorLink(f.tractor_id, f.serial_number) : '—'}${f.customer_name ? html`<div class="small muted">${f.customer_name}</div>` : ''}` },
    { label: 'Description', key: 'description', render: (f) => html`<span class="small">${f.description}</span>` },
    { label: 'Status', key: 'status', render: (f) => statusBadge(f.status) },
  ], rows, { empty: 'No failure reports match', scroll: true });
}

export async function failureView(id) {
  const f = await api(`/failures/${encodeURIComponent(id)}`);
  return html`
    ${pageHead({
      crumbs: html`<a href="#/quality">Failures &amp; issues</a> /`,
      title: html`<span class="mono">${f.id}</span> · ${stageLabel[f.stage]} failure`,
      sub: html`${f.part_name} · ${severityBadge(f.severity)} ${statusBadge(f.status)}`,
      actions: html`
        ${f.status === 'open' ? actionBtn({ label: 'Start investigation', url: `/failures/${f.id}/status`, body: { status: 'investigating' } }, 'btn') : ''}
        ${f.status !== 'resolved' ? html`<button class="btn primary" data-dialog="resolve-failure" data-id="${f.id}">Resolve…</button>` : actionBtn({ label: 'Reopen', url: `/failures/${f.id}/status`, body: { status: 'open' } }, 'btn')}`,
    })}
    <div class="grid cols-2">
      <section class="card"><div class="card-head"><h2>Report</h2></div><div class="card-body"><dl class="dl">
        <dt>Reported</dt><dd>${fmtDate(f.reported_date, { year: true })}</dd>
        <dt>Stage</dt><dd>${stageLabel[f.stage]}</dd>
        <dt>Class</dt><dd>${f.failure_class}</dd>
        <dt>Severity</dt><dd>${severityBadge(f.severity)}</dd>
        <dt>Description</dt><dd>${f.description}</dd>
        <dt>Quantity</dt><dd>${f.quantity}</dd>
        <dt>Status</dt><dd>${statusBadge(f.status)}${f.resolved_date ? ` on ${fmtDate(f.resolved_date)}` : ''}</dd>
        ${f.resolution ? html`<dt>Resolution</dt><dd>${f.resolution}</dd>` : ''}
      </dl></div></section>
      <section class="card"><div class="card-head"><h2>Traceability</h2></div><div class="card-body"><dl class="dl">
        <dt>Part</dt><dd>${partLink(f.part_number)} ${f.part_name}</dd>
        <dt>Supplier</dt><dd>${supplierLink(f.supplier_id, f.supplier_name)}</dd>
        <dt>Unit / lot</dt><dd>${f.inventory_part_id ? html`<a class="mono" href="#/inventory-parts/${f.inventory_part_id}">${f.part_serial ?? f.lot_number}</a>` : '—'}</dd>
        <dt>Parts order</dt><dd>${poLink(f.inventory_order_id)}</dd>
        <dt>Tractor</dt><dd>${f.tractor_id ? html`${tractorLink(f.tractor_id, f.serial_number)} (${f.model_number})` : '—'}</dd>
        <dt>Customer</dt><dd>${customerLink(f.customer_id, f.customer_name)}</dd>
      </dl>
      ${f.sameLotFailures.length ? html`<h3 style="margin:14px 0 6px">Other failures from lot ${f.lot_number}</h3>
        ${f.sameLotFailures.map((x) => html`<div class="small"><a class="mono" href="#/quality/${x.id}">${x.id}</a> · ${fmtDate(x.reported_date)} · ${x.stage} — ${x.description}</div>`)}` : ''}
      </div></section>
    </div>`;
}

DIALOGS['resolve-failure'] = (data, done) => {
  openDialog(`Resolve ${data.id}`, String(html`
    <label class="field">Resolution<textarea name="resolution" required placeholder="e.g. Replaced under warranty; failed unit returned to supplier"></textarea></label>
    <div class="form-actions"><button class="btn primary">Resolve</button></div>`), async (body) => {
    await api(`/failures/${data.id}/status`, { method: 'POST', body: { status: 'resolved', resolution: body.resolution } });
    toast(`${data.id} resolved`);
    done();
  });
};

DIALOGS['log-failure'] = async (data, done) => {
  const cat = await api('/catalog');
  const parts = data.parts ? JSON.parse(data.parts) : cat.parts.map((p) => p.part_number);
  const stage = data.stage ?? 'field';
  openDialog('Log a failure or issue', String(html`
    <div class="form-grid">
      <label class="field">Stage<select name="stage">${[['field', 'Field (in service)'], ['manufacturing', 'Manufacturing / QC'], ['receiving', 'Receiving inspection']].map(([v, l]) => html`<option value="${v}" ${v === stage ? 'selected' : ''}>${l}</option>`)}</select></label>
      <label class="field">Severity<select name="severity">${['low', 'medium', 'high', 'critical'].map((s) => html`<option ${s === 'medium' ? 'selected' : ''}>${s}</option>`)}</select></label>
      ${data.inventoryPart ? html`<input type="hidden" name="inventoryPartId" value="${data.inventoryPart}">` : html`
        <label class="field">Tractor (id or serial)<input name="tractorId" value="${data.tractor ?? ''}" placeholder="optional"></label>
        <label class="field">Part<select name="partNumber">${parts.map((pn) => html`<option>${pn}</option>`)}</select></label>
        <label class="field">Supplier <span class="muted">(if no tractor)</span><select name="supplierId"><option value="">—</option>${cat.suppliers.map((s) => html`<option value="${s.id}">${s.id} · ${s.name}</option>`)}</select></label>`}
      <label class="field">Failure class<select name="failureClass">${['Mechanical', 'Hydraulic', 'Electrical', 'Structural', 'Wear', 'Fit & Finish', 'Software', 'Thermal', 'Damaged in Transit', 'Dead on Arrival', 'Wrong Spec'].map((c) => html`<option>${c}</option>`)}</select></label>
      <label class="field" style="grid-column:1/-1">What happened<textarea name="description" required></textarea></label>
    </div>
    <div class="form-actions"><button class="btn primary">Log failure</button></div>`), async (body) => {
    const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== ''));
    const out = await api('/failures', { method: 'POST', body: clean });
    toast(`Logged ${out.id}`);
    done();
  });
};
