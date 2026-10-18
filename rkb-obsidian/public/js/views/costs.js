// Cost & efficiency: are we over- or under-spending against actual demand, for any period?

import {
  api, html, fmtMoney, fmtNum, fmtPct, fmtMonth, fmtDate, qs, table, pageHead, kpi, rangeControl, partLink, supplierLink, today, addDays,
} from '../lib.js';
import { barChart, lineChart, legend, tipRows } from '../charts.js';

export async function costsView() {
  const q = qs();
  const to = q.get('to') ?? today();
  const from = q.get('from') ?? addDays(to, -364);
  const c = await api(`/costs?from=${from}&to=${to}`);
  const s = c.summary;
  const m = c.monthly;
  const over = s.overUnderVsDemand;

  const spendSeries = [
    { name: 'Parts purchased', color: 'var(--s1)', values: m.map((x) => x.purchased) },
    { name: 'Parts consumed in builds', color: 'var(--s2)', values: m.map((x) => x.consumed) },
    { name: 'Needed by actual demand', color: 'var(--s3)', values: m.map((x) => x.demandNeed) },
  ];
  const fva = c.forecastVsActual;

  return html`
    ${pageHead({ title: 'Cost & efficiency', sub: 'How much the supply chain spent against what actual demand needed — and what it cost to hold, rush and fix.', actions: rangeControl(c.from, c.to) })}
    <div class="kpis">
      ${kpi('Parts purchased', fmtMoney(s.partsPurchased), `${fmtNum(s.purchaseOrders)} orders · ${fmtDate(c.from, { year: true })} – ${fmtDate(c.to, { year: true })}`)}
      ${kpi('Needed by actual demand', fmtMoney(s.demandNeed), `parts for ${fmtNum(s.demandTractors)} tractors ordered`)}
      ${kpi(over >= 0 ? 'Over-bought vs demand' : 'Under-bought vs demand', `${over >= 0 ? '+' : '−'}${fmtMoney(Math.abs(over))}`,
        s.overUnderPct === null ? '' : `${over >= 0 ? '+' : '−'}${fmtPct(Math.abs(s.overUnderPct), 1)} of need`, Math.abs(s.overUnderPct ?? 0) > 0.05)}
      ${kpi('Rush premiums', fmtMoney(s.rushPremium + s.rushFreightPremium), `${s.rushOrders} rush POs · ${fmtPct(s.rushShare, 1)} of parts spend`, s.rushShare > 0.01)}
      ${kpi('Inventory carrying cost', fmtMoney(s.carryingCost), `avg ${fmtMoney(s.inventoryAvg)} held · ${s.inventoryTurns ?? '—'} turns/yr`)}
      ${kpi('Late deliveries', fmtNum(s.lateDeliveries), s.lateDeliveries ? `${fmtMoney(s.lateDeliveryValue)} of orders, avg ${s.avgDaysLate}d late` : `of ${s.deliveredOrders} orders delivered`, s.lateDeliveries > 0)}
    </div>

    <section class="card" style="margin-bottom:16px"><div class="card-head"><h2>What the numbers say</h2></div>
      <div class="card-body stack" style="gap:6px">${c.insights.map((i) => html`<div class="callout ${i.tone === 'warn' ? 'warn' : ''}">${i.text}</div>`)}</div></section>

    <div class="grid cols-2" style="margin-bottom:16px">
      <section class="card"><div class="card-head"><h2>Spend vs. consumption vs. actual demand, by month</h2></div>
        ${legend(spendSeries)}
        <div class="card-body">${barChart({
          labels: m.map((x) => x.month), series: spendSeries, stacked: false, height: 240,
          labelEvery: Math.max(1, Math.ceil(m.length / 12)), fmtLabel: (l) => fmtMonth(l),
          tip: (i) => tipRows(fmtMonth(m[i].month), [...spendSeries.map((x) => [x.name, fmtMoney(x.values[i]), x.color]),
            ['Purchased − needed', `${m[i].purchased - m[i].demandNeed >= 0 ? '+' : '−'}${fmtMoney(Math.abs(m[i].purchased - m[i].demandNeed))}`],
            ['Rush premium', fmtMoney(m[i].rushPremium)]]),
        })}</div>
        <div class="card-note">"Needed by actual demand" = a parts kit for every tractor customers ordered that month, at the average price paid.</div></section>
      <section class="card"><div class="card-head"><h2>Parts inventory value</h2></div>
        <div class="card-body">${lineChart({
          labels: c.inventory.map((x) => x.date), series: [{ name: 'Inventory value', color: 'var(--s1)', values: c.inventory.map((x) => x.value) }],
          height: 240, labelEvery: Math.max(1, Math.ceil(c.inventory.length / 8)), fmtLabel: (d) => fmtDate(d),
          tip: (i) => tipRows(fmtDate(c.inventory[i].date, { year: true }), [['Parts on hand', fmtMoney(c.inventory[i].value)]]),
        })}</div>
        <div class="card-note">Start ${fmtMoney(s.inventoryStart)} → end ${fmtMoney(s.inventoryEnd)} · ${s.daysOfSupply ?? '—'} days of supply on average · carrying cost at ${fmtPct(c.assumptions.carryingCostRate)}/yr.</div></section>
    </div>

    <div class="grid cols-2" style="margin-bottom:16px">
      <section class="card"><div class="card-head"><h2>Where the money went</h2></div>
        ${table([
          { label: 'Cost', key: 'k', nosort: true },
          { label: 'Amount', key: 'v', num: true, nosort: true, render: (r) => fmtMoney(r.v) },
          { label: 'Note', key: 'n', nosort: true, render: (r) => html`<span class="muted small">${r.n}</span>` },
        ], [
          { k: 'Parts purchased', v: s.partsPurchased, n: `${fmtMoney(s.partsReceived)} received in period` },
          { k: 'Rush premiums (parts)', v: s.rushPremium, n: `${s.rushOrders} expedited orders at +${fmtPct(c.assumptions.rushPremium)}` },
          { k: 'Outbound freight', v: s.outboundFreight, n: `incl. ${fmtMoney(s.rushFreightPremium)} rush freight premium` },
          { k: 'Inventory carrying cost', v: s.carryingCost, n: `on ${fmtMoney(s.inventoryAvg)} average stock` },
          { k: 'Pickup & return hauling', v: s.serviceHaul, n: `${s.repairJobs} repair jobs` },
          { k: 'Repair labour & parts', v: s.repairCost, n: 'field failures repaired at the plant' },
          { k: 'Scrapped on the line', v: s.scrapValue, n: 'parts failing build / QC' },
          { k: 'Rejected at receiving', v: s.rejectedValue, n: 'returned to suppliers for credit' },
        ], { ctx: 'costLine' })}
        <div class="card-note">Parts cost per tractor built: ${fmtMoney(s.partsCostPerTractor)} · ${fmtNum(s.tractorsBuilt)} built, ${fmtNum(s.tractorsDelivered)} delivered (${fmtMoney(s.revenueDelivered)} revenue).</div></section>
      <section class="card"><div class="card-head"><h2>Forecast vs. actual tractors ordered</h2></div>
        ${fva.length ? html`${legend([{ name: 'Actual', color: 'var(--s1)', line: true }, { name: 'Forecast (one month ahead)', color: 'var(--s2)', line: true }])}
        <div class="card-body">${lineChart({
          labels: fva.map((x) => x.month),
          series: [{ name: 'Actual', color: 'var(--s1)', values: fva.map((x) => x.actual) }, { name: 'Forecast', color: 'var(--s2)', values: fva.map((x) => x.forecast) }],
          height: 220, labelEvery: Math.max(1, Math.ceil(fva.length / 10)), fmtLabel: (l) => fmtMonth(l), yMin: 0,
        })}</div>
        <div class="card-note">Mean absolute error ${s.forecastMape}% over ${fva.length} months — the gap the inventory model buffers with safety stock.</div>`
        : html`<div class="empty">Pick a range with at least one complete month</div>`}</section>
    </div>

    <div class="grid cols-2">
      <section class="card"><div class="card-head"><h2>By part</h2></div>
        ${table([
          { label: 'Part', key: 'partNumber', render: (p) => partLink(p.partNumber) },
          { label: 'Bought', key: 'boughtQty', num: true, render: (p) => fmtNum(p.boughtQty) },
          { label: 'Used', key: 'usedQty', num: true, render: (p) => fmtNum(p.usedQty) },
          { label: 'Bought ÷ used', key: 'buyToUseRatio', num: true, render: (p) => (p.buyToUseRatio === null ? '—' : html`<span class="${p.buyToUseRatio > 1.15 || p.buyToUseRatio < 0.85 ? 'due over' : ''}">${fmtNum(p.buyToUseRatio, 2)}</span>`) },
          { label: 'Spend', key: 'boughtValue', num: true, render: (p) => fmtMoney(p.boughtValue) },
          { label: 'Rush', key: 'rushPremium', num: true, render: (p) => fmtMoney(p.rushPremium) },
          { label: 'Excess now', key: 'excessValue', num: true, render: (p) => (p.excessValue ? fmtMoney(p.excessValue) : '—') },
        ], c.parts, { ctx: 'costPart', scroll: true })}
        <div class="card-note">Excess now = stock on hand today beyond the next 90 days' requirement plus safety stock.</div></section>
      <section class="card"><div class="card-head"><h2>By supplier</h2></div>
        ${table([
          { label: 'Supplier', key: 'name', render: (x) => supplierLink(x.id, x.name) },
          { label: 'Orders', key: 'pos', num: true },
          { label: 'Spend', key: 'spend', num: true, render: (x) => fmtMoney(x.spend) },
          { label: 'Share', key: 'share', num: true, sort: (x) => x.spend, render: (x) => fmtPct(s.partsPurchased ? x.spend / s.partsPurchased : 0) },
          { label: 'Rush orders', key: 'rush_count', num: true },
          { label: 'Rush premium', key: 'rush_premium', num: true, render: (x) => fmtMoney(x.rush_premium) },
        ], c.suppliers, { ctx: 'costSupplier' })}</section>
    </div>`;
}
