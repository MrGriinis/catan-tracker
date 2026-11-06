// Turns a stream of per-frame measurements into discrete throws:
//   WAITING -> MOVEMENT -> SETTLING -> CONFIRMED -> WAITING
// It has no pixel or DOM access, so every timing scenario can be unit-tested.

export const DEFAULT_ROLL_OPTIONS = {
  motionThreshold: 0.002, // fraction of pixels that changed
  movementFrames: 2, // consecutive moving frames before it counts as a throw
  quietFrames: 3, // consecutive still frames before reading starts
  stableFrames: 6, // matching readings needed to confirm, among the most recent frames
  spareFrames: 6, // how many extra recent frames may be unreadable without starting over
  maxDisagreeing: 1, // recent readings of a different value tolerated when confirming
  settleTimeoutFrames: 45, // give up and ask a human after this many still frames
  warmupFrames: 15, // camera auto-exposure settling; also captures dice already on the table
  samePoseTolerance: 0.5, // in die sides
};

function samePose(a, b, tolerance) {
  if (!a || !b || a.length !== b.length) return false;
  const close = (p, q) => Math.hypot(p.cx - q.cx, p.cy - q.cy) <= tolerance * ((p.side + q.side) / 2);
  return (close(a[0], b[0]) && close(a[1], b[1])) || (close(a[0], b[1]) && close(a[1], b[0]));
}

const valueKey = (values) => [...values].sort((x, y) => x - y).join();

export function createRollDetector(options = {}) {
  const cfg = { ...DEFAULT_ROLL_OPTIONS, ...options };
  let state = 'WAITING';
  let frame = 0;
  let moving = 0;
  let quiet = 0;
  let settle = 0;
  let recent = [];
  // Where the dice were at the last accepted rest. Motion that leaves them in the same
  // place with the same faces was a hand or a shadow passing, not a throw.
  let restPose = null;
  let restKey = null;

  const resetConsensus = () => {
    recent = [];
    settle = 0;
    moving = 0;
  };

  function update({ motion, reading }) {
    frame++;
    const isMoving = motion > cfg.motionThreshold;

    if (frame <= cfg.warmupFrames) {
      if (!isMoving && reading?.status === 'ok') {
        restPose = reading.dice;
        restKey = valueKey(reading.values);
      }
      return { state, event: null };
    }

    switch (state) {
      case 'CONFIRMED':
        state = 'WAITING';
        moving = isMoving ? 1 : 0;
        break;
      case 'WAITING':
        moving = isMoving ? moving + 1 : 0;
        if (moving >= cfg.movementFrames) {
          state = 'MOVEMENT';
          quiet = 0;
        }
        break;
      case 'MOVEMENT':
        quiet = isMoving ? 0 : quiet + 1;
        if (quiet >= cfg.quietFrames) {
          state = 'SETTLING';
          resetConsensus();
        }
        break;
      case 'SETTLING': {
        if (isMoving) {
          // One noisy frame (a focus or exposure change) is not the dice moving again.
          moving++;
          if (moving >= cfg.movementFrames) {
            state = 'MOVEMENT';
            quiet = 0;
          }
          break;
        }
        moving = 0;
        settle++;
        recent.push(reading?.status === 'ok' ? reading : null);
        if (recent.length > cfg.stableFrames + cfg.spareFrames) recent.shift();

        if (reading?.status === 'ok') {
          const key = valueKey(reading.values);
          const readings = recent.filter(Boolean);
          const agreeing = readings.filter(
            (r) => valueKey(r.values) === key && samePose(r.dice, reading.dice, 0.25),
          );
          // Frames the camera couldn't read don't count against a throw, because real video
          // drops in and out. A different value does: the dice would not really have settled.
          const disagreeing = readings.length - agreeing.length;

          if (agreeing.length >= cfg.stableFrames && disagreeing <= cfg.maxDisagreeing) {
            const confidence = Math.min(...agreeing.map((r) => r.confidence));
            const unchanged = key === restKey && samePose(reading.dice, restPose, cfg.samePoseTolerance);
            restPose = reading.dice;
            restKey = key;
            if (unchanged) {
              state = 'WAITING';
              moving = 0;
              return { state, event: { type: 'ignored', reason: 'dice did not move' } };
            }
            state = 'CONFIRMED';
            return {
              state,
              event: {
                type: 'roll',
                d1: reading.values[0],
                d2: reading.values[1],
                confidence,
                frames: agreeing.length,
              },
            };
          }
        }
        if (settle >= cfg.settleTimeoutFrames) {
          state = 'WAITING';
          moving = 0;
          restPose = null;
          restKey = null;
          // Empty table: someone picked the dice up. Nothing is wrong, so stay silent.
          if (reading?.status === 'no-dice' || reading?.status === 'low-contrast') {
            return { state, event: null };
          }
          return {
            state,
            event: { type: 'uncertain', reason: reading?.status ?? 'unreadable' },
          };
        }
        break;
      }
      default:
        break;
    }
    return { state, event: null };
  }

  return {
    update,
    get state() { return state; },
    configure(next) { Object.assign(cfg, next); },
    get options() { return { ...cfg }; },
  };
}
