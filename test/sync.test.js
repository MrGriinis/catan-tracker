import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEvent, replay } from '../src/game/engine.js';
import { randomBoard } from '../src/game/board.js';
import { validEvents } from '../src/game/validate.js';
import {
  buildLiveDoc, codeFromHash, createLatestOnly, makeCode, readLiveDoc,
} from '../src/sync/liveGame.js';

const players = [{ id: 'p1', name: 'Red', color: 'red' }, { id: 'p2', name: 'Blue', color: 'blue' }];
const realLog = () => [
  makeEvent('GameStarted', { gameId: 'g', name: 'Test', players }),
  makeEvent('BoardConfigured', { hexes: randomBoard(), resetRobber: true }),
  makeEvent('SettlementBuilt', { player: 'p1', vertex: 20 }),
  makeEvent('CityBuilt', { player: 'p1', vertex: 20 }),
  makeEvent('RoadBuilt', { player: 'p1', edge: 3 }),
  makeEvent('DiceRolled', { d1: 3, d2: 4 }, { id: 'r1', origin: 'camera', confidence: 0.9 }),
  makeEvent('RollCorrected', { target: 'r1', d1: 3, d2: 5 }),
  makeEvent('RobberMoved', { hex: 2 }),
  makeEvent('DevelopmentCardPlayed', { player: 'p2', card: 'knight' }),
  makeEvent('EventVoided', { target: 'r1' }),
];

test('a real event log passes validation', () => {
  assert.equal(validEvents(realLog()), true);
});

test('validation rejects anything a view could print as markup', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const event = (type, fields) => [{
    id: 'e', ts: 't', origin: 'manual', type, ...fields,
  }];
  const attacks = [
    event('DiceRolled', { d1: payload, d2: 1 }),
    event('DiceRolled', { d1: 7, d2: 1 }),
    event('DiceRolled', { d1: 1.5, d2: 1 }),
    event('RollCorrected', { d1: 1, d2: payload, target: 'r' }),
    event('BoardConfigured', { hexes: Array(19).fill({ terrain: 'forest', number: payload }) }),
    event('BoardConfigured', { hexes: Array(19).fill({ terrain: payload, number: 5 }) }),
    event('BoardConfigured', { hexes: Array(3).fill({ terrain: 'forest', number: 5 }) }),
    event('SettlementBuilt', { player: 'p1', vertex: payload }),
    event('SettlementBuilt', { player: 'p1', vertex: 54 }),
    event('RoadBuilt', { player: 'p1', edge: -1 }),
    event('RobberMoved', { hex: payload }),
    event('GameStarted', { name: 'x', players: payload }),
    event('Unknown', {}),
    event('constructor', {}),
    [{ id: 'e', ts: 't', origin: 'manual', type: 'DiceRolled', d1: 1, d2: 1, confidence: payload }],
    [{ ts: 't', origin: 'manual', type: 'DiceRolled', d1: 1, d2: 1 }],
    [null],
    'not a list',
  ];
  for (const attack of attacks) assert.equal(validEvents(attack), false, JSON.stringify(attack));
});

test('a shared log survives the trip and replays identically', () => {
  const events = realLog();
  const doc = buildLiveDoc({ uid: 'u1', name: 'Test', events });
  assert.deepEqual(Object.keys(doc).sort(), ['eventsJson', 'name', 'ownerUid'], 'must match firestore.rules');
  const received = readLiveDoc(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(received, events);
  assert.equal(replay(received).buildings.size, replay(events).buildings.size);
});

test('a damaged or forged document is refused', () => {
  assert.equal(readLiveDoc(null), null);
  assert.equal(readLiveDoc({}), null);
  assert.equal(readLiveDoc({ eventsJson: 'not json' }), null);
  assert.equal(readLiveDoc({ eventsJson: '[{"id":"e","type":"DiceRolled","d1":"<b>"}]' }), null);
});

test('codes are long, URL-safe, unique, and read back from the link', () => {
  const codes = new Set(Array.from({ length: 200 }, () => makeCode()));
  assert.equal(codes.size, 200);
  for (const code of codes) {
    assert.match(code, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(codeFromHash(`#${code}`), code);
  }
});

test('a link with no valid code is ignored', () => {
  for (const hash of ['', '#', '#short', '#players', '#has spaces in it and is long enough', `#${'a'.repeat(65)}`]) {
    assert.equal(codeFromHash(hash), null, hash);
  }
});

function deferredSender() {
  const sent = [];
  const waiting = [];
  return {
    sent,
    send: (value) => {
      sent.push(value);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    settle: () => waiting.shift().resolve(),
    fail: (error) => waiting.shift().reject(error),
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('publisher skips superseded versions and never overlaps', async () => {
  const s = deferredSender();
  const publisher = createLatestOnly(s.send);
  publisher.push(1);
  publisher.push(2);
  publisher.push(3);
  await tick();
  assert.deepEqual(s.sent, [1], 'the second send waits for the first');
  s.settle();
  await tick();
  assert.deepEqual(s.sent, [1, 3], 'version 2 was already out of date');
  s.settle();
  await tick();
  publisher.push(4);
  await tick();
  assert.deepEqual(s.sent, [1, 3, 4], 'it restarts after going idle');
  s.settle();
});

test('a failed send is reported and does not stop later sends', async () => {
  const s = deferredSender();
  const errors = [];
  const publisher = createLatestOnly(s.send, (e) => errors.push(e.message));
  publisher.push(1);
  publisher.push(2);
  await tick();
  s.fail(new Error('offline'));
  await tick();
  assert.deepEqual(errors, ['offline']);
  assert.deepEqual(s.sent, [1, 2]);
  s.settle();
});

test('stopping drops unsent data, so a stopped game cannot reappear online', async () => {
  const s = deferredSender();
  const publisher = createLatestOnly(s.send);
  publisher.push(1);
  publisher.push(2);
  await tick();
  let stopped = false;
  publisher.cancel().then(() => { stopped = true; });
  await tick();
  assert.equal(stopped, false, 'it waits for the request in progress');
  s.settle();
  await tick();
  assert.equal(stopped, true);
  assert.deepEqual(s.sent, [1], 'version 2 was never sent');
});
