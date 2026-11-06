// Classical dice reader with no dependencies. It assumes light dice with dark pips on a
// darker matte surface, seen from roughly overhead. It works on plain RGBA buffers, so the
// same code runs in the browser and under `node --test`. It fails closed: anything it
// cannot read confidently is reported as a status, and a value is never guessed.

export const DEFAULT_DICE_OPTIONS = {
  minSideFraction: 0.025, // die side, as a fraction of the shorter frame dimension
  maxSideFraction: 0.45,
  minContrast: 45, // dice must be this much brighter than the surface, in grey levels
  maxAspect: 1.35,
  minFill: 0.5,
  minConfidence: 0.45,
};

const PATCH = 48;
const PIP_MARGIN = 0.11; // ignore rounded die edges, which shade dark

export function toGray({ data, width, height }) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return gray;
}

function histogram(values) {
  const h = new Uint32Array(256);
  for (let i = 0; i < values.length; i++) h[values[i]]++;
  return h;
}

function percentile(hist, total, fraction) {
  const target = total * fraction;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= target) return v;
  }
  return 255;
}

function otsu(hist, total) {
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += v * hist[v];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) {
      best = between;
      threshold = v;
    }
  }
  return threshold;
}

function erode(mask, width, height) {
  const out = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - width] && mask[i + width]) out[i] = 1;
    }
  }
  return out;
}

/** Connected foreground regions, with the row extents needed for the convex hull. */
function labelComponents(mask, width, height, minArea) {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const regions = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let area = 0;
    const rows = new Map();
    while (top) {
      const i = stack[--top];
      area++;
      const x = i % width;
      const y = (i - x) / width;
      const row = rows.get(y);
      if (!row) rows.set(y, [x, x]);
      else {
        if (x < row[0]) row[0] = x;
        if (x > row[1]) row[1] = x;
      }
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < width - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && mask[i - width] && !seen[i - width]) { seen[i - width] = 1; stack[top++] = i - width; }
      if (y < height - 1 && mask[i + width] && !seen[i + width]) { seen[i + width] = 1; stack[top++] = i + width; }
    }
    if (area < minArea) continue;
    const points = [];
    for (const [y, [a, b]] of rows) {
      points.push([a, y], [b + 1, y], [a, y + 1], [b + 1, y + 1]);
    }
    regions.push({ area, points });
  }
  return regions;
}

function convexHull(points) {
  const pts = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const hull = [];
    for (const p of list) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
    return hull;
  };
  return [...half(pts), ...half(pts.reverse())];
}

/** The minimum-area rectangle always has one side along a hull edge. */
function minAreaRect(points) {
  const hull = convexHull(points);
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i];
    const [bx, by] = hull[(i + 1) % hull.length];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    let minU = Infinity; let maxU = -Infinity; let minV = Infinity; let maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU;
    const h = maxV - minV;
    if (!best || w * h < best.w * best.h) {
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = { cx: cu * ux - cv * uy, cy: cu * uy + cv * ux, w, h, ux, uy };
    }
  }
  return best;
}

