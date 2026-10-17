// Supply & demand projections: the forecast, the build plan, and what parts to buy.

import {
  api, html, fmtNum, fmtMoney, fmtPct, fmtWeek, fmtMonth, fmtDate, kpi, seg, qs, table, statusBadge,
  pageHead, partLink, orderLink, customerLink, supplierLink, modelSwatch, MODEL_COLORS, actionBtn, relDue, tractorLink,
} from '../lib.js';
import { barChart, lineChart, legend, tipRows } from '../charts.js';

const MODELS = ['TX-100', 'TX-200', 'TX-300', 'TX-400', 'TX-500'];

export async function planningView() {
  const [plan, forecast] = await Promise.all([api('/plan'), api('/forecast')]);
  const q = qs();
  const fm = q.get('fm') ?? 'all';
  const bf = q.get('builds') ?? 'risk';
  const rf = q.get('recs') ?? 'act';
  const s = plan.summary;
  const st = plan.settings;

  return html`
    ${pageHead({ title: 'Supply & demand plan', sub: `Model output as of ${fmtDate(plan.asOf)} for the next ${plan.horizonDays} days — review, then act on the recommendations.` })}
    <div class="kpis">
      ${kpi('Tractor demand', fmtNum(s.firmUnits + s.forecastUnits), `${s.firmUnits} firm + ${s.forecastUnits} forecast (to build)`)}
      ${kpi('Covered by stock', fmtNum(s.coveredByStock), 'unassigned tractors netted first')}
      ${kpi('Builds planned', fmtNum(s.buildsPlanned), `${fmtPct(s.capacityUtilization)} of build capacity`)}
      ${kpi('Builds at risk', fmtNum(s.buildsAtRisk), `${s.lateBuilds} projected late`, s.lateBuilds > 0)}
      ${kpi('Parts POs recommended', fmtNum(s.recommendedPurchaseOrders), `${s.actNowPurchaseOrders} to place this week`, s.actNowPurchaseOrders > 0)}
      ${kpi('Recommended spend', fmtMoney(s.recommendedSpend), `${plan.horizonDays}-day horizon`)}
    </div>

    <section class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>Planning assumptions</h2><span class="muted small">Change these and the models re-run instantly</span></div>
      <form class="card-body" data-form-post="/settings">
        <div class="form-grid">
          <label class="field">Plan to forecast level
            <select name="forecast_service_level">${[['p50', 'Expected (P50)'], ['p75', 'Cautious (P75)'], ['p90', 'Conservative (P90)']].map(([v, l]) => html`<option value="${v}" ${v === st.serviceLevel ? 'selected' : ''}>${l}</option>`)}</select></label>
          <label class="field">Safety stock (days of use)<input name="safety_stock_days" type="number" min="0" max="60" value="${st.safetyStockDays}"></label>
          <label class="field">Build bays (tractors/day)<input name="build_bays" type="number" min="1" max="20" value="${st.buildBays}"></label>
          <label class="field">Planning horizon (days)<input name="planning_horizon_days" type="number" min="30" max="180" value="${plan.horizonDays}"></label>
          <label class="field">Receiving time (days)<input name="receiving_days" type="number" min="0" max="14" value="${st.receivingDays}"></label>
        </div>
        <div class="form-actions"><span class="muted small" style="margin-right:auto">Typical order-to-delivery lead time (from history): ${st.orderToDeliveryLeadDays} days</span><button class="btn primary">Re-run plan</button></div>
      </form>
    </section>

    ${forecastCard(forecast, fm)}

    <div class="grid cols-2" style="margin:16px 0">
      ${buildPlanCard(plan)}
      ${demandCard(plan)}
    </div>

    <section class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>Parts to purchase</h2>
        <div class="right">${seg('recs', [['act', 'Act now', plan.recommendations.filter((r) => r.urgency !== 'upcoming').length], ['all', 'All', plan.recommendations.length]], rf)}</div></div>
      <div class="card-note">Recommendations from the inventory prediction model: sized to restore safety stock and cover the next 30 days of builds, from the best-scoring supplier that can deliver in time.</div>
      ${recommendationsTable(plan.recommendations.filter((r) => rf === 'all' || r.urgency !== 'upcoming'))}
    </section>

    <section class="card" style="margin-bottom:16px">
      <div class="card-head"><h2>Build plan</h2>
        <div class="right">${seg('builds', [['risk', 'At risk', plan.builds.filter((b) => b.status !== 'ok').length], ['firm', 'Firm orders', plan.builds.filter((b) => b.source === 'firm').length], ['all', 'All', plan.builds.length]], bf)}</div></div>
      <div class="card-note">How many tractors to build, and by when. Firm orders are built up to 3 weeks early when capacity allows; forecast demand is built about a week before it's needed.</div>
      ${buildsTable(plan.builds.filter((b) => (bf === 'risk' ? b.status !== 'ok' : bf === 'firm' ? b.source === 'firm' : true)))}
    </section>

    <div class="grid cols-2" style="margin-bottom:16px">
      <section class="card"><div class="card-head"><h2>Orders at risk</h2></div>
        ${table([
          { label: 'Order', key: 'orderId', render: (r) => orderLink(r.orderId) },
          { label: 'Customer', key: 'customerName', render: (r) => customerLink(r.customerId, r.customerName) },
          { label: 'Units', key: 'unitsAtRisk', num: true, render: (r) => `${r.unitsAtRisk} of ${r.quantity} × ${r.model}` },
          { label: 'Due', key: 'expectedDelivery', render: (r) => fmtDate(r.expectedDelivery) },
          { label: 'Why', key: 'shortParts', render: (r) => [r.shortParts.length ? `Short: ${r.shortParts.join(', ')}` : '', r.capacityConstrained ? 'Capacity' : ''].filter(Boolean).join(' · ') },
          { label: 'Outlook', key: 'daysLate', render: (r) => (r.daysLate ? html`<span class="badge critical">${r.daysLate}d late</span>` : statusBadge('at_risk')) },
        ], plan.orderRisks, { empty: 'No customer orders at risk' })}</section>
      <section class="card"><div class="card-head"><h2>Use existing stock first</h2></div>
        <div class="card-note">Unassigned finished or in-progress tractors the model nets against demand instead of building new ones.</div>
        ${table([
          { label: 'Tractor', key: 'serialNumber', render: (r) => tractorLink(r.tractorId, r.serialNumber) },
          { label: 'Status', key: 'tractorStatus', render: (r) => statusBadge(r.tractorStatus) },
          { label: 'Covers', key: 'orderId', render: (r) => (r.orderId ? html`${orderLink(r.orderId)} <span class="muted">${r.customerName}</span>` : html`<span class="muted">Forecast demand</span>`) },
          { label: 'Need by', key: 'needBy', render: (r) => fmtDate(r.needBy) },
          { label: '', nosort: true, render: (r) => (r.orderId ? actionBtn({ label: 'Earmark', url: `/tractors/${r.tractorId}/earmark`, body: { orderId: r.orderId } }) : '') },
        ], plan.stockAllocations, { empty: 'No unassigned tractors in stock' })}</section>
    </div>

    <section class="card">
      <div class="card-head"><h2>Parts requirements — next ${plan.horizonDays} days</h2></div>
      <div class="card-note">Requirement = planned builds × bill of materials × (1 + expected scrap/reject rate from parts performance tracking).</div>
      ${table([
        { label: 'Part', key: 'partNumber', render: (r) => html`${partLink(r.partNumber)} <span class="muted">${r.partName}</span>` },
        { label: 'On hand', key: 'onHand', num: true, render: (r) => fmtNum(r.onHand) },
        { label: 'On order', key: 'pending', num: true, render: (r) => fmtNum(r.pending) },
        { label: 'Need (firm)', key: 'firmRequirement', num: true, render: (r) => fmtNum(r.firmRequirement) },
        { label: 'Need (forecast)', key: 'forecastRequirement', num: true, render: (r) => fmtNum(r.forecastRequirement) },
        { label: 'Loss rate', key: 'expectedLossRate', num: true, render: (r) => fmtPct(r.expectedLossRate, 1) },
        { label: 'Safety stock', key: 'safetyStock', num: true },
        { label: 'Lowest projected', key: 'projectedMinWithExistingSupply', num: true, render: (r) => html`<span class="${r.projectedMinWithExistingSupply < 0 ? 'due over' : ''}">${fmtNum(r.projectedMinWithExistingSupply)}</span>` },
        { label: 'First shortfall', key: 'firstShortageDate', render: (r) => (r.firstShortageDate ? fmtDate(r.firstShortageDate) : '—') },
        { label: 'To buy', key: 'recommendedQuantity', num: true, render: (r) => fmtNum(r.recommendedQuantity) },
        { label: 'Status', key: 'status', render: (r) => statusBadge(r.status) },
      ], plan.parts)}
      <div class="card-note">"Lowest projected" uses only stock on hand and existing POs (at their predicted arrival) — a negative number is a shortfall without new orders.</div>
    </section>`;
}

