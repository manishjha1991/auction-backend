/**
 * Point table + NRR for historical CPL databases (read-only).
 * Mirrors logic in routes/user.js and scripts/cpl-points-table-pdf.js
 */

const parseRuns = (scoreString) => {
  if (!scoreString) return 0;
  const scoreStr = String(scoreString).trim();
  if (['null', 'TBD', 'NA', '', 'undefined'].includes(scoreStr) || scoreStr.toLowerCase() === 'null') return 0;
  const match = scoreStr.match(/^(\d+)/);
  if (match) return parseInt(match[1], 10) || 0;
  const num = parseFloat(scoreStr);
  return isNaN(num) ? 0 : Math.floor(num);
};

const parseWickets = (scoreString) => {
  if (!scoreString) return 0;
  const scoreStr = String(scoreString).trim();
  if (['null', 'TBD', 'NA', '', 'undefined'].includes(scoreStr) || scoreStr.toLowerCase() === 'null') return 0;
  const slashMatch = scoreStr.match(/\/(\d+)/);
  if (slashMatch) {
    const w = parseInt(slashMatch[1], 10);
    if (!isNaN(w) && w >= 0 && w <= 10) return w;
  }
  const hyphenMatch = scoreStr.match(/-(\d+)/);
  if (hyphenMatch) {
    const w = parseInt(hyphenMatch[1], 10);
    if (!isNaN(w) && w >= 0 && w <= 10) return w;
  }
  return 0;
};

const parseOvers = (oversString) => {
  if (!oversString) return null;
  const oversStr = String(oversString).trim();
  if (['null', 'TBD', 'NA', '', 'undefined'].includes(oversStr) || oversStr.toLowerCase() === 'null') return null;
  const decimalMatch = oversStr.match(/^(\d+)\.(\d+)$/);
  if (decimalMatch) {
    const overs = parseInt(decimalMatch[1], 10);
    const balls = parseInt(decimalMatch[2], 10);
    if (!isNaN(overs) && !isNaN(balls) && balls >= 0 && balls <= 5) return overs + balls / 6;
  }
  const wholeMatch = oversStr.match(/^(\d+)$/);
  if (wholeMatch) return parseInt(wholeMatch[1], 10) || null;
  const num = parseFloat(oversStr);
  return !isNaN(num) && num >= 0 ? num : null;
};

const DEFAULT_OVERS = 20;

const calculateNRR = (fixtures, teamName, userId) => {
  let totalRunsScored = 0;
  let totalRunsConceded = 0;
  let totalOversFaced = 0;
  let totalOversBowled = 0;
  const userIdStr = userId ? userId.toString() : null;

  fixtures.forEach((fx) => {
    if (!fx.winner) return;
    const team1Runs = parseRuns(fx.team1Score);
    const team2Runs = parseRuns(fx.team2Score);
    if (team1Runs === 0 && team2Runs === 0) return;

    const team1Wickets = parseWickets(fx.team1Score);
    const team2Wickets = parseWickets(fx.team2Score);
    const team1OversActual = parseOvers(fx.team1Overs) ?? DEFAULT_OVERS;
    const team2OversActual = parseOvers(fx.team2Overs) ?? DEFAULT_OVERS;

    const team1OversFaced = team1Wickets === 10 ? DEFAULT_OVERS : team1OversActual;
    const team2OversFaced = team2Wickets === 10 ? DEFAULT_OVERS : team2OversActual;
    const team1OversBowled = team2Wickets === 10 ? DEFAULT_OVERS : team2OversActual;
    const team2OversBowled = team1Wickets === 10 ? DEFAULT_OVERS : team1OversActual;

    const team1UserIdStr = fx.team1UserId ? fx.team1UserId.toString() : null;
    const team2UserIdStr = fx.team2UserId ? fx.team2UserId.toString() : null;

    let isTeam1 = false;
    let isTeam2 = false;
    if (userIdStr) {
      if (team1UserIdStr === userIdStr) isTeam1 = true;
      else if (team2UserIdStr === userIdStr) isTeam2 = true;
    }
    if (!isTeam1 && !isTeam2) {
      if (fx.team1 && fx.team1.trim().toLowerCase() === (teamName || '').trim().toLowerCase()) isTeam1 = true;
      else if (fx.team2 && fx.team2.trim().toLowerCase() === (teamName || '').trim().toLowerCase()) isTeam2 = true;
    }
    if (!isTeam1 && !isTeam2) return;

    if (isTeam1) {
      totalRunsScored += team1Runs;
      totalRunsConceded += team2Runs;
      totalOversFaced += team1OversFaced;
      totalOversBowled += team1OversBowled;
    } else {
      totalRunsScored += team2Runs;
      totalRunsConceded += team1Runs;
      totalOversFaced += team2OversFaced;
      totalOversBowled += team2OversBowled;
    }
  });

  if (totalOversFaced === 0 || totalOversBowled === 0) return 0;
  const runsScoredPerOver = totalRunsScored / totalOversFaced;
  const runsConcededPerOver = totalRunsConceded / totalOversBowled;
  return parseFloat((runsScoredPerOver - runsConcededPerOver).toFixed(3));
};

