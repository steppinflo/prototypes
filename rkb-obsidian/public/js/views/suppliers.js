// Suppliers: reliability score (from parts performance tracking), delivery and quality history.

import {
  api, html, fmtNum, fmtPct, fmtDate, fmtMonth, fmtMoney, table, statusBadge, pageHead, partLink, poLink, kpi, daysBetween, severityBadge, actionBtn,
} from '../lib.js';
import { barChart } from '../charts.js';
import { supplierTrendChart, recurringTable } from './quality.js';

const scoreColor = (v) => (v >= 60 ? 'var(--good)' : v >= 45 ? 'var(--warning)' : 'var(--critical)');
const scoreWord = (v) => (v >= 60 ? 'Reliable' : v >= 45 ? 'Watch' : 'At risk');
export const scoreRing = (v) => html`<div class="score-ring" style="--v:${v ?? 0};--c:${scoreColor(v)}" title="Reliability score ${fmtNum(v, 1)} / 100"><span>${fmtNum(v)}</span></div>`;

export async function suppliersView() {
  const list = await api('/suppliers');
  return html`
    ${pageHead({ title: 'Suppliers', sub: 'Reliability scores combine delivery timeliness with the failure history of the parts each supplier provides.' })}
    <div class="grid cols-3">${list.map((s) => html`
      <a class="card supplier-card" href="#/suppliers/${s.id}" style="color:inherit;text-decoration:none">
        ${scoreRing(s.reliability_score)}
        <div style="min-width:0">
          <div class="muted small">${s.code} · ${s.city}, ${s.state}</div>
          <h2>${s.name}</h2>
          <div style="margin:4px 0"><span class="badge ${s.reliability_score >= 60 ? 'good' : s.reliability_score >= 45 ? 'warning' : 'critical'}">${scoreWord(s.reliability_score)}</span></div>
          <div class="small ink2">${fmtPct(s.performance.onTimeRate)} on time · ${fmtNum(s.performance.avgDaysLate, 1)}d avg late · ${fmtNum(s.performance.failuresPer100Installed, 1)} failures per 100 units</div>
          <div class="small muted" style="margin-top:4px">${s.parts.length} parts (${s.parts.filter((p) => p.is_primary).length} as primary) · ${s.openOrders} open orders · ${s.quoted_lead_days}d quoted lead</div>
        </div>
      </a>`)}</div>`;
}