function forecastCard(f, fm) {
  const months = f.historyMonths.slice(-24);
  const isAll = fm === 'all';
  const models = isAll ? f.models : f.models.filter((m) => m.model === fm);
  const hist = months.map((mo) => models.reduce((s, m) => s + (m.history.find((h) => h.month === mo)?.value ?? 0), 0));
  const fMonths = f.models[0].monthly.map((x) => x.month);
  const fVals = fMonths.map((mo) => models.reduce((s, m) => s + (m.monthly.find((x) => x.month === mo)?.mean ?? 0), 0));
  const labels = [...months, ...fMonths];
  const color = isAll ? 'var(--s1)' : MODEL_COLORS[fm];
  const histChart = lineChart({
    labels,
    series: [
      { name: 'Tractors ordered', color, values: [...hist, ...fMonths.map(() => null)] },
      { name: 'Forecast', color, dashed: true, values: [...hist.map((v, i) => (i === hist.length - 1 ? v : null)), ...fVals] },
    ],
    height: 220,
    labelEvery: 3,
    fmtLabel: (l) => fmtMonth(l),
  });
  const weekly = isAll ? f.weeklyTotals : models[0].weekly;
  const weekChart = lineChart({
    labels: weekly.map((w) => w.weekStart),
    series: [{ name: 'Expected new-order tractors', color, values: weekly.map((w) => w.mean) }],
    band: { lo: weekly.map((w) => w.p10), hi: weekly.map((w) => w.p90), color },
    height: 220,
    labelEvery: 2,
    fmtLabel: (l) => fmtWeek(l),
    tip: (i) => tipRows(`Week of ${fmtWeek(weekly[i].weekStart)}`, [['Expected', fmtNum(weekly[i].mean, 1)], ['Range (P10–P90)', `${fmtNum(weekly[i].p10, 1)}–${fmtNum(weekly[i].p90, 1)}`]]),
  });
  const seasonChart = barChart({
    labels: ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'],
    series: [{ name: 'Seasonality index', color: 'var(--s1)', values: f.seasonality }],
    height: 200,
    tip: (i) => tipRows(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][i], [['Index (1.0 = average month)', fmtNum(f.seasonality[i], 2)]]),
  });
  const total = isAll ? f.totals : models[0].total;
  return html`<section class="card">
    <div class="card-head"><h2>Demand forecast</h2><div class="right">${seg('fm', [['all', 'All models'], ...MODELS.map((m) => [m, m])], fm)}</div></div>
    <div class="grid cols-2" style="padding:0 14px 6px">
      <div><h3 style="margin:4px 0 2px">Monthly tractors ordered — history &amp; forecast</h3>${histChart}</div>
      <div><h3 style="margin:4px 0 2px">Next ${f.horizonDays} days by week — expected with P10–P90 range</h3>${weekChart}
        ${legend([{ name: 'Expected', color, line: true }, { name: 'P10–P90 range', color, band: true }])}</div>
    </div>
    <div class="grid cols-3" style="padding:6px 14px 14px;align-items:start">
      <div class="kpi"><div class="label">New-order tractors expected, next ${f.horizonDays} days</div>
        <div class="value">${fmtNum(total.mean)}</div><div class="hint">P10 ${fmtNum(total.p10)} · P75 ${fmtNum(total.p75)} · P90 ${fmtNum(total.p90)}</div></div>
      <div class="kpi"><div class="label">Economic factor</div><div class="value">×${fmtNum(f.economic.factor, 3)}</div>
        <div class="hint">Market trend index ${fmtNum(f.economic.marketTrend, 2)} · inflation ${fmtNum(f.economic.inflation, 2)}% (avg of ${f.economic.months.map(fmtMonth).join(', ')})</div></div>
      <div class="kpi"><div class="label">Backtest accuracy (total orders)</div><div class="value">${f.accuracy.mape === null ? '—' : `${fmtNum(100 - f.accuracy.mape)}%`}</div>
        <div class="hint">MAPE ${fmtNum(f.accuracy.mape, 1)}% · ${f.accuracy.note}</div></div>
    </div>
    <div class="grid cols-2" style="padding:0 14px 14px;align-items:start">
      <div><h3 style="margin-bottom:4px">Seasonality (month-of-year index)</h3>${seasonChart}</div>
      <div>${table([
        { label: 'Model', key: 'model', render: (m) => html`${modelSwatch(m.model)}${m.model} <span class="muted">${m.name}</span>` },
        { label: 'Level/mo', key: 'level', num: true, render: (m) => fmtNum(m.level, 1) },
        { label: 'Trend/mo', key: 'trendPerMonth', num: true, render: (m) => (m.trendPerMonth >= 0 ? '+' : '') + fmtNum(m.trendPerMonth, 2) },
        { label: `${f.horizonDays}d expected`, key: 'total', num: true, sort: (m) => m.total.mean, render: (m) => fmtNum(m.total.mean, 1) },
        { label: 'P10–P90', key: 'range', num: true, nosort: true, render: (m) => `${fmtNum(m.total.p10)}–${fmtNum(m.total.p90)}` },
      ], f.models)}</div>
    </div>
    <div class="card-note">${f.method}</div>
  </section>`;
}