/**
 * @param {import('mongoose').Connection} conn
 */
async function fetchPointTableFromConnection(conn) {
  const db = conn.db;
  const [users, fixtures] = await Promise.all([
    db
      .collection('users')
      .find({
        teamName: { $exists: true, $ne: null, $ne: 'NA' },
        isActive: true,
        isAdmin: { $ne: true },
      })
      .project({ _id: 1, teamName: 1, abbreviation: 1, points: 1, matchesPlayed: 1, fairnessPoint: 1 })
      .toArray(),
    db
      .collection('fixtures')
      .find({
        isActive: true,
        winner: { $ne: null, $exists: true },
      })
      .project({
        team1: 1,
        team2: 1,
        team1UserId: 1,
        team2UserId: 1,
        team1Score: 1,
        team2Score: 1,
        team1Overs: 1,
        team2Overs: 1,
        winner: 1,
      })
      .toArray(),
  ]);

  const table = users.map((user) => {
    const matchesPlayed = user.matchesPlayed || 0;
    const points = user.points || 0;
    const fairness = user.fairnessPoint || 0;
    const nrr = calculateNRR(fixtures, user.teamName, user._id);
    const displayName = user.abbreviation || user.teamName || 'Unknown';
    return {
      rank: 0,
      teamName: displayName,
      fullTeamName: user.teamName || displayName,
      points,
      fairness,
      nrr,
      matchesPlayed,
      wins: Math.floor(points / 2),
      losses: matchesPlayed - Math.floor(points / 2),
    };
  });

  table.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const nrrA = a.nrr || 0;
    const nrrB = b.nrr || 0;
    if (nrrB !== nrrA) return nrrB - nrrA;
    if (b.fairness !== a.fairness) return b.fairness - a.fairness;
    if (a.matchesPlayed !== b.matchesPlayed) return a.matchesPlayed - b.matchesPlayed;
    return (a.teamName || '').localeCompare(b.teamName || '');
  });

  table.forEach((t, i) => {
    t.rank = i + 1;
  });

  return { table, fixtureCount: fixtures.length };
}

/**
 * Completed final from playofffixtures: matchId F (normal/groups) or WCF (World Cup).
 */
async function fetchPlayoffFinalWinner(conn) {
  const db = conn.db;
  const col = db.collection('playofffixtures');
  const arr = await col
    .find({
      matchId: { $in: ['F', 'WCF'] },
      winner: { $nin: [null, '', 'TBD', 'tbd'] },
    })
    .sort({ updatedAt: -1 })
    .limit(1)
    .toArray();
  const doc = arr[0] || null;
  if (!doc) return null;
  return {
    teamName: doc.winner,
    winnerUserId: doc.winnerUserId ? String(doc.winnerUserId) : null,
    matchId: doc.matchId,
    stage: doc.stage || null,
    team1: doc.team1,
    team2: doc.team2,
    team1Score: doc.team1Score,
    team2Score: doc.team2Score,
    margin: doc.margin || null,
    isCompleted: doc.isCompleted === true,
  };
}

function normalizeTeamKey(s) {
  return String(s || '')
    .replace(/\p{Emoji}/gu, '')
    .trim()
    .toLowerCase();
}

/**
 * Merge playoff winner with league row (abbreviation / full name match).
 */
function enrichChampionFromTable(playoffWinner, table) {
  if (!playoffWinner || !playoffWinner.teamName) return null;
  const target = normalizeTeamKey(playoffWinner.teamName);
  const row = table.find((r) => {
    const a = normalizeTeamKey(r.teamName);
    const b = normalizeTeamKey(r.fullTeamName);
    return a === target || b === target;
  });
  if (row) {
    return {
      ...row,
      source: 'playoff',
      playoffMatchId: playoffWinner.matchId,
      playoffStage: playoffWinner.stage,
      finalOpponent:
        normalizeTeamKey(playoffWinner.team1) === target ? playoffWinner.team2 : playoffWinner.team1,
      finalScores: `${playoffWinner.team1Score ?? '-'} vs ${playoffWinner.team2Score ?? '-'}`,
    };
  }
  return {
    rank: null,
    teamName: playoffWinner.teamName,
    fullTeamName: playoffWinner.teamName,
    points: null,
    fairness: null,
    nrr: null,
    matchesPlayed: null,
    wins: null,
    losses: null,
    source: 'playoff_only',
    playoffMatchId: playoffWinner.matchId,
    playoffStage: playoffWinner.stage,
    finalScores: `${playoffWinner.team1Score ?? '-'} vs ${playoffWinner.team2Score ?? '-'}`,
  };
}

