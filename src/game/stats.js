// Derived dice statistics and CSV export. Every function takes the rolls from replay().
export const TOTALS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
export const THEORETICAL = Object.fromEntries(TOTALS.map((t) => [t, (6 - Math.abs(7 - t)) / 36]));
// Rarest totals need an expected count of at least 5 for chi-squared to mean anything.
export const CHI_SQUARED_MIN_ROLLS = 180;
const CHI_SQUARED_CRITICAL_5PCT_DF10 = 18.31;

export function diceStats(rolls) {
  const n = rolls.length;
  const freq = Object.fromEntries(TOTALS.map((t) => [t, 0]));
  const faces = [0, 0, 0, 0, 0, 0];
  const lastSeen = Object.fromEntries(TOTALS.map((t) => [t, -1]));
  const longestGap = Object.fromEntries(TOTALS.map((t) => [t, 0]));
  const deviationSeries = [];
  let doubles = 0;
  let sum = 0;

  rolls.forEach((roll, i) => {
    freq[roll.total]++;
    faces[roll.d1 - 1]++;
    faces[roll.d2 - 1]++;
    if (roll.d1 === roll.d2) doubles++;
    sum += roll.total;
    longestGap[roll.total] = Math.max(longestGap[roll.total], i - lastSeen[roll.total] - 1);
    lastSeen[roll.total] = i;
    // Total variation distance: 0 means a perfect match, 1 means completely disjoint.
    const seen = i + 1;
    deviationSeries.push(
      TOTALS.reduce((acc, t) => acc + Math.abs(freq[t] / seen - THEORETICAL[t]), 0) / 2,
    );
  });

  const rows = TOTALS.map((t) => {
    // A number still waiting at the end of the log is an open gap and may be the longest.
    const currentGap = n - lastSeen[t] - 1;
    const expected = n * THEORETICAL[t];
    return {
      total: t,
      count: freq[t],
      actual: n ? freq[t] / n : 0,
      theoretical: THEORETICAL[t],
      expected,
      deviation: freq[t] - expected,
      longestGap: Math.max(longestGap[t], currentGap),
      currentGap,
    };
  });

  const chiSquared = n
    ? rows.reduce((acc, r) => acc + (r.count - r.expected) ** 2 / r.expected, 0)
    : 0;

  return {
    count: n,
    rows,
    faces,
    doubles,
    sevens: freq[7],
    sevenRate: n ? freq[7] / n : 0,
    mean: n ? sum / n : 0,
    deviationSeries,
    chiSquared,
    chiSquaredUsable: n >= CHI_SQUARED_MIN_ROLLS,
    chiSquaredSuspicious: n >= CHI_SQUARED_MIN_ROLLS && chiSquared > CHI_SQUARED_CRITICAL_5PCT_DF10,
  };
}

export function playerRollStats(rolls, players) {
  return players.map((p) => {
    const own = rolls.filter((r) => r.player === p.id);
    return {
      ...p,
      rolls: own.length,
      sevens: own.filter((r) => r.total === 7).length,
      mean: own.length ? own.reduce((sum, r) => sum + r.total, 0) / own.length : 0,
    };
  });
}

/** How often a human had to overrule the camera, measured on non-simulated rolls only. */
export function recognitionStats(timeline, rolls) {
  const byOrigin = (origin) => ({
    kept: rolls.filter((r) => r.origin === origin && !r.corrected).length,
    corrected: rolls.filter((r) => r.origin === origin && r.corrected).length,
    voided: timeline.filter(
      (t) => t.event.type === 'DiceRolled' && t.event.origin === origin && t.voided,
    ).length,
  });
  return { camera: byOrigin('camera'), simulated: byOrigin('simulated') };
}

function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Stops a player name from running as a formula when the file opens in a spreadsheet.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rollsToCsv(state) {
  const name = (id) => state.players.find((p) => p.id === id)?.name ?? '';
  const header = [
    'game', 'roll', 'timestamp', 'player_inferred', 'die_1', 'die_2', 'total', 'origin',
    'confidence', 'corrected', 'detected_as', 'production',
  ];
  const lines = state.rolls.map((r) => {
    const production = r.production
      ? Object.entries(r.production.byPlayer)
        .map(([p, res]) => `${name(p)}: ${Object.entries(res).map(([k, v]) => `${v} ${k}`).join(' ')}`)
        .join('; ')
      : '';
    return [
      state.game?.name, r.index + 1, r.ts, name(r.player), r.d1, r.d2, r.total, r.origin,
      r.confidence == null ? '' : r.confidence.toFixed(3),
      r.corrected, r.detected ? `${r.detected.d1}+${r.detected.d2}` : '', production,
    ].map(csvCell).join(',');
  });
  return [header.join(','), ...lines].join('\r\n');
}
