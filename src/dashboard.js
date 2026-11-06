// Read-only player dashboard. It writes nothing: it rebuilds state from the same event log
// as the tracker, and follows whichever game the tracker has open. On the tracker's computer
// it reads local storage. On other devices it receives the log from the server.
import { RESOURCES } from './game/board.js';
import { playerSummaries, replay } from './game/engine.js';
import { expectedPerRoll } from './game/rules.js';
import { diceStats } from './game/stats.js';
import { createStore, memoryStorage } from './game/store.js';
import { firebaseConfig } from './sync/firebaseConfig.js';
import { codeFromHash, readLiveDoc } from './sync/liveGame.js';
import { dieFace, distributionChart, esc, installTooltip } from './ui/charts.js';
import { boardSvg, describeEvent, productionSummary } from './ui/views.js';

const COLORS = new Set(['red', 'blue', 'orange', 'white']);
const playerVar = (color) => `var(--player-${COLORS.has(color) ? color : 'white'})`;
const dot = (color) => `<i class="pdot" style="background:${playerVar(color)}"></i>`;
const VIEW_ONLY = { boardMode: 'view', draft: null, selectedPlayer: null };
const FEED_LENGTH = 7;

let storage;
try {
  storage = window.localStorage;
} catch {
  storage = memoryStorage();
}
const store = createStore(storage);
const root = document.querySelector('#dashboard');
const { hostname } = window.location;
// Static hosting has no server to stream from, so it reads this browser's storage instead.
const STATIC_HOST = hostname.endsWith('.github.io');
const CLOUD_CODE = firebaseConfig ? codeFromHash(window.location.hash) : null;
const REMOTE = Boolean(CLOUD_CODE) || (!['localhost', '127.0.0.1', '[::1]'].includes(hostname) && !STATIC_HOST);
const SHOW_BROWSER_NOTE = STATIC_HOST && !REMOTE;
const SAME_BROWSER_NOTE = 'This page shows games from this browser only. To show a game on other devices, use Share with players on the tracker and open its link.';
let linkInactive = false;
let live = null; // latest game received from the server, on other devices
let connected = false;
let lastRollId = null;

function openGameId() {
  const games = store.listGames();
  let wanted = null;
  try {
    wanted = JSON.parse(storage.getItem('catan.pref.lastGame'));
  } catch { /* Fall through to the newest game. */ }
  return games.some((g) => g.id === wanted) ? wanted : games.at(-1)?.id ?? null;
}

function playerCard(state, p, isNext) {
  const filled = Math.min(10, p.visibleVP);
  const track = Array.from({ length: 10 }, (_, i) => `<i ${i < filled ? `style="background:${playerVar(p.color)}"` : ''}></i>`).join('');
  // Derived from the replayed roll, so a corrected roll updates this too.
  const production = state.rolls.at(-1)?.production;
  const gains = production?.byPlayer[p.id] ?? {};
  const sumOf = (byResource) => RESOURCES.reduce((sum, r) => sum + (byResource?.[r] ?? 0), 0);
  const gained = sumOf(gains);
  const blockedNow = sumOf(production?.blocked[p.id]);
  const resources = RESOURCES.map((r) => `<div class="${gains[r] ? 'got' : ''}"><i style="background:var(--res-${r})"></i><b>${gains[r] ? `+${gains[r]}` : '–'}</b><span>${r}</span><small>total ${p.produced[r]}</small></div>`).join('');
  const blocked = sumOf(p.lostToRobber);
  return `<section class="card player-card ${isNext ? 'next' : ''}">
    <div class="player-head">${dot(p.color)}<span class="name">${esc(p.name)}</span>${isNext ? '<span class="next-tag">Next to roll</span>' : ''}</div>
    <div class="vp"><span class="vp-value">${p.visibleVP}</span><span class="muted">visible VP</span></div>
    <div class="vp-track" role="img" aria-label="${p.visibleVP} of 10 victory points"> ${track}</div>
    <div class="awards">
      ${p.longestRoad ? '<span class="badge">Longest Road</span>' : ''}
      ${p.largestArmy ? '<span class="badge">Largest Army</span>' : ''}
      ${p.visibleVP >= 10 ? '<span class="badge">10 visible points</span>' : ''}
    </div>
    <div class="round">
      <div class="round-head">
        <span>Latest roll</span>
        <b>${gained ? `+${gained} card${gained === 1 ? '' : 's'}` : 'nothing'}</b>
        ${blockedNow ? `<span class="round-blocked" title="Blocked by the robber">⚠ ${blockedNow} blocked</span>` : ''}
      </div>
      <div class="res" aria-label="Resources gained from the latest roll, with game totals">${resources}</div>
    </div>
    <div class="counts">
      <div><b>${p.settlements}</b><span>settlements</span></div>
      <div><b>${p.cities}</b><span>cities</span></div>
      <div><b>${p.roads}</b><span>roads</span></div>
      <div><b>${p.knights}</b><span>knights</span></div>
    </div>
    <div class="player-foot">
      <span>Game total <b>${p.totalProduced}</b>${blocked ? ` · blocked <b>${blocked}</b>` : ''}</span>
      <span>Expected <b>${expectedPerRoll(state, p.id).toFixed(2)}</b> per roll</span>
    </div>
  </section>`;
}

