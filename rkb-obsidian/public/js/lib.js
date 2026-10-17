// Shared front-end helpers: API calls, formatting, small HTML builders.

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.details = data.details;
    throw err;
  }
  return data;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => (v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, (c) => ESC[c]));

/** Tagged template that escapes interpolations unless they are raw() or arrays of raw. */
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    out += render(v) + strings[i + 1];
  });
  return raw(out);
}
function render(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(render).join('');
  if (v && v.__raw) return v.value;
  return esc(v);
}
export function raw(value) {
  return { __raw: true, value: String(value), toString() { return this.value; } };
}

// ---- dates -------------------------------------------------------------------------
let TODAY = new Date().toISOString().slice(0, 10);
export const setToday = (t) => { TODAY = t; };
export const today = () => TODAY;
const DAY = 86400000;
const toDate = (iso) => new Date(`${iso}T00:00:00Z`);
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);
export const addDays = (iso, n) => new Date(toDate(iso).getTime() + n * DAY).toISOString().slice(0, 10);

export function fmtDate(iso, { year = false } = {}) {
  if (!iso) return '—';
  const d = toDate(iso);
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (year || iso.slice(0, 4) !== TODAY.slice(0, 4)) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}
export function fmtWeek(iso) {
  return toDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
export function fmtMonth(ym) {
  return `${toDate(`${ym}-01`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })} '${ym.slice(2, 4)}`;
}
/** "Overdue 3d" / "Today" / "Tomorrow" / "in 5d" / "Mon, Oct 19" */
export function relDue(iso) {
  const d = daysBetween(TODAY, iso);
  if (d < 0) return { text: `Overdue ${-d}d`, cls: 'over' };
  if (d === 0) return { text: 'Today', cls: 'today' };
  if (d === 1) return { text: 'Tomorrow', cls: '' };
  if (d < 7) return { text: toDate(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }), cls: '' };
  return { text: fmtDate(iso), cls: '' };
}

// ---- numbers -----------------------------------------------------------------------
export const fmtNum = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n) ? '—'
  : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const fmtMoney = (n) => (n === null || n === undefined ? '—'
  : `$${Number(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Number(n) >= 1e4 ? `${Math.round(n / 1e3)}k` : fmtNum(n)}`);
export const fmtPct = (n, d = 0) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(d)}%`);

// ---- labels ------------------------------------------------------------------------
export const MODEL_COLORS = { 'TX-100': 'var(--s1)', 'TX-200': 'var(--s2)', 'TX-300': 'var(--s3)', 'TX-400': 'var(--s4)', 'TX-500': 'var(--s5)' };
export const modelSwatch = (m) => html`<span class="swatch" style="background:${MODEL_COLORS[m] ?? 'var(--axis)'}"></span>`;

const STATUS = {
  // customer orders
  received: ['Received', 'info'], in_production: ['In production', 'info'], ready: ['Ready to ship', 'good'],
  shipping: ['Shipping', 'info'], partially_delivered: ['Part delivered', 'info'], delivered: ['Delivered', 'plain'], cancelled: ['Cancelled', 'plain'],
  // tractors
  qc_hold: ['QC hold', 'high'], inventoried: ['In stock', 'good'], earmarked: ['Earmarked', 'info'],
  // POs & shipments
  submitted: ['Submitted', 'plain'], confirmed: ['Confirmed', 'plain'], in_transit: ['In transit', 'info'],
  // parts
  in_stock: ['In stock', 'good'], installed: ['Installed', 'plain'], consumed: ['Consumed', 'plain'], scrapped: ['Scrapped', 'critical'], rejected: ['Rejected', 'critical'],
  // failures
  open: ['Open', 'critical'], investigating: ['Investigating', 'medium'], resolved: ['Resolved', 'good'],
  // plan
  ok: ['OK', 'good'], critical: ['Critical', 'critical'], order_now: ['Order now', 'high'], planned: ['Planned', 'plain'],
  late: ['Late', 'critical'], parts_risk: ['Parts risk', 'medium'], at_risk: ['At risk', 'medium'],
  overdue: ['Overdue', 'critical'], this_week: ['This week', 'high'], upcoming: ['Upcoming', 'plain'],
};
export function statusBadge(s) {
  const [label, cls] = STATUS[s] ?? [String(s).replace(/_/g, ' '), 'plain'];
  return html`<span class="badge ${cls}">${label}</span>`;
}
export const severityBadge = (s) => html`<span class="badge ${s}">${s[0].toUpperCase()}${s.slice(1)}</span>`;
export const stageLabel = { receiving: 'Receiving', manufacturing: 'Manufacturing', field: 'Field' };

export const link = (href, text, cls = '') => html`<a href="${href}" class="${cls}">${text}</a>`;
export const orderLink = (id) => (id ? link(`#/orders/${id}`, id, 'mono') : '—');
export const tractorLink = (id, serial) => (id ? link(`#/tractors/${id}`, serial || id, 'mono') : '—');
export const partLink = (pn) => link(`#/parts/${pn}`, pn, 'mono');
export const poLink = (id) => (id ? link(`#/purchasing/${id}`, id, 'mono') : '—');
export const supplierLink = (id, name) => link(`#/suppliers/${id}`, name || id);
export const customerLink = (id, name) => (id ? link(`#/customers/${id}`, name || id) : '—');