function buildPlanCard(plan) {
  const w = plan.buildWeeks;
  const series = MODELS.map((m) => ({ name: m, color: MODEL_COLORS[m], values: w.map((x) => x.byModel[m] ?? 0) }));
  return html`<section class="card"><div class="card-head"><h2>Tractors to build, by week</h2></div>
    ${legend([...series, { name: 'Build capacity', color: 'var(--ink-2)', line: true }])}
    <div class="card-body">${barChart({
      labels: w.map((x) => x.weekStart), series, ref: { values: w.map((x) => x.capacity), label: 'Capacity' },
      height: 230, labelEvery: 2, fmtLabel: (l) => fmtWeek(l),
      tip: (i) => tipRows(`Week of ${fmtWeek(w[i].weekStart)}`, [...series.filter((s) => s.values[i]).map((s) => [s.name, s.values[i], s.color]),
        ['Total (firm)', `${w[i].total} (${w[i].firm})`], ['Capacity', w[i].capacity]]),
    })}</div></section>`;
}

function demandCard(plan) {
  const w = plan.demandWeekly;
  const series = [
    { name: 'Firm — built/building', color: 'var(--s1)', values: w.map((x) => x.firmBuilt) },
    { name: 'Firm — to build', color: 'var(--s2)', values: w.map((x) => x.firmToBuild) },
    { name: 'Forecast', color: 'var(--s3)', values: w.map((x) => x.forecast) },
  ];
  return html`<section class="card"><div class="card-head"><h2>Tractor demand by delivery week</h2></div>
    ${legend(series)}
    <div class="card-body">${barChart({ labels: w.map((x) => x.weekStart), series, height: 230, labelEvery: 2, fmtLabel: (l) => fmtWeek(l) })}</div></section>`;
}

