// The Firebase-independent part of sharing a game, so it can be tested without a network.
import { validEvents } from '../game/validate.js';

const CODE_BYTES = 16;
const CODE_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

/** A random code that is impractical to guess. It is the only key to a shared game. */
export function makeCode(random = (bytes) => crypto.getRandomValues(bytes)) {
  const bytes = random(new Uint8Array(CODE_BYTES));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The code travels after the # so it is never sent to the web host. */
export function codeFromHash(hash) {
  const code = hash.replace(/^#/, '');
  return CODE_PATTERN.test(code) ? code : null;
}

/** The log is stored as text, because Firestore cannot store every shape of nested data. */
export function buildLiveDoc({ uid, name, events }) {
  return {
    ownerUid: uid,
    name: String(name ?? 'Game').slice(0, 200),
    eventsJson: JSON.stringify(events),
  };
}

/** Returns the events in a received document, or null when it can't be trusted. */
export function readLiveDoc(doc) {
  if (typeof doc?.eventsJson !== 'string') return null;
  try {
    const events = JSON.parse(doc.eventsJson);
    return validEvents(events) ? events : null;
  } catch {
    return null;
  }
}

/**
 * Sends only the newest value and never overlaps requests. Each send holds the whole event
 * log, so anything superseded while a request is in flight has no reason to be sent.
 */
export function createLatestOnly(send, onError = () => {}) {
  let pending = null;
  let running = null;

  async function run() {
    while (pending) {
      const value = pending;
      pending = null;
      try {
        await send(value);
      } catch (error) {
        onError(error);
      }
    }
    running = null;
  }

  return {
    push(value) {
      pending = value;
      running ??= run();
    },
    /** Drops anything unsent and resolves when the current request has finished. */
    async cancel() {
      pending = null;
      await running;
    },
  };
}
