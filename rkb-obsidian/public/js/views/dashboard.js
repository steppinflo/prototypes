// Landing page, laid out like the sketch: inventory of parts down the left, "what do you
// need to do today" in the centre with 90-day demand below it, current tractor inventory
// and current orders on the right.

import {
  api, html, fmtNum, fmtMoney, fmtPct, fmtWeek, fmtDate, relDue, kpi, seg, qs, actionBtn,
  severityBadge, statusBadge, modelSwatch, today, addDays, daysBetween, helpLabel,
} from '../lib.js';
import { barChart, legend, tipRows } from '../charts.js';

const CATEGORY_ORDER = ['Purchasing', 'Receiving', 'Production', 'Fulfilment', 'Customer', 'Service', 'Quality'];

export async function dashboardView() {
  const d = await api('/dashboard');
  const q = qs();
  const due = q.get('due') ?? 'now';
  const cat = q.get('cat') ?? 'all';
  const weekOut = addDays(d.today, 7);
  const byDue = {
    now: d.tasks.filter((t) => t.due <= d.today || t.severity === 'critical'),
    week: d.tasks.filter((t) => t.due <= weekOut || t.severity === 'critical'),
    all: d.tasks,
  };
  let tasks = byDue[due] ?? byDue.now;
  const cats = CATEGORY_ORDER.filter((c) => tasks.some((t) => t.category === c));
  if (cat !== 'all') tasks = tasks.filter((t) => t.category === cat);
  const s = d.summary;
  const overdue = d.tasks.filter((t) => t.overdueDays > 0).length;
  const atRisk = d.orders.filter((o) => o.risk).length;

  return html`
    <div class="page-head"><div><h1>Good ${greeting()} — here's the plan for ${fmtDate(d.today)}</h1>
      <div class="sub">${d.tasks.filter((t) => t.due <= d.today).length} tasks due today · ${overdue} overdue · ${atRisk} customer order${atRisk === 1 ? '' : 's'} at risk</div></div>
      <div class="actions"><a class="btn" href="#/planning">Open supply &amp; demand plan →</a></div></div>
    <div class="kpis">
      ${kpi('Tasks due now', fmtNum(byDue.now.length), `${d.tasks.filter((t) => t.severity === 'critical').length} critical`, d.tasks.some((t) => t.severity === 'critical'))}
      ${kpi('Parts POs to place', fmtNum(s.actNowPurchaseOrders), `of ${s.recommendedPurchaseOrders} recommended in ${d.demand.horizonDays}d`, s.actNowPurchaseOrders > 0)}
      ${kpi('Tractors to build', fmtNum(s.buildsPlanned), `${s.firmUnits} firm · ${s.forecastUnits} forecast · ${s.coveredByStock} from stock`)}
      ${kpi('Orders at risk', fmtNum(s.ordersAtRisk), `${s.lateBuilds} builds projected late`, s.lateBuilds > 0)}
      ${kpi('Recommended parts spend', fmtMoney(s.recommendedSpend), `next ${d.demand.horizonDays} days`)}
      ${kpi('Build capacity used', fmtPct(s.capacityUtilization), `next ${d.demand.horizonDays} days`)}
    </div>
    <div class="dash">
      <section class="card dash-parts">${partsPanel(d.parts)}</section>
      <section class="card dash-tasks">
        <div class="card-head"><h2>What do you need to do today</h2>
          <div class="right">${seg('due', [['now', 'Due now', byDue.now.length], ['week', 'This week', byDue.week.length], ['all', 'All', d.tasks.length]], due)}</div></div>
        <div class="card-head" style="padding-top:0">${seg('cat', [['all', 'All'], ...cats.map((c) => [c, c])], cat)}</div>
        <div class="tasks">${tasks.length ? tasks.map(taskCard) : html`<div class="empty">Nothing ${due === 'now' ? 'due right now' : 'here'} 🎉</div>`}</div>
      </section>
      <section class="card dash-tractors">${tractorsPanel(d.tractors)}</section>
      <section class="card dash-orders">${ordersPanel(d.orders)}</section>
      <section class="card dash-demand">${demandPanel(d.demand)}</section>
    </div>`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}

