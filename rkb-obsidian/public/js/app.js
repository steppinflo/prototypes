// Hash router + global behaviours (tooltips, POST buttons, theme, search).

import { api, toast, setToday, fmtDate, sortTable, html, setQuery, DIALOGS } from './lib.js';
import { dashboardView } from './views/dashboard.js';
import { planningView } from './views/planning.js';
import { ordersView, orderView } from './views/orders.js';
import { tractorsView, tractorView } from './views/tractors.js';
import { partsView, partView, inventoryPartView } from './views/parts.js';
import { purchasingView, purchaseOrderView } from './views/purchasing.js';
import { shippingView } from './views/shipping.js';
import { qualityView, failureView } from './views/quality.js';
import { suppliersView, supplierView } from './views/suppliers.js';
import { customersView, customerView } from './views/customers.js';
import { aboutView } from './views/about.js';
import { costsView } from './views/costs.js';
import { serviceView, serviceJobView } from './views/service.js';
import { notificationsView } from './views/notifications.js';
import './views/escalations.js';

const ROUTES = [
  [/^\/?$/, 'dashboard', dashboardView],
  [/^\/planning$/, 'planning', planningView],
  [/^\/orders$/, 'orders', ordersView],
  [/^\/orders\/(.+)$/, 'orders', orderView],
  [/^\/tractors$/, 'tractors', tractorsView],
  [/^\/tractors\/(.+)$/, 'tractors', tractorView],
  [/^\/parts$/, 'parts', partsView],
  [/^\/parts\/(.+)$/, 'parts', partView],
  [/^\/inventory-parts\/(.+)$/, 'parts', inventoryPartView],
  [/^\/purchasing$/, 'purchasing', purchasingView],
  [/^\/purchasing\/(.+)$/, 'purchasing', purchaseOrderView],
  [/^\/shipping$/, 'shipping', shippingView],
  [/^\/quality$/, 'quality', qualityView],
  [/^\/quality\/(.+)$/, 'quality', failureView],
  [/^\/suppliers$/, 'suppliers', suppliersView],
  [/^\/suppliers\/(.+)$/, 'suppliers', supplierView],
  [/^\/customers$/, 'customers', customersView],
  [/^\/customers\/(.+)$/, 'customers', customerView],
  [/^\/about$/, 'about', aboutView],
  [/^\/costs$/, 'costs', costsView],
  [/^\/service$/, 'service', serviceView],
  [/^\/service\/(.+)$/, 'service', serviceJobView],
  [/^\/notifications$/, 'notifications', notificationsView],
];

const view = document.getElementById('view');
let renderSeq = 0;

export async function render({ keepScroll = false } = {}) {
  const seq = ++renderSeq;
  const path = decodeURIComponent(location.hash.replace(/^#/, '').split('?')[0]) || '/';
  const route = ROUTES.find(([re]) => re.test(path)) ?? ROUTES[0];
  const params = path.match(route[0])?.slice(1) ?? [];
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === route[1]));
  document.getElementById('sidebar').classList.remove('open');
  const scroll = window.scrollY;
  if (!metaLoaded) await refreshMeta();
  if (!keepScroll) view.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const out = await route[2](...params);
    if (seq !== renderSeq) return;
    view.innerHTML = String(out);
    window.scrollTo(0, keepScroll ? scroll : 0);
  } catch (err) {
    if (seq !== renderSeq) return;
    view.innerHTML = String(html`<div class="card"><div class="empty">Couldn't load this page: ${err.message}</div></div>`);
  }
  refreshMeta();
}

let metaLoaded = false;
async function refreshMeta() {
  try {
    const meta = await api('/meta');
    metaLoaded = true;
    setToday(meta.today);
    document.getElementById('today').textContent = `Today · ${fmtDate(meta.today, { year: true })}`;
    document.getElementById('task-badge').textContent = meta.urgentTasks || '';
    document.getElementById('sidebar-foot').innerHTML = String(html`
      Prototype data as of ${fmtDate(meta.seedDate, { year: true })} · ${meta.datasetRowsUsed.toLocaleString()} dataset rows (shifted +${meta.datasetYearShift}y)
      <br><button class="btn small ghost" id="reseed-btn" style="color:inherit;padding-left:0">↺ Reset demo data</button>`);
  } catch { /* meta is decorative */ }
}

// ---- global delegated behaviour ---------------------------------------------------

document.addEventListener('click', async (e) => {
  const th = e.target.closest('th.sortable');
  if (th) return sortTable(th);

  const postBtn = e.target.closest('[data-post]');
  if (postBtn) {
    e.preventDefault();
    if (postBtn.dataset.confirm && !confirm(postBtn.dataset.confirm)) return;
    postBtn.disabled = true;
    try {
      const out = await api(postBtn.dataset.post, { method: 'POST', body: JSON.parse(postBtn.dataset.body || '{}') });
      toast(postBtn.dataset.success || describe(postBtn.dataset.post, out));
      await render({ keepScroll: true });
    } catch (err) {
      toast(err.message + (err.details?.short ? ` — short: ${err.details.short.map((s) => `${s.partNumber} (${s.available} of ${s.need})`).join(', ')}` : ''), 'error');
      postBtn.disabled = false;
    }
    return;
  }

  const dlgBtn = e.target.closest('[data-dialog]');
  if (dlgBtn) {
    const opener = DIALOGS[dlgBtn.dataset.dialog];
    if (opener) opener({ ...dlgBtn.dataset, ...(dlgBtn.dataset.payload ? JSON.parse(dlgBtn.dataset.payload) : {}) }, () => render({ keepScroll: true }));
    return;
  }

  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) return setQuery({ tab: tabBtn.dataset.tab });

  const rangeBtn = e.target.closest('[data-range-from]');
  if (rangeBtn) return setQuery({ from: rangeBtn.dataset.rangeFrom, to: rangeBtn.dataset.rangeTo });

  if (e.target.id === 'reseed-btn') {
    if (!confirm('Rebuild all prototype data from the source dataset? Changes made in the portal will be lost.')) return;
    e.target.disabled = true;
    await api('/admin/reseed', { method: 'POST' });
    toast('Demo data rebuilt');
    location.hash = '#/';
    render();
  }

  // Segmented filters live in the URL query so views stay stateless and linkable.
  const segBtn = e.target.closest('[data-seg] button');
  if (segBtn) setQuery({ [segBtn.parentElement.dataset.seg]: segBtn.dataset.value });
});