function buildSeasonInsights(table) {
  if (!table.length) return null;
  const champion = table[0];
  const second = table[1];
  const gap = second ? champion.points - second.points : null;
  let bestNrr = table[0];
  for (const row of table) {
    if ((row.nrr || 0) > (bestNrr.nrr || 0)) bestNrr = row;
  }
  let highestFairness = table[0];
  for (const row of table) {
    if ((row.fairness || 0) > (highestFairness.fairness || 0)) highestFairness = row;
  }
  return {
    pointsLeader: champion.teamName,
    pointsLeaderValue: champion.points,
    runnerUp: second ? second.teamName : null,
    titleMarginPoints: gap,
    titleRaceNote:
      gap === 0
        ? 'Title decided on NRR / fairness tie-breakers.'
        : gap === 2
          ? 'One-win margin at the top.'
          : gap > 2
            ? `${gap} points clear at the top.`
            : 'Close finish at the top.',
    bestNrrTeam: bestNrr.teamName,
    bestNrrValue: bestNrr.nrr,
    highestFairnessTeam: highestFairness.teamName,
    highestFairnessValue: highestFairness.fairness,
  };
}

function economyFromBowling(ballsBowled, runsGiven) {
  const b = Number(ballsBowled) || 0;
  const r = Number(runsGiven) || 0;
  if (b < 36) return null;
  return (r / b) * 6;
}

/** True if p should rank above q as leading wicket-taker */
function isBetterBowler(p, q) {
  if (!q) return true;
  if (p.wickets !== q.wickets) return p.wickets > q.wickets;
  const ep = economyFromBowling(p.ballsBowled, p.runsGiven);
  const eq = economyFromBowling(q.ballsBowled, q.runsGiven);
  if (ep != null && eq != null && ep !== eq) return ep < eq;
  if (ep != null && eq == null) return true;
  if (ep == null && eq != null) return false;
  return p.ballsBowled > q.ballsBowled;
}

/**
 * Aggregate playerstats for a historical season (no tournament-ready filter).
 * @param {import('mongoose').Connection} conn
 * @returns {Promise<{ bestBowler: object|null, bestAllRounder: object|null, bestAllRoundTeam: object|null }>}
 */
const WICKETS_EXPR = { $ifNull: ['$bowlingStats.wickets', 0] };