export function recommendationsTable(recs) {
  return table([
    { label: 'Urgency', key: 'urgency', render: (r) => statusBadge(r.urgency) },
    { label: 'Part', key: 'partNumber', render: (r) => html`${partLink(r.partNumber)}<div class="muted small">${r.partName}</div>` },
    { label: 'Qty', key: 'quantity', num: true },
    { label: 'Supplier', key: 'supplierName', render: (r) => html`${supplierLink(r.supplierId, r.supplierName)}<div class="muted small">score ${fmtNum(r.supplierScore, 0)} · ${r.effectiveLeadDays}d lead</div>` },
    { label: 'Order by', key: 'orderBy', render: (r) => { const d = relDue(r.orderBy); return html`<span class="due ${d.cls}">${d.text}</span>`; } },
    { label: 'Needed', key: 'needDate', render: (r) => html`${fmtDate(r.needDate)}${r.daysLate ? html`<div class="due over small">arrives ${r.daysLate}d late</div>` : ''}` },
    { label: 'Cost', key: 'cost', num: true, render: (r) => fmtMoney(r.cost) },
    { label: 'Blocking', key: 'buildsBlocked', render: (r) => html`${r.buildsBlocked ? `${r.buildsBlocked} builds` : 'Safety stock'}${r.impactedOrders.length ? html`<div class="small">${r.impactedOrders.map((o) => html`<a class="chip" href="#/orders/${o.orderId}">${o.customerName}</a> `)}</div>` : ''}` },
    { label: '', nosort: true, render: (r) => actionBtn({ label: 'Place PO', url: '/inventory-orders', body: { partNumber: r.partNumber, supplierId: r.supplierId, quantity: r.quantity, source: 'model_recommendation' } }, 'btn small primary') },
  ], recs, { empty: 'No purchases needed right now' });
}

