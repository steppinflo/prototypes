// Tiny SVG chart kit: thin marks, rounded data-ends on the baseline side away from the
// axis, 2px surface gaps between stacked segments, hairline grid, hover tooltips.

import { esc, raw, fmtNum } from './lib.js';

function niceMax(v) {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}
function ticks(max, n = 4) {
  const top = niceMax(max);
  const step = top / n;
  return Array.from({ length: n + 1 }, (_, i) => +(i * step).toFixed(6));
}
const tipAttr = (h) => `data-tip="${esc(h)}"`;
export const tipRows = (title, rows) => `<b>${esc(title)}</b>${rows.map(([k, v, color]) =>
  `<div class="tt-row"><span>${color ? `<span class="swatch" style="background:${color}"></span>` : ''}${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}`;

/** Rect with only the top corners rounded. */
function topRounded(x, y, w, h, r) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * Vertical bars. series: [{name, color, values[]}]; stacked by default.
 * ref: {values[], label} draws a step line (e.g. capacity). tip(i) -> tooltip HTML.
 */
export function barChart({ labels, series, stacked = true, height = 220, width = 720, ref = null, tip = null, labelEvery = 1, fmtLabel = (l) => l }) {
  const m = { t: 12, r: ref ? 64 : 12, b: 26, l: 36 };
  const pw = width - m.l - m.r;
  const ph = height - m.t - m.b;
  const n = labels.length;
  const totals = labels.map((_, i) => (stacked ? series.reduce((s, se) => s + (se.values[i] || 0), 0) : Math.max(...series.map((se) => se.values[i] || 0))));
  const max = Math.max(...totals, ...(ref ? ref.values : [0]), 1);
  const tk = ticks(max * 1.05);
  const top = tk[tk.length - 1];
  const y = (v) => m.t + ph - (v / top) * ph;
  const colW = pw / n;
  const groupW = Math.min(stacked ? 34 : 44, colW * 0.66);
  let out = '';
  for (const t of tk) out += `<line class="grid-line" x1="${m.l}" x2="${m.l + pw}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmtNum(t, t % 1 ? 1 : 0)}</text>`;
  labels.forEach((lab, i) => {
    const cx = m.l + colW * i + colW / 2;
    let bars = '';
    if (stacked) {
      let acc = 0;
      const visible = series.filter((s) => (s.values[i] || 0) > 0);
      visible.forEach((s, k) => {
        const v = s.values[i] || 0;
        const y0 = y(acc);
        const y1 = y(acc + v);
        const gap = k > 0 ? 2 : 0;
        const h = Math.max(0, y0 - y1 - gap);
        const x = cx - groupW / 2;
        bars += k === visible.length - 1
          ? `<path d="${topRounded(x, y1, groupW, h, 4)}" fill="${s.color}"/>`
          : `<rect x="${x}" y="${y1}" width="${groupW}" height="${h}" fill="${s.color}"/>`;
        acc += v;
      });
    } else {
      const bw = (groupW - 2 * (series.length - 1)) / series.length;
      series.forEach((s, k) => {
        const v = s.values[i] || 0;
        const x = cx - groupW / 2 + k * (bw + 2);
        bars += `<path d="${topRounded(x, y(v), bw, y(0) - y(v), 3)}" fill="${s.color}"/>`;
      });
    }
    const label = i % labelEvery === 0 ? `<text x="${cx}" y="${height - 8}" text-anchor="middle">${esc(fmtLabel(lab, i))}</text>` : '';
    const tipHtml = tip ? tip(i) : tipRows(fmtLabel(lab, i), series.map((s) => [s.name, fmtNum(s.values[i] || 0, 1).replace(/\.0$/, ''), s.color]));
    out += `<g class="col"><rect class="col-bg" x="${m.l + colW * i}" y="${m.t}" width="${colW}" height="${ph}"/>${bars}${label}<rect class="hit" x="${m.l + colW * i}" y="${m.t}" width="${colW}" height="${ph}" ${tipAttr(tipHtml)}/></g>`;
  });
  out += `<line class="axis-line" x1="${m.l}" x2="${m.l + pw}" y1="${y(0)}" y2="${y(0)}"/>`;
  if (ref) {
    let d = '';
    ref.values.forEach((v, i) => {
      const x0 = m.l + colW * i;
      d += `${i ? 'L' : 'M'}${x0},${y(v)}H${x0 + colW}`;
    });
    out += `<path class="ref-line" d="${d}" fill="none" pointer-events="none"/><text class="ref-label" x="${m.l + pw + 6}" y="${y(ref.values[ref.values.length - 1]) + 4}">${esc(ref.label)}</text>`;
  }
  return raw(`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img">${out}</svg>`);
}

/**
 * Lines over a shared x axis. series: [{name, color, values[] (null = gap), width}]
 * band: {lo[], hi[], color} shaded interval. markers: draw points.
 */
