// Turns a stream of per-frame measurements into discrete throws:
//   WAITING -> MOVEMENT -> SETTLING -> CONFIRMED -> WAITING
// It has no pixel or DOM access, so every timing scenario can be unit-tested.

export const DEFAULT_ROLL_OPTIONS = {
  motionThreshold: 0.002, // fraction of pixels that changed
  movementFrames: 2, // consecutive moving frames before it counts as a throw
  quietFrames: 3, // consecutive still frames before reading starts
  stableFrames: 6, // consecutive identical readings needed to confirm
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
  let streak = 0;
  let streakKey = null;
  let streakPose = null;
  let streakConfidence = 1;
  // Where the dice were at the last accepted rest. Motion that leaves them in the same
  // place with the same faces was a hand or a shadow passing, not a throw.
  let restPose = null;
  let restKey = null;

  const resetConsensus = () => {
    streak = 0;
    streakKey = null;
    streakPose = null;
    streakConfidence = 1;
    settle = 0;
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
          state = 'MOVEMENT';
          quiet = 0;
          break;
        }
        settle++;
        if (reading?.status === 'ok') {
          const key = valueKey(reading.values);
          const steady = key === streakKey && samePose(reading.dice, streakPose, 0.25);
          if (steady) {
            streak++;
            streakConfidence = Math.min(streakConfidence, reading.confidence);
          } else {
            streak = 1;
            streakConfidence = reading.confidence;
          }
          streakKey = key;
          streakPose = reading.dice;

          if (streak >= cfg.stableFrames) {
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
                confidence: streakConfidence,
                frames: streak,
              },
            };
          }
        } else {
          streak = 0;
          streakKey = null;
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
