// App wiring: owns the current game, applies events, re-renders, and handles input.
// All game logic lives in src/game and all recognition in src/vision.
import { emptyBoard, randomBoard, checkBoard } from './game/board.js';
import { checkCity, checkRoad, checkRobber, checkSettlement } from './game/rules.js';
import { lastUndoable, makeEvent, replay } from './game/engine.js';
import { rollsToCsv } from './game/stats.js';
import { validEvents } from './game/validate.js';
import { firebaseConfig, publicUrl } from './sync/firebaseConfig.js';
import { buildLiveDoc, createLatestOnly, makeCode } from './sync/liveGame.js';
import { createStore, memoryStorage } from './game/store.js';
import { createPipeline } from './vision/pipeline.js';
import { createSimCamera } from './vision/simCamera.js';
import { esc, installTooltip } from './ui/charts.js';
import {
  boardTab, describeEvent, diceTab, gamesTab, latestRollView, playersTab, timelineTab,
} from './ui/views.js';

const $ = (selector) => document.querySelector(selector);
const STATUS_TEXT = {
  'no-dice': 'No dice in view',
  'low-contrast': 'No dice found (dice need a darker surface behind them)',
  'one-die': 'Only one die found',
  'too-many': 'More than two die-like objects: narrow the dice area',
  'size-mismatch': 'Two objects found, but their sizes differ too much',
  unreadable: 'Dice found, but the pips are unreadable',
};
const STATES = ['WAITING', 'MOVEMENT', 'SETTLING', 'CONFIRMED'];

let browserStorage;
try {
  browserStorage = window.localStorage;
} catch {
  browserStorage = memoryStorage();
}
const store = createStore(browserStorage);