export function kpi(label, value, hint = '', alert = false) {
  return html`<div class="kpi ${alert ? 'alert' : ''}"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`;
}

export function pageHead({ title, sub, crumbs, actions }) {
  return html`<div class="page-head"><div>
      ${crumbs ? html`<div class="crumbs">${crumbs}</div>` : ''}
      <h1>${title}</h1>${sub ? html`<div class="sub">${sub}</div>` : ''}
    </div>${actions ? html`<div class="actions">${actions}</div>` : ''}</div>`;
}

/** Button that POSTs to the API when clicked (handled by a delegated listener in app.js). */
export function actionBtn(action, cls = 'btn small') {
  if (!action) return '';
  return html`<button class="${cls}" data-post="${action.url}" data-body="${JSON.stringify(action.body ?? {})}"
    ${action.confirm ? raw(`data-confirm="${esc(action.confirm)}"`) : ''}>${action.label}</button>`;
}

/** Sortable table. columns: [{key, label, num, render(row), sort(row)}] */
export function table(columns, rows, { id = `t${Math.random().toString(36).slice(2, 8)}`, empty = 'Nothing here', scroll = false } = {}) {
  if (!rows.length) return html`<div class="empty">${empty}</div>`;
  TABLES.set(id, { columns, rows });
  const head = columns.map((c, i) => html`<th class="${c.num ? 'num' : ''} ${c.nosort ? '' : 'sortable'}" data-table="${id}" data-col="${i}">${c.label}</th>`);
  return html`<div class="table-wrap ${scroll ? 'table-scroll' : ''}"><table id="${id}"><thead><tr>${head}</tr></thead>
    <tbody>${tableBody(columns, rows)}</tbody></table></div>`;
}
const TABLES = new Map();
function tableBody(columns, rows) {
  return rows.map((r) => html`<tr>${columns.map((c) => html`<td class="${c.num ? 'num' : ''} ${c.cls ?? ''}">${c.render ? c.render(r) : r[c.key]}</td>`)}</tr>`);
}
export function sortTable(th) {
  const t = TABLES.get(th.dataset.table);
  if (!t) return;
  const col = t.columns[Number(th.dataset.col)];
  if (col.nosort) return;
  const asc = !th.classList.contains('sorted-asc');
  const keyFn = col.sort ?? ((r) => r[col.key]);
  t.rows = [...t.rows].sort((a, b) => {
    const x = keyFn(a);
    const y = keyFn(b);
    const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''));
    return asc ? cmp : -cmp;
  });
  const tableEl = th.closest('table');
  tableEl.querySelectorAll('th').forEach((h) => h.classList.remove('sorted-asc', 'sorted-desc'));
  th.classList.add(asc ? 'sorted-asc' : 'sorted-desc');
  tableEl.querySelector('tbody').innerHTML = String(raw(tableBody(t.columns, t.rows).join('')));
}

export function seg(name, options, current) {
  return html`<div class="seg" data-seg="${name}">${options.map(([value, label, count]) =>
    html`<button data-value="${value}" class="${String(value) === String(current) ? 'on' : ''}">${label}${count !== undefined ? html`<span class="count">${count}</span>` : ''}</button>`)}</div>`;
}

export function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3500);
}

export function openDialog(title, bodyHtml, onSubmit) {
  const dlg = document.getElementById('dialog');
  dlg.innerHTML = String(html`<form method="dialog"><div class="dialog-head"><h2>${title}</h2>
    <button class="btn ghost small" value="cancel" style="margin-left:auto" formnovalidate>✕</button></div>
    <div class="dialog-body">${raw(bodyHtml)}</div></form>`);
  const form = dlg.querySelector('form');
  form.addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const btn = e.submitter;
    if (btn) btn.disabled = true;
    try {
      await onSubmit(data);
      dlg.close();
    } catch (err) {
      toast(err.message + (err.details?.short ? `: ${err.details.short.map((s) => `${s.partNumber} (${s.available}/${s.need})`).join(', ')}` : ''), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  dlg.showModal();
}

export const qs = () => new URLSearchParams(location.hash.split('?')[1] ?? '');
export function setQuery(params) {
  const [path] = location.hash.split('?');
  const q = qs();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  location.hash = s ? `${path}?${s}` : path;
}

/** Dialog openers by name; a button with data-dialog="name" opens one (handled in app.js). */
export const DIALOGS = {};
