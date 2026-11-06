// Checks an event log from outside this browser: an imported file or a shared game link.
// Anyone can create such data, and the views print numbers from it directly, so every
// field a view relies on must have exactly the expected type before it is replayed.
import { TERRAINS, TOPOLOGY } from './board.js';

const isText = (v) => typeof v === 'string' && v.length <= 200;
const isDie = (v) => Number.isInteger(v) && v >= 1 && v <= 6;
const isIndex = (v, list) => Number.isInteger(v) && v >= 0 && v < list.length;

function validHex(h) {
  if (h === null || typeof h !== 'object') return false;
  const terrainOk = h.terrain === null || TERRAINS.includes(h.terrain);
  const numberOk = h.number === null || (Number.isInteger(h.number) && h.number >= 2 && h.number <= 12);
  return terrainOk && numberOk;
}

const CHECKS = {
  GameStarted: (e) => isText(e.name) && Array.isArray(e.players) && e.players.length <= 6
    && e.players.every((p) => isText(p?.id) && isText(p?.name) && isText(p?.color)),
  BoardConfigured: (e) => Array.isArray(e.hexes) && e.hexes.length === TOPOLOGY.hexes.length && e.hexes.every(validHex),
  DiceRolled: (e) => isDie(e.d1) && isDie(e.d2),
  RollCorrected: (e) => isDie(e.d1) && isDie(e.d2) && isText(e.target),
  SettlementBuilt: (e) => isText(e.player) && isIndex(e.vertex, TOPOLOGY.vertices),
  CityBuilt: (e) => isText(e.player) && isIndex(e.vertex, TOPOLOGY.vertices),
  RoadBuilt: (e) => isText(e.player) && isIndex(e.edge, TOPOLOGY.edges),
  RobberMoved: (e) => isIndex(e.hex, TOPOLOGY.hexes),
  DevelopmentCardPlayed: (e) => isText(e.player) && isText(e.card),
  EventVoided: (e) => isText(e.target),
};

export function validEvents(events) {
  return Array.isArray(events) && events.every((e) => (
    e !== null && typeof e === 'object'
    && isText(e.id) && isText(e.ts) && isText(e.origin)
    && (e.confidence == null || typeof e.confidence === 'number')
    && Object.hasOwn(CHECKS, e.type) && CHECKS[e.type](e)
  ));
}