const prefs = {
  load(key, fallback) {
    try {
      const raw = browserStorage.getItem(`catan.pref.${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  save(key, value) {
    try {
      browserStorage.setItem(`catan.pref.${key}`, JSON.stringify(value));
    } catch { /* A preference that fails to save only affects the next visit. */ }
  },
};

let gameId = null;
let events = [];
let state = replay([]);
const ui = {
  tab: 'dice',
  boardMode: 'layout',
  draft: emptyBoard(),
  brush: 't:hills',
  selectedPlayer: null,
  editingRoll: null,
  snapshots: new Map(), // event id -> JPEG of what the camera saw (this session only)
  manual: [null, null],
  sim: null,
  sourceKind: null,
  simStats: { checked: 0, agreed: 0 },
  uncertain: null,
  drawingRoi: false,
};

// ---------- Game state ----------

// ---------- Sharing through Firebase ----------
// A game is shared only after clicking Share with players, and each game gets its own code.

const cloud = { api: null, user: null, publisher: null };
const codeKey = (id) => `liveCode.${id}`;
const liveCode = () => (gameId ? prefs.load(codeKey(gameId), null) : null);
const playerLink = (code) => `${new URL('dashboard.html', publicUrl ?? window.location.href).href}#${code}`;

async function loadCloud() {
  cloud.api ??= await import('./sync/cloud.js');
  cloud.publisher ??= createLatestOnly(
    ({ code, doc }) => cloud.api.publishGame(code, doc),
    () => toast('Could not update the player link. Rolls are still saved here and will be sent with the next update.'),
  );
  return cloud.api;
}

function publishCloud() {
  const code = liveCode();
  if (!code || !cloud.user) return;
  cloud.publisher.push({
    code,
    doc: buildLiveDoc({ uid: cloud.user.uid, name: state.game?.name, events }),
  });
}

async function startSharing() {
  try {
    const api = await loadCloud();
    cloud.user = (await api.currentUser()) ?? (await api.signIn());
    if (!liveCode()) prefs.save(codeKey(gameId), makeCode());
    publishCloud();
    renderShare();
    await copyPlayerLink();
  } catch (error) {
    // Closing the sign-in window is a normal choice, not a failure worth reporting.
    if (error?.code !== 'auth/popup-closed-by-user' && error?.code !== 'auth/cancelled-popup-request') {
      toast(`Could not start sharing: ${error.message || error.code}`);
    }
  }
}

async function stopSharing() {
  const code = liveCode();
  if (!code) return;
  try {
    const api = await loadCloud();
    await cloud.publisher.cancel();
    cloud.user ??= await api.currentUser();
    if (!cloud.user) cloud.user = await api.signIn();
    await api.removeGame(code);
    prefs.save(codeKey(gameId), null);
    renderShare();
    toast('Sharing stopped. The game was removed from the internet and the link no longer works.');
  } catch (error) {
    toast(`Could not stop sharing: ${error.message || error.code}. The link still works.`);
  }
}

async function copyPlayerLink() {
  const link = playerLink(liveCode());
  try {
    await navigator.clipboard.writeText(link);
    toast('Player link copied. Anyone with it can view this game.');
  } catch {
    toast(`Player link: ${link}`);
  }
}

function renderShare() {
  const code = firebaseConfig ? liveCode() : null;
  $('#share-start').hidden = !firebaseConfig || Boolean(code) || !gameId;
  $('#share-copy').hidden = !code;
  $('#share-stop').hidden = !code;
}

// Sends the event log to the server for players' devices. Requests are chained so an older
// update can never arrive after a newer one.
let sharing = false;
let publishQueue = Promise.resolve();
function publishLive() {
  publishCloud();
  if (!sharing || !gameId) return;
  const body = JSON.stringify({ game: { id: gameId, name: state.game?.name }, events });
  publishQueue = publishQueue
    .then(() => fetch('/api/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }))
    .then((res) => { if (!res.ok) throw new Error(res.status); })
    .catch(() => toast('Could not update players\' screens. Is the server still running?'));
}

function dispatch(event) {
  events = store.append(gameId, event);
  state = replay(events);
  render();
  publishLive();
  if (!store.isPersistent()) toast('Browser storage is full or blocked, so this game will not survive a reload. Export it to keep it.');
}

function openGame(id) {
  gameId = id;
  prefs.save('lastGame', id);
  events = store.events(id);
  state = replay(events);
  ui.editingRoll = null;
  ui.uncertain = null;
  ui.selectedPlayer = currentTurnPlayer();
  ui.boardMode = state.board ? 'settlement' : 'layout';
  ui.draft = state.board ? structuredClone(state.board) : emptyBoard();
  render();
  publishLive();
}

function currentTurnPlayer() {
  if (!state.players.length) return null;
  return state.players[state.rolls.length % state.players.length].id;
}

function addRoll(d1, d2, meta) {
  dispatch(makeEvent('DiceRolled', { d1, d2 }, meta));
  ui.selectedPlayer = state.rolls.at(-1)?.player ?? ui.selectedPlayer;
  return events.at(-1).id;
}

// ---------- Rendering ----------

function render() {
  const games = store.listGames();
  $('#game-select').innerHTML = games.map((g) => `<option value="${esc(g.id)}" ${g.id === gameId ? 'selected' : ''}>${esc(g.name)}</option>`).join('');
  $('#undo').disabled = !lastUndoable(events);
  renderShare();
  $('#latest').innerHTML = latestRollView(state);
  for (const btn of document.querySelectorAll('[data-tab]')) {
    const on = btn.dataset.tab === ui.tab;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-selected', on);
  }
  const tabs = {
    dice: () => diceTab(state, ui),
    board: () => boardTab(state, ui),
    players: () => playersTab(state),
    timeline: () => timelineTab(state),
    games: () => gamesTab(games.map((meta) => ({ meta, state: replay(store.events(meta.id)) })), gameId),
  };
  $('#tab-body').innerHTML = tabs[ui.tab]();
  renderManual();
  renderUncertain();
}

function renderManual() {
  const row = (die) => [1, 2, 3, 4, 5, 6].map((v) => `<button class="seg ${ui.manual[die] === v ? 'on' : ''}" data-action="manual-pick" data-die="${die}" data-value="${v}" aria-label="Die ${die + 1}: ${v}">${v}</button>`).join('');
  $('#manual-d1').innerHTML = row(0);
  $('#manual-d2').innerHTML = row(1);
  $('#manual-add').disabled = !(ui.manual[0] && ui.manual[1]);
}

function renderUncertain() {
  const box = $('#uncertain');
  box.hidden = !ui.uncertain;
  if (!ui.uncertain) return;
  box.innerHTML = `<b>⚠ Throw not recorded</b>
    <p class="small">${esc(STATUS_TEXT[ui.uncertain.reason] ?? ui.uncertain.reason)}. Check the dice, or enter the result below.</p>
    ${ui.uncertain.snapshot ? `<img src="${ui.uncertain.snapshot}" alt="Frame the camera could not read">` : ''}
    <button class="btn tiny" data-action="dismiss-uncertain">Dismiss</button>`;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

// ---------- Camera ----------

const video = $('#video');
const overlay = $('#overlay');
const pipeline = createPipeline({
  video,
  overlay,
  onFrame({ motion, reading, state: machine, threshold }) {
    for (const s of STATES) {
      $(`#state-${s}`).classList.toggle('on', s === machine);
    }
    $('#motion-bar').style.width = `${Math.min(100, (motion / (threshold * 5)) * 100)}%`;
    let text;
    if (!reading) text = 'Movement: reading paused';
    else if (reading.status === 'ok') text = `Reading ${reading.values[0]} + ${reading.values[1]} (${Math.round(reading.confidence * 100)}% confidence)`;
    else text = STATUS_TEXT[reading.status] ?? reading.status;
    $('#reader-status').textContent = text;
  },
  onEvent(event) {
    if (event.type === 'roll') onDetectedRoll(event);
    else if (event.type === 'uncertain') {
      ui.uncertain = event;
      renderUncertain();
    } else if (event.type === 'ignored') {
      toast('Movement seen, but the dice did not change. No roll recorded.');
    }
  },
});

function onDetectedRoll(detected) {
  ui.uncertain = null;
  const simulated = ui.sourceKind === 'sim';
  const id = addRoll(detected.d1, detected.d2, {
    origin: simulated ? 'simulated' : 'camera',
    confidence: detected.confidence,
    verified: false,
  });
  ui.snapshots.set(id, detected.snapshot);
  if (ui.snapshots.size > 40) ui.snapshots.delete(ui.snapshots.keys().next().value);
  if (simulated && ui.sim) {
    ui.simStats.checked++;
    const seen = [detected.d1, detected.d2].sort((a, b) => a - b).join();
    if (seen === ui.sim.truth().join()) ui.simStats.agreed++;
    $('#sim-score').textContent = `Simulator agreement: ${ui.simStats.agreed} of ${ui.simStats.checked} throws`;
  }
  render();
}

function stopSource() {
  pipeline.stop();
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
  if (video.src) {
    URL.revokeObjectURL(video.src);
    video.removeAttribute('src');
    video.load();
  }
  ui.sim?.stop();
  ui.sim = null;
  ui.sourceKind = null;
  $('#stage').classList.remove('live');
  $('#source-stop').hidden = true;
  $('#source-start').hidden = false;
  $('#sim-controls').hidden = true;
  $('#sim-banner').hidden = true;
  $('#reader-status').textContent = 'Camera off';
  $('#motion-bar').style.width = '0';
  for (const s of STATES) $(`#state-${s}`).classList.remove('on');
}

function beginSource(kind) {
  ui.sourceKind = kind;
  $('#stage').classList.add('live');
  $('#source-stop').hidden = false;
  $('#source-start').hidden = true;
  pipeline.start();
}

async function refreshCameraList() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput' && d.deviceId);
    const select = $('#source');
    const current = select.value;
    select.querySelectorAll('option[data-device]').forEach((o) => o.remove());
    cams.forEach((cam, i) => {
      const option = new Option(cam.label || `Camera ${i + 1}`, `cam:${cam.deviceId}`);
      option.dataset.device = '1';
      select.insertBefore(option, select.querySelector('option[value="file"]'));
    });
    if ([...select.options].some((o) => o.value === current)) select.value = current;
  } catch { /* The default camera option still works without a device list. */ }
}

async function startSelectedSource() {
  const choice = $('#source').value;
  stopSource();
  if (choice === 'file') {
    $('#video-file').click();
    return;
  }
  if (choice === 'sim') {
    ui.sim = createSimCamera();
    ui.simStats = { checked: 0, agreed: 0 };
    $('#sim-score').textContent = 'Simulator agreement: no throws yet';
    video.srcObject = ui.sim.stream;
    await video.play();
    $('#sim-controls').hidden = false;
    $('#sim-banner').hidden = false;
    beginSource('sim');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    toast('This browser gives no camera access here. Open the app through https:// or http://localhost.');
    return;
  }
  try {
    const deviceId = choice.startsWith('cam:') ? choice.slice(4) : undefined;
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        // On a phone, prefer the back camera. Computers ignore this.
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
      },
    });
    await video.play();
    beginSource('camera');
    refreshCameraList();
  } catch (error) {
    toast(`Could not start the camera: ${error.message || error.name}`);
    stopSource();
  }
}

async function startVideoFile(file) {
  video.src = URL.createObjectURL(file);
  try {
    await video.play();
    beginSource('file');
  } catch (error) {
    toast(`Could not play that file: ${error.message || error.name}`);
    stopSource();
  }
}

// Dice-area selection, in fractions of the video frame.
let roiStart = null;
function pointerToFraction(e) {
  const r = overlay.getBoundingClientRect();
  // The overlay letterboxes with the video, so account for object-fit: contain.
  const scale = Math.min(r.width / overlay.width, r.height / overlay.height);
  const w = overlay.width * scale;
  const h = overlay.height * scale;
  const x = (e.clientX - r.left - (r.width - w) / 2) / w;
  const y = (e.clientY - r.top - (r.height - h) / 2) / h;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}
function rectFrom(a, b) {
  return {
    x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y),
  };
}
overlay.addEventListener('pointerdown', (e) => {
  if (!ui.drawingRoi) return;
  roiStart = pointerToFraction(e);
  overlay.setPointerCapture(e.pointerId);
});
overlay.addEventListener('pointermove', (e) => {
  if (roiStart) pipeline.setDraftRoi(rectFrom(roiStart, pointerToFraction(e)));
});
overlay.addEventListener('pointerup', (e) => {
  if (!roiStart) return;
  const area = rectFrom(roiStart, pointerToFraction(e));
  roiStart = null;
  ui.drawingRoi = false;
  overlay.classList.remove('drawing');
  $('#roi-set').textContent = 'Set dice area';
  if (area.w < 0.05 || area.h < 0.05) {
    pipeline.setDraftRoi(null);
    toast('That area is too small, so the dice area was not changed.');
    return;
  }
  pipeline.setRoi(area);
  prefs.save('roi', area);
});

// ---------- Actions ----------

const actions = {
  'manual-pick': ({ die, value }) => {
    ui.manual[Number(die)] = Number(value);
    renderManual();
  },
  'manual-add': () => {
    addRoll(ui.manual[0], ui.manual[1], { origin: 'manual', verified: true });
    ui.manual = [null, null];
    ui.uncertain = null;
    render();
  },
  'edit-roll': ({ id }) => { ui.editingRoll = id; render(); },
  'cancel-edit': () => { ui.editingRoll = null; render(); },
  'save-roll': ({ id }) => {
    const d1 = Number($('#edit-d1').value);
    const d2 = Number($('#edit-d2').value);
    ui.editingRoll = null;
    dispatch(makeEvent('RollCorrected', { target: id, d1, d2 }, { origin: 'manual', verified: true }));
  },
  void: ({ id }) => dispatch(makeEvent('EventVoided', { target: id }, { origin: 'manual', verified: true })),
  restore: ({ id }) => {
    // Restoring means voiding the live void that targets this event.
    const live = [...events].reverse().find(
      (e) => e.type === 'EventVoided' && e.target === id
        && !state.timeline.find((t) => t.event.id === e.id)?.voided,
    );
    if (live) dispatch(makeEvent('EventVoided', { target: live.id }, { origin: 'manual', verified: true }));
  },
  'show-frame': ({ id }) => {
    $('#frame-img').src = ui.snapshots.get(id);
    $('#frame-dialog').showModal();
  },
  'dismiss-uncertain': () => { ui.uncertain = null; renderUncertain(); },
  'goto-robber': () => {
    if (!state.board) {
      toast('Save a board layout before placing the robber.');
      ui.tab = 'board';
      ui.boardMode = 'layout';
    } else {
      ui.tab = 'board';
      ui.boardMode = 'robber';
    }
    render();
  },
  'board-mode': ({ mode }) => {
    if (ui.boardMode === 'layout' && mode !== 'layout' && !state.board) return;
    if (mode === 'layout') ui.draft = state.board ? structuredClone(state.board) : ui.draft;
    ui.boardMode = mode;
    render();
  },
  brush: ({ brush }) => { ui.brush = brush; render(); },
  'board-random': () => { ui.draft = randomBoard(); render(); },
  'board-clear': () => { ui.draft = emptyBoard(); render(); },
  'board-cancel': () => {
    ui.draft = structuredClone(state.board);
    ui.boardMode = 'settlement';
    render();
  },
  'board-save': () => {
    if (checkBoard(ui.draft).errors.length) return;
    ui.boardMode = 'settlement';
    dispatch(makeEvent('BoardConfigured', {
      hexes: structuredClone(ui.draft),
      resetRobber: state.rolls.length === 0,
    }, { origin: 'manual', verified: true }));
  },
  'select-player': ({ id }) => { ui.selectedPlayer = id; render(); },
  knight: ({ id }) => dispatch(makeEvent('DevelopmentCardPlayed', { player: id, card: 'knight' }, { origin: 'manual', verified: true })),
  'open-game': ({ id }) => openGame(id),
  'roll-sim': () => ui.sim?.roll(),
  'repeat-sim': () => ui.sim?.roll(ui.sim.truth()),
  'hand-sim': () => ui.sim?.passHand(),
};

const manualEvent = (type, payload) => makeEvent(type, payload, { origin: 'manual', verified: true });

function clickHex(hex) {
  if (ui.boardMode === 'layout') {
    const [kind, value] = ui.brush.split(':');
    const cell = ui.draft[hex];
    if (kind === 't') {
      cell.terrain = value;
      if (value === 'desert') cell.number = null;
    } else if (cell.terrain === 'desert') {
      toast('The desert has no number.');
    } else {
      cell.number = Number(value);
    }
    render();
  } else if (ui.boardMode === 'robber') {
    const reason = checkRobber(state, hex);
    if (reason) toast(reason);
    else dispatch(manualEvent('RobberMoved', { hex }));
  }
}

function clickVertex(vertex) {
  const player = ui.selectedPlayer;
  const city = ui.boardMode === 'city';
  const reason = (city ? checkCity : checkSettlement)(state, player, vertex);
  if (reason) toast(reason);
  else dispatch(manualEvent(city ? 'CityBuilt' : 'SettlementBuilt', { player, vertex }));
}

function clickEdge(edge) {
  const reason = checkRoad(state, ui.selectedPlayer, edge);
  if (reason) toast(reason);
  else dispatch(manualEvent('RoadBuilt', { player: ui.selectedPlayer, edge }));
}

document.addEventListener('click', (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (actionEl && !actionEl.disabled) {
    actions[actionEl.dataset.action]?.(actionEl.dataset);
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    ui.tab = tab.dataset.tab;
    render();
    return;
  }
  const { hex, vertex, edge } = e.target.dataset ?? {};
  if (hex != null) clickHex(Number(hex));
  else if (vertex != null) clickVertex(Number(vertex));
  else if (edge != null) clickEdge(Number(edge));
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-hex],[data-vertex],[data-edge]')) {
    e.preventDefault();
    e.target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
});

