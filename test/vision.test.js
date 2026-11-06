// All frames here are synthetic. These tests prove the pipeline's logic and its failure
// handling, not its accuracy on real dice. Real-footage validation is described in the README.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDice } from '../src/vision/dice.js';
import { createMotionMeter } from '../src/vision/motion.js';
import { createRollDetector } from '../src/vision/rollDetector.js';
import { makeRng, placeDice, renderScene } from '../src/vision/synth.js';

const W = 640;
const H = 480;

function accuracy({ trials = 72, side = 70, seed = 5, ...scene }) {
  const rng = makeRng(seed);
  let right = 0;
  let wrong = 0;
  let rejected = 0;
  const statuses = {};
  for (let i = 0; i < trials; i++) {
    const a = (i % 6) + 1;
    const b = (Math.floor(i / 6) % 6) + 1;
    const dice = placeDice(W, H, side, rng, [a, b]);
    const frame = renderScene({ width: W, height: H, dice, ...scene }, rng);
    const result = detectDice(frame);
    statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    const truth = [...dice].sort((x, y) => x.cx - y.cx).map((d) => d.value);
    if (result.status !== 'ok') rejected++;
    else if (result.values.join() === truth.join()) right++;
    else wrong++;
  }
  return { right, wrong, rejected, statuses };
}

test('reads every value pair at any rotation in clean conditions', () => {
  const r = accuracy({});
  assert.equal(r.wrong, 0, JSON.stringify(r));
  assert.equal(r.right, 72, JSON.stringify(r));
});

test('small dice in a wide view', () => {
  const r = accuracy({ side: 36 });
  assert.equal(r.wrong, 0, JSON.stringify(r));
  assert.ok(r.right >= 68, JSON.stringify(r));
});

test('heavy sensor noise', () => {
  const r = accuracy({ noise: 18 });
  assert.equal(r.wrong, 0, JSON.stringify(r));
  assert.ok(r.right >= 68, JSON.stringify(r));
});

test('uneven lighting across the table', () => {
  const r = accuracy({ gradient: 50 });
  assert.equal(r.wrong, 0, JSON.stringify(r));
  assert.ok(r.right >= 68, JSON.stringify(r));
});

test('dim scene with reduced contrast', () => {
  const r = accuracy({ table: 25, faceLevel: 140, pipLevel: 30 });
  assert.equal(r.wrong, 0, JSON.stringify(r));
  assert.ok(r.right >= 68, JSON.stringify(r));
});

test('dice lying flush against each other are still separated', () => {
  const side = 70;
  const dice = [
    { cx: 280, cy: 240, side, angle: 0.3, value: 5 },
    { cx: 280 + side * Math.cos(0.3), cy: 240 + side * Math.sin(0.3), side, angle: 0.3, value: 2 },
  ];
  const result = detectDice(renderScene({ width: W, height: H, dice }));
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.values, [5, 2]);
});

test('dice touching corner to edge are still separated', () => {
  const side = 70;
  const dice = [
    { cx: 260, cy: 240, side, angle: 0, value: 6 },
    { cx: 260 + side * 1.2, cy: 262, side, angle: 0.6, value: 3 },
  ];
  const result = detectDice(renderScene({ width: W, height: H, dice }));
  assert.equal(result.status, 'ok', JSON.stringify(result.status));
  assert.deepEqual(result.values, [6, 3]);
});

test('fails closed: empty table, one die, three dice, flat table', () => {
  const noDice = detectDice(renderScene({ width: W, height: H, dice: [] }));
  assert.notEqual(noDice.status, 'ok');

  const one = detectDice(renderScene({
    width: W, height: H, dice: [{ cx: 300, cy: 200, side: 70, angle: 0.4, value: 4 }],
  }));
  assert.equal(one.status, 'one-die');

  const three = detectDice(renderScene({
    width: W,
    height: H,
    dice: [
      { cx: 100, cy: 100, side: 70, angle: 0, value: 4 },
      { cx: 300, cy: 200, side: 70, angle: 0, value: 4 },
      { cx: 500, cy: 300, side: 70, angle: 0, value: 4 },
    ],
  }));
  assert.equal(three.status, 'too-many');
});

test('fails closed: a blank white block never gets a value', () => {
  const result = detectDice(renderScene({
    width: W,
    height: H,
    dice: [
      { cx: 200, cy: 200, side: 70, angle: 0, value: 0 },
      { cx: 400, cy: 200, side: 70, angle: 0, value: 3 },
    ],
  }));
  assert.equal(result.status, 'unreadable');
});

