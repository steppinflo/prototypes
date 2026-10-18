// Parts inventory: balances, projections, suppliers, lots, and per-unit traceability.

import {
  api, html, raw, fmtNum, fmtMoney, fmtPct, fmtDate, fmtWeek, table, statusBadge, pageHead, partLink, poLink,
  supplierLink, tractorLink, DIALOGS, openDialog, toast, kpi, severityBadge, seg, qs, modelSwatch,
} from '../lib.js';
import { tractorSvg, getCatalog, setCatalog } from '../tractorDiagram.js';
import { lineChart, legend, tipRows } from '../charts.js';
import { recommendationsTable } from './planning.js';

export async function partsView() {
  const parts = await api('/parts');
  return html`
    ${pageHead({ title: 'Parts inventory', sub: 'Balance, pending orders and 90-day requirement for every part that goes into a tractor.', actions: html`<button class="btn primary" data-dialog="new-po">+ New parts order</button>` })}
    <section class="card">
      ${table([
        { label: 'Part number', key: 'part_number', render: (p) => partLink(p.part_number) },
        { label: 'Part name', key: 'part_name' },
        { label: 'Type', key: 'category' },
        { label: 'Tracking', key: 'serialized', render: (p) => (p.serialized ? 'Serial' : 'Lot') },
        { label: 'Available', key: 'available', num: true, render: (p) => fmtNum(p.available) },
        { label: 'Pending', key: 'pending', num: true, render: (p) => fmtNum(p.pending) },
        { label: '90-day need', key: 'need', num: true, sort: (p) => p.plan.grossRequirement, render: (p) => fmtNum(p.plan.grossRequirement) },
        { label: 'Unit cost', key: 'unit_cost', num: true, render: (p) => fmtMoney(p.unit_cost) },
        { label: 'Stock value', key: 'value', num: true, sort: (p) => p.available * p.unit_cost, render: (p) => fmtMoney(p.available * p.unit_cost) },
        { label: 'Suppliers (score)', key: 'suppliers', nosort: true, render: (p) => html`${p.suppliers.map((s) => html`<a class="chip" href="#/suppliers/${s.supplierId}">${s.supplierId.slice(-1)}${s.isPrimary ? '★' : ''} ${fmtNum(s.score)}</a> `)}` },
        { label: 'Next order', key: 'next', sort: (p) => p.nextRecommendation?.orderBy ?? '9', render: (p) => (p.nextRecommendation ? html`${fmtNum(p.nextRecommendation.quantity)} by ${fmtDate(p.nextRecommendation.orderBy)}` : '—') },
        { label: 'Status', key: 'status', sort: (p) => p.plan.status, render: (p) => statusBadge(p.plan.status) },
      ], parts, { ctx: 'partList' })}
      <div class="card-note">★ primary supplier · scores from parts performance tracking (0–100)</div>
    </section>`;
}

