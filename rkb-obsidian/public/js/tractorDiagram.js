// Tractor parts diagram: a schematic side view where every part in the bill of materials
// is its own region, keyed by part number. Used full-size on the tractor and part pages
// and as a thumbnail in the hover preview on any part link.
//
// Layouts follow the bill of materials: a cab model (CAB-STD, doors, handles) or an
// open station (ROPS-01); TX-500 gets dual rear tyres. Engine and transmission regions
// resolve to that model's engine / transmission part numbers.
//
// No imports and no DOM access at import time, so the region map can be unit-tested in Node.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// Region shapes in a 680 x 372 coordinate space. `when` limits a region to a layout.
const R = (key, shapes, when) => ({ key, shapes, when });
const rect = (x, y, w, h, rx = 4) => ['rect', { x, y, width: w, height: h, rx }];
const circ = (cx, cy, r) => ['circle', { cx, cy, r }];

export const REGIONS = [
  R('TIR-R', [circ(492, 272, 80)], 'dual'),
  R('TIR-R', [circ(480, 272, 80)]),
  R('TIR-F', [circ(160, 304, 48)]),
  R('CAB-STD', [rect(372, 70, 162, 128, 12)], 'cab'),
  R('DOR-CAB', [rect(404, 80, 72, 112, 6)], 'cab'),
  R('DHL-01', [rect(458, 134, 12, 6, 2)], 'cab'),
  R('SEAT-01', [rect(488, 140, 30, 50, 5)], 'cab'),
  R('ROPS-01', [rect(414, 74, 10, 150, 3), rect(494, 74, 10, 150, 3), rect(414, 74, 90, 10, 3)], 'rops'),
  R('SEAT-01', [rect(444, 166, 32, 44, 5)], 'rops'),
  R('engine', [rect(176, 200, 122, 44, 6)]),
  R('FLT-KIT', [rect(304, 206, 16, 30, 4)]),
  R('ECU-01', [rect(328, 196, 26, 18, 3)]),
  R('BAT-12', [rect(124, 222, 36, 20, 3)]),
  R('LGT-KIT', [circ(110, 204, 6), rect(380, 60, 26, 8, 2)], 'cab'),
  R('LGT-KIT', [circ(110, 204, 6), rect(446, 64, 26, 8, 2)], 'rops'),
  R('HRN-01', [['polyline', { points: '112,210 140,214 172,212 300,198 341,205 392,150 393,68' }]], 'cab'),
  R('HRN-01', [['polyline', { points: '112,210 140,214 172,212 300,198 341,205 419,140 419,90 459,72' }]], 'rops'),
  R('transmission', [rect(340, 238, 76, 46, 6)]),
  R('HYD-PMP', [rect(282, 266, 32, 24, 4)]),
  R('AXL-FR', [rect(160, 262, 44, 12, 3), circ(160, 304, 10)]),
  R('AXL-RR', [rect(416, 262, 64, 14, 3), circ(480, 272, 16)]),
  R('HYD-LFT', [rect(556, 232, 62, 10, 3), rect(556, 270, 66, 10, 3), rect(614, 232, 8, 48, 2)]),
  R('FST-M10', [circ(200, 259, 3), circ(260, 259, 3), circ(330, 259, 3), circ(440, 259, 3)]),
];

// Non-interactive bodywork drawn between the tyres and the parts.
const STRUCTURE = {
  afterTyres: [circ(480, 272, 44), circ(160, 304, 25)],
  body: [rect(104, 190, 258, 62, 10), rect(300, 132, 10, 58, 2), rect(150, 252, 310, 14, 3)],
  cab: [rect(382, 80, 16, 70, 3)],
};

const COLORS = {
  good: 'var(--good)', warn: 'var(--warning)', bad: 'var(--critical)',
  s1: 'var(--s1)', s2: 'var(--s2)', s3: 'var(--s3)', s4: 'var(--s4)', s5: 'var(--s5)',
};

let CATALOG = null; // { parts: [...], bom: [...], models: [...] }
export const setCatalog = (c) => { CATALOG = c; };
export const getCatalog = () => CATALOG;
export const partInfo = (pn) => CATALOG?.parts.find((p) => p.part_number === pn) ?? null;

/** Layout and region -> part number mapping for a tractor model. */
export function layoutFor(model, catalog = CATALOG) {
  const lines = catalog.bom.filter((b) => b.model_number === model);
  const has = (pn) => lines.some((b) => b.part_number === pn);
  const catOf = (cat) => lines.find((b) => catalog.parts.find((p) => p.part_number === b.part_number)?.category === cat)?.part_number;
  const qty = (pn) => lines.find((b) => b.part_number === pn)?.quantity ?? 0;
  const keyMap = { engine: catOf('engine'), transmission: catOf('transmission') };
  return {
    model,
    cab: has('CAB-STD'),
    dual: qty('TIR-R') > 2,
    lines,
    partFor: (key) => keyMap[key] ?? key,
  };
}

/** Pick a representative model whose bill of materials contains the part (for previews). */
export function modelForPart(pn, catalog = CATALOG) {
  const models = [...new Set(catalog.bom.filter((b) => b.part_number === pn).map((b) => b.model_number))].sort();
  return models[0] ?? null;
}

function attrs(o) {
  return Object.entries(o).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
}

/**
 * SVG markup. color(pn) -> 'good' | 'warn' | 'bad' | 's1'..'s5' | null (default accent).
 * focus: part number drawn highlighted (thumbnails). muted: draw other parts faintly.
 */