test('fails closed: a die half covered by a hand is not read as a value', () => {
  const result = detectDice(renderScene({
    width: W,
    height: H,
    dice: [
      { cx: 200, cy: 200, side: 70, angle: 0, value: 6 },
      { cx: 400, cy: 240, side: 70, angle: 0, value: 6 },
    ],
    blobs: [{ cx: 450, cy: 240, r: 60, level: 40 }],
  }));
  assert.notEqual(result.status, 'ok');
});

function boxBlur(frame, r) {
  const { width: w, height: h, data } = frame;
  const copy = Uint8ClampedArray.from(data);
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += copy[(y * w + x + k) * 4] + copy[((y + k) * w + x) * 4];
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = sum / (4 * r + 2);
    }
  }
  return frame;
}

/** An off-axis camera sees part of each die's side face along one edge. */
function addSideWalls(frame, dice, fraction) {
  const { width: w, data } = frame;
  for (const d of dice) {
    const c = Math.cos(d.angle);
    const s = Math.sin(d.angle);
    for (let u = -d.side / 2; u <= d.side / 2; u += 0.5) {
      for (let t = 0; t < d.side * fraction; t += 0.5) {
        const v = d.side / 2 + t;
        const i = (Math.round(d.cy + u * s + v * c) * w + Math.round(d.cx + u * c - v * s)) * 4;
        if (i >= 0 && i < data.length) data[i] = data[i + 1] = data[i + 2] = 170;
      }
    }
  }
  return frame;
}

function degraded(degrade, side = 64) {
  const rng = makeRng(13);
  const out = { right: 0, wrong: 0, rejected: 0 };
  for (let i = 0; i < 36; i++) {
    const dice = placeDice(W, H, side, rng, [(i % 6) + 1, (Math.floor(i / 6) % 6) + 1]);
    const result = detectDice(degrade(renderScene({ width: W, height: H, dice }, rng), dice));
    const truth = [...dice].sort((a, b) => a.cx - b.cx).map((d) => d.value).join();
    if (result.status !== 'ok') out.rejected++;
    else if (result.values.join() === truth) out.right++;
    else out.wrong++;
  }
  return out;
}

test('focus blur on small dice still reads correctly', () => {
  const r = degraded((f) => boxBlur(f, 1), 28);
  assert.equal(r.wrong, 0, JSON.stringify(r));
  assert.ok(r.right >= 33, JSON.stringify(r));
});

test('slightly off-axis camera still reads correctly', () => {
  const r = degraded((f, dice) => addSideWalls(f, dice, 0.15));
  assert.equal(r.wrong, 0, JSON.stringify(r));
  assert.ok(r.right >= 33, JSON.stringify(r));
});

test('fails closed: strongly off-axis camera never records a wrong value', () => {
  const r = degraded((f, dice) => addSideWalls(f, dice, 0.3));
  assert.equal(r.wrong, 0, JSON.stringify(r));
});

test('tilted camera: side faces, even with their own dots, do not change the count', () => {
  const addSideDots = (frame, dice) => {
    addSideWalls(frame, dice, 0.4);
    const { width: w, data } = frame;
    for (const d of dice) {
      const c = Math.cos(d.angle);
      const s = Math.sin(d.angle);
      const v = d.side * 0.7;
      for (let u = -5; u <= 5; u += 0.5) {
        for (let t = -3; t <= 3; t += 0.5) {
          const i = (Math.round(d.cy + u * s + (v + t) * c) * w + Math.round(d.cx + u * c - (v + t) * s)) * 4;
          if (i >= 0 && i < data.length) data[i] = data[i + 1] = data[i + 2] = 30;
        }
      }
    }
    return frame;
  };
  const r = degraded(addSideDots);
  assert.equal(r.wrong, 0, JSON.stringify(r));
  assert.ok(r.right >= 33, JSON.stringify(r));
});

test('a rejected die explains why, for the on-screen diagnostics', () => {
  const result = detectDice(renderScene({
    width: W,
    height: H,
    dice: [
      { cx: 200, cy: 200, side: 70, angle: 0, value: 0 },
      { cx: 400, cy: 200, side: 70, angle: 0, value: 3 },
    ],
  }));
  assert.equal(result.status, 'unreadable');
  assert.match(result.dice[0].reason, /no dark dots/);
  assert.equal(result.dice[1].value, 3);
  assert.equal(result.dice[0].view.patch.length, 48 * 48);
});

