// Append-only event persistence. Storage is injected so tests can run without a browser.
const INDEX_KEY = 'catan.games';
const gameKey = (id) => `catan.game.${id}`;

export function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
  };
}

export function createStore(storage) {
  // If the browser refuses storage, the game keeps running and the UI warns about it.
  let persistent = true;
  const memory = new Map();

  const read = (key, fallback) => {
    if (memory.has(key)) return memory.get(key);
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  };
  const write = (key, value) => {
    memory.set(key, value);
    try {
      storage.setItem(key, JSON.stringify(value));
      persistent = true;
    } catch {
      persistent = false;
    }
  };

  return {
    isPersistent: () => persistent,
    listGames: () => read(INDEX_KEY, []),
    events: (id) => read(gameKey(id), []),
    append(id, event) {
      const events = [...read(gameKey(id), []), event];
      write(gameKey(id), events);
      return events;
    },
    createGame(id, name) {
      write(INDEX_KEY, [...read(INDEX_KEY, []), { id, name, createdAt: new Date().toISOString() }]);
      write(gameKey(id), []);
    },
    importGame(meta, events) {
      const games = read(INDEX_KEY, []).filter((g) => g.id !== meta.id);
      write(INDEX_KEY, [...games, meta]);
      write(gameKey(meta.id), events);
    },
  };
}
