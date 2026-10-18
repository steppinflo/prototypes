// Failures & issues across receiving (parts orders), manufacturing and the field,
// plus the parts performance tracker that scores each part x supplier.

import {
  api, html, fmtNum, fmtPct, fmtDate, fmtMonth, seg, qs, table, statusBadge, severityBadge, pageHead, partLink,
  supplierLink, tractorLink, customerLink, poLink, kpi, DIALOGS, openDialog, toast, actionBtn, stageLabel, rangeControl, today, addDays,
} from '../lib.js';
import { barChart, lineChart, hBars, legend, tipRows } from '../charts.js';
import { notificationList } from './notifications.js';

const STAGES = [['receiving', 'Receiving', 'var(--s1)'], ['manufacturing', 'Manufacturing', 'var(--s2)'], ['field', 'Field', 'var(--s3)']];

export async function qualityView() {
  const q = qs();
  const stage = q.get('stage') ?? '';
  const status = q.get('fstatus') ?? 'unresolved';
  const tab = q.get('tab') ?? 'recurring';
  const metric = q.get('metric') ?? 'failureRate';
  const to = q.get('to') ?? today();
  const from = q.get('from') ?? addDays(to, -364);
  const [quality, failures] = await Promise.all([
    api(`/quality?from=${from}&to=${to}`),
    api(`/failures?stage=${stage}&status=${status === 'all' ? '' : status}&from=${from}&to=${to}&limit=300`),
  ]);
  const perf = quality.performance;
  const count = (st, s) => quality.byStage.filter((r) => (!st || r.stage === st) && (!s || r.status === s)).reduce((a, r) => a + r.n, 0);
  const unresolved = quality.byStage.filter((r) => r.status !== 'resolved').reduce((a, r) => a + r.n, 0);
  const months = quality.months;
  const monthSeries = STAGES.map(([k, l, c]) => ({ name: l, color: c, values: months.map((m) => quality.byMonth.find((r) => r.month === m && r.stage === k)?.n ?? 0) }));
  const worsening = quality.trends.filter((t) => t.worsening);
  const rising = quality.recurring.filter((r) => r.trend === 'rising');

  return html`
    ${pageHead({ title: 'Failures & issues', sub: 'Problems at receiving inspection, on the line and in the field — and the patterns behind them, by part and supplier.',
      actions: html`${rangeControl(quality.from, quality.to)}<button class="btn primary" data-dialog="log-failure" data-stage="field">+ Log failure</button>` })}
    <div class="kpis">
      ${kpi('Unresolved issues', fmtNum(unresolved), `${count('field', 'open')} new field reports`, unresolved > 0)}
      ${kpi('Field failures', fmtNum(count('field')), 'tractors in service, in period')}
      ${kpi('Manufacturing / QC', fmtNum(count('manufacturing')), 'caught before shipping')}
      ${kpi('Receiving rejects', fmtNum(count('receiving')), 'units failing inspection')}
      ${kpi('Recurring patterns', fmtNum(quality.recurring.length), `${rising.length} rising in the second half of the period`, rising.length > 0)}
      ${kpi('Suppliers getting worse', fmtNum(worsening.length), worsening.map((t) => t.code).join(', ') || 'none', worsening.length > 0)}
    </div>

    <section class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>Supplier trends</h2>
        <div class="right">${seg('metric', [['failureRate', 'Failures per 1,000 units'], ['onTimeRate', 'On-time delivery'], ['avgDaysLate', 'Avg days late']], metric)}</div></div>
      ${supplierTrendChart(quality.trends, metric)}
      <div class="card-note">3-month rolling average. Failures are per 1,000 units installed over the trailing 12 months. A supplier is flagged as getting worse when its failure rate rises 25%+ or on-time delivery drops 10+ points between the first and second half of the period.</div>
    </section>

    <section class="card" style="margin-bottom:16px">
      <div class="tabs">${[['recurring', `Recurring failures (${quality.recurring.length})`], ['lots', `Lot clusters (${quality.lotClusters.length})`], ['late', `Repeat late deliveries (${quality.lateDeliveries.length})`],
        ['perf', 'Parts performance'], ['suppliers', 'Supplier reliability']].map(([k, l]) =>
        html`<button class="${k === tab ? 'on' : ''}" data-tab="${k}">${l}</button>`)}</div>
      ${tab === 'recurring' ? recurringTable(quality.recurring) : tab === 'lots' ? lotTable(quality.lotClusters) : tab === 'late' ? lateTable(quality.lateDeliveries)
        : tab === 'perf' ? perfTable(perf) : supplierBars(perf)}
      ${tab === 'perf' && perf.flags.length ? html`<div class="card-body"><h3 style="margin:8px 0">Tracker flags</h3>${perf.flags.map((f) =>
        html`<div class="callout ${f.type === 'quality_review' ? 'warn' : ''}" style="margin-bottom:6px">${f.type === 'quality_review' ? '⚠ Quality review: ' : '⇄ Sourcing: '}${f.message}</div>`)}</div>` : ''}
      ${tab === 'perf' || tab === 'suppliers' ? html`<div class="card-note">${perf.method}. Scores for the selected period; ≥15 installed units needed for the quality term.</div>` : ''}
    </section>

    <div class="grid cols-2" style="margin-bottom:16px">
      <section class="card"><div class="card-head"><h2>Failures by month</h2></div>
        ${legend(monthSeries)}
        <div class="card-body">${barChart({ labels: months, series: monthSeries, height: 220, fmtLabel: (m) => fmtMonth(m), labelEvery: Math.max(1, Math.ceil(months.length / 12)) })}</div></section>
      <section class="card"><div class="card-head"><h2>Worst parts in period</h2></div>
        <div class="card-body">${hBars(quality.byPart.slice(0, 10).map((p) => ({
          label: `${p.part_number} ${p.name}`, href: `#/parts/${p.part_number}`, value: p.n, color: 'var(--s2)', note: `${p.field} in field`,
        })))}</div></section>
    </div>

    <section class="card">
      <div class="card-head"><h2>Failure reports</h2>
        <div class="right">${seg('stage', [['', 'All stages'], ...STAGES.map(([k, l]) => [k, l])], stage)}
          ${seg('fstatus', [['unresolved', 'Unresolved'], ['open', 'Open'], ['investigating', 'Investigating'], ['resolved', 'Resolved'], ['all', 'All']], status)}</div></div>
      ${failuresTable(failures.rows)}
      <div class="card-note">${failures.rows.length} of ${failures.total} in the selected period</div>
    </section>`;
}

const SUPPLIER_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'];

export function supplierTrendChart(trends, metric) {
  const months = trends[0]?.months.map((m) => m.month) ?? [];
  const fmt = metric === 'onTimeRate' ? (v) => fmtPct(v) : metric === 'avgDaysLate' ? (v) => `${fmtNum(v, 1)}d` : (v) => fmtNum(v, 1);
  // 3-month rolling average so the direction is visible through monthly noise.
  const smooth = (vals) => vals.map((_, i) => {
    const w = vals.slice(Math.max(0, i - 2), i + 1).filter((v) => v !== null);
    return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
  });
  const raw = (t) => t.months.map((m) => (m[metric] === null ? null : metric === 'onTimeRate' ? m[metric] * 100 : m[metric]));
  const series = trends.map((t, i) => ({
    name: `${t.code}${t.worsening ? ' ▲ getting worse' : ''}`, color: SUPPLIER_COLORS[i % 5], values: smooth(raw(t)),
  }));
  if (!months.length) return html`<div class="empty">No data in range</div>`;
  return html`${legend(series.map((s) => ({ ...s, line: true })))}
    <div class="card-body">${lineChart({
      labels: months, series, height: 240, labelEvery: Math.max(1, Math.ceil(months.length / 12)), fmtLabel: (m) => fmtMonth(m), yMin: 0,
      tip: (i) => tipRows(`${fmtMonth(months[i])} (that month · 3-mo avg)`, trends.map((t, k) => [t.name,
        `${t.months[i][metric] === null ? '—' : fmt(t.months[i][metric])} · ${series[k].values[i] === null ? '—' : fmt(metric === 'onTimeRate' ? series[k].values[i] / 100 : series[k].values[i])}`, SUPPLIER_COLORS[k % 5]])),
    })}</div>`;
}

export function recurringTable(rows) {
  return table([
    { label: 'Pattern', key: 'symptom', render: (r) => html`<b>${r.symptom}</b><div class="small muted">${r.failureClass} · ${r.stages.map((x) => stageLabel[x]).join(', ')}</div>` },
    { label: 'Part', key: 'partNumber', render: (r) => partLink(r.partNumber) },
    { label: 'Supplier', key: 'supplierId', render: (r) => supplierLink(r.supplierId, r.supplierName) },
    { label: 'Units', key: 'units', num: true },
    { label: 'First – last', key: 'lastSeen', render: (r) => html`<span class="nowrap">${fmtDate(r.firstSeen)} – ${fmtDate(r.lastSeen)}</span>` },
    { label: 'Trend', key: 'trend', render: (r) => html`<span class="badge ${r.trend === 'rising' ? 'critical' : r.trend === 'falling' ? 'good' : 'plain'}">${r.trend} ${r.earlierHalf}→${r.recentHalf}</span>` },
    { label: 'Spread', key: 'customers', render: (r) => html`<span class="small">${r.customers} customers · ${r.lots} lots</span>` },
    { label: 'Open', key: 'open', num: true },
    { label: '', nosort: true, render: (r) => actionBtn({ label: 'Raise with supplier…', dialog: 'notify', data: {
      recipientType: 'supplier', recipientId: r.supplierId, urgency: r.trend === 'rising' ? 'urgent' : 'normal', entity: 'part', entityId: r.partNumber,
      subject: `Recurring failure: ${r.partNumber} — ${r.symptom}`,
      body: `We have ${r.units} reports of "${r.symptom}" on ${r.partNumber} from your parts between ${r.firstSeen} and ${r.lastSeen} (${r.lots} lots, ${r.customers} customers). Please send root cause and a corrective action plan.` } }) },
  ], rows, { ctx: 'recurring', empty: 'No pattern repeats 3+ times in this period', scroll: true });
}

function lotTable(rows) {
  return table([
    { label: 'Lot', key: 'lot_number', render: (r) => html`<span class="mono">${r.lot_number}</span>` },
    { label: 'Part', key: 'part_number', render: (r) => partLink(r.part_number) },
    { label: 'Supplier', key: 'supplier_id', render: (r) => supplierLink(r.supplier_id, r.supplier_name) },
    { label: 'Failures', key: 'units', num: true, render: (r) => html`${r.units} <span class="muted small">of ${r.lot_size} in lot</span>` },
    { label: 'Stages', key: 'stages', render: (r) => r.stages.split(',').map((x) => stageLabel[x]).join(', ') },
    { label: 'First – last', key: 'last_seen', render: (r) => `${fmtDate(r.first_seen)} – ${fmtDate(r.last_seen)}` },
  ], rows, { ctx: 'lot', empty: 'No lot has more than one failure in this period', scroll: true });
}

function lateTable(rows) {
  return table([
    { label: 'Supplier', key: 'supplier_id', render: (r) => supplierLink(r.supplier_id, r.supplier_name) },
    { label: 'Part', key: 'part_number', render: (r) => partLink(r.part_number) },
    { label: 'Late', key: 'late', num: true, render: (r) => `${r.late} of ${r.pos}` },
    { label: 'Late rate', key: 'lateRate', num: true, render: (r) => html`<span class="${r.lateRate > 0.5 ? 'due over' : ''}">${fmtPct(r.lateRate)}</span>` },
    { label: 'Avg days late', key: 'avg_late', num: true, render: (r) => fmtNum(r.avg_late, 1) },
    { label: 'Worst', key: 'worst', num: true, render: (r) => `${r.worst}d` },
    { label: '', nosort: true, render: (r) => actionBtn({ label: 'Raise with supplier…', dialog: 'notify', data: {
      recipientType: 'supplier', recipientId: r.supplier_id, urgency: 'normal', entity: 'part', entityId: r.part_number,
      subject: `Repeated late deliveries: ${r.part_number}`,
      body: `${r.late} of ${r.pos} orders for ${r.part_number} arrived late (avg ${r.avg_late} days, worst ${r.worst}). Please confirm realistic lead times or a recovery plan.` } }) },
  ], rows, { ctx: 'late', empty: 'No supplier/part was late 3+ times in this period', scroll: true });
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
  ], [...perf.parts].sort((a, b) => a.score - b.score), { ctx: 'supplierPart', scroll: true });
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
  ], rows, { ctx: 'failure', empty: 'No failure reports match', scroll: true });
}

export async function failureView(id) {
  const f = await api(`/failures/${encodeURIComponent(id)}`);
  return html`
    ${pageHead({
      crumbs: html`<a href="#/quality">Failures &amp; issues</a> /`,
      title: html`<span class="mono">${f.id}</span> · ${stageLabel[f.stage]} failure`,
      sub: html`${f.part_name} · ${severityBadge(f.severity)} ${statusBadge(f.status)}`,
      actions: html`
        ${f.stage === 'field' && f.status !== 'resolved' && f.tractorStatus === 'delivered' && !f.activeJob
          ? actionBtn({ label: 'Arrange pickup & repair…', dialog: 'pickup', data: { failureId: f.id, rush: f.severity === 'critical' ? '1' : '' } }, 'btn primary') : ''}
        ${f.activeJob ? html`<a class="btn" href="#/service/${f.activeJob.id}">Service job ${f.activeJob.id} →</a>` : ''}
        ${actionBtn({ label: f.customer_id ? 'Notify customer…' : 'Notify supplier…', dialog: 'notify', data: f.customer_id
          ? { recipientType: 'customer', recipientId: f.customer_id, urgency: 'normal', entity: 'failure', entityId: f.id, subject: `Your report ${f.id}`, body: `We are working on the ${f.part_name} issue on ${f.serial_number}.` }
          : { recipientType: 'supplier', recipientId: f.supplier_id, urgency: 'normal', entity: 'failure', entityId: f.id, subject: `Quality issue ${f.id}: ${f.part_number}`, body: `${f.description}. Please investigate and advise.` } }, 'btn')}
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
      </div>
      ${f.serviceJobs.length ? html`<div class="card-head"><h2>Service jobs</h2></div>${table([
        { label: 'Job', key: 'id', render: (j) => html`<a class="mono" href="#/service/${j.id}">${j.id}</a>` },
        { label: 'Status', key: 'status' },
        { label: 'Pickup', key: 'scheduled_pickup_date', render: (j) => fmtDate(j.scheduled_pickup_date) },
        { label: 'Back by', key: 'expected_return_date', render: (j) => fmtDate(j.returned_date ?? j.expected_return_date) },
      ], f.serviceJobs, { ctx: 'job' })}` : ''}
      ${notificationList(f.notifications)}</section>
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