test('fails closed: dice on a pale table are rejected as low contrast', () => {
  const dice = [
    { cx: 200, cy: 200, side: 70, angle: 0, value: 3 },
    { cx: 400, cy: 200, side: 70, angle: 0, value: 4 },
  ];
  assert.equal(detectDice(renderScene({ width: W, height: H, dice, table: 215 })).status, 'low-contrast');
});

test('motion meter ignores noise but sees a die move', () => {
  const meter = createMotionMeter();
  const rng = makeRng(2);
  const dice = [{ cx: 200, cy: 200, side: 50, angle: 0, value: 3 }];
  meter.update(renderScene({ width: W, height: H, dice, noise: 6 }, rng));
  const still = meter.update(renderScene({ width: W, height: H, dice, noise: 6 }, rng));
  assert.equal(still, 0);
  const moved = [{ ...dice[0], cx: 300 }];
  assert.ok(meter.update(renderScene({ width: W, height: H, dice: moved, noise: 6 }, rng)) > 0.002);
});

// Scripted streams for the state machine.
const ok = (a, b, x = 100) => ({
  status: 'ok',
  values: [a, b],
  confidence: 0.9,
  dice: [{ cx: x, cy: 100, side: 50 }, { cx: x + 200, cy: 100, side: 50 }],
});
const still = (reading, n) => Array(n).fill({ motion: 0, reading });
const moving = (n) => Array(n).fill({ motion: 0.05, reading: { status: 'no-dice', dice: [] } });

function run(frames, options = {}) {
  const detector = createRollDetector({ warmupFrames: 0, ...options });
  const states = [];
  const events = [];
  for (const frame of frames) {
    const { state, event } = detector.update(frame);
    states.push(state);
    if (event) events.push(event);
  }
  return { states, events };
}
const rolls = (events) => events.filter((e) => e.type === 'roll');

test('a throw is recorded exactly once, however long the dice rest', () => {
  const { events, states } = run([...moving(10), ...still(ok(3, 4), 300)]);
  assert.equal(rolls(events).length, 1);
  assert.deepEqual([rolls(events)[0].d1, rolls(events)[0].d2], [3, 4]);
  for (const s of ['MOVEMENT', 'SETTLING', 'CONFIRMED', 'WAITING']) assert.ok(states.includes(s), s);
});

test('identical result after a real new throw counts as a second roll', () => {
  const { events } = run([
    ...moving(10), ...still(ok(4, 4, 100), 30),
    ...moving(10), ...still(ok(4, 4, 400), 30),
  ]);
  assert.equal(rolls(events).length, 2);
});

test('a hand passing over resting dice is not a new roll', () => {
  const { events } = run([
    ...moving(10), ...still(ok(4, 4, 100), 30),
    ...moving(8), ...still(ok(4, 4, 102), 30),
  ]);
  assert.equal(rolls(events).length, 1);
  assert.equal(events.filter((e) => e.type === 'ignored').length, 1);
});

test('a single-frame flicker does not start a throw', () => {
  const { events, states } = run([...still(ok(1, 2), 5), { motion: 0.5, reading: null }, ...still(ok(1, 2), 40)]);
  assert.equal(events.length, 0);
  assert.ok(!states.includes('MOVEMENT'));
});

test('dice already on the table at startup are not recorded', () => {
  const detector = createRollDetector({ warmupFrames: 15 });
  const events = [];
  for (const frame of [...still(ok(6, 1), 40), ...moving(4), ...still(ok(6, 1), 40)]) {
    const { event } = detector.update(frame);
    if (event?.type === 'roll') events.push(event);
  }
  assert.equal(events.length, 0, 'same faces in the same place, so nothing was thrown');
});

test('an unstable reading does not confirm, a persistent failure asks for help', () => {
  const flicker = [];
  for (let i = 0; i < 60; i++) flicker.push({ motion: 0, reading: ok(i % 2 ? 2 : 3, 4) });
  const { events } = run([...moving(5), ...flicker]);
  assert.equal(rolls(events).length, 0);
  assert.equal(events.filter((e) => e.type === 'uncertain').length, 1);
});