function sampleBilinear(gray, width, height, x, y) {
  const x0 = Math.max(0, Math.min(width - 2, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 2, Math.floor(y)));
  const fx = Math.max(0, Math.min(1, x - x0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const i = y0 * width + x0;
  return (
    gray[i] * (1 - fx) * (1 - fy)
    + gray[i + 1] * fx * (1 - fy)
    + gray[i + width] * (1 - fx) * fy
    + gray[i + width + 1] * fx * fy
  );
}

const PIP_TEMPLATES = (() => {
  const c = [0, 0];
  const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const anti = [[1, -1], [-1, 1]];
  const main = [[-1, -1], [1, 1]];
  const side1 = [[-1, 0], [1, 0]];
  const side2 = [[0, -1], [0, 1]];
  return {
    1: [[c]],
    2: [main, anti],
    3: [[...main, c], [...anti, c]],
    4: [corners],
    5: [[...corners, c]],
    6: [[...corners, ...side1], [...corners, ...side2]],
  };
})();

/** Mean distance from pips to the canonical layout, in die-side units. Lower is better. */
function templateError(pips) {
  const templates = PIP_TEMPLATES[pips.length];
  if (!templates) return Infinity;
  let best = Infinity;
  for (const template of templates) {
    for (let scale = 0.2; scale <= 0.34; scale += 0.02) {
      const free = template.map(([x, y]) => [x * scale, y * scale]);
      let total = 0;
      for (const pip of pips) {
        let nearest = Infinity;
        let index = -1;
        free.forEach((t, i) => {
          if (!t) return;
          const d = Math.hypot(t[0] - pip.u, t[1] - pip.v);
          if (d < nearest) { nearest = d; index = i; }
        });
        total += nearest;
        free[index] = null;
      }
      best = Math.min(best, total / pips.length);
    }
  }
  return best;
}

function readPips(gray, width, height, rect) {
  const side = (rect.w + rect.h) / 2;
  const patch = new Uint8Array(PATCH * PATCH);
  const lo = Math.floor(PATCH * PIP_MARGIN);
  const hi = PATCH - lo;
  const inner = [];
  for (let py = 0; py < PATCH; py++) {
    const v = ((py + 0.5) / PATCH - 0.5) * rect.h;
    for (let px = 0; px < PATCH; px++) {
      const u = ((px + 0.5) / PATCH - 0.5) * rect.w;
      const value = Math.round(sampleBilinear(
        gray, width, height,
        rect.cx + u * rect.ux - v * rect.uy,
        rect.cy + u * rect.uy + v * rect.ux,
      ));
      patch[py * PATCH + px] = value;
      if (px >= lo && px < hi && py >= lo && py < hi) inner.push(value);
    }
  }
  const hist = histogram(inner);
  const white = percentile(hist, inner.length, 0.8);
  const dark = percentile(hist, inner.length, 0.01);
  const contrast = white - dark;
  if (contrast < 40) return { value: null, confidence: 0, pips: [], reason: 'no-pips' };

  const threshold = (white + dark) / 2;
  const mask = new Uint8Array(PATCH * PATCH);
  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) {
      if (patch[y * PATCH + x] < threshold) mask[y * PATCH + x] = 1;
    }
  }

  const minPip = PATCH * PATCH * 0.0035;
  const maxPip = PATCH * PATCH * 0.2;
  const pips = [];
  for (const region of labelComponents(mask, PATCH, PATCH, minPip)) {
    if (region.area > maxPip) continue;
    const xs = region.points.map((p) => p[0]);
    const ys = region.points.map((p) => p[1]);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    if (Math.max(bw, bh) / Math.max(1, Math.min(bw, bh)) > 2) continue;
    if (region.area / (bw * bh) < 0.45) continue;
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    pips.push({ u: cx / PATCH - 0.5, v: cy / PATCH - 0.5, area: region.area });
  }

  const positions = pips.map((p) => ({
    x: rect.cx + p.u * rect.w * rect.ux - p.v * rect.h * rect.uy,
    y: rect.cy + p.u * rect.w * rect.uy + p.v * rect.h * rect.ux,
  }));
  if (pips.length < 1 || pips.length > 6) {
    return { value: null, confidence: 0, pips: positions, reason: `${pips.length}-pips` };
  }
  const error = templateError(pips);
  const areas = pips.map((p) => p.area);
  const uniformity = Math.min(...areas) / Math.max(...areas);
  const geometryScore = Math.max(0, 1 - error / 0.14);
  const uniformityScore = Math.min(1, uniformity / 0.4);
  const contrastScore = Math.min(1, contrast / 90);
  const confidence = geometryScore * uniformityScore * contrastScore;
  return { value: pips.length, confidence, pips: positions, reason: null, side };
}

function candidateFromRegion(region, grow, opts, limits) {
  const rect = minAreaRect(region.points);
  rect.w += grow * 2;
  rect.h += grow * 2;
  const side = Math.sqrt(rect.w * rect.h);
  if (side < limits.minSide || side > limits.maxSide) return null;
  const aspect = Math.max(rect.w, rect.h) / Math.min(rect.w, rect.h);
  if (aspect > opts.maxAspect) return null;
  // Erosion shrinks the area, so judge fill on the rectangle as it was eroded.
  const fill = region.area / ((rect.w - grow * 2) * (rect.h - grow * 2));
  if (fill < opts.minFill) return null;
  return { rect, side };
}

function splitIfPair(region, opts, limits) {
  const rect = minAreaRect(region.points);
  const long = Math.max(rect.w, rect.h);
  const short = Math.min(rect.w, rect.h);
  const aspect = long / short;
  if (aspect < 1.7 || aspect > 2.35) return [];
  if (short < limits.minSide || short > limits.maxSide) return [];
  if (region.area / (rect.w * rect.h) < opts.minFill) return [];
  // Two dice pressed flat together: cut the rectangle across its long axis.
  const alongU = rect.w >= rect.h;
  const dirX = alongU ? rect.ux : -rect.uy;
  const dirY = alongU ? rect.uy : rect.ux;
  const half = long / 4;
  return [-1, 1].map((sign) => ({
    side: short,
    rect: {
      ...rect,
      cx: rect.cx + sign * half * dirX,
      cy: rect.cy + sign * half * dirY,
      w: alongU ? long / 2 : short,
      h: alongU ? short : long / 2,
    },
  }));
}