export async function partView(pn) {
  const p = await api(`/parts/${encodeURIComponent(pn)}`);
  if (!getCatalog()) setCatalog(await api('/catalog'));
  const models = p.usedIn.map((u) => u.model_number);
  const shownModel = models.includes(qs().get('model')) ? qs().get('model') : models[0];
  const proj = p.projection ?? [];
  const chart = lineChart({
    labels: proj.map((x) => x.weekStart),
    series: [
      { name: 'Existing stock + open POs', color: 'var(--s2)', values: proj.map((x) => x.existingSupply) },
      { name: 'With recommended POs', color: 'var(--s1)', values: proj.map((x) => x.withRecommendations) },
    ],
    refY: { value: p.plan.safetyStock, label: `Safety stock ${p.plan.safetyStock}`, color: 'var(--ink-2)' },
    height: 260, width: 1240, labelEvery: 1, fmtLabel: (l) => fmtWeek(l),
    tip: (i) => tipRows(`End of week of ${fmtWeek(proj[i].weekStart)}`, [['Existing supply only', fmtNum(proj[i].existingSupply), 'var(--s2)'], ['With recommendations', fmtNum(proj[i].withRecommendations), 'var(--s1)'], ['Safety stock', proj[i].safetyStock]]),
  });
  return html`
    ${pageHead({
      crumbs: html`<a href="#/parts">Parts inventory</a> /`,
      title: html`<span class="mono">${p.part_number}</span> · ${p.name}`,
      sub: html`${p.category} · ${p.serialized ? 'tracked by serial number' : 'tracked by lot'} · ${fmtMoney(p.unit_cost)} list · pack ${p.pack_size}, min order ${p.min_order_qty} · used in ${p.usedIn.map((u) => `${u.model_number} (×${u.quantity})`).join(', ')}`,
      actions: html`<button class="btn primary" data-dialog="new-po" data-part="${p.part_number}">+ Order this part</button>`,
    })}
    <div class="kpis">
      ${kpi('Available', fmtNum(p.available), 'on hand, ready to build')}
      ${kpi('Pending', fmtNum(p.pending), `on ${p.openOrders.length} open parts order(s)`)}
      ${kpi('90-day requirement', fmtNum(p.plan.grossRequirement), `${p.plan.firmRequirement} firm · ${p.plan.forecastRequirement} forecast`)}
      ${kpi('Expected loss rate', fmtPct(p.plan.expectedLossRate, 1), 'QC scrap + receiving rejects')}
      ${kpi('Plan status', statusBadge(p.plan.status), p.plan.firstShortageDate ? `short from ${fmtDate(p.plan.firstShortageDate)} without new orders` : 'no shortfall projected', p.plan.status === 'critical')}
    </div>
    <section class="card" style="margin-bottom:16px"><div class="card-head"><h2>Where it goes</h2>
        ${models.length > 1 ? html`<div class="right">${seg('model', models.map((m) => [m, m]), shownModel)}</div>` : ''}</div>
      <div class="tractor-view">
        <div>${raw(tractorSvg({ model: shownModel, focus: p.part_number, muted: true, title: `${p.name} on a ${shownModel}` }))}</div>
        <div class="td-panel"><h3>${p.name}</h3><p class="desc">${p.description}</p>
          <div class="muted small" style="margin-bottom:4px">Used in</div>
          ${p.usedIn.map((u) => html`<div style="padding:4px 0;border-top:1px solid var(--border)">${modelSwatch(u.model_number)}${u.model_number} ${u.name} <span class="muted">× ${u.quantity} per tractor</span></div>`)}
        </div>
      </div></section>
    <section class="card" style="margin-bottom:16px"><div class="card-head"><h2>Projected on-hand, next ${proj.length} weeks</h2></div>
      ${legend([{ name: 'Existing stock + open POs', color: 'var(--s2)', line: true }, { name: 'With recommended POs', color: 'var(--s1)', line: true }, { name: 'Safety stock', color: 'var(--ink-2)', line: true }])}
      <div class="card-body">${chart}</div></section>
    ${p.recommendations.length ? html`<section class="card" style="margin-bottom:16px"><div class="card-head"><h2>Recommended orders</h2></div>${recommendationsTable(p.recommendations)}</section>` : ''}
    <section class="card" style="margin-bottom:16px"><div class="card-head"><h2>Suppliers for this part</h2></div>
      ${table([
        { label: 'Supplier', key: 'name', render: (s) => html`${supplierLink(s.supplier_id, s.name)}${s.is_primary ? html` <span class="badge plain">Primary</span>` : ''}` },
        { label: 'Score', key: 'score', num: true, sort: (s) => s.performance?.score, render: (s) => html`<span class="score">${fmtNum(s.performance?.score)}</span>` },
        { label: 'Unit cost', key: 'unit_cost', num: true, render: (s) => fmtMoney(s.unit_cost) },
        { label: 'Quoted lead', key: 'quoted_lead_days', num: true, render: (s) => `${s.quoted_lead_days}d` },
        { label: 'Typical slip', key: 'slip', num: true, sort: (s) => s.performance?.predictedSlipDays, render: (s) => `${fmtNum(s.performance?.predictedSlipDays, 1)}d` },
        { label: 'On time', key: 'ot', num: true, sort: (s) => s.performance?.onTimeRate, render: (s) => fmtPct(s.performance?.onTimeRate) },
        { label: 'Installed', key: 'inst', num: true, sort: (s) => s.performance?.unitsInstalled, render: (s) => fmtNum(s.performance?.unitsInstalled) },
        { label: 'Failures (rcv/mfg/field)', key: 'f', nosort: true, render: (s) => (s.performance ? `${s.performance.failures.receiving} / ${s.performance.failures.manufacturing} / ${s.performance.failures.field}` : '—') },
        { label: 'Failure rate', key: 'fr', num: true, sort: (s) => s.performance?.failureRate, render: (s) => html`${fmtPct(s.performance?.failureRate, 1)} <span class="muted small">vs ${fmtPct(s.performance?.categoryFailureRate, 1)}</span>` },
      ], p.suppliers, { ctx: 'supplierPart' })}</section>
    <div class="grid cols-2" style="margin-bottom:16px">
      <section class="card"><div class="card-head"><h2>Open parts orders</h2></div>
        ${table([
          { label: 'PO', key: 'poId', render: (r) => poLink(r.poId) },
          { label: 'Supplier', key: 'supplierName', render: (r) => supplierLink(r.supplierId, r.supplierName) },
          { label: 'Qty', key: 'quantity', num: true },
          { label: 'Quoted', key: 'expectedDelivery', render: (r) => html`${fmtDate(r.expectedDelivery)}${r.overdue ? html` <span class="badge critical">Late</span>` : ''}` },
          { label: 'Predicted', key: 'predictedArrival', render: (r) => html`${fmtDate(r.predictedArrival)}<div class="muted small">${r.basis}</div>` },
          { label: 'Status', key: 'status', render: (r) => statusBadge(r.status) },
        ], p.openOrders, { ctx: 'receipt', empty: 'Nothing on order' })}</section>
      <section class="card"><div class="card-head"><h2>In stock (${p.serialized ? 'units' : 'lots'})</h2></div>
        ${table([
          { label: p.serialized ? 'Serial' : 'Lot', key: 'id', render: (ip) => html`<a class="mono" href="#/inventory-parts/${ip.id}">${ip.serial_number ?? ip.lot_number}</a>` },
          { label: 'Supplier', key: 'supplier_name', render: (ip) => supplierLink(ip.supplier_id, ip.supplier_name) },
          { label: 'Received', key: 'received_date', render: (ip) => fmtDate(ip.received_date) },
          { label: 'On hand', key: 'quantity_on_hand', num: true },
          { label: 'PO', key: 'inventory_order_id', render: (ip) => poLink(ip.inventory_order_id) },
        ], p.stock, { ctx: 'stock', empty: 'None on hand', scroll: true })}</section>
    </div>
    <div class="grid cols-2">
      <section class="card"><div class="card-head"><h2>Recently installed</h2></div>
        ${table([
          { label: 'Tractor', key: 'serial_number', render: (r) => tractorLink(r.tractor_id, r.serial_number) },
          { label: 'Unit / lot', key: 'part_serial', render: (r) => html`<a class="mono" href="#/inventory-parts/${r.inventory_part_id}">${r.part_serial ?? r.lot_number}</a>` },
          { label: 'Qty', key: 'quantity', num: true },
          { label: 'Installed', key: 'installed_date', render: (r) => fmtDate(r.installed_date) },
        ], p.recentInstalls, { ctx: 'install', scroll: true })}</section>
      <section class="card"><div class="card-head"><h2>Recent failures</h2></div>
        ${table([
          { label: 'Report', key: 'id', render: (f) => html`<a class="mono" href="#/quality/${f.id}">${f.id}</a>` },
          { label: 'Date', key: 'reported_date', render: (f) => fmtDate(f.reported_date) },
          { label: 'Stage', key: 'stage' },
          { label: 'Class', key: 'failure_class' },
          { label: 'Supplier', key: 'supplier_id' },
          { label: 'Status', key: 'status', render: (f) => statusBadge(f.status) },
        ], p.failures, { ctx: 'failure', empty: 'No failures recorded', scroll: true })}</section>
    </div>`;
}