export function lineChart({ labels, series, band = null, height = 220, width = 720, labelEvery = 1, fmtLabel = (l) => l, tip = null, yMin = null, refY = null }) {
  const m = { t: 12, r: 14, b: 26, l: 40 };
  const pw = width - m.l - m.r;
  const ph = height - m.t - m.b;
  const n = labels.length;
  const all = series.flatMap((s) => s.values).concat(band ? band.hi : []).filter((v) => v !== null && v !== undefined);
  const lo = yMin ?? Math.min(0, ...all);
  const tk = ticks(Math.max(...all, 1) - lo);
  const top = tk[tk.length - 1] + lo;
  const x = (i) => m.l + (n === 1 ? pw / 2 : (pw * i) / (n - 1));
  const y = (v) => m.t + ph - ((v - lo) / (top - lo)) * ph;
  let out = '';
  for (const t of tk) out += `<line class="grid-line" x1="${m.l}" x2="${m.l + pw}" y1="${y(t + lo)}" y2="${y(t + lo)}"/><text x="${m.l - 6}" y="${y(t + lo) + 4}" text-anchor="end">${fmtNum(t + lo)}</text>`;
  if (lo < 0) out += `<line class="axis-line" x1="${m.l}" x2="${m.l + pw}" y1="${y(0)}" y2="${y(0)}"/>`;
  if (refY) out += `<line x1="${m.l}" x2="${m.l + pw}" y1="${y(refY.value)}" y2="${y(refY.value)}" stroke="${refY.color}" stroke-width="1.5"/><text x="${m.l + pw - 4}" y="${y(refY.value) - 5}" text-anchor="end" class="ref-label">${esc(refY.label)}</text>`;
  if (band) {
    const idx = band.lo.map((v, i) => (v === null ? null : i)).filter((i) => i !== null);
    if (idx.length) {
      const d = `M${idx.map((i) => `${x(i)},${y(band.hi[i])}`).join('L')}L${[...idx].reverse().map((i) => `${x(i)},${y(band.lo[i])}`).join('L')}Z`;
      out += `<path d="${d}" fill="${band.color}" opacity="0.16"/>`;
    }
  }
  for (const s of series) {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null || v === undefined) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i)},${y(v)}`;
      pen = true;
    });
    out += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2}" stroke-linejoin="round" stroke-linecap="round" ${s.dashed ? 'stroke-dasharray="5 4"' : ''}/>`;
  }
  labels.forEach((lab, i) => {
    if (i % labelEvery === 0) out += `<text x="${x(i)}" y="${height - 8}" text-anchor="middle">${esc(fmtLabel(lab, i))}</text>`;
  });
  const colW = pw / Math.max(1, n - 1);
  labels.forEach((lab, i) => {
    const tipHtml = tip ? tip(i) : tipRows(fmtLabel(lab, i), series.filter((s) => s.values[i] !== null && s.values[i] !== undefined).map((s) => [s.name, fmtNum(s.values[i], 1), s.color]));
    out += `<g class="col"><line x1="${x(i)}" x2="${x(i)}" y1="${m.t}" y2="${m.t + ph}" stroke="var(--axis)" opacity="0" class="xh"/><rect class="hit" x="${x(i) - colW / 2}" y="${m.t}" width="${colW}" height="${ph}" ${tipAttr(tipHtml)}/></g>`;
  });
  return raw(`<svg class="chart line-chart" viewBox="0 0 ${width} ${height}" role="img">${out}</svg>`);
}

/** Horizontal bars as HTML rows. items: [{label, value, color, href, note}] */
export function hBars(items, { fmt = (v) => fmtNum(v), max = null } = {}) {
  const top = max ?? Math.max(...items.map((i) => i.value), 1);
  return raw(`<div class="hbars">${items.map((it) => `
    <div class="hbar-row" ${it.tip ? tipAttr(it.tip) : ''}>
      <div class="hbar-label">${it.href ? `<a href="${esc(it.href)}">${esc(it.label)}</a>` : esc(it.label)}${it.note ? ` <span class="muted small">${esc(it.note)}</span>` : ''}</div>
      <div class="hbar-track"><span style="width:${Math.max(0.5, (100 * it.value) / top)}%;background:${it.color ?? 'var(--s1)'}"></span></div>
      <div class="hbar-val">${esc(fmt(it.value))}</div>
    </div>`).join('')}</div>`);
}

export function legend(items) {
  return raw(`<div class="legend">${items.map((it) => (it.line
    ? `<span><span class="line-key" style="border-color:${it.color}"></span>${esc(it.name)}</span>`
    : it.band ? `<span><span class="band-key" style="background:${it.color}"></span>${esc(it.name)}</span>`
      : `<span><span class="swatch" style="background:${it.color}"></span>${esc(it.name)}</span>`)).join('')}</div>`);
}