async function fetchSeasonPlayerHighlights(conn) {
  const db = conn.db;
  let perPlayerAgg = [];
  let perTeamAgg = [];
  let usersRaw = [];
  let playersRaw = [];
  try {
    ;[perPlayerAgg, perTeamAgg, usersRaw, playersRaw] = await Promise.all([
      db
        .collection('playerstats')
        .aggregate([
          { $match: { playerId: { $exists: true, $ne: null }, userId: { $exists: true, $ne: null } } },
          {
            $group: {
              _id: '$playerId',
              userId: { $last: '$userId' },
              runs: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
              wickets: { $sum: WICKETS_EXPR },
              ballsBowled: { $sum: { $ifNull: ['$bowlingStats.ballsBowled', 0] } },
              runsGiven: { $sum: { $ifNull: ['$bowlingStats.runsGiven', 0] } },
              mom: { $sum: { $cond: [{ $eq: ['$isMom', true] }, 1, 0] } },
              matches: { $sum: 1 },
              fiveWicketHauls: {
                $sum: { $cond: [{ $gte: [WICKETS_EXPR, 5] }, 1, 0] },
              },
              fourWicketHauls: {
                $sum: {
                  $cond: [
                    {
                      $and: [{ $gte: [WICKETS_EXPR, 4] }, { $lt: [WICKETS_EXPR, 5] }],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ])
        .toArray(),
      db
        .collection('playerstats')
        .aggregate([
          { $match: { userId: { $exists: true, $ne: null } } },
          {
            $group: {
              _id: '$userId',
              runs: { $sum: { $ifNull: ['$battingStats.runs', 0] } },
              wickets: { $sum: WICKETS_EXPR },
            },
          },
        ])
        .toArray(),
      db.collection('users').find({}).project({ _id: 1, teamName: 1, abbreviation: 1 }).toArray(),
      db.collection('players').find({}).project({ _id: 1, name: 1 }).toArray(),
    ]);
  } catch (e) {
    console.warn('fetchSeasonPlayerHighlights read error', e.message);
    return { bestBowler: null, bestAllRounder: null, bestAllRoundTeam: null };
  }

  const userTeam = new Map();
  for (const u of usersRaw) {
    const label = u.teamName || u.abbreviation || null;
    if (label) userTeam.set(String(u._id), label);
  }

  const playerName = new Map();
  for (const p of playersRaw) {
    playerName.set(String(p._id), p.name || null);
  }

  const players = perPlayerAgg.map((row) => ({
    playerId: String(row._id),
    userId: String(row.userId),
    runs: Number(row.runs) || 0,
    wickets: Number(row.wickets) || 0,
    ballsBowled: Number(row.ballsBowled) || 0,
    runsGiven: Number(row.runsGiven) || 0,
    mom: Number(row.mom) || 0,
    matches: Number(row.matches) || 0,
    fourWicketHauls: Number(row.fourWicketHauls) || 0,
    fiveWicketHauls: Number(row.fiveWicketHauls) || 0,
  }));

  /** @type {Record<string, { runs: number, wickets: number }>} */
  const byTeamUser = {};
  for (const row of perTeamAgg) {
    const uid = String(row._id);
    byTeamUser[uid] = {
      runs: Number(row.runs) || 0,
      wickets: Number(row.wickets) || 0,
    };
  }

  let bestBowlerRaw = null;
  for (const p of players) {
    if (p.wickets <= 0) continue;
    if (isBetterBowler(p, bestBowlerRaw)) bestBowlerRaw = p;
  }

  let bestARRaw = null;
  let bestARScore = -Infinity;
  for (const p of players) {
    const qualifies =
      (p.runs >= 30 && p.wickets >= 3) || (p.runs >= 50 && p.wickets >= 2) || (p.runs >= 80 && p.wickets >= 1);
    if (!qualifies) continue;
    const score = p.runs + p.wickets * 22 + p.mom * 8;
    if (score > bestARScore) {
      bestARScore = score;
      bestARRaw = p;
    }
  }

  let bestTeamRaw = null;
  let bestTeamScore = -Infinity;
  for (const [uid, tw] of Object.entries(byTeamUser)) {
    const score = tw.runs + tw.wickets * 15;
    if (score > bestTeamScore) {
      bestTeamScore = score;
      bestTeamRaw = {
        teamName: userTeam.get(uid) || 'Unknown',
        userId: uid,
        totalRuns: tw.runs,
        totalWickets: tw.wickets,
      };
    }
  }

  const shortId = (id) => (id && id.length > 6 ? id.slice(-6) : id || '');

  const formatBowler = (b) => {
    if (!b) return null;
    const econ = economyFromBowling(b.ballsBowled, b.runsGiven);
    const parts = [`${b.wickets} wickets`];
    if (b.fiveWicketHauls) parts.push(`${b.fiveWicketHauls}× 5w`);
    if (b.fourWicketHauls) parts.push(`${b.fourWicketHauls}× 4w`);
    if (econ != null) parts.push(`econ ${econ.toFixed(2)}`);
    if (b.mom) parts.push(`${b.mom}× MoM`);
    const nm = playerName.get(b.playerId) || `Player …${shortId(b.playerId)}`;
    return {
      playerName: nm,
      teamName: userTeam.get(b.userId) || null,
      totalWickets: b.wickets,
      fourWicketHauls: b.fourWicketHauls,
      fiveWicketHauls: b.fiveWicketHauls,
      economy: econ != null ? Number(econ.toFixed(3)) : null,
      momCount: b.mom,
      matchesPlayed: b.matches,
      achievement: parts.join(' · '),
    };
  };

  const formatAllRounder = (b) => {
    if (!b) return null;
    const parts = [`${b.runs} runs`, `${b.wickets} wkts`];
    if (b.mom) parts.push(`${b.mom}× MoM`);
    const nm = playerName.get(b.playerId) || `Player …${shortId(b.playerId)}`;
    return {
      playerName: nm,
      teamName: userTeam.get(b.userId) || null,
      totalRuns: b.runs,
      totalWickets: b.wickets,
      momCount: b.mom,
      matchesPlayed: b.matches,
      achievement: parts.join(' · '),
    };
  };

  const formatTeam = (t) => {
    if (!t || bestTeamScore <= 0) return null;
    return {
      teamName: t.teamName,
      squadRuns: t.totalRuns,
      squadWickets: t.totalWickets,
      achievement: `${t.totalRuns} runs & ${t.totalWickets} wickets (squad totals)`,
    };
  };

  return {
    bestBowler: formatBowler(bestBowlerRaw),
    bestAllRounder: formatAllRounder(bestARRaw),
    bestAllRoundTeam: formatTeam(bestTeamRaw),
  };
}

module.exports = {
  fetchPointTableFromConnection,
  fetchPlayoffFinalWinner,
  enrichChampionFromTable,
  buildSeasonInsights,
  fetchSeasonPlayerHighlights,
};
