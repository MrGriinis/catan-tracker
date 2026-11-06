// Pure HTML string views. They read state and emit markup, and main.js owns all behaviour.
import { RESOURCES, TERRAINS, TOPOLOGY, checkBoard, toPixel } from '../game/board.js';
import { checkCity, checkRoad, checkRobber, checkSettlement } from '../game/rules.js';
import { playerSummaries } from '../game/engine.js';
import {
  CHI_SQUARED_MIN_ROLLS, diceStats, playerRollStats, recognitionStats,
} from '../game/stats.js';
import { dieFace, distributionChart, esc, lineChart, stackedBars } from './charts.js';

const RESOURCE_COLOR = {
  ore: 'var(--res-ore)', brick: 'var(--res-brick)', wool: 'var(--res-wool)', grain: 'var(--res-grain)', lumber: 'var(--res-lumber)',
};
// Stack order is the validated colour-adjacency order, not the alphabetical one.
const RESOURCE_STACK = ['ore', 'brick', 'wool', 'grain', 'lumber'];
const COLORS = new Set(['red', 'blue', 'orange', 'white']);
const playerVar = (color) => `var(--player-${COLORS.has(color) ? color : 'white'})`;
const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const signed = (v, d = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;

const playerName = (state, id) => state.players.find((p) => p.id === id)?.name ?? '';
const originBadge = (origin) => `<span class="badge origin-${esc(origin)}">${esc(origin)}</span>`;
const dot = (color) => `<i class="pdot" style="background:${playerVar(color)}"></i>`;

export function productionSummary(state, roll) {
  if (!roll.production) return '<span class="muted">No board saved, so production was not calculated.</span>';
  if (roll.total === 7) return '<span class="muted">A 7 produces nothing.</span>';
  const parts = [];
  for (const [id, res] of Object.entries(roll.production.byPlayer)) {
    const items = Object.entries(res).map(([k, v]) => `${v} ${k}`).join(', ');
    parts.push(`<b>${esc(playerName(state, id))}</b> +${esc(items)}`);
  }
  for (const [id, res] of Object.entries(roll.production.blocked)) {
    const items = Object.entries(res).map(([k, v]) => `${v} ${k}`).join(', ');
    parts.push(`<span class="muted">${esc(playerName(state, id))} blocked by the robber: ${esc(items)}</span>`);
  }
  return parts.length ? parts.join(' · ') : '<span class="muted">Nobody produced anything.</span>';
}

export function latestRollView(state) {
  const roll = state.rolls.at(-1);
  if (!roll) return '<p class="empty">No rolls yet. Throw the dice, or add one below.</p>';
  return `<div class="latest">
      <div class="latest-dice">${dieFace(roll.d1, 54)}${dieFace(roll.d2, 54)}</div>
      <div class="latest-total">${roll.total}</div>
      <div class="latest-meta">
        <div>Roll ${roll.index + 1} · ${originBadge(roll.origin)}${roll.corrected ? ' <span class="badge">corrected</span>' : ''}</div>
        <div class="muted">${roll.player ? `${esc(playerName(state, roll.player))}'s turn (inferred)` : ''}</div>
      </div>
    </div>
    <p class="production">${productionSummary(state, roll)}</p>
    ${state.needsRobberMove ? '<button class="btn primary wide" data-action="goto-robber">7 rolled: move the robber</button>' : ''}`;
}

export function diceTab(state, ui) {
  const stats = diceStats(state.rolls);
  const recog = recognitionStats(state.timeline, state.rolls);
  const chi = !stats.count
    ? '–'
    : stats.chiSquaredUsable
      ? `${stats.chiSquared.toFixed(1)}${stats.chiSquaredSuspicious ? ' ⚠' : ''}`
      : `needs ${CHI_SQUARED_MIN_ROLLS} rolls`;

  const camera = recog.camera;
  const cameraTotal = camera.kept + camera.corrected + camera.voided;
  const cameraLine = cameraTotal
    ? `${camera.kept} of ${cameraTotal} camera rolls kept unchanged, ${camera.corrected} corrected, ${camera.voided} voided.`
    : 'No real camera rolls yet, so recognition accuracy is unmeasured.';

  return `
  <div class="tiles">
    <div class="tile"><div class="tile-label">Rolls</div><div class="tile-value">${stats.count}</div></div>
    <div class="tile"><div class="tile-label">Sevens</div><div class="tile-value">${stats.sevens}</div>
      <div class="tile-sub">${stats.count ? pct(stats.sevenRate) : '–'} (expected 16.7%)</div></div>
    <div class="tile"><div class="tile-label">Mean total</div><div class="tile-value">${stats.count ? stats.mean.toFixed(2) : '–'}</div><div class="tile-sub">expected 7.00</div></div>
    <div class="tile"><div class="tile-label">Doubles</div><div class="tile-value">${stats.doubles}</div>
      <div class="tile-sub">${stats.count ? pct(stats.doubles / stats.count) : '–'} (expected 16.7%)</div></div>
    <div class="tile"><div class="tile-label">χ² against fair dice</div><div class="tile-value ${stats.chiSquaredUsable ? '' : 'small'}">${chi}</div><div class="tile-sub">above 18.3 is unusual (5% level)</div></div>
  </div>
  <section class="card"><h3>Actual versus theoretical frequency</h3>${distributionChart(stats.rows)}</section>
  <section class="card"><h3>Overall distance from theoretical distribution</h3>
    <p class="muted small">Total variation distance after each roll: 0% is a perfect match. It should fall as rolls accumulate.</p>
    ${lineChart({ series: [{ name: 'Distance', color: 'var(--series-1)', values: stats.deviationSeries }], yFormat: (v) => pct(v, 0), label: 'Distance from theoretical distribution over time' })}
  </section>
  <section class="card"><h3>By total</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Total</th><th class="num">Count</th><th class="num">Actual</th><th class="num">Theoretical</th><th class="num">Expected</th><th class="num">Deviation</th><th class="num">Longest gap</th><th class="num">Rolls since last</th></tr></thead>
      <tbody>${stats.rows.map((r) => `<tr><td><b>${r.total}</b></td><td class="num">${r.count}</td><td class="num">${pct(r.actual)}</td><td class="num">${pct(r.theoretical, 2)}</td><td class="num">${r.expected.toFixed(1)}</td><td class="num">${stats.count ? signed(r.deviation) : '–'}</td><td class="num">${stats.count ? r.longestGap : '–'}</td><td class="num">${stats.count ? r.currentGap : '–'}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="muted small">Die faces (both dice combined, expected ${stats.count ? (stats.count / 3).toFixed(1) : '–'} each): ${stats.faces.map((n, i) => `<b>${i + 1}</b>: ${n}`).join(' · ')}</p>
  </section>
  <section class="card"><h3>Roll history</h3>
    <p class="muted small">${esc(cameraLine)} Corrections and voids stay in the log, and production is recalculated from them.</p>
    ${historyTable(state, ui)}
  </section>`;
}

function historyTable(state, ui) {
  if (!state.rolls.length) return '<p class="empty">No rolls recorded.</p>';
  const rows = [...state.rolls].reverse().map((r) => {
    const editing = ui.editingRoll === r.eventId;
    const options = (selected) => [1, 2, 3, 4, 5, 6].map((v) => `<option ${v === selected ? 'selected' : ''}>${v}</option>`).join('');
    const value = editing
      ? `<select id="edit-d1" aria-label="Die 1">${options(r.d1)}</select> <select id="edit-d2" aria-label="Die 2">${options(r.d2)}</select>`
      : `${dieFace(r.d1, 22)} ${dieFace(r.d2, 22)}`;
    const actions = editing
      ? `<button class="btn tiny primary" data-action="save-roll" data-id="${esc(r.eventId)}">Save</button> <button class="btn tiny" data-action="cancel-edit">Cancel</button>`
      : `${ui.snapshots.has(r.eventId) ? `<button class="btn tiny" data-action="show-frame" data-id="${esc(r.eventId)}">Frame</button> ` : ''}<button class="btn tiny" data-action="edit-roll" data-id="${esc(r.eventId)}">Edit</button> <button class="btn tiny" data-action="void" data-id="${esc(r.eventId)}">Void</button>`;
    return `<tr>
      <td class="num">${r.index + 1}</td><td class="num">${time(r.ts)}</td><td>${esc(playerName(state, r.player))}</td>
      <td class="nowrap">${value}</td><td class="num"><b>${r.total}</b></td>
      <td>${originBadge(r.origin)}${r.corrected ? ` <span class="badge" title="Camera read ${r.detected.d1}+${r.detected.d2}">was ${r.detected.d1}+${r.detected.d2}</span>` : ''}</td>
      <td class="num">${r.confidence == null ? '–' : pct(r.confidence, 0)}</td>
      <td class="nowrap">${actions}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th class="num">#</th><th class="num">Time</th><th>Turn (inferred)</th><th>Dice</th><th class="num">Total</th><th>Origin</th><th class="num">Confidence</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

const TERRAIN_LABEL = {
  hills: 'Hills', forest: 'Forest', pasture: 'Pasture', fields: 'Fields', mountains: 'Mountains', desert: 'Desert',
};

export function boardSvg(state, ui) {
  const size = 58;
  const px = (x, y) => toPixel(x, y, size);
  const editing = ui.boardMode === 'layout';
  const config = editing ? ui.draft : state.board;
  const latest = state.rolls.at(-1)?.total;
  const player = ui.selectedPlayer;
  const color = (id) => state.players.find((p) => p.id === id)?.color;
  const pieceVar = (id) => `var(--piece-${COLORS.has(color(id)) ? color(id) : 'white'})`;

  const hexes = TOPOLOGY.hexes.map((h) => {
    const cfg = config?.[h.id] ?? {};
    const points = h.corners.map((c) => px(TOPOLOGY.vertices[c].x, TOPOLOGY.vertices[c].y).join(',')).join(' ');
    const [cx, cy] = px(h.x, h.y);
    const clickable = editing || (ui.boardMode === 'robber' && !checkRobber(state, h.id));
    const hot = !editing && cfg.number != null && cfg.number === latest && h.id !== state.robberHex;
    const number = cfg.number != null
      ? `<circle class="token" cx="${cx}" cy="${cy + 2}" r="17"></circle>
         <text class="token-num ${cfg.number === 6 || cfg.number === 8 ? 'hot' : ''}" x="${cx}" y="${cy + 8}" text-anchor="middle">${cfg.number}</text>`
      : '';
    const terrainText = cfg.terrain
      ? `<text class="terrain-label" x="${cx}" y="${cy - 25}" text-anchor="middle">${TERRAIN_LABEL[cfg.terrain]}</text>`
      : `<text class="terrain-label" x="${cx}" y="${cy + 4}" text-anchor="middle">H${h.id}</text>`;
    return `<polygon class="hex t-${esc(cfg.terrain ?? 'none')} ${hot ? 'hit-now' : ''} ${clickable ? 'clickable' : ''}" points="${points}" ${clickable ? `data-hex="${h.id}" role="button" tabindex="0" aria-label="Hex ${h.id}"` : ''}></polygon>${terrainText}${number}`;
  }).join('');

  const roads = [...state.roads.entries()].map(([id, owner]) => {
    const e = TOPOLOGY.edges[id];
    const [x1, y1] = px(TOPOLOGY.vertices[e.a].x, TOPOLOGY.vertices[e.a].y);
    const [x2, y2] = px(TOPOLOGY.vertices[e.b].x, TOPOLOGY.vertices[e.b].y);
    return `<line class="road-out" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>
      <line class="road" style="stroke:${pieceVar(owner)}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>`;
  }).join('');

  const buildings = [...state.buildings.entries()].map(([id, b]) => {
    const v = TOPOLOGY.vertices[id];
    const [x, y] = px(v.x, v.y);
    const s = b.kind === 'city' ? 1.35 : 1;
    const path = b.kind === 'city'
      ? 'M-11,9V-3L-4,-9L3,-3V0H11V9Z'
      : 'M-8,8V-2L0,-9L8,-2V8Z';
    return `<path class="piece" style="fill:${pieceVar(b.player)}" transform="translate(${x},${y}) scale(${s})" d="${path}"><title>${esc(playerName(state, b.player))} ${b.kind}</title></path>`;
  }).join('');

  let targets = '';
  if (ui.boardMode === 'settlement' || ui.boardMode === 'city') {
    const check = ui.boardMode === 'city' ? checkCity : checkSettlement;
    targets = TOPOLOGY.vertices.filter((v) => !check(state, player, v.id)).map((v) => {
      const [x, y] = px(v.x, v.y);
      return `<circle class="target" cx="${x}" cy="${y}" r="9" data-vertex="${v.id}" role="button" tabindex="0" aria-label="Intersection ${v.id}"></circle>`;
    }).join('');
  } else if (ui.boardMode === 'road') {
    targets = TOPOLOGY.edges.filter((e) => !checkRoad(state, player, e.id)).map((e) => {
      const [x1, y1] = px(TOPOLOGY.vertices[e.a].x, TOPOLOGY.vertices[e.a].y);
      const [x2, y2] = px(TOPOLOGY.vertices[e.b].x, TOPOLOGY.vertices[e.b].y);
      return `<line class="target-edge" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" data-edge="${e.id}" role="button" tabindex="0" aria-label="Edge ${e.id}"></line>`;
    }).join('');
  }

  let robber = '';
  if (!editing && state.robberHex != null) {
    const h = TOPOLOGY.hexes[state.robberHex];
    const [x, y] = px(h.x, h.y);
    robber = `<g class="robber" transform="translate(${x + 26},${y + 22})"><circle r="7" cy="-11"></circle><path d="M-9,10C-9,-6 9,-6 9,10Z"></path><title>Robber</title></g>`;
  }

  const allX = TOPOLOGY.vertices.map((v) => px(v.x, v.y)[0]);
  const allY = TOPOLOGY.vertices.map((v) => px(v.x, v.y)[1]);
  const pad = 22;
  const box = [Math.min(...allX) - pad, Math.min(...allY) - pad, Math.max(...allX) - Math.min(...allX) + pad * 2, Math.max(...allY) - Math.min(...allY) + pad * 2];
  return `<svg class="board" viewBox="${box.join(' ')}" aria-label="Game board">${hexes}${roads}${buildings}${targets}${robber}</svg>`;
}

export function boardTab(state, ui) {
  const editing = ui.boardMode === 'layout';
  const modeBtn = (mode, label, disabled = false) => `<button class="seg ${ui.boardMode === mode ? 'on' : ''}" data-action="board-mode" data-mode="${mode}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  const noBoard = !state.board;

  let side = '';
  if (editing) {
    const check = checkBoard(ui.draft);
    const brushBtn = (key, label, cls = '') => `<button class="chip ${cls} ${ui.brush === key ? 'on' : ''}" data-action="brush" data-brush="${key}">${label}</button>`;
    side = `
      <h3>Match your physical board</h3>
      <p class="muted small">Pick a terrain or number, then click hexes. Layout is entered by hand in this version.</p>
      <div class="chips">${TERRAINS.map((t) => brushBtn(`t:${t}`, TERRAIN_LABEL[t], `t-${t}`)).join('')}</div>
      <div class="chips">${[2, 3, 4, 5, 6, 8, 9, 10, 11, 12].map((n) => brushBtn(`n:${n}`, n)).join('')}</div>
      <div class="row">
        <button class="btn" data-action="board-random">Random legal layout</button>
        <button class="btn" data-action="board-clear">Clear</button>
      </div>
      <div class="row">
        <button class="btn primary" data-action="board-save" ${check.errors.length ? 'disabled' : ''}>Save layout</button>
        ${noBoard ? '' : '<button class="btn" data-action="board-cancel">Cancel</button>'}
      </div>
      ${check.errors.length ? `<p class="small muted">${check.errors.length} of 19 hexes still incomplete.</p>` : '<p class="small ok">All hexes configured.</p>'}
      ${check.warnings.map((w) => `<p class="small warn">⚠ ${esc(w)}</p>`).join('')}`;
  } else {
    const lastRoll = state.rolls.at(-1);
    const hint = {
      settlement: 'Click a highlighted intersection. Only legal spots are shown.',
      city: 'Click one of this player\'s settlements.',
      road: 'Click a highlighted edge. A road must connect to the player\'s own pieces.',
      robber: 'Click the hex the robber moved to.',
    }[ui.boardMode];
    side = `
      <h3>Record a change</h3>
      ${ui.boardMode !== 'robber' ? `<div class="chips">${state.players.map((p) => `<button class="chip ${ui.selectedPlayer === p.id ? 'on' : ''}" data-action="select-player" data-id="${esc(p.id)}">${dot(p.color)}${esc(p.name)}</button>`).join('')}</div>` : ''}
      <p class="muted small">${hint}</p>
      <p class="small">Robber on <b>${state.robberHex == null ? 'no hex' : `H${state.robberHex}`}</b>${state.needsRobberMove ? ' · <span class="warn">⚠ waiting for a move after the 7</span>' : ''}</p>
      ${lastRoll ? `<h3>Last roll: ${lastRoll.total}</h3><p class="small">${productionSummary(state, lastRoll)}</p>` : ''}
      <p class="small muted">Highlighted hexes matched the last roll. Mistakes can be reversed with Undo or from the Timeline.</p>`;
  }
  return `
    <div class="seg-row" role="group" aria-label="Board tool">
      ${modeBtn('layout', 'Layout')}${modeBtn('settlement', 'Settlement', noBoard)}${modeBtn('city', 'City', noBoard)}${modeBtn('road', 'Road', noBoard)}${modeBtn('robber', 'Robber', noBoard)}
    </div>
    <div class="board-layout"><div class="board-wrap">${boardSvg(state, ui)}</div><aside class="card board-side">${side}</aside></div>`;
}

export function playersTab(state) {
  const players = playerSummaries(state);
  const rollStats = playerRollStats(state.rolls, state.players);
  const running = Object.fromEntries(players.map((p) => [p.id, 0]));
  const cumulative = Object.fromEntries(players.map((p) => [p.id, []]));
  for (const roll of state.rolls) {
    for (const p of players) {
      const made = Object.values(roll.production?.byPlayer[p.id] ?? {}).reduce((a, b) => a + b, 0);
      running[p.id] += made;
      cumulative[p.id].push(running[p.id]);
    }
  }
  const byRes = RESOURCE_STACK.map((r) => players.reduce((sum, p) => sum + p.produced[r], 0));
  const flags = (p) => [p.longestRoad ? 'Longest Road' : '', p.largestArmy ? 'Largest Army' : ''].filter(Boolean).join(', ');

  return `
  <section class="card"><h3>Players</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Player</th><th class="num">Visible VP</th><th class="num">Settlements</th><th class="num">Cities</th><th class="num">Roads</th><th class="num">Longest chain</th><th class="num">Knights</th><th>Awards</th><th class="num">Rolls</th><th class="num">Sevens</th><th class="num">Mean roll</th></tr></thead>
      <tbody>${players.map((p, i) => `<tr><td class="nowrap">${dot(p.color)}<b>${esc(p.name)}</b></td><td class="num"><b>${p.visibleVP}</b></td><td class="num">${p.settlements}</td><td class="num">${p.cities}</td><td class="num">${p.roads}</td><td class="num">${p.roadLength}</td>
        <td class="num nowrap">${p.knights} <button class="btn tiny" data-action="knight" data-id="${esc(p.id)}" aria-label="Record a knight played by ${esc(p.name)}">+1</button></td>
        <td>${esc(flags(p)) || '<span class="muted">–</span>'}</td><td class="num">${rollStats[i].rolls}</td><td class="num">${rollStats[i].sevens}</td><td class="num">${rollStats[i].rolls ? rollStats[i].mean.toFixed(2) : '–'}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="muted small">Visible VP counts buildings and awards only. Hidden victory-point cards are not included. Turns are inferred from seating order, one per roll.</p>
  </section>
  <section class="card"><h3>Resources produced from dice</h3>
    ${stackedBars(players.map((p) => ({
    label: p.name,
    segments: RESOURCE_STACK.map((r) => ({ name: r, value: p.produced[r], color: RESOURCE_COLOR[r] })),
  })), RESOURCE_STACK.map((r) => ({ name: r, color: RESOURCE_COLOR[r] })))}
    <div class="table-wrap"><table>
      <thead><tr><th>Player</th>${RESOURCE_STACK.map((r) => `<th class="num">${r}</th>`).join('')}<th class="num">Total</th><th class="num">Blocked by robber</th></tr></thead>
      <tbody>${players.map((p) => `<tr><td class="nowrap">${dot(p.color)}${esc(p.name)}</td>${RESOURCE_STACK.map((r) => `<td class="num">${p.produced[r]}</td>`).join('')}<td class="num"><b>${p.totalProduced}</b></td><td class="num">${RESOURCES.reduce((sum, r) => sum + p.lostToRobber[r], 0)}</td></tr>`).join('')}
      <tr><td><b>All players</b></td>${byRes.map((n) => `<td class="num"><b>${n}</b></td>`).join('')}<td class="num"><b>${byRes.reduce((a, b) => a + b, 0)}</b></td><td></td></tr></tbody>
    </table></div>
    <div class="note"><b>These are not card holdings.</b> Trades, spending, steals and discards aren't tracked yet, so this app doesn't show inventories. Starting-placement resources are not counted, and the bank-shortage rule is not applied because the bank's stock is unknown. Totals are what the dice entitled each player to.</div>
  </section>
  <section class="card"><h3>Production over time</h3>
    ${lineChart({
    series: players.map((p) => ({ name: p.name, color: playerVar(p.color), values: cumulative[p.id] })),
    yFormat: (v) => String(Math.round(v * 10) / 10),
    label: 'Cumulative resources produced by each player',
    labelEnds: true,
    height: 240,
  })}
  </section>`;
}

const EVENT_TEXT = {
  GameStarted: (e) => `Game "${e.name}" started with ${e.players.length} players`,
  BoardConfigured: () => 'Board layout saved',
  DiceRolled: (e) => `Dice rolled: ${e.d1} + ${e.d2} = ${e.d1 + e.d2}`,
  RollCorrected: (e) => `Roll corrected to ${e.d1} + ${e.d2} = ${e.d1 + e.d2}`,
  SettlementBuilt: (e, s) => `${playerName(s, e.player)} built a settlement on I${e.vertex}`,
  CityBuilt: (e, s) => `${playerName(s, e.player)} built a city on I${e.vertex}`,
  RoadBuilt: (e, s) => `${playerName(s, e.player)} built a road on E${e.edge}`,
  RobberMoved: (e) => `Robber moved to H${e.hex}`,
  DevelopmentCardPlayed: (e, s) => `${playerName(s, e.player)} played a ${e.card}`,
  EventVoided: () => 'Undo: cancelled an earlier event',
};

export function describeEvent(event, state) {
  return (EVENT_TEXT[event.type] ?? (() => event.type))(event, state);
}

export function timelineTab(state) {
  const rows = [...state.timeline].reverse().map(({ event: e, voided, rejected }) => {
    const text = describeEvent(e, state);
    const action = e.type === 'GameStarted' ? '' : voided
      ? `<button class="btn tiny" data-action="restore" data-id="${esc(e.id)}">Restore</button>`
      : `<button class="btn tiny" data-action="void" data-id="${esc(e.id)}">Void</button>`;
    return `<li class="${voided ? 'voided' : ''}">
      <span class="muted small tl-time">${time(e.ts)}</span>
      <span class="tl-text">${esc(text)}${voided ? ' <span class="badge">voided</span>' : ''}${rejected ? ` <span class="warn small">⚠ no longer valid: ${esc(rejected)}</span>` : ''}</span>
      ${originBadge(e.origin)}${action}</li>`;
  }).join('');
  return `<section class="card"><h3>Event log</h3>
    <p class="muted small">Everything the app knows is rebuilt from this list. Nothing is erased, and corrections are appended as new events.</p>
    <ul class="timeline">${rows}</ul></section>`;
}

export function gamesTab(games, currentId) {
  const rows = games.map(({ meta, state }) => {
    const s = diceStats(state.rolls);
    const recog = recognitionStats(state.timeline, state.rolls);
    return `<tr>
      <td>${esc(meta.name)}${meta.id === currentId ? ' <span class="badge">open</span>' : ''}</td>
      <td class="num">${new Date(meta.createdAt).toLocaleDateString()}</td>
      <td class="num">${s.count}</td><td class="num">${s.count ? pct(s.sevenRate) : '–'}</td><td class="num">${s.count ? s.mean.toFixed(2) : '–'}</td>
      <td class="num">${s.count ? pct(s.deviationSeries.at(-1)) : '–'}</td>
      <td class="num">${s.chiSquaredUsable ? s.chiSquared.toFixed(1) : '–'}</td>
      <td class="num">${recog.camera.kept + recog.camera.corrected}</td><td class="num">${recog.simulated.kept + recog.simulated.corrected}</td>
      <td>${meta.id === currentId ? '' : `<button class="btn tiny" data-action="open-game" data-id="${esc(meta.id)}">Open</button>`}</td></tr>`;
  }).join('');
  return `<section class="card"><h3>Compare games</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>Game</th><th class="num">Started</th><th class="num">Rolls</th><th class="num">Sevens</th><th class="num">Mean</th><th class="num">Distance from theory</th><th class="num">χ²</th><th class="num">Camera rolls</th><th class="num">Simulated</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="muted small">χ² appears after ${CHI_SQUARED_MIN_ROLLS} rolls, because a single game is rarely enough to say anything about the dice. Games are stored in this browser, so export them to keep a backup.</p>
    <div class="row"><label class="btn">Import game JSON<input type="file" id="import-file" accept="application/json,.json" hidden></label></div>
  </section>`;
}