installTooltip();

// A separate window, because browsers slow down the camera loop in a hidden tab.
$('#open-dashboard').addEventListener('click', (e) => {
  e.preventDefault();
  window.open('dashboard.html', 'catan-dashboard', 'popup,width=1400,height=900');
});

// ---------- Header and dialogs ----------

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileSafe = (name) => name.replace(/[^\w-]+/g, '_').slice(0, 40) || 'game';

$('#export-csv').addEventListener('click', () => {
  download(`${fileSafe(state.game?.name ?? 'game')}_rolls.csv`, 'text/csv', `﻿${rollsToCsv(state)}`);
});
$('#export-json').addEventListener('click', () => {
  const meta = store.listGames().find((g) => g.id === gameId);
  download(`${fileSafe(meta?.name ?? 'game')}.json`, 'application/json', JSON.stringify({ meta, events }, null, 1));
});

$('#undo').addEventListener('click', () => {
  const target = lastUndoable(events);
  if (!target) return;
  const description = describeEvent(target, state);
  dispatch(makeEvent('EventVoided', { target: target.id }, { origin: 'manual', verified: true }));
  toast(`Undone: ${description}. You can restore it from the Timeline.`);
});

$('#game-select').addEventListener('change', (e) => openGame(e.target.value));
$('#new-game').addEventListener('click', () => openNewGameDialog());

