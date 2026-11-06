import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOPOLOGY, STANDARD_TERRAIN_COUNTS, checkBoard, randomBoard, emptyBoard,
} from '../src/game/board.js';
import { computeProduction, expectedPerRoll, longestRoad, awardHolder } from '../src/game/rules.js';
import { makeEvent, replay, playerSummaries, lastUndoable } from '../src/game/engine.js';
import { diceStats, rollsToCsv, playerRollStats, recognitionStats } from '../src/game/stats.js';
import { createStore, memoryStorage } from '../src/game/store.js';
import { makeRng } from '../src/vision/synth.js';

const PLAYERS = [
  { id: 'p1', name: 'Red', color: 'red' },
  { id: 'p2', name: 'Blue', color: 'blue' },
  { id: 'p3', name: 'Orange', color: 'orange' },
];

function boardWith(hex, terrain, number) {
  const board = randomBoard(makeRng(3)).map((h) => ({ ...h, number: h.number === number ? 3 : h.number }));
  board[hex] = { terrain, number };
  return board;
}

function log(...events) {
  let n = 0;
  return [makeEvent('GameStarted', { gameId: 'g', name: 'T', players: PLAYERS }, { id: 'start' }),
    ...events.map(([type, payload, meta]) => makeEvent(type, payload, { id: `x${++n}`, ...meta }))];
}

const nonAdjacentCorners = (hex) => {
  const [a, , c] = TOPOLOGY.hexes[hex].corners;
  return [a, c];
};

test('topology has the known counts of the standard board', () => {
  assert.equal(TOPOLOGY.hexes.length, 19);
  assert.equal(TOPOLOGY.vertices.length, 54);
  assert.equal(TOPOLOGY.edges.length, 72);
  for (const h of TOPOLOGY.hexes) assert.equal(new Set(h.corners).size, 6);
  for (const v of TOPOLOGY.vertices) assert.ok(v.hexes.length >= 1 && v.hexes.length <= 3);
  assert.equal(TOPOLOGY.vertices.filter((v) => v.hexes.length === 3).length, 24);
  assert.equal(TOPOLOGY.hexes[9].neighbors.length, 6, 'centre hex has six neighbours');
});

test('random boards use the standard pieces and keep 6 and 8 apart', () => {
  for (let seed = 1; seed < 40; seed++) {
    const { errors, warnings } = checkBoard(randomBoard(makeRng(seed)));
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  }
  assert.equal(
    Object.values(STANDARD_TERRAIN_COUNTS).reduce((a, b) => a + b),
    TOPOLOGY.hexes.length,
  );
});

test('checkBoard reports an unconfigured board', () => {
  assert.equal(checkBoard(emptyBoard()).errors.length, 19);
});

test('settlement yields 1, city yields 2, across all players on a hex', () => {
  const board = boardWith(9, 'forest', 8);
  const [a, c] = nonAdjacentCorners(9);
  const buildings = new Map([[a, { player: 'p1', kind: 'settlement' }], [c, { player: 'p2', kind: 'city' }]]);
  const out = computeProduction({ board, buildings, robberHex: 0, total: 8 });
  assert.equal(out.byPlayer.p1.lumber, 1);
  assert.equal(out.byPlayer.p2.lumber, 2);
});

test('robber blocks production and records it as blocked', () => {
  const board = boardWith(9, 'mountains', 5);
  const [a] = nonAdjacentCorners(9);
  const buildings = new Map([[a, { player: 'p1', kind: 'city' }]]);
  const out = computeProduction({ board, buildings, robberHex: 9, total: 5 });
  assert.deepEqual(out.byPlayer, {});
  assert.equal(out.blocked.p1.ore, 2);
});