export async function supplierView(id) {
  const [s, trends] = await Promise.all([api(`/suppliers/${encodeURIComponent(id)}`), api(`/quality/trends?supplier=${encodeURIComponent(id)}`)]);
  const t = trends.trends[0];
  const p = s.performance;
  const md = s.monthlyDelivery;
  return html`
    ${pageHead({
      crumbs: html`<a href="#/suppliers">Suppliers</a> /`,
      title: s.name,
      sub: html`${s.code} · ${s.primary_address} · ${fmtNum(s.lat, 2)}, ${fmtNum(s.lng, 2)}`,
      actions: actionBtn({ label: 'Notify supplier…', dialog: 'notify', data: { recipientType: 'supplier', recipientId: s.id, urgency: 'normal', entity: null, entityId: null,
        subject: `Performance review — ${s.name}`, body: `Over the last 12 months: ${Math.round((p.onTimeRate ?? 0) * 100)}% on-time, ${p.avgDaysLate} days late on average, ${p.failuresPer100Installed} failures per 100 units. ` } }, 'btn'),
    })}
    ${t?.worsening ? html`<div class="callout bad" style="margin-bottom:16px"><b>Getting worse:</b> failure rate ${t.direction.failureRate.before} → ${t.direction.failureRate.after} per 1,000 units,
      on-time ${Math.round(t.direction.onTime.before * 100)}% → ${Math.round(t.direction.onTime.after * 100)}% (first vs. second half of the last 12 months).</div>` : ''}
    <div class="kpis">
      <div class="kpi" style="display:flex;gap:12px;align-items:center">${scoreRing(s.reliability_score)}<div><div class="label">Reliability score</div><div class="hint">${scoreWord(s.reliability_score)} · PO-weighted part scores</div></div></div>
      ${kpi('On-time delivery', fmtPct(p.onTimeRate), `${p.purchaseOrders} orders received`)}
      ${kpi('Average days late', fmtNum(p.avgDaysLate, 1), `typical slip used for planning: ${fmtNum(p.predictedSlipDays, 1)}d`)}
      ${kpi('Failures per 100 units', fmtNum(p.failuresPer100Installed, 2), `${p.failures} failures all stages`)}
      ${kpi('Quoted lead time', `${s.quoted_lead_days}d`, 'from order to delivery')}
    </div>
    ${s.flags.length ? html`<div class="stack" style="margin-bottom:16px;gap:6px">${s.flags.map((f) => html`<div class="callout ${f.type === 'quality_review' ? 'warn' : ''}">${f.message}</div>`)}</div>` : ''}
    <div class="grid cols-2" style="margin-bottom:16px">
      <section class="card"><div class="card-head"><h2>On-time delivery by month</h2></div>
        <div class="card-body">${barChart({
          labels: md.map((m) => m.month), series: [{ name: 'On-time %', color: 'var(--s1)', values: md.map((m) => Math.round(m.on_time * 100)) }],
          height: 200, fmtLabel: (m) => fmtMonth(m), labelEvery: 2,
        })}</div></section>
      <section class="card"><div class="card-head"><h2>Open orders</h2></div>
        ${table([
          { label: 'PO', key: 'poId', render: (r) => poLink(r.poId) },
          { label: 'Part', key: 'partNumber', render: (r) => partLink(r.partNumber) },
          { label: 'Qty', key: 'quantity', num: true },
          { label: 'Quoted', key: 'expectedDelivery', render: (r) => html`${fmtDate(r.expectedDelivery)}${r.overdue ? html` <span class="badge critical">Late</span>` : ''}` },
          { label: 'Predicted', key: 'predictedArrival', render: (r) => fmtDate(r.predictedArrival) },
          { label: 'Status', key: 'status', render: (r) => statusBadge(r.status) },
        ], s.openOrders, { ctx: 'receipt', empty: 'No open orders' })}</section>
    </div>
    <div class="grid cols-2" style="margin-bottom:16px">
      <section class="card"><div class="card-head"><h2>Failures per 1,000 units, last 12 months</h2></div>${supplierTrendChart(trends.trends, 'failureRate')}</section>
      <section class="card"><div class="card-head"><h2>Days late per delivery, last 12 months</h2></div>${supplierTrendChart(trends.trends, 'avgDaysLate')}</section>
    </div>
    <section class="card" style="margin-bottom:16px"><div class="card-head"><h2>Recurring issues, last 12 months</h2></div>${recurringTable(trends.recurring)}</section>
    <section class="card" style="margin-bottom:16px"><div class="card-head"><h2>Parts supplied — performance</h2></div>
      ${table([
        { label: 'Part', key: 'partNumber', render: (r) => html`${partLink(r.partNumber)} <span class="muted small">${r.partName}</span>` },
        { label: 'Role', key: 'isPrimary', render: (r) => (r.isPrimary ? 'Primary' : 'Alternate') },
        { label: 'Unit cost', key: 'unitCost', num: true, render: (r) => fmtMoney(r.unitCost) },
        { label: 'Installed', key: 'unitsInstalled', num: true, render: (r) => fmtNum(r.unitsInstalled) },
        { label: 'Failures', key: 'f', num: true, sort: (r) => r.failures.total, render: (r) => `${r.failures.receiving}/${r.failures.manufacturing}/${r.failures.field}` },
        { label: 'Failure rate', key: 'failureRate', num: true, render: (r) => html`${fmtPct(r.failureRate, 1)} <span class="muted small">/ ${fmtPct(r.categoryFailureRate, 1)} avg</span>` },
        { label: 'On time', key: 'onTimeRate', num: true, render: (r) => fmtPct(r.onTimeRate) },
        { label: 'Avg late', key: 'avgDaysLate', num: true, render: (r) => (r.avgDaysLate === null ? '—' : `${fmtNum(r.avgDaysLate, 1)}d`) },
        { label: 'Score', key: 'score', num: true, render: (r) => html`<span class="score">${fmtNum(r.score)}</span>` },
      ], s.parts, { ctx: 'supplierPart' })}
      <div class="card-note">Failures shown as receiving / manufacturing / field. Failure rate vs. the average for that part category across all suppliers.</div></section>
    <div class="grid cols-2">
      <section class="card"><div class="card-head"><h2>Recent deliveries</h2></div>
        ${table([
          { label: 'PO', key: 'id', render: (r) => poLink(r.id) },
          { label: 'Part', key: 'part_number', render: (r) => partLink(r.part_number) },
          { label: 'Qty', key: 'quantity', num: true },
          { label: 'Quoted', key: 'expected_delivery_date', render: (r) => fmtDate(r.expected_delivery_date) },
          { label: 'Delivered', key: 'actual_delivery_date', render: (r) => { const d = daysBetween(r.expected_delivery_date, r.actual_delivery_date); return html`${fmtDate(r.actual_delivery_date)} ${d > 0 ? html`<span class="due over small">+${d}d</span>` : html`<span class="small" style="color:var(--good-text)">on time</span>`}`; } },
        ], s.recentOrders, { ctx: 'delivery', scroll: true })}</section>
      <section class="card"><div class="card-head"><h2>Recent failures</h2></div>
        ${table([
          { label: 'Report', key: 'id', render: (f) => html`<a class="mono" href="#/quality/${f.id}">${f.id}</a>` },
          { label: 'Date', key: 'reported_date', render: (f) => fmtDate(f.reported_date) },
          { label: 'Part', key: 'part_number', render: (f) => partLink(f.part_number) },
          { label: 'Stage', key: 'stage' },
          { label: 'Severity', key: 'severity', render: (f) => severityBadge(f.severity) },
          { label: 'Status', key: 'status', render: (f) => statusBadge(f.status) },
        ], s.failures, { ctx: 'failure', scroll: true })}</section>
    </div>`;
}