function buildsTable(builds) {
  return table([
    { label: '#', key: 'seq', num: true },
    { label: 'Model', key: 'model', cls: 'nowrap', render: (b) => html`${modelSwatch(b.model)}${b.model}` },
    { label: 'For', key: 'orderId', render: (b) => (b.orderId ? html`${orderLink(b.orderId)} <span class="muted">${b.customerName}</span>` : html`<span class="muted">Forecast (order expected ~${fmtDate(b.expectedSubmission)})</span>`) },
    { label: 'Build date', key: 'buildDate', render: (b) => fmtDate(b.buildDate) },
    { label: 'Latest start', key: 'latestStart', render: (b) => fmtDate(b.latestStart) },
    { label: 'Ship by', key: 'needBy', render: (b) => fmtDate(b.needBy) },
    { label: 'Parts ready', key: 'partsReady', render: (b) => (b.partsReady ? fmtDate(b.partsReady) : html`<span class="muted">on hand</span>`) },
    { label: 'Short', key: 'shortParts', render: (b) => b.shortParts.join(', ') || '—' },
    { label: 'Status', key: 'status', render: (b) => html`${statusBadge(b.status)}${b.daysLate ? html` <span class="small due over">${b.daysLate}d</span>` : ''}` },
    { label: '', nosort: true, render: (b) => (!b.startableNow ? '' : actionBtn({ label: 'Start now', url: '/builds', body: b.orderId ? { orderId: b.orderId, count: 1 } : { model: b.model, count: 1 } })) },
  ], builds, { empty: 'No builds in this view', scroll: true });
}
