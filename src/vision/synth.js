// Software renderer for dice scenes. It supplies the unit tests and the app's simulated
// camera with frames whose ground truth is known. Passing on these frames shows the
// pipeline's logic works. It does not prove accuracy on real dice under real lighting.

const PIP_LAYOUT = {
  1: [[0, 0]],
  2: [[-1, -1], [1, 1]],
  3: [[-1, -1], [0, 0], [1, 1]],
  4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
  5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
  6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]],
};

export function makeRng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    // xorshift32: fast, and repeatable so a failing test can be replayed exactly
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * scene: { width, height, table, gradient, noise, shadow, faceLevel, pipLevel,
 *          dice:[{cx,cy,side,angle,value}], blobs:[{cx,cy,r,level}] }
 */
export function renderScene(scene, rng = makeRng(7), target = null) {
  const {
    width, height, table = 45, gradient = 0, noise = 3, shadow = 0.35,
    faceLevel = 235, pipLevel = 25, dice = [], blobs = [],
  } = scene;
  const data = target ?? new Uint8ClampedArray(width * height * 4);
  const gray = new Float32Array(width * height);

  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      gray[i] = table + (gradient * (x / width + y / height - 1));
    }
  }

  for (const die of dice) {
    const { cx, cy, side, angle = 0, value } = die;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const half = side / 2;
    const radius = side * 0.12; // rounded corners
    const pipRadius = side * 0.085;
    const pipSpacing = side * 0.27;
    const pips = PIP_LAYOUT[value] ?? [];
    const off = side * 0.08; // soft shadow, cast down-right
    const reach = Math.ceil(half * Math.SQRT2 + off + 2);

    const insideDie = (u, v) => {
      const qx = Math.abs(u) - (half - radius);
      const qy = Math.abs(v) - (half - radius);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
    };

    for (let y = Math.max(0, Math.floor(cy - reach)); y < Math.min(height, cy + reach); y++) {
      for (let x = Math.max(0, Math.floor(cx - reach)); x < Math.min(width, cx + reach); x++) {
        const i = y * width + x;
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const u = dx * cos + dy * sin;
        const v = -dx * sin + dy * cos;
        const su = (dx - off) * cos + (dy - off) * sin;
        const sv = -(dx - off) * sin + (dy - off) * cos;
        if (insideDie(su, sv) < 0) gray[i] *= 1 - shadow;
        const d = insideDie(u, v);
        if (d >= 1) continue;
        let level = faceLevel;
        for (const [px, py] of pips) {
          const pd = Math.hypot(u - px * pipSpacing, v - py * pipSpacing) - pipRadius;
          if (pd < 1) {
            const t = Math.min(1, Math.max(0, pd * 0.5 + 0.5));
            level = pipLevel + (faceLevel - pipLevel) * t;
            break;
          }
        }
        const coverage = Math.min(1, Math.max(0, 0.5 - d));
        gray[i] = gray[i] * (1 - coverage) + level * coverage;
      }
    }
  }

  for (const { cx, cy, r, level } of blobs) {
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(height, cy + r); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(width, cx + r); x++) {
        if (Math.hypot(x - cx, y - cy) < r) gray[y * width + x] = level;
      }
    }
  }

  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const value = gray[i] + (noise ? (rng() - 0.5) * 2 * noise : 0);
    data[p] = value;
    data[p + 1] = value;
    data[p + 2] = value;
    data[p + 3] = 255;
  }
  return { data, width, height };
}

/** Random non-overlapping resting positions for two dice. */
export function placeDice(width, height, side, rng, values) {
  const margin = side * 1.1;
  const pick = () => ({
    cx: margin + rng() * (width - margin * 2),
    cy: margin + rng() * (height - margin * 2),
    side,
    angle: rng() * Math.PI,
  });
  const a = pick();
  let b = pick();
  while (Math.hypot(a.cx - b.cx, a.cy - b.cy) < side * 1.7) b = pick();
  return [{ ...a, value: values[0] }, { ...b, value: values[1] }];
}