export function taskCard(t) {
  const due = relDue(t.due);
  return html`<div class="task ${t.severity}">
    <div class="bar"></div>
    <div>
      <div class="task-title">${t.title}</div>
      <div class="task-detail">${t.detail}</div>
      <div class="task-blocking"><b>Blocking:</b> ${t.blocking}</div>
      <div class="task-meta">${severityBadge(t.severity)}<span class="chip">${t.category}</span>
        ${t.customers.map((c) => html`<a class="chip" href="#/customers/${c.id}">👤 ${c.name}</a>`)}
        ${t.links.map((l) => html`<a class="chip" href="${l.href}">${l.label}</a>`)}</div>
    </div>
    <div class="task-side">
      <span class="due ${due.cls}">${due.text}</span>
      <div class="task-btns">
        ${actionBtn(t.action, 'btn small primary')}
        ${t.more.map((m) => actionBtn(m, 'btn small'))}
        <button class="btn small ghost" data-post="/tasks/state" data-body="${JSON.stringify({ key: t.key, status: 'snoozed', days: 1 })}" data-success="Snoozed until tomorrow" title="Snooze 1 day">Snooze</button>
        <button class="btn small ghost" data-post="/tasks/state" data-body="${JSON.stringify({ key: t.key, status: 'done' })}" data-success="Marked done" title="Mark done">✓</button>
      </div>
    </div>
  </div>`;
}

const PART_STATUS_ORDER = { critical: 0, order_now: 1, planned: 2, ok: 3 };

function partsPanel(parts) {
  const sorted = [...parts].sort((a, b) => PART_STATUS_ORDER[a.status] - PART_STATUS_ORDER[b.status] || a.part_number.localeCompare(b.part_number));
  const flagged = parts.filter((p) => p.status === 'critical' || p.status === 'order_now').length;
  return html`<div class="card-head"><h2>Inventory of parts</h2><div class="right"><a class="small" href="#/parts">All parts →</a></div></div>
    <div class="card-note">${flagged} part${flagged === 1 ? '' : 's'} need action · bar = on hand vs. 90-day requirement</div>
    <div class="mini-list">${sorted.map((p) => {
      const need = Math.max(p.requirement90, 1);
      const pctOn = Math.min(100, (100 * p.available) / need);
      const pctPend = Math.min(100 - pctOn, (100 * p.pending) / need);
      return html`<a class="mini-item" href="#/parts/${p.part_number}">
        <div><div class="t"><span class="mono">${p.part_number}</span> <span class="ink2" style="font-weight:400">${p.part_name}</span></div>
          <div class="meter" title="On hand ${p.available}, pending ${p.pending}, 90-day need ${p.requirement90}">
            <span style="width:${pctOn}%;background:var(--s1)"></span><span style="width:${pctPend}%;background:var(--s1);opacity:.35"></span></div></div>
        <div class="r"><div>${fmtNum(p.available)} <span class="muted">+${fmtNum(p.pending)}</span></div>
          <div>${p.status === 'ok' || p.status === 'planned' ? '' : statusBadge(p.status)}</div></div>
      </a>`;
    })}</div>
    <div class="card-note">Available <b>+pending</b> (on order) units</div>`;
}

const TRACTOR_COLS = [['in_production', 'Building'], ['qc_hold', 'QC hold'], ['inventoried', 'In stock'], ['earmarked', 'Earmarked'], ['shipping', 'Shipping']];
const TRACTOR_HELP = {
  Model: 'Tractor model.',
  Building: 'On the line today: one working day per tractor once all its parts are on hand.',
  'QC hold': 'Failed end-of-line test and waiting for a replacement part.',
  'In stock': 'Finished and not assigned to any customer order — available to earmark.',
  Earmarked: 'Finished and reserved for a customer order, waiting to ship.',
  Shipping: 'On a truck to the customer.',
};
const colHelp = (l) => `<b>${l}</b><div style="margin-top:3px">${TRACTOR_HELP[l]}</div>`;