export async function inventoryPartView(id) {
  const ip = await api(`/inventory-parts/${encodeURIComponent(id)}`);
  return html`
    ${pageHead({
      crumbs: html`<a href="#/parts">Parts inventory</a> / ${partLink(ip.part_number)} /`,
      title: html`${ip.serial_number ? html`Unit <span class="mono">${ip.serial_number}</span>` : html`Lot <span class="mono">${ip.lot_number}</span>`}`,
      sub: html`${ip.part_name} · ${statusBadge(ip.status)}`,
      actions: html`<button class="btn" data-dialog="log-failure" data-inventory-part="${ip.id}" data-stage="receiving">Log issue…</button>`,
    })}
    <div class="grid cols-2" style="margin-bottom:16px">
      <section class="card"><div class="card-head"><h2>Inventory part</h2></div><div class="card-body"><dl class="dl">
        <dt>Record</dt><dd class="mono">${ip.id}</dd>
        <dt>Part</dt><dd>${partLink(ip.part_number)} ${ip.part_name} (${ip.category})</dd>
        <dt>Serial number</dt><dd class="mono">${ip.serial_number ?? '— (lot-tracked)'}</dd>
        <dt>Lot number</dt><dd class="mono">${ip.lot_number}</dd>
        <dt>Supplier</dt><dd>${supplierLink(ip.supplier_id, ip.supplier_name)}</dd>
        <dt>Parts order</dt><dd>${poLink(ip.inventory_order_id)}</dd>
        <dt>Received</dt><dd>${fmtDate(ip.received_date, { year: true })}</dd>
        <dt>Quantity</dt><dd>${fmtNum(ip.quantity)} received · ${fmtNum(ip.quantity_on_hand)} on hand</dd>
        <dt>Status</dt><dd>${statusBadge(ip.status)}</dd>
      </dl></div></section>
      <section class="card"><div class="card-head"><h2>Failures</h2></div>
        ${table([
          { label: 'Report', key: 'id', render: (f) => html`<a class="mono" href="#/quality/${f.id}">${f.id}</a>` },
          { label: 'Date', key: 'reported_date', render: (f) => fmtDate(f.reported_date) },
          { label: 'Stage', key: 'stage' },
          { label: 'Severity', key: 'severity', render: (f) => severityBadge(f.severity) },
          { label: 'Status', key: 'status', render: (f) => statusBadge(f.status) },
        ], ip.failures, { ctx: 'failure', empty: 'No failures linked to this part' })}</section>
    </div>
    <section class="card"><div class="card-head"><h2>Installed in</h2></div>
      ${table([
        { label: 'Tractor', key: 'serial_number', render: (r) => tractorLink(r.tractor_id, r.serial_number) },
        { label: 'Model', key: 'model_number' },
        { label: 'Qty', key: 'quantity', num: true },
        { label: 'Installed', key: 'installed_date', render: (r) => fmtDate(r.installed_date) },
        { label: 'Tractor status', key: 'tractor_status', render: (r) => statusBadge(r.tractor_status) },
        { label: 'Customer', key: 'customer_name', render: (r) => r.customer_name ?? '—' },
      ], ip.installedIn, { ctx: 'installedIn', empty: 'Not installed in any tractor yet' })}</section>`;
}

