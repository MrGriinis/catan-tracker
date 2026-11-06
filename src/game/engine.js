// Event-sourced game state. The event log is the only source of truth, and state is
// always replay(events). Corrections and undo are events too, so nothing is erased.
// Production is derived during replay, so correcting a past roll or voiding a
// building recalculates every later result automatically.
import { RESOURCES, desertHex } from './board.js';
import {
  awardHolder, checkCity, checkRoad, checkRobber, checkSettlement, computeProduction, longestRoad,
} from './rules.js';

export const ORIGINS = ['camera', 'manual', 'simulated', 'inference'];

export function makeEvent(type, payload = {}, meta = {}) {
  return {
    id: meta.id ?? `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    type,
    ts: meta.ts ?? new Date().toISOString(),
    origin: meta.origin ?? 'manual',
    confidence: meta.confidence ?? null,
    verified: meta.verified ?? meta.origin === undefined,
    ...payload,
  };
}

/**
 * Walk backwards so a later void wins: voiding a void restores the original event,
 * which gives redo for free. The most recent live correction of each roll wins.
 */
function resolveMeta(events) {
  const voided = new Set();
  const corrections = new Map();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (voided.has(e.id)) continue;
    if (e.type === 'EventVoided') voided.add(e.target);
    if (e.type === 'RollCorrected' && !corrections.has(e.target)) corrections.set(e.target, e);
  }
  return { voided, corrections };
}

export function initialState() {
  return {
    game: null,
    players: [],
    board: null,
    robberHex: null,
    buildings: new Map(),
    roads: new Map(),
    knights: {},
    longestRoadHolder: null,
    largestArmyHolder: null,
    roadLengths: {},
    rolls: [],
    needsRobberMove: false,
    timeline: [],
    rejected: [],
  };
}

function updateAwards(state) {
  const lengths = {};
  for (const p of state.players) lengths[p.id] = longestRoad(state, p.id);
  state.roadLengths = lengths;
  state.longestRoadHolder = awardHolder(lengths, state.longestRoadHolder, 5);
  const knights = {};
  for (const p of state.players) knights[p.id] = state.knights[p.id] ?? 0;
  state.largestArmyHolder = awardHolder(knights, state.largestArmyHolder, 3);
}

function applyRoll(state, event, correction) {
  const d1 = correction ? correction.d1 : event.d1;
  const d2 = correction ? correction.d2 : event.d2;
  const total = d1 + d2;
  const index = state.rolls.length;
  // Turn order is inferred. Each roll is one turn, in seating order from the first player.
  const player = state.players.length ? state.players[index % state.players.length].id : null;
  const production = computeProduction({
    board: state.board,
    buildings: state.buildings,
    robberHex: state.robberHex,
    total,
  });
  state.rolls.push({
    eventId: event.id,
    index,
    d1,
    d2,
    total,
    ts: event.ts,
    origin: event.origin,
    confidence: event.confidence,
    corrected: Boolean(correction),
    detected: correction ? { d1: event.d1, d2: event.d2 } : null,
    player,
    production: state.board ? production : null,
  });
  state.needsRobberMove = total === 7;
}

const handlers = {
  GameStarted(state, e) {
    state.game = { id: e.gameId, name: e.name, startedAt: e.ts };
    state.players = e.players;
  },
  BoardConfigured(state, e) {
    state.board = e.hexes;
    if (state.robberHex == null || e.resetRobber) state.robberHex = desertHex(e.hexes);
  },
  DiceRolled: applyRoll,
  RollCorrected() {},
  SettlementBuilt(state, e) {
    const reason = checkSettlement(state, e.player, e.vertex);
    if (reason) return reason;
    state.buildings.set(e.vertex, { player: e.player, kind: 'settlement' });
    updateAwards(state);
    return null;
  },
  CityBuilt(state, e) {
    const reason = checkCity(state, e.player, e.vertex);
    if (reason) return reason;
    state.buildings.set(e.vertex, { player: e.player, kind: 'city' });
    return null;
  },
  RoadBuilt(state, e) {
    const reason = checkRoad(state, e.player, e.edge);
    if (reason) return reason;
    state.roads.set(e.edge, e.player);
    updateAwards(state);
    return null;
  },
  RobberMoved(state, e) {
    const reason = checkRobber(state, e.hex);
    if (reason) return reason;
    state.robberHex = e.hex;
    state.needsRobberMove = false;
    return null;
  },
  DevelopmentCardPlayed(state, e) {
    if (e.card === 'knight') {
      state.knights[e.player] = (state.knights[e.player] ?? 0) + 1;
      updateAwards(state);
    }
    return null;
  },
};

export function replay(events) {
  const { voided, corrections } = resolveMeta(events);
  const state = initialState();
  for (const event of events) {
    const isVoided = voided.has(event.id);
    const entry = { event, voided: isVoided, rejected: null };
    state.timeline.push(entry);
    if (isVoided || event.type === 'EventVoided') continue;
    const handler = handlers[event.type];
    if (!handler) continue;
    const reason = event.type === 'DiceRolled'
      ? handler(state, event, corrections.get(event.id))
      : handler(state, event);
    if (reason) {
      entry.rejected = reason;
      state.rejected.push({ event, reason });
    }
  }
  return state;
}

/** The newest event that undo should cancel. Game setup is never undone this way. */
export function lastUndoable(events) {
  const { voided } = resolveMeta(events);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (voided.has(e.id) || e.type === 'EventVoided' || e.type === 'GameStarted') continue;
    return e;
  }
  return null;
}

function emptyResources() {
  return Object.fromEntries(RESOURCES.map((r) => [r, 0]));
}

/** Per-player summary. Inventory is deliberately absent: production is not holdings. */
export function playerSummaries(state) {
  return state.players.map((p) => {
    let settlements = 0;
    let cities = 0;
    for (const b of state.buildings.values()) {
      if (b.player !== p.id) continue;
      if (b.kind === 'city') cities++;
      else settlements++;
    }
    let roads = 0;
    for (const owner of state.roads.values()) if (owner === p.id) roads++;
    const produced = emptyResources();
    const lostToRobber = emptyResources();
    for (const roll of state.rolls) {
      if (!roll.production) continue;
      for (const [r, n] of Object.entries(roll.production.byPlayer[p.id] ?? {})) produced[r] += n;
      for (const [r, n] of Object.entries(roll.production.blocked[p.id] ?? {})) lostToRobber[r] += n;
    }
    const longest = state.longestRoadHolder === p.id;
    const army = state.largestArmyHolder === p.id;
    return {
      ...p,
      settlements,
      cities,
      roads,
      roadLength: state.roadLengths[p.id] ?? 0,
      knights: state.knights[p.id] ?? 0,
      longestRoad: longest,
      largestArmy: army,
      visibleVP: settlements + cities * 2 + (longest ? 2 : 0) + (army ? 2 : 0),
      produced,
      lostToRobber,
      totalProduced: RESOURCES.reduce((sum, r) => sum + produced[r], 0),
    };
  });
}