function feedItems(state) {
  return state.timeline
    .filter(({ event: e, voided, rejected }) => !voided && !rejected && !['EventVoided', 'RollCorrected'].includes(e.type))
    .slice(-FEED_LENGTH)
    .reverse()
    .map(({ event: e }) => {
      // A corrected roll must show the corrected value, not what the camera first read.
      const roll = e.type === 'DiceRolled' ? state.rolls.find((r) => r.eventId === e.id) : null;
      const shown = roll ? { ...e, d1: roll.d1, d2: roll.d2 } : e;
      const when = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `<li><time>${when}</time><span>${esc(describeEvent(shown, state))}</span></li>`;
    }).join('');
}

function currentEvents() {
  if (REMOTE) return live?.events ?? null;
  const id = openGameId();
  return id ? store.events(id) : null;
}

function render() {
  const events = currentEvents();
  if (!events) {
    let waiting = `<h1>${connected ? 'Waiting for the tracker' : 'Connecting…'}</h1><p class="muted">The game appears here once the tracker is open on the host computer.</p>`;
    if (linkInactive) waiting = '<h1>This link isn\'t active</h1><p class="muted">The game may have ended or stopped being shared. Ask the host for a new link.</p>';
    root.innerHTML = REMOTE
      ? `<div class="dash-empty"><div>${waiting}</div></div>`
      : `<div class="dash-empty"><div><h1>No game yet</h1><p class="muted">Start a game on the tracker and it will appear here.${SHOW_BROWSER_NOTE ? ` ${SAME_BROWSER_NOTE}` : ''}</p><a class="btn primary" href="index.html">Open tracker</a></div></div>`;
    return;
  }
  const state = replay(events);
  const players = playerSummaries(state);
  const stats = diceStats(state.rolls);
  const latest = state.rolls.at(-1);
  const next = players.length ? players[state.rolls.length % players.length] : null;
  const name = (pid) => state.players.find((p) => p.id === pid)?.name ?? '';

  const isNew = latest && lastRollId !== null && latest.eventId !== lastRollId;
  lastRollId = latest?.eventId ?? '';

  const peak = Math.max(...stats.rows.map((r) => r.count));
  const mostRolled = peak ? stats.rows.filter((r) => r.count === peak).map((r) => r.total).join(', ') : '–';
  const sinceSeven = stats.rows.find((r) => r.total === 7).currentGap;
  const simulated = state.rolls.some((r) => r.origin === 'simulated');

  root.innerHTML = `
    <header class="dash-top">
      <h1>${esc(state.game?.name ?? 'Game')}</h1>
      <span class="muted">Roll ${stats.count}</span>
      ${simulated ? '<span class="badge origin-simulated">includes simulated rolls</span>' : ''}
      ${REMOTE && !connected ? '<span class="badge badge-warn">⚠ Reconnecting: this may be out of date</span>' : ''}
      <span class="spacer"></span>
      ${REMOTE ? '' : '<a class="btn" href="index.html">Tracker</a>'}
    </header>
    ${state.needsRobberMove ? `<div class="dash-alert">⚠ 7 rolled: ${esc(name(latest.player))} moves the robber</div>` : ''}
    <div class="dash-now">
      <section class="card">
        <div class="dash-label">Next to roll</div>
        <div class="next-name">${next ? `${dot(next.color)}${esc(next.name)}` : '–'}</div>
      </section>
      <section class="card">
        <div class="dash-label">Latest roll${latest?.player ? `, ${esc(name(latest.player))}` : ''}</div>
        ${latest ? `<div class="roll-now">
          <div class="dice ${isNew ? 'new-roll' : ''}">${dieFace(latest.d1, 62)}${dieFace(latest.d2, 62)}</div>
          <div class="roll-total ${isNew ? 'new-roll' : ''}">${latest.total}</div>
          <div class="roll-detail"><p>${productionSummary(state, latest)}</p></div>
        </div>` : '<p class="empty">Waiting for the first roll.</p>'}
      </section>
    </div>
    <div class="dash-players ${players.length % 2 ? '' : 'even'}" style="--players:${players.length || 1}">${players.map((p) => playerCard(state, p, p.id === next?.id)).join('')}</div>
    <div class="dash-lower">
      <section class="card">
        <h3>Board${state.robberHex != null ? ` · robber on H${state.robberHex}` : ''}</h3>
        ${state.board ? boardSvg(state, VIEW_ONLY) : '<p class="empty">The board layout hasn\'t been entered yet.</p>'}
      </section>
      <div class="dash-side">
        <div class="tiles">
          <div class="tile"><div class="tile-label">Sevens</div><div class="tile-value">${stats.sevens}</div><div class="tile-sub">${stats.count ? `${(stats.sevenRate * 100).toFixed(1)}%, expected 16.7%` : 'expected 16.7%'}</div></div>
          <div class="tile"><div class="tile-label">Rolls since last 7</div><div class="tile-value">${stats.count ? sinceSeven : '–'}</div></div>
          <div class="tile"><div class="tile-label">Most rolled</div><div class="tile-value">${mostRolled}</div><div class="tile-sub">${peak ? `${peak} time${peak === 1 ? '' : 's'}` : ''}</div></div>
        </div>
        <section class="card"><h3>Dice so far</h3>${distributionChart(stats.rows)}</section>
        <section class="card"><h3>Recent events</h3><ul class="dash-feed">${feedItems(state)}</ul></section>
        <p class="dash-footnote">Visible VP leaves out hidden victory-point cards. Large resource numbers are what the latest roll gave. Totals count resources from dice this game, not cards held. Expected uses the current board and robber. Turns are inferred from seating order.${SHOW_BROWSER_NOTE ? ` ${SAME_BROWSER_NOTE}` : ''}</p>
      </div>
    </div>`;
}

if (CLOUD_CODE) {
  const inactive = () => {
    live = null;
    linkInactive = true;
    render();
  };
  import('./sync/cloud.js')
    .then((cloud) => cloud.watchGame(CLOUD_CODE, {
      onData(doc, confirmed) {
        connected = confirmed;
        // Until the server answers, a missing document only means "not loaded yet".
        if (!doc && !confirmed) { render(); return; }
        const events = readLiveDoc(doc);
        if (!events) { inactive(); return; }
        linkInactive = false;
        live = { events };
        render();
      },
      onError() {
        connected = false;
        render();
      },
    }))
    .catch(() => {
      connected = false;
      render();
    });
} else if (REMOTE) {
  // EventSource reconnects by itself, and the server resends the current game on connect.
  const source = new EventSource('/api/live/stream');
  source.onmessage = (e) => {
    connected = true;
    live = JSON.parse(e.data) ?? live;
    render();
  };
  source.onerror = () => {
    connected = false;
    render();
  };
} else {
  // The storage event fires here whenever the tracker, in another tab or window, saves.
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key.startsWith('catan.game') || e.key === 'catan.pref.lastGame') render();
  });
}

installTooltip();
render();
