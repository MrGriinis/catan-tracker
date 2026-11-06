// Geometry and configuration of the standard 19-hex board. Ids are derived from
// geometry, so they are stable across games and sessions. A future vision module
// can map detected pieces onto the same I<n> / E<n> / H<n> ids.

export const TERRAINS = ['hills', 'forest', 'pasture', 'fields', 'mountains', 'desert'];
export const RESOURCES = ['brick', 'lumber', 'wool', 'grain', 'ore'];
export const TERRAIN_RESOURCE = {
  hills: 'brick',
  forest: 'lumber',
  pasture: 'wool',
  fields: 'grain',
  mountains: 'ore',
  desert: null,
};
export const STANDARD_TERRAIN_COUNTS = {
  hills: 3, forest: 4, pasture: 4, fields: 4, mountains: 3, desert: 1,
};
export const STANDARD_TOKENS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

// Pointy-top hex corners on an integer lattice: x units are sqrt(3)/2 * size,
// y units are size/2. Shared corners land on identical integers, so they dedupe exactly.
const CORNER_OFFSETS = [[0, -2], [1, -1], [1, 1], [0, 2], [-1, 1], [-1, -1]];

function byRowThenColumn(a, b) {
  return a.y - b.y || a.x - b.x;
}

function buildTopology() {
  const radius = 2;
  const hexes = [];
  for (let r = -radius; r <= radius; r++) {
    for (let q = -radius; q <= radius; q++) {
      if (Math.abs(q + r) <= radius) hexes.push({ q, r, x: 2 * q + r, y: 3 * r });
    }
  }
  hexes.sort(byRowThenColumn);
  hexes.forEach((h, i) => { h.id = i; });

  const vertexMap = new Map();
  for (const h of hexes) {
    for (const [dx, dy] of CORNER_OFFSETS) {
      const key = `${h.x + dx},${h.y + dy}`;
      if (!vertexMap.has(key)) vertexMap.set(key, { x: h.x + dx, y: h.y + dy, hexes: [], edges: [], neighbors: [] });
      vertexMap.get(key).hexes.push(h.id);
    }
  }
  const vertices = [...vertexMap.values()].sort(byRowThenColumn);
  vertices.forEach((v, i) => { v.id = i; });
  const vertexAt = (x, y) => vertexMap.get(`${x},${y}`);

  const edgeMap = new Map();
  for (const h of hexes) {
    h.corners = CORNER_OFFSETS.map(([dx, dy]) => vertexAt(h.x + dx, h.y + dy).id);
    for (let i = 0; i < 6; i++) {
      const a = h.corners[i];
      const b = h.corners[(i + 1) % 6];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (!edgeMap.has(key)) {
        edgeMap.set(key, {
          a: Math.min(a, b),
          b: Math.max(a, b),
          x: (vertices[a].x + vertices[b].x) / 2,
          y: (vertices[a].y + vertices[b].y) / 2,
          hexes: [],
        });
      }
      edgeMap.get(key).hexes.push(h.id);
    }
  }
  const edges = [...edgeMap.values()].sort(byRowThenColumn);
  edges.forEach((e, i) => {
    e.id = i;
    vertices[e.a].edges.push(i);
    vertices[e.b].edges.push(i);
    vertices[e.a].neighbors.push(e.b);
    vertices[e.b].neighbors.push(e.a);
  });

  for (const h of hexes) {
    h.neighbors = hexes
      .filter((o) => o.id !== h.id && Math.hypot(o.x - h.x, (o.y - h.y) / Math.sqrt(3)) <= 2.01)
      .map((o) => o.id);
  }
  return { hexes, vertices, edges };
}

export const TOPOLOGY = buildTopology();

/** Lattice to pixel conversion for a hex of the given circumradius. */
export function toPixel(x, y, size) {
  return [(x * Math.sqrt(3) * size) / 2, (y * size) / 2];
}

export function emptyBoard() {
  return TOPOLOGY.hexes.map(() => ({ terrain: null, number: null }));
}

function shuffle(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A random legal layout. It exists for trying the app without a physical board to copy. */
export function randomBoard(rng = Math.random) {
  const terrains = shuffle(
    Object.entries(STANDARD_TERRAIN_COUNTS).flatMap(([t, n]) => Array(n).fill(t)),
    rng,
  );
  for (let attempt = 0; ; attempt++) {
    const tokens = shuffle(STANDARD_TOKENS, rng);
    const board = terrains.map((terrain) => ({
      terrain,
      number: terrain === 'desert' ? null : tokens.pop(),
    }));
    const hot = (b) => b.number === 6 || b.number === 8;
    const clash = TOPOLOGY.hexes.some(
      (h) => hot(board[h.id]) && h.neighbors.some((n) => hot(board[n])),
    );
    if (!clash || attempt > 5000) return board;
  }
}

/**
 * errors stop the board from producing correctly. warnings flag a layout that
 * differs from the standard set, which may be a deliberate house variant.
 */
export function checkBoard(board) {
  const errors = [];
  const warnings = [];
  board.forEach((h, i) => {
    if (!h.terrain) errors.push(`H${i} has no terrain`);
    else if (h.terrain !== 'desert' && h.number == null) errors.push(`H${i} (${h.terrain}) has no number`);
    else if (h.terrain === 'desert' && h.number != null) errors.push(`H${i} is desert but has a number`);
  });
  for (const [terrain, expected] of Object.entries(STANDARD_TERRAIN_COUNTS)) {
    const n = board.filter((h) => h.terrain === terrain).length;
    if (n !== expected) warnings.push(`${n} ${terrain} (standard set has ${expected})`);
  }
  const tokens = board.map((h) => h.number).filter((n) => n != null).sort((a, b) => a - b);
  if (tokens.join() !== STANDARD_TOKENS.join()) warnings.push('Number tokens differ from the standard set');
  const hot = (h) => h.number === 6 || h.number === 8;
  const adjacent = TOPOLOGY.hexes.some(
    (h) => hot(board[h.id]) && h.neighbors.some((n) => hot(board[n])),
  );
  if (adjacent) warnings.push('A 6 or 8 sits next to another 6 or 8');
  return { errors, warnings };
}

export function desertHex(board) {
  const i = board.findIndex((h) => h.terrain === 'desert');
  return i === -1 ? null : i;
}