test('bank shortage: nobody is paid when several are owed, a lone player gets the remainder', () => {
  const board = boardWith(9, 'fields', 6);
  const [a, c] = nonAdjacentCorners(9);
  const both = new Map([[a, { player: 'p1', kind: 'settlement' }], [c, { player: 'p2', kind: 'settlement' }]]);
  const short = computeProduction({
    board, buildings: both, robberHex: 0, total: 6, bankStock: { brick: 19, lumber: 19, wool: 19, grain: 1, ore: 19 },
  });
  assert.equal(short.byPlayer.p1?.grain, undefined);
  assert.equal(short.byPlayer.p2?.grain, undefined);
  assert.deepEqual(short.shortages, ['grain']);

  const lone = new Map([[a, { player: 'p1', kind: 'city' }]]);
  const partial = computeProduction({
    board, buildings: lone, robberHex: 0, total: 6, bankStock: { brick: 19, lumber: 19, wool: 19, grain: 1, ore: 19 },
  });
  assert.equal(partial.byPlayer.p1.grain, 1);
});

test('expected income weighs dice odds and buildings, and the robber removes it', () => {
  const board = emptyBoard();
  board[9] = { terrain: 'forest', number: 8 };
  const [a, c] = nonAdjacentCorners(9);
  const buildings = new Map([[a, { player: 'p1', kind: 'city' }], [c, { player: 'p2', kind: 'settlement' }]]);
  const near = (x, y) => assert.ok(Math.abs(x - y) < 1e-9, `${x} vs ${y}`);
  near(expectedPerRoll({ board, buildings, robberHex: 0 }, 'p1'), 10 / 36);
  near(expectedPerRoll({ board, buildings, robberHex: 0 }, 'p2'), 5 / 36);
  near(expectedPerRoll({ board, buildings, robberHex: 9 }, 'p1'), 0);
  near(expectedPerRoll({ board: null, buildings, robberHex: 0 }, 'p1'), 0);
});

test('replay produces resources from dice and the board state at that moment', () => {
  const board = boardWith(9, 'pasture', 9);
  const [a] = nonAdjacentCorners(9);
  const events = log(
    ['BoardConfigured', { hexes: board }],
    ['DiceRolled', { d1: 4, d2: 5 }], // before the settlement exists
    ['SettlementBuilt', { player: 'p1', vertex: a }],
    ['DiceRolled', { d1: 4, d2: 5 }],
  );
  const s = replay(events);
  assert.equal(s.rolls[0].production.byPlayer.p1, undefined);
  assert.equal(s.rolls[1].production.byPlayer.p1.wool, 1);
  assert.equal(playerSummaries(s)[0].produced.wool, 1);
});

test('correcting a past roll recalculates production and keeps the detected value', () => {
  const board = boardWith(9, 'pasture', 9);
  const [a] = nonAdjacentCorners(9);
  const events = log(
    ['BoardConfigured', { hexes: board }],
    ['SettlementBuilt', { player: 'p1', vertex: a }],
    ['DiceRolled', { d1: 2, d2: 2 }, { id: 'roll', origin: 'camera', confidence: 0.8 }],
    ['RollCorrected', { target: 'roll', d1: 4, d2: 5 }],
  );
  const s = replay(events);
  assert.equal(s.rolls[0].total, 9);
  assert.deepEqual(s.rolls[0].detected, { d1: 2, d2: 2 });
  assert.equal(playerSummaries(s)[0].produced.wool, 1);
});

test('void removes a roll, voiding the void restores it, turn order follows', () => {
  const base = log(
    ['DiceRolled', { d1: 1, d2: 1 }, { id: 'r1' }],
    ['DiceRolled', { d1: 2, d2: 2 }, { id: 'r2' }],
  );
  assert.equal(replay(base)[`rolls`][1].player, 'p2');
  const voided = [...base, makeEvent('EventVoided', { target: 'r1' }, { id: 'v1' })];
  const s = replay(voided);
  assert.equal(s.rolls.length, 1);
  assert.equal(s.rolls[0].total, 4);
  assert.equal(s.rolls[0].player, 'p1', 'turn inference shifts when a false roll is voided');
  const restored = [...voided, makeEvent('EventVoided', { target: 'v1' }, { id: 'v2' })];
  assert.equal(replay(restored).rolls.length, 2);
  assert.equal(lastUndoable(restored).id, 'r2');
});