export function tractorSvg({ model, color = () => null, focus = null, muted = false, title = '', className = '' }) {
  const L = layoutFor(model);
  const active = (r) => !r.when || (r.when === 'cab' && L.cab) || (r.when === 'rops' && !L.cab) || (r.when === 'dual' && L.dual);
  const struct = (shapes) => shapes.map(([t, a]) => `<${t} ${attrs(a)} class="td-struct"/>`).join('');
  const region = (r) => {
    const pn = L.partFor(r.key);
    if (!L.lines.some((b) => b.part_number === pn)) return '';
    const c = focus ? (pn === focus ? 'var(--s4)' : null) : COLORS[color(pn)] ?? null;
    const base = c ?? 'var(--accent)';
    const fillOpacity = focus ? (pn === focus ? 0.85 : 0.12) : c ? 0.4 : 0.16;
    const isFocus = focus && pn === focus;
    const shapes = r.shapes.map(([t, a]) => (t === 'polyline'
      ? `<polyline ${attrs(a)} fill="none" stroke="transparent" stroke-width="14" class="td-hit"/><polyline ${attrs(a)} fill="none" stroke="${base}" stroke-width="${isFocus ? 4 : 2}" stroke-dasharray="5 3" stroke-linecap="round"/>`
      : `<${t} ${attrs(a)} fill="${base}" fill-opacity="${fillOpacity}" stroke="${base}" stroke-width="${isFocus ? 2 : 0.75}" ${muted && !isFocus ? 'stroke-opacity="0.5"' : ''}/>`)).join('');
    const info = partInfo(pn);
    return `<g data-part="${esc(pn)}" class="td-part ${isFocus ? 'td-focus' : ''}"><title>${esc(info?.name ?? pn)}</title>${shapes}</g>`;
  };
  const regions = REGIONS.filter(active);
  const tyres = regions.filter((r) => r.key.startsWith('TIR-'));
  const rest = regions.filter((r) => !r.key.startsWith('TIR-'));
  const cabParts = rest.filter((r) => r.when === 'cab' || r.when === 'rops');
  const others = rest.filter((r) => !cabParts.includes(r));
  return `<svg class="td ${className}" viewBox="0 0 680 372" role="img" aria-label="${esc(title || `${model} parts diagram`)}">
    <line x1="40" y1="352" x2="640" y2="352" class="td-ground"/>
    ${tyres.map(region).join('')}${struct(STRUCTURE.afterTyres)}${struct(STRUCTURE.body)}
    ${cabParts.filter((r) => r.key !== 'SEAT-01' && r.key !== 'LGT-KIT' && r.key !== 'HRN-01').map(region).join('')}
    ${L.cab ? struct(STRUCTURE.cab) : ''}
    ${cabParts.filter((r) => r.key === 'SEAT-01').map(region).join('')}
    ${others.map(region).join('')}
    ${cabParts.filter((r) => r.key === 'LGT-KIT' || r.key === 'HRN-01').map(region).join('')}
  </svg>`;
}

/** Hover-preview card: thumbnail with the part highlighted, its name and what it does. */
export function partPreviewHtml(pn) {
  const info = partInfo(pn);
  const model = info && modelForPart(pn);
  if (!info || !model) return null;
  const usedIn = CATALOG.bom.filter((b) => b.part_number === pn).map((b) => `${b.model_number}${b.quantity > 1 ? ` ×${b.quantity}` : ''}`).join(', ');
  return `<div class="td-preview">${tractorSvg({ model, focus: pn, muted: true })}
    <div class="td-preview-text"><b>${esc(info.name)}</b> <span class="mono">${esc(pn)}</span>
    <div>${esc(info.description)}</div><div class="td-preview-meta">Used in ${esc(usedIn)} · shown on ${esc(model)}</div></div></div>`;
}

// ---- Interactive diagrams (tractor page): hover to preview a part, click to pin it ----

const PANELS = new Map(); // diagram id -> { render(pn), pinned }

export function registerDiagram(id, render, pinned) {
  PANELS.set(id, { render, pinned });
}

// Hovering dims everything else; a pinned (clicked) part is only outlined so the
// colour overview of the whole tractor stays readable.
function focusPart(root, pn, dim = false) {
  root.querySelectorAll('[data-part]').forEach((g) => {
    g.classList.toggle('td-dim', dim && !!pn && g.dataset.part !== pn);
    g.classList.toggle('td-sel', !!pn && g.dataset.part === pn);
  });
  root.querySelectorAll('[data-pick]').forEach((b) => b.classList.toggle('on', b.dataset.pick === pn));
  const entry = PANELS.get(root.dataset.td);
  const panel = root.querySelector('.td-panel');
  if (entry && panel && pn) panel.innerHTML = entry.render(pn);
}

export function initDiagram(root) {
  const entry = PANELS.get(root.dataset.td);
  if (entry?.pinned) focusPart(root, entry.pinned);
}

if (typeof document !== 'undefined') {
  document.addEventListener('mouseover', (e) => {
    const root = e.target.closest('[data-td]');
    if (!root) return;
    const g = e.target.closest('[data-part]');
    const entry = PANELS.get(root.dataset.td);
    if (g) focusPart(root, g.dataset.part, true);
    else if (entry && !e.target.closest('.td-panel, .td-picks')) focusPart(root, entry.pinned);
  });
  document.addEventListener('mouseout', (e) => {
    const root = e.target.closest('[data-td]');
    if (!root || root.contains(e.relatedTarget)) return;
    const entry = PANELS.get(root.dataset.td);
    if (entry) focusPart(root, entry.pinned);
  });
  document.addEventListener('click', (e) => {
    const root = e.target.closest('[data-td]');
    if (!root) return;
    const g = e.target.closest('[data-part], [data-pick]');
    if (!g) return;
    const pn = g.dataset.part ?? g.dataset.pick;
    const entry = PANELS.get(root.dataset.td);
    if (entry) entry.pinned = pn;
    focusPart(root, pn);
  });
}