test('one flickering frame only delays confirmation, it does not corrupt the value', () => {
  const frames = [...moving(5), ...still(ok(5, 5), 3), { motion: 0, reading: { status: 'unreadable', dice: [] } }, ...still(ok(5, 5), 10)];
  const out = rolls(run(frames).events);
  assert.equal(out.length, 1);
  assert.equal(out[0].d1 + out[0].d2, 10);
});

test('real video: a reading that keeps dropping out is still confirmed', () => {
  const unreadable = { motion: 0, reading: { status: 'unreadable', dice: [] } };
  const frames = [...moving(5)];
  for (let i = 0; i < 12; i++) frames.push({ motion: 0, reading: ok(2, 5) }, unreadable);
  const out = rolls(run(frames).events);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].d1, out[0].d2], [2, 5]);
});

test('real video: one noisy frame while settling does not restart the throw', () => {
  // The first three still frames only move it from MOVEMENT to SETTLING.
  const frames = [...moving(5), ...still(ok(4, 6), 6), { motion: 0.05, reading: null }, ...still(ok(4, 6), 3)];
  const { events, states } = run(frames);
  assert.equal(rolls(events).length, 1);
  assert.equal(states[11], 'SETTLING', 'the blip must not send it back to MOVEMENT');
});

test('real video: small jitter in position does not restart the count', () => {
  const frames = [...moving(5)];
  for (let i = 0; i < 12; i++) frames.push({ motion: 0, reading: ok(3, 3, 100 + (i % 2) * 6) });
  assert.equal(rolls(run(frames).events).length, 1);
});

test('safety: a value that flips back and forth is never recorded', () => {
  const frames = [...moving(5)];
  for (let i = 0; i < 60; i++) frames.push({ motion: 0, reading: ok(i % 3 ? 2 : 3, 4) });
  assert.equal(rolls(run(frames).events).length, 0);
});

test('safety: a persistent minority reading blocks confirmation until it clears', () => {
  // Six readings agree, but three recent ones say something else, so this must wait.
  const undecided = [...moving(5), ...still(ok(1, 1), 8), ...still(ok(2, 2), 3), ...still(ok(1, 1), 1)];
  assert.equal(rolls(run(undecided).events).length, 0);
  // Once the conflicting readings have aged out, the throw is confirmed.
  const out = rolls(run([...undecided, ...still(ok(1, 1), 12)]).events);
  assert.equal(out.length, 1);
  assert.equal(out[0].d1, 1);
});

test('picking the dice up off the table raises no alarm', () => {
  const { events } = run([
    ...moving(5), ...still(ok(1, 3), 20),
    ...moving(5), ...still({ status: 'no-dice', dice: [] }, 60),
  ]);
  assert.equal(events.filter((e) => e.type === 'uncertain').length, 0);
  assert.equal(rolls(events).length, 1);
});

test('dice still rolling reset the confirmation count', () => {
  const frames = [...moving(5), ...still(ok(2, 2), 4), ...moving(3), ...still(ok(6, 5, 300), 20)];
  const out = rolls(run(frames).events);
  assert.equal(out.length, 1);
  assert.equal(out[0].d1, 6);
});

test('end to end: rendered frames through motion, dice reader and state machine', () => {
  const rng = makeRng(9);
  const meter = createMotionMeter();
  const detector = createRollDetector({ warmupFrames: 3 });
  const truth = [];
  const seen = [];
  const push = (scene) => {
    const frame = renderScene({ width: W, height: H, noise: 4, ...scene }, rng);
    const motion = meter.update(frame);
    const { event } = detector.update({ motion, reading: motion < 0.002 ? detectDice(frame) : null });
    if (event?.type === 'roll') seen.push([event.d1, event.d2]);
  };
  for (let i = 0; i < 5; i++) push({ dice: [] });

  const throws = [[3, 4], [6, 6], [6, 6], [1, 2], [5, 2], [4, 4]];
  for (const values of throws) {
    const rest = placeDice(W, H, 60, rng, values);
    for (let f = 0; f < 8; f++) {
      push({
        dice: placeDice(W, H, 60, rng, [1 + (f % 6), 1 + ((f + 2) % 6)]),
      });
    }
    for (let f = 0; f < 15; f++) push({ dice: rest });
    truth.push([...rest].sort((a, b) => a.cx - b.cx).map((d) => d.value));
  }
  assert.deepEqual(seen, truth);
});