function tractorsPanel(rows) {
  const total = (k) => rows.reduce((s, r) => s + r[k], 0);
  return html`<div class="card-head"><h2>Current inventory of tractors</h2><div class="right"><a class="small" href="#/tractors">All →</a></div></div>
    <div class="card-body flush"><table>
      <thead><tr><th>${helpLabel('Model', colHelp('Model'))}</th>${TRACTOR_COLS.map(([k, l]) => html`<th class="num"><a href="#/tractors?status=${k}">${helpLabel(l, colHelp(l))}</a></th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr><td class="nowrap">${modelSwatch(r.model)}<a href="#/tractors?model=${r.model}&status=current">${r.model}</a></td>
        ${TRACTOR_COLS.map(([k]) => html`<td class="num">${r[k] ? r[k] : html`<span class="muted">·</span>`}</td>`)}</tr>`)}
        <tr><td><b>Total</b></td>${TRACTOR_COLS.map(([k]) => html`<td class="num"><b>${total(k)}</b></td>`)}</tr></tbody></table></div>
    <div class="card-note">In stock = finished and unassigned · Earmarked = finished and reserved for a customer order</div>`;
}

function ordersPanel(orders) {
  return html`<div class="card-head"><h2>Current orders</h2><div class="right"><span class="muted small">${orders.length} open</span><a class="small" href="#/orders">All →</a></div></div>
    <div class="mini-list" style="max-height:640px;overflow:auto">${orders.map((o) => {
      const days = daysBetween(today(), o.expected_delivery_date);
      return html`<a class="mini-item" href="#/orders/${o.id}">
        <div><div class="t">${o.customer_name}</div>
          <div class="s"><span class="mono">${o.id}</span> · ${o.quantity} × ${o.model_number}</div>
          <div class="progress"><div class="meter" title="${o.built} built, ${o.building} building, of ${o.quantity}">
            <span style="width:${(100 * o.shipped) / o.quantity}%;background:var(--s3)"></span>
            <span style="width:${(100 * (o.built - o.shipped)) / o.quantity}%;background:var(--s1)"></span>
            <span style="width:${(100 * o.building) / o.quantity}%;background:var(--s1);opacity:.35"></span></div>
            <span class="muted small">${o.built}/${o.quantity}</span></div></div>
        <div class="r"><div class="${days < 0 ? 'due over' : ''}">${fmtDate(o.expected_delivery_date)}</div>
          <div>${o.risk ? statusBadge(o.risk.severity) : statusBadge(o.status)}</div></div>
      </a>`;
    })}</div>
    ${legend([{ name: 'Shipped', color: 'var(--s3)' }, { name: 'Built', color: 'var(--s1)' }])}`;
}

function demandPanel(demand) {
  const w = demand.weekly;
  const series = [
    { name: 'Firm — already built / building', color: 'var(--s1)', values: w.map((x) => x.firmBuilt) },
    { name: 'Firm — still to build', color: 'var(--s2)', values: w.map((x) => x.firmToBuild) },
    { name: 'Forecast — orders not yet received', color: 'var(--s3)', values: w.map((x) => x.forecast) },
  ];
  const sum = (k) => w.reduce((s, x) => s + x[k], 0);
  const chart = barChart({
    labels: w.map((x) => x.weekStart),
    series,
    height: 230,
    width: 760,
    labelEvery: 2,
    fmtLabel: (l) => fmtWeek(l),
    tip: (i) => tipRows(`Week of ${fmtWeek(w[i].weekStart)}`, [
      ...series.map((s) => [s.name, fmtNum(s.values[i]), s.color]),
      ['Total tractors', fmtNum(w[i].firmBuilt + w[i].firmToBuild + w[i].forecast)],
    ]),
  });
  return html`<div class="card-head"><h2>Demand for the next ${demand.horizonDays} days</h2>
      <div class="right muted small">tractors by week they're due to customers</div></div>
    ${legend(series)}
    <div class="card-body">${chart}</div>
    <div class="card-note">${sum('firmBuilt') + sum('firmToBuild')} firm tractors on open orders (${sum('firmToBuild')} still to build) + ~${sum('forecast')} forecast from orders the model expects to arrive
      (new-order forecast for the period: ${fmtNum(demand.forecastTotals.mean)}, range ${fmtNum(demand.forecastTotals.p10)}–${fmtNum(demand.forecastTotals.p90)}).
      Forecast demand is shifted by the typical order-to-delivery lead time. <a href="#/planning">Details →</a></div>`;
}