function findCandidates(mask, width, height, opts, limits) {
  const minArea = limits.minSide ** 2 * opts.minFill;
  const candidates = [];
  for (const region of labelComponents(mask, width, height, minArea)) {
    const single = candidateFromRegion(region, 0, opts, limits);
    if (single) candidates.push(single);
    else candidates.push(...splitIfPair(region, opts, limits));
  }
  return candidates;
}

function evaluate(mask, gray, width, height, opts, limits) {
  let candidates = findCandidates(mask, width, height, opts, limits);
  // Dice touching at an angle merge into one blob. Erode to pull them apart, then grow back.
  if (candidates.length < 2) {
    let eroded = mask;
    for (let grow = 1; grow <= 4 && candidates.length < 2; grow++) {
      eroded = erode(eroded, width, height);
      const minArea = limits.minSide ** 2 * opts.minFill * 0.4;
      const found = labelComponents(eroded, width, height, minArea)
        .map((r) => candidateFromRegion(r, grow, opts, limits))
        .filter(Boolean);
      if (found.length >= 2) candidates = found;
    }
  }
  if (candidates.length === 0) return { status: 'no-dice', dice: [], confidence: 0, candidates: 0 };
  if (candidates.length > 2) return { status: 'too-many', dice: [], confidence: 0, candidates: candidates.length };

  const dice = candidates.map(({ rect, side }) => {
    const read = readPips(gray, width, height, rect);
    return {
      cx: rect.cx,
      cy: rect.cy,
      side,
      rect,
      value: read.confidence >= opts.minConfidence ? read.value : null,
      rawCount: read.value,
      confidence: read.confidence,
      pips: read.pips,
      reason: read.reason,
    };
  }).sort((a, b) => a.cx - b.cx);

  if (dice.length === 1) return { status: 'one-die', dice, confidence: 0, candidates: 1 };
  const ratio = Math.max(dice[0].side, dice[1].side) / Math.min(dice[0].side, dice[1].side);
  if (ratio > 1.4) return { status: 'size-mismatch', dice, confidence: 0, candidates: 2 };
  if (dice.some((d) => d.value == null)) return { status: 'unreadable', dice, confidence: 0, candidates: 2 };
  return { status: 'ok', dice, confidence: Math.min(dice[0].confidence, dice[1].confidence), candidates: 2 };
}

/**
 * Returns { status, dice, confidence, values?, threshold }.
 * status: ok | no-dice | low-contrast | one-die | too-many | size-mismatch | unreadable
 */
export function detectDice(frame, options = {}) {
  const opts = { ...DEFAULT_DICE_OPTIONS, ...options };
  const { width, height } = frame;
  const gray = toGray(frame);
  const hist = histogram(gray);
  const total = gray.length;
  const background = percentile(hist, total, 0.5);
  const peak = percentile(hist, total, 0.998);
  if (peak - background < opts.minContrast) {
    return { status: 'low-contrast', dice: [], confidence: 0, candidates: 0 };
  }
  const shorter = Math.min(width, height);
  const limits = {
    minSide: Math.max(10, shorter * opts.minSideFraction),
    maxSide: shorter * opts.maxSideFraction,
  };
  // No single threshold survives every lighting setup, so try several and keep the best.
  const span = peak - background;
  const thresholds = [
    background + span * 0.5,
    background + span * 0.35,
    background + span * 0.65,
    otsu(hist, total),
  ];
  let best = null;
  for (const threshold of thresholds) {
    const mask = new Uint8Array(total);
    for (let i = 0; i < total; i++) if (gray[i] > threshold) mask[i] = 1;
    const result = evaluate(mask, gray, width, height, opts, limits);
    result.threshold = threshold;
    if (result.status === 'ok' && result.confidence >= 0.7) {
      best = result;
      break;
    }
    if (!best || rank(result) > rank(best)) best = result;
  }
  if (best.status === 'ok') best.values = [best.dice[0].value, best.dice[1].value];
  return best;
}

const STATUS_RANK = { ok: 5, unreadable: 4, 'size-mismatch': 3, 'one-die': 2, 'too-many': 1, 'no-dice': 0 };
function rank(result) {
  return STATUS_RANK[result.status] + result.confidence;
}
