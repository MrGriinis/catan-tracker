// Dependency-free SVG charts. Colours come from CSS variables so both themes work.
// Hover uses data-tip attributes that a single global tooltip reads. Every value shown
// here also appears in a table next to the chart.

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const pct = (v, digits = 1) => `${(v * 100).toFixed(digits)}%`;

/** Shows data-tip text in the page's #tip element when hovering a chart mark. */
export function installTooltip() {
  const tip = document.querySelector('#tip');
  document.addEventListener('pointermove', (e) => {
    const target = e.target.closest?.('[data-tip]');
    if (!target) { tip.hidden = true; return; }
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.transform = `translate(${x}px, ${e.clientY + 14}px)`;
  });
}

function niceMax(value) {
  if (value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  const n = value / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

function roundedTopBar(x, y, w, h, r = 4) {
  const radius = Math.min(r, h, w / 2);
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + w - radius}Q${x + w},${y} ${x + w},${y + radius}V${y + h}Z`;
}

export function distributionChart(rows) {
  const W = 720; const H = 280;
  const m = { top: 12, right: 8, bottom: 30, left: 42 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const yMax = niceMax(Math.max(0.2, ...rows.map((r) => r.actual)));
  const y = (v) => m.top + ih - (v / yMax) * ih;
  const band = iw / rows.length;
  const barW = Math.min(30, band * 0.5);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * yMax);

  const grid = ticks.map((t) => `
    <line class="grid" x1="${m.left}" x2="${W - m.right}" y1="${y(t)}" y2="${y(t)}"></line>
    <text class="tick" x="${m.left - 8}" y="${y(t) + 4}" text-anchor="end">${(t * 100).toFixed(t * 100 % 1 ? 1 : 0)}%</text>`).join('');

  const marks = rows.map((r, i) => {
    const cx = m.left + band * i + band / 2;
    const tip = `Total ${r.total}: ${r.count} rolls, ${pct(r.actual)} actual, ${pct(r.theoretical)} theoretical`;
    return `<g>
      <path class="bar" d="${roundedTopBar(cx - barW / 2, y(r.actual), barW, m.top + ih - y(r.actual))}"></path>
      <line class="theory" x1="${cx - barW / 2 - 5}" x2="${cx + barW / 2 + 5}" y1="${y(r.theoretical)}" y2="${y(r.theoretical)}"></line>
      <text class="tick" x="${cx}" y="${H - 10}" text-anchor="middle">${r.total}</text>
      <rect class="hit" x="${m.left + band * i}" y="${m.top}" width="${band}" height="${ih + 22}" data-tip="${esc(tip)}"></rect>
    </g>`;
  }).join('');

  return `<div class="legend">
      <span><i class="swatch" style="background:var(--series-1)"></i>Actual</span>
      <span><i class="swatch line" style="background:var(--ink)"></i>Theoretical</span>
    </div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Actual versus theoretical frequency of each dice total">
      ${grid}<line class="axis" x1="${m.left}" x2="${W - m.right}" y1="${y(0)}" y2="${y(0)}"></line>${marks}
    </svg>`;
}

/** series: [{ name, color, values }], all the same length. labelEnds adds direct labels. */
export function lineChart({ series, yFormat = (v) => String(v), label, yMaxFixed = null, labelEnds = false, height = 220 }) {
  const n = series[0]?.values.length ?? 0;
  const W = 720; const H = height;
  const m = { top: 12, right: labelEnds ? 92 : 12, bottom: 26, left: 42 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  if (n < 2) return `<p class="empty">Needs at least two rolls.</p>`;

  const peak = Math.max(...series.flatMap((s) => s.values));
  const yMax = yMaxFixed ?? niceMax(Math.max(peak, 1e-6));
  const x = (i) => m.left + (i / (n - 1)) * iw;
  const y = (v) => m.top + ih - (v / yMax) * ih;
  const ticks = [0, 0.5, 1].map((t) => t * yMax);
  const grid = ticks.map((t) => `
    <line class="grid" x1="${m.left}" x2="${W - m.right}" y1="${y(t)}" y2="${y(t)}"></line>
    <text class="tick" x="${m.left - 8}" y="${y(t) + 4}" text-anchor="end">${esc(yFormat(t))}</text>`).join('');

  // Thin out the path and hit columns on long games. The endpoint is always kept.
  const step = Math.max(1, Math.ceil(n / 150));
  const indexes = [];
  for (let i = 0; i < n; i += step) indexes.push(i);
  if (indexes.at(-1) !== n - 1) indexes.push(n - 1);

  const lines = series.map((s) => `<polyline class="line" style="stroke:${s.color}" points="${indexes.map((i) => `${x(i).toFixed(1)},${y(s.values[i]).toFixed(1)}`).join(' ')}"></polyline>`).join('');

  const columnWidth = iw / Math.max(1, indexes.length - 1);
  const columns = indexes.map((i) => {
    const tip = `Roll ${i + 1}: ${series.map((s) => `${s.name} ${yFormat(s.values[i])}`).join(', ')}`;
    return `<g class="col">
      <line class="cross" x1="${x(i)}" x2="${x(i)}" y1="${m.top}" y2="${m.top + ih}"></line>
      ${series.map((s) => `<circle class="dot" cx="${x(i)}" cy="${y(s.values[i])}" r="4" style="fill:${s.color}"></circle>`).join('')}
      <rect class="hit" x="${x(i) - columnWidth / 2}" y="${m.top}" width="${columnWidth}" height="${ih}" data-tip="${esc(tip)}"></rect>
    </g>`;
  }).join('');

  let ends = '';
  if (labelEnds) {
    // Nudge the labels apart so tied lines stay readable.
    const placed = series
      .map((s) => ({ s, ly: y(s.values[n - 1]) }))
      .sort((a, b) => a.ly - b.ly);
    for (let i = 1; i < placed.length; i++) {
      placed[i].ly = Math.max(placed[i].ly, placed[i - 1].ly + 15);
    }
    ends = placed.map(({ s, ly }) => `<text class="end-label" x="${W - m.right + 8}" y="${ly + 4}">${esc(s.name)}</text>`).join('');
  }

  const legend = series.length > 1
    ? `<div class="legend">${series.map((s) => `<span><i class="swatch line" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`
    : '';

  return `${legend}<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">
    ${grid}<line class="axis" x1="${m.left}" x2="${W - m.right}" y1="${y(0)}" y2="${y(0)}"></line>
    ${lines}${columns}${ends}
    <text class="tick" x="${m.left}" y="${H - 6}">Roll 1</text>
    <text class="tick" x="${W - m.right}" y="${H - 6}" text-anchor="end">Roll ${n}</text>
  </svg>`;
}

/** rows: [{ label, segments: [{ name, value, color }] }] */
export function stackedBars(rows, legendItems) {
  const W = 720;
  const rowH = 34;
  const m = { top: 6, right: 44, bottom: 6, left: 104 };
  const H = m.top + m.bottom + rows.length * rowH;
  const iw = W - m.left - m.right;
  const max = Math.max(1, ...rows.map((r) => r.segments.reduce((sum, s) => sum + s.value, 0)));
  const body = rows.map((row, i) => {
    const yy = m.top + i * rowH + 7;
    let cursor = m.left;
    let rowTotal = 0;
    const segs = row.segments.filter((s) => s.value > 0).map((s) => {
      const w = (s.value / max) * iw;
      const tip = `${row.label}: ${s.value} ${s.name}`;
      const rect = `<rect style="fill:${s.color}" x="${cursor}" y="${yy}" width="${Math.max(1, w - 2)}" height="18" rx="2" data-tip="${esc(tip)}"></rect>`;
      cursor += w;
      rowTotal += s.value;
      return rect;
    }).join('');
    return `<text class="row-label" x="${m.left - 10}" y="${yy + 14}" text-anchor="end">${esc(row.label)}</text>
      ${segs}<text class="tick" x="${cursor + 6}" y="${yy + 14}">${rowTotal}</text>`;
  }).join('');
  const legend = `<div class="legend">${legendItems.map((l) => `<span><i class="swatch" style="background:${l.color}"></i>${esc(l.name)}</span>`).join('')}</div>`;
  return `${legend}<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Resources produced per player, by type">${body}</svg>`;
}

const PIPS = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
};

export function dieFace(value, size = 48) {
  const dots = (PIPS[value] ?? []).map(([c, r]) => `<circle cx="${25 + c * 25}" cy="${25 + r * 25}" r="7"></circle>`).join('');
  return `<svg class="die" width="${size}" height="${size}" viewBox="0 0 100 100" role="img" aria-label="Die showing ${value}">
    <rect x="3" y="3" width="94" height="94" rx="16"></rect>${dots}</svg>`;
}
