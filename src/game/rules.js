// Pure game rules. Nothing here knows about cameras, storage or the DOM.
import { RESOURCES, TERRAIN_RESOURCE, TOPOLOGY } from './board.js';

export const SUPPLY = { settlement: 5, city: 4, road: 15 };
const { vertices, edges, hexes } = TOPOLOGY;

function count(state, player, kind) {
  let n = 0;
  for (const b of state.buildings.values()) if (b.player === player && b.kind === kind) n++;
  return n;
}

function isSetup(state, player) {
  return count(state, player, 'settlement') + count(state, player, 'city') < 2;
}

/** Each validator returns null when legal, otherwise a human-readable reason. */
export function checkSettlement(state, player, vertex) {
  if (!vertices[vertex]) return 'Unknown intersection';
  if (state.buildings.has(vertex)) return 'Intersection is occupied';
  if (vertices[vertex].neighbors.some((n) => state.buildings.has(n))) {
    return 'Too close to another building (distance rule)';
  }
  if (count(state, player, 'settlement') >= SUPPLY.settlement) return 'No settlements left in supply';
  if (!isSetup(state, player)) {
    const connected = vertices[vertex].edges.some((e) => state.roads.get(e) === player);
    if (!connected) return 'Settlement must connect to one of your roads';
  }
  return null;
}

export function checkCity(state, player, vertex) {
  const b = state.buildings.get(vertex);
  if (!b || b.kind !== 'settlement' || b.player !== player) return 'A city must replace your own settlement';
  if (count(state, player, 'city') >= SUPPLY.city) return 'No cities left in supply';
  return null;
}

export function checkRoad(state, player, edge) {
  const e = edges[edge];
  if (!e) return 'Unknown edge';
  if (state.roads.has(edge)) return 'Edge already has a road';
  let roadCount = 0;
  for (const owner of state.roads.values()) if (owner === player) roadCount++;
  if (roadCount >= SUPPLY.road) return 'No roads left in supply';
  const connects = [e.a, e.b].some((v) => {
    const b = state.buildings.get(v);
    if (b) return b.player === player;
    return vertices[v].edges.some((other) => state.roads.get(other) === player);
  });
  return connects ? null : 'Road must connect to your own building or road';
}

export function checkRobber(state, hex) {
  if (!hexes[hex]) return 'Unknown hex';
  if (hex === state.robberHex) return 'The robber must move to a different hex';
  return null;
}

/**
 * Production for a dice total. bankStock is optional, because the bank can only be
 * known once every card movement is tracked. Without it, the result is what players
 * are entitled to, and the shortage rule is not applied.
 */
export function computeProduction({ board, buildings, robberHex, total, bankStock = null }) {
  const byPlayer = {};
  const blocked = {};
  const sources = [];
  if (!board) return { byPlayer, blocked, sources, shortages: [] };

  const add = (target, player, resource, n) => {
    target[player] ??= {};
    target[player][resource] = (target[player][resource] ?? 0) + n;
  };

  board.forEach((cfg, hexId) => {
    if (cfg.number !== total) return;
    const resource = TERRAIN_RESOURCE[cfg.terrain];
    if (!resource) return;
    const isBlocked = hexId === robberHex;
    let touched = false;
    for (const v of hexes[hexId].corners) {
      const b = buildings.get(v);
      if (!b) continue;
      touched = true;
      add(isBlocked ? blocked : byPlayer, b.player, resource, b.kind === 'city' ? 2 : 1);
    }
    sources.push({ hex: hexId, resource, blocked: isBlocked, touched });
  });

  const shortages = [];
  if (bankStock) {
    for (const resource of RESOURCES) {
      const owed = Object.keys(byPlayer).filter((p) => byPlayer[p][resource]);
      const total_owed = owed.reduce((sum, p) => sum + byPlayer[p][resource], 0);
      const stock = bankStock[resource];
      if (total_owed <= stock) continue;
      shortages.push(resource);
      // Official rule: a lone recipient takes what remains. Several recipients get nothing.
      for (const p of owed) {
        if (owed.length === 1 && stock > 0) byPlayer[p][resource] = stock;
        else delete byPlayer[p][resource];
      }
    }
  }
  return { byPlayer, blocked, sources, shortages };
}

/** Average cards per dice roll a player can expect from the current board and robber. */
export function expectedPerRoll(state, player) {
  if (!state.board) return 0;
  let expected = 0;
  state.board.forEach((cfg, hexId) => {
    if (cfg.number == null || !TERRAIN_RESOURCE[cfg.terrain] || hexId === state.robberHex) return;
    const probability = (6 - Math.abs(7 - cfg.number)) / 36;
    for (const v of hexes[hexId].corners) {
      const b = state.buildings.get(v);
      if (b?.player === player) expected += probability * (b.kind === 'city' ? 2 : 1);
    }
  });
  return expected;
}

/** Longest continuous road for one player. An opponent's building breaks the chain. */
export function longestRoad(state, player) {
  const own = [...state.roads.entries()].filter(([, p]) => p === player).map(([e]) => e);
  const passable = (v) => {
    const b = state.buildings.get(v);
    return !b || b.player === player;
  };
  const walk = (vertex, used) => {
    let best = 0;
    for (const id of vertices[vertex].edges) {
      if (used.has(id) || state.roads.get(id) !== player) continue;
      const next = edges[id].a === vertex ? edges[id].b : edges[id].a;
      used.add(id);
      best = Math.max(best, 1 + (passable(next) ? walk(next, used) : 0));
      used.delete(id);
    }
    return best;
  };
  let best = 0;
  for (const id of own) {
    const { a, b } = edges[id];
    best = Math.max(best, walk(a, new Set()), walk(b, new Set()));
  }
  return best;
}

/**
 * Award holder for a threshold-based bonus. An incumbent keeps it on a tie. If the
 * incumbent loses the lead and others tie for it, nobody holds it.
 */
export function awardHolder(scores, current, minimum) {
  const max = Math.max(0, ...Object.values(scores));
  if (max < minimum) return null;
  if (current != null && scores[current] === max) return current;
  const leaders = Object.keys(scores).filter((p) => scores[p] === max);
  return leaders.length === 1 ? leaders[0] : null;
}