test('undo of a settlement that a city depended on flags the city as rejected', () => {
  const [a] = nonAdjacentCorners(9);
  const events = log(
    ['SettlementBuilt', { player: 'p1', vertex: a }, { id: 's' }],
    ['CityBuilt', { player: 'p1', vertex: a }, { id: 'c' }],
    ['EventVoided', { target: 's' }, { id: 'v' }],
  );
  const s = replay(events);
  assert.equal(s.buildings.size, 0);
  assert.equal(s.rejected.length, 1);
  assert.equal(s.rejected[0].event.id, 'c');
});

test('placement rules: distance, ownership, connection, robber must move', () => {
  const v = TOPOLOGY.vertices[20];
  const events = log(
    ['SettlementBuilt', { player: 'p1', vertex: v.id }],
    ['SettlementBuilt', { player: 'p2', vertex: v.neighbors[0] }],
    ['CityBuilt', { player: 'p2', vertex: v.id }],
    ['RoadBuilt', { player: 'p2', edge: v.edges[0] }],
    ['RobberMoved', { hex: 3 }],
    ['RobberMoved', { hex: 3 }],
  );
  const s = replay(events);
  const reasons = s.rejected.map((r) => r.reason);
  assert.equal(reasons.length, 4);
  assert.match(reasons[0], /distance/);
  assert.match(reasons[1], /own settlement/);
  assert.match(reasons[2], /connect/);
  assert.match(reasons[3], /different hex/);
});

test('a 7 asks for a robber move and the move clears the request', () => {
  const s1 = replay(log(['DiceRolled', { d1: 3, d2: 4 }]));
  assert.equal(s1.needsRobberMove, true);
  const s2 = replay(log(['DiceRolled', { d1: 3, d2: 4 }], ['RobberMoved', { hex: 2 }]));
  assert.equal(s2.needsRobberMove, false);
});

function roadPath(length) {
  // Walk the outer ring so the path is a simple chain.
  const path = [];
  let vertex = TOPOLOGY.vertices.find((v) => v.hexes.length === 1).id;
  const used = new Set();
  while (path.length < length) {
    const next = TOPOLOGY.vertices[vertex].edges.find((e) => !used.has(e));
    used.add(next);
    path.push(next);
    const { a, b } = TOPOLOGY.edges[next];
    vertex = a === vertex ? b : a;
  }
  return path;
}

test('longest road: 5 awards it, an opposing settlement breaks the chain', () => {
  const edges = roadPath(5);
  const start = TOPOLOGY.edges[edges[0]];
  const startVertex = TOPOLOGY.vertices[start.a].edges.includes(edges[1]) ? start.b : start.a;
  const events = log(
    ['SettlementBuilt', { player: 'p1', vertex: startVertex }],
    ...edges.map((e) => ['RoadBuilt', { player: 'p1', edge: e }]),
  );
  const s = replay(events);
  assert.deepEqual(s.rejected, []);
  assert.equal(longestRoad(s, 'p1'), 5);
  assert.equal(s.longestRoadHolder, 'p1');
  assert.equal(playerSummaries(s)[0].visibleVP, 3);

  const shared = TOPOLOGY.edges[edges[2]];
  const middle = [shared.a, shared.b].find((v) => TOPOLOGY.edges[edges[3]].a === v || TOPOLOGY.edges[edges[3]].b === v);
  s.buildings.set(middle, { player: 'p2', kind: 'settlement' });
  assert.equal(longestRoad(s, 'p1'), 3);
});

test('award holder: ties keep the incumbent, unresolved ties award nobody', () => {
  assert.equal(awardHolder({ a: 5, b: 5 }, 'a', 5), 'a');
  assert.equal(awardHolder({ a: 6, b: 5 }, 'b', 5), 'a');
  assert.equal(awardHolder({ a: 4, b: 3 }, null, 5), null);
  assert.equal(awardHolder({ a: 3, b: 6, c: 6 }, 'a', 5), null);
});