function describe(url, out) {
  if (url.includes('/pickup')) return `Picked up — at the plant ${fmtDate(out.eta)}`;
  if (url.includes('/arrive')) return 'Tractor received at the plant for repair';
  if (url.includes('/service-jobs') && url.includes('/repair')) return `Repaired — on its way back, ETA ${fmtDate(out.eta)}`;
  if (url.includes('/service-jobs') && url.includes('/return')) return 'Tractor back with the customer — job complete';
  if (out.premium && !url.includes('/expedite')) return `Placed rush ${out.id}, due ${fmtDate(out.expected)} (+$${Math.round(out.premium).toLocaleString('en-US')} premium)`;
  if (out.id && url.includes('/inventory-orders') && !url.includes('/receive') && !url.includes('/ship') && !url.includes('/expedite')) return `Placed ${out.id}`;
  if (out.received !== undefined) return `Received ${out.received} into stock${out.rejected ? `, ${out.rejected} rejected` : ''}`;
  if (out.tractors && url.includes('/builds')) return `Started ${out.tractors.length} build(s): ${out.tractors.map((t) => t.serial).join(', ')}`;
  if (out.shipmentId) return `Shipment ${out.shipmentId} booked, ETA ${fmtDate(out.eta)}`;
  if (url.includes('/expedite')) return `Expedited ${out.id}: now due ${fmtDate(out.expected)} (+$${Math.round(out.premium).toLocaleString('en-US')})`;
  if (url.includes('/rush')) return `${out.id} is now a rush order — builds moved up`;
  if (url.includes('/ack')) return 'Acknowledged';
  if (out.status) return `Updated (${out.status})`;
  if (url.includes('/clear-hold')) return 'Replacement installed — released from QC hold';
  if (url.includes('/complete')) return 'Passed QC — build complete';
  if (url.includes('/earmark')) return `Earmarked to ${out.orderId}`;
  if (url.includes('/deliver')) return 'Marked delivered';
  if (url.includes('/cancel')) return `Cancelled ${out.id}; its tractors returned to stock`;
  return 'Done';
}

// Inline forms that POST their fields (e.g. planning assumptions), or that set URL filters.
document.addEventListener('submit', async (e) => {
  const qf = e.target.closest('form[data-query-form]');
  if (qf) {
    e.preventDefault();
    return setQuery(Object.fromEntries(new FormData(qf).entries()));
  }
  const form = e.target.closest('form[data-form-post]');
  if (!form) return;
  e.preventDefault();
  const btn = form.querySelector('button:not([type=button])');
  if (btn) btn.disabled = true;
  try {
    await api(form.dataset.formPost, { method: 'POST', body: Object.fromEntries(new FormData(form).entries()) });
    toast(form.dataset.success || 'Saved — models re-ran');
    await render({ keepScroll: true });
  } catch (err) {
    toast(err.message, 'error');
    if (btn) btn.disabled = false;
  }
});

// Tooltips for anything with data-tip (chart hit areas, bars).
const tip = document.getElementById('tooltip');
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[data-tip]');
  if (!el) return tip.classList.remove('on');
  tip.innerHTML = el.dataset.tip;
  tip.classList.add('on');
});
document.addEventListener('mousemove', (e) => {
  if (!tip.classList.contains('on')) return;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let x = e.clientX + 14;
  let y = e.clientY + 14;
  if (x + w > window.innerWidth - 8) x = e.clientX - w - 14;
  if (y + h > window.innerHeight - 8) y = e.clientY - h - 14;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
});
document.addEventListener('scroll', () => tip.classList.remove('on'), true);

// Theme toggle (persists per browser).
const THEME_KEY = 'rkb-theme';
try {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* storage unavailable */ }
document.getElementById('theme-btn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, document.documentElement.dataset.theme); } catch { /* ignore */ }
  render({ keepScroll: true });
});

document.getElementById('menu-btn').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));

// Global search: jump straight to an entity when the identifier is recognisable.
document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('search').value.trim();
  if (!q) return;
  const up = q.toUpperCase();
  if (/^SO-/.test(up)) location.hash = `#/orders/${up}`;
  else if (/^PO-/.test(up)) location.hash = `#/purchasing/${up}`;
  else if (/^FR-/.test(up)) location.hash = `#/quality/${up}`;
  else if (/^SUP-/.test(up)) location.hash = `#/suppliers/${up}`;
  else if (/^CUS-/.test(up)) location.hash = `#/customers/${up}`;
  else if (/^(T-|RKB-)/.test(up)) location.hash = `#/tractors/${up}`;
  else if (/^IP-/.test(up) || /^[A-E][A-Z]+\d*-\d{7}$/.test(up)) location.hash = `#/inventory-parts/${up}`;
  else if (/^[A-Z]{3,4}-[A-Z0-9]+$/.test(up)) location.hash = `#/parts/${up}`;
  else location.hash = `#/tractors?q=${encodeURIComponent(q)}`;
  document.getElementById('search').value = '';
});

window.addEventListener('hashchange', () => render());
render();