const PLAYER_COLORS = ['red', 'blue', 'orange', 'white'];
function playerRow(i) {
  const color = PLAYER_COLORS[i];
  const name = color[0].toUpperCase() + color.slice(1);
  return `<div class="player-row">
    <input name="name${i}" value="${name}" maxlength="24" aria-label="Player ${i + 1} name" required>
    <select name="color${i}" aria-label="Player ${i + 1} colour">${PLAYER_COLORS.map((c) => `<option ${c === color ? 'selected' : ''}>${c}</option>`).join('')}</select>
  </div>`;
}
function openNewGameDialog() {
  const form = $('#new-game-form');
  form.reset();
  form.elements.name.value = `Game ${store.listGames().length + 1}`;
  form.elements.count.value = '4';
  $('#player-rows').innerHTML = [0, 1, 2, 3].map(playerRow).join('');
  $('#new-game-cancel').hidden = !gameId;
  $('#new-game-dialog').showModal();
}
$('#new-game-form').elements.count.addEventListener('change', (e) => {
  const n = Number(e.target.value);
  $('#player-rows').innerHTML = Array.from({ length: n }, (_, i) => playerRow(i)).join('');
});
$('#new-game-cancel').addEventListener('click', () => $('#new-game-dialog').close());
$('#new-game-dialog').addEventListener('cancel', (e) => {
  if (!gameId) e.preventDefault(); // A game must exist before anything can be recorded.
});
$('#new-game-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  const n = Number(form.elements.count.value);
  const players = Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`,
    name: form.elements[`name${i}`].value.trim() || `Player ${i + 1}`,
    color: form.elements[`color${i}`].value,
  }));
  if (new Set(players.map((p) => p.color)).size !== n) {
    toast('Each player needs a different colour.');
    return;
  }
  const id = `g${Date.now().toString(36)}`;
  const name = form.elements.name.value.trim() || 'Game';
  store.createGame(id, name);
  store.append(id, makeEvent('GameStarted', { gameId: id, name, players }, { origin: 'manual', verified: true }));
  $('#new-game-dialog').close();
  openGame(id);
});
$('#frame-close').addEventListener('click', () => $('#frame-dialog').close());

document.addEventListener('change', async (e) => {
  if (e.target.id !== 'import-file' || !e.target.files[0]) return;
  try {
    const data = JSON.parse(await e.target.files[0].text());
    if (typeof data?.meta?.id !== 'string' || !validEvents(data.events)) throw new Error('not a game export');
    store.importGame(data.meta, data.events);
    openGame(data.meta.id);
    toast(`Imported "${data.meta.name}".`);
  } catch (error) {
    toast(`Could not import that file: ${error.message}`);
  }
});

$('#source-start').addEventListener('click', startSelectedSource);
$('#source-stop').addEventListener('click', stopSource);
$('#video-file').addEventListener('change', (e) => {
  if (e.target.files[0]) startVideoFile(e.target.files[0]);
  e.target.value = '';
});
$('#roi-set').addEventListener('click', (e) => {
  if (!pipeline.running()) {
    toast('Start a source first, then draw the dice area on the video.');
    return;
  }
  ui.drawingRoi = !ui.drawingRoi;
  overlay.classList.toggle('drawing', ui.drawingRoi);
  e.target.textContent = ui.drawingRoi ? 'Drag on the video…' : 'Set dice area';
});
$('#roi-reset').addEventListener('click', () => {
  const full = { x: 0, y: 0, w: 1, h: 1 };
  pipeline.setRoi(full);
  prefs.save('roi', full);
});
$('#debug-toggle').addEventListener('change', (e) => {
  pipeline.setDebug(e.target.checked);
  prefs.save('debug', e.target.checked);
});
$('#motion-sensitivity').addEventListener('input', (e) => {
  const motionThreshold = Number(e.target.value) / 1000;
  $('#motion-value').textContent = `${(motionThreshold * 100).toFixed(2)}%`;
  pipeline.configure({ motionThreshold });
  prefs.save('motion', motionThreshold);
});
$('#stable-frames').addEventListener('input', (e) => {
  const stableFrames = Number(e.target.value);
  $('#stable-value').textContent = stableFrames;
  pipeline.configure({ stableFrames });
  prefs.save('stable', stableFrames);
});

// ---------- Startup ----------

function restorePrefs() {
  const motion = prefs.load('motion', 0.002);
  const stable = prefs.load('stable', 6);
  $('#motion-sensitivity').value = motion * 1000;
  $('#motion-value').textContent = `${(motion * 100).toFixed(2)}%`;
  $('#stable-frames').value = stable;
  $('#stable-value').textContent = stable;
  pipeline.configure({ motionThreshold: motion, stableFrames: stable });
  const debug = prefs.load('debug', true);
  $('#debug-toggle').checked = debug;
  pipeline.setDebug(debug);
  pipeline.setRoi(prefs.load('roi', { x: 0, y: 0, w: 1, h: 1 }));
}

// Only the local server has this route. Static hosting simply runs unshared.
const onLocalServer = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
(onLocalServer ? fetch('/api/info').then((res) => res.json()) : Promise.resolve({ sharing: false }))
  .then((info) => {
    sharing = info.sharing;
    if (!sharing) return;
    const label = $('#share-urls');
    // Virtual adapters add extra addresses, so show the likeliest and keep the rest in a tooltip.
    label.textContent = info.urls.length
      ? `Players' devices: ${info.urls[0]}`
      : 'Sharing is on, but no network connection was found';
    if (info.urls.length > 1) label.title = `If that doesn't connect, try: ${info.urls.slice(1).join(', ')}`;
    label.hidden = false;
    publishLive();
  })
  .catch(() => { /* Without the server's info, the app simply runs unshared. */ });

$('#share-start').addEventListener('click', startSharing);
$('#share-copy').addEventListener('click', copyPlayerLink);
$('#share-stop').addEventListener('click', stopSharing);

// After a reload, a game already being shared carries on updating its link.
function resumeSharing() {
  if (!firebaseConfig || !liveCode()) return;
  loadCloud()
    .then((api) => api.currentUser())
    .then((user) => {
      cloud.user = user;
      if (user) publishCloud();
      else toast('Sign in again with Share with players: the player link is not updating.');
    })
    .catch(() => toast('Could not reach the sharing service. Rolls are still saved in this browser.'));
}

restorePrefs();
refreshCameraList();
const games = store.listGames();
const last = prefs.load('lastGame', null);
if (games.length) {
  openGame(games.some((g) => g.id === last) ? last : games.at(-1).id);
  resumeSharing();
} else {
  render();
  openNewGameDialog();
}