test('largest army goes to the first player with 3 knights and counts 2 VP', () => {
  const knight = ['DevelopmentCardPlayed', { player: 'p2', card: 'knight' }];
  const s = replay(log(knight, knight, knight));
  assert.equal(s.largestArmyHolder, 'p2');
  assert.equal(playerSummaries(s)[1].visibleVP, 2);
});

test('dice stats: frequency, gaps, chi-squared gating', () => {
  const rolls = [[3, 4], [1, 1], [3, 4], [6, 6], [2, 2]].map(([d1, d2]) => ({ d1, d2, total: d1 + d2 }));
  const s = diceStats(rolls);
  assert.equal(s.count, 5);
  assert.equal(s.sevens, 2);
  assert.equal(s.sevenRate, 0.4);
  assert.equal(s.doubles, 3);
  const seven = s.rows.find((r) => r.total === 7);
  assert.equal(seven.longestGap, 2, 'open gap after the last 7 counts');
  assert.equal(seven.currentGap, 2);
  assert.ok(Math.abs(seven.deviation - (2 - 5 / 6)) < 1e-9);
  assert.equal(s.chiSquaredUsable, false);
  assert.equal(s.faces.reduce((a, b) => a + b), 10);
});

test('empirical stats converge on theory for fair simulated dice', () => {
  const rng = makeRng(11);
  const rolls = Array.from({ length: 20000 }, () => {
    const d1 = 1 + Math.floor(rng() * 6);
    const d2 = 1 + Math.floor(rng() * 6);
    return { d1, d2, total: d1 + d2 };
  });
  const s = diceStats(rolls);
  assert.ok(Math.abs(s.sevenRate - 1 / 6) < 0.012);
  assert.ok(s.deviationSeries.at(-1) < 0.03);
  assert.ok(s.chiSquaredUsable);
});

test('CSV quotes commas and neutralises spreadsheet formulas in names', () => {
  const players = [{ id: 'p1', name: '=SUM(A1), hi', color: 'red' }];
  const s = replay([
    makeEvent('GameStarted', { gameId: 'g', name: 'A "game"', players }, { id: 's' }),
    makeEvent('DiceRolled', { d1: 1, d2: 2 }, { id: 'r', origin: 'camera', confidence: 0.91 }),
  ]);
  const csv = rollsToCsv(s);
  assert.match(csv, /"A ""game"""/);
  assert.match(csv, /"'=SUM\(A1\), hi"/);
  assert.match(csv, /,camera,0\.910,false,/);
  assert.equal(csv.split('\r\n').length, 2);
});

test('recognition stats separate camera from simulated rolls and count overrides', () => {
  const s = replay(log(
    ['DiceRolled', { d1: 1, d2: 2 }, { id: 'a', origin: 'camera' }],
    ['DiceRolled', { d1: 1, d2: 3 }, { id: 'b', origin: 'camera' }],
    ['DiceRolled', { d1: 1, d2: 4 }, { id: 'c', origin: 'camera' }],
    ['DiceRolled', { d1: 1, d2: 5 }, { id: 'd', origin: 'simulated' }],
    ['RollCorrected', { target: 'b', d1: 2, d2: 3 }],
    ['EventVoided', { target: 'c' }],
  ));
  assert.deepEqual(recognitionStats(s.timeline, s.rolls).camera, { kept: 1, corrected: 1, voided: 1 });
  assert.equal(recognitionStats(s.timeline, s.rolls).simulated.kept, 1);
  assert.equal(playerRollStats(s.rolls, PLAYERS)[0].rolls, 1);
});

test('store persists events and survives a storage failure', () => {
  const storage = memoryStorage();
  const store = createStore(storage);
  store.createGame('g1', 'One');
  store.append('g1', { id: 'a' });
  assert.deepEqual(createStore(storage).events('g1'), [{ id: 'a' }]);
  assert.equal(createStore(storage).listGames()[0].name, 'One');

  const broken = createStore({
    getItem: () => null,
    setItem: () => { throw new Error('quota'); },
  });
  broken.createGame('g2', 'Two');
  assert.equal(broken.append('g2', { id: 'b' }).length, 1);
  assert.equal(broken.isPersistent(), false);
});