DIALOGS['new-po'] = async (data, done) => {
  const cat = await api('/catalog');
  const part = data.part ?? cat.parts[0].part_number;
  const optionsFor = (pn) => cat.supplierParts.filter((sp) => sp.part_number === pn)
    .map((sp) => `<option value="${sp.supplier_id}">${cat.suppliers.find((s) => s.id === sp.supplier_id).name} — $${sp.unit_cost} · ${sp.quoted_lead_days}d quoted${sp.is_primary ? ' (primary)' : ''}</option>`).join('');
  openDialog('New parts order', String(html`
    <div class="form-grid">
      <label class="field" style="grid-column:1/-1">Part<select name="partNumber" id="po-part">${cat.parts.map((p) => html`<option value="${p.part_number}" ${p.part_number === part ? 'selected' : ''}>${p.part_number} · ${p.name}</option>`)}</select></label>
      <label class="field" style="grid-column:1/-1">Supplier<select name="supplierId" id="po-supplier"></select></label>
      <label class="field">Quantity<input name="quantity" type="number" min="1" value="${cat.parts.find((p) => p.part_number === part).min_order_qty}" required></label>
    </div>
    <div class="form-actions"><button class="btn primary">Place order</button></div>`), async (body) => {
    const out = await api('/inventory-orders', { method: 'POST', body: { ...body, source: 'manual' } });
    toast(`Placed ${out.id}`);
    done();
  });
  const partSel = document.getElementById('po-part');
  const supSel = document.getElementById('po-supplier');
  const sync = () => { supSel.innerHTML = optionsFor(partSel.value); };
  partSel.addEventListener('change', sync);
  sync();
};

