const PlayerStats = require('../models/PlayerStats');
const Player = require('../models/Player');
const User = require('../models/User');
const PlayerCareerSummary = require('../models/PlayerCareerSummary');
const PlayerTeamTournamentStat = require('../models/PlayerTeamTournamentStat');
const { normalizePlayerName } = require('./playerIdentity');

/** Max rows stored per milestone list (50s/100s/spells). Totals use full dedupe count; lists were capped at 20 and no longer matched Total 50s/100s in UI when count > cap. */
const MAX_DETAILS = Math.max(
  20,
  Math.min(2000, parseInt(process.env.CPL_MILESTONE_MAX_DETAILS || '500', 10) || 500),
);

function normName(name) {
  return normalizePlayerName(name);
}

function safeDiv(a, b) {
  if (!b) return 0;
  return a / b;
}

function emptyBlock() {
  return {
    totalRuns: 0,
    totalBalls: 0,
    innings: 0,
    totalFifties: 0,
    totalHundreds: 0,
    highestScore: 0,
    totalWickets: 0,
    totalRunsGiven: 0,
    totalBallsBowled: 0,
    bowlingInnings: 0,
    battingStrikeRate: 0,
    battingAverage: 0,
    bowlingAverage: 0,
    bestBowling: '0/0',
    centuries: [],
    fifties: [],
    bestBowlingSpells: [],
  };
}

function sortCenturies(a, b) {
  if (b.runs !== a.runs) return b.runs - a.runs;
  if (a.balls !== b.balls) return a.balls - b.balls;
  const ad = a.date ? new Date(a.date).getTime() : 0;
  const bd = b.date ? new Date(b.date).getTime() : 0;
  return bd - ad;
}

function sortBowling(a, b) {
  if (b.wickets !== a.wickets) return b.wickets - a.wickets;
  if (a.runsGiven !== b.runsGiven) return a.runsGiven - b.runsGiven;
  if (a.ballsBowled !== b.ballsBowled) return a.ballsBowled - b.ballsBowled;
  const ad = a.date ? new Date(a.date).getTime() : 0;
  const bd = b.date ? new Date(b.date).getTime() : 0;
  return bd - ad;
}

/** Calendar day (UTC YYYY-MM-DD); empty if missing / invalid. */
function inningsDateKey(date) {
  if (date == null || date === '') return '';
  try {
    const t = new Date(date).getTime();
    if (Number.isNaN(t)) return '';
    return new Date(date).toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

function normOpp(team) {
  return String(team || '')
    .trim()
    .toLowerCase();
}

/** Duplicate = same score + balls + opponent + calendar day (batting). */
function battingMilestoneDedupeKey(c) {
  const dk = inningsDateKey(c.date);
  const opp = normOpp(c.opponentTeam);
  return `${Number(c.runs)}|${Number(c.balls)}|${opp}|${dk}`;
}

/** Duplicate = same figures + opponent + calendar day (bowling). */
function bowlingSpellDedupeKey(b) {
  const dk = inningsDateKey(b.date);
  const opp = normOpp(b.opponentTeam);
  return `${Number(b.wickets)}|${Number(b.runsGiven)}|${Number(b.ballsBowled)}|${opp}|${dk}`;
}

function dedupeBattingMilestones(items) {
  const seen = new Set();
  const out = [];
  for (const c of items || []) {
    const key = battingMilestoneDedupeKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function dedupeBowlingSpells(items) {
  const seen = new Set();
  const out = [];
  for (const b of items || []) {
    const key = bowlingSpellDedupeKey(b);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

function finalizeBlock(block) {
  const out = { ...block };
  let centuries = dedupeBattingMilestones(out.centuries || []);
  let fifties = dedupeBattingMilestones(out.fifties || []);
  let bestBowlingSpells = dedupeBowlingSpells(out.bestBowlingSpells || []);

  out.totalHundreds = centuries.length;
  out.totalFifties = fifties.length;

  out.battingStrikeRate = Number(safeDiv(out.totalRuns * 100, out.totalBalls).toFixed(2));
  out.battingAverage = Number(safeDiv(out.totalRuns, out.innings).toFixed(2));
  out.bowlingAverage = out.totalWickets > 0 ? Number(safeDiv(out.totalRunsGiven, out.totalWickets).toFixed(2)) : 0;
  out.centuries = [...centuries].sort(sortCenturies).slice(0, MAX_DETAILS);
  out.fifties = [...fifties].sort(sortCenturies).slice(0, MAX_DETAILS);
  out.bestBowlingSpells = [...bestBowlingSpells].sort(sortBowling).slice(0, MAX_DETAILS);
  const best = out.bestBowlingSpells[0];
  out.bestBowling = best ? `${best.wickets}/${best.runsGiven}` : '0/0';
  return out;
}

function computeLiveBlockFromStats(statsDocs, opponentById) {
  const block = emptyBlock();
  for (const stat of statsDocs) {
    const runs = Number(stat?.battingStats?.runs) || 0;
    const balls = Number(stat?.battingStats?.balls) || 0;
    const wickets = Number(stat?.bowlingStats?.wickets) || 0;
    const runsGiven = Number(stat?.bowlingStats?.runsGiven) || 0;
    const ballsBowled = Number(stat?.bowlingStats?.ballsBowled) || 0;
    const opponentTeam = opponentById.get(String(stat?.opponentUserId || '')) || 'Unknown';
    const date = stat?.createdAt || null;

    block.totalRuns += runs;
    block.totalBalls += balls;
    block.innings += 1;
    block.totalWickets += wickets;
    block.totalRunsGiven += runsGiven;
    block.totalBallsBowled += ballsBowled;
    if (wickets > 0 || runsGiven > 0 || ballsBowled > 0) block.bowlingInnings += 1;
    if (runs > block.highestScore) block.highestScore = runs;

    if (runs >= 100) {
      block.totalHundreds += 1;
      block.centuries.push({ runs, balls, opponentTeam, date });
    } else if (runs >= 50 && runs < 100) {
      block.totalFifties += 1;
      block.fifties.push({ runs, balls, opponentTeam, date });
    }
    if (wickets > 0 || runsGiven > 0 || ballsBowled > 0) {
      block.bestBowlingSpells.push({ wickets, runsGiven, ballsBowled, opponentTeam, date });
    }
  }
  return finalizeBlock(block);
}

function mergeBlocks(historical, live) {
  const h = historical || emptyBlock();
  const l = live || emptyBlock();
  const merged = {
    totalRuns: (h.totalRuns || 0) + (l.totalRuns || 0),
    totalBalls: (h.totalBalls || 0) + (l.totalBalls || 0),
    innings: (h.innings || 0) + (l.innings || 0),
    // totalFifties / totalHundreds recalculated in finalizeBlock after deduping merged milestone lists
    totalFifties: 0,
    totalHundreds: 0,
    highestScore: Math.max(h.highestScore || 0, l.highestScore || 0),
    totalWickets: (h.totalWickets || 0) + (l.totalWickets || 0),
    totalRunsGiven: (h.totalRunsGiven || 0) + (l.totalRunsGiven || 0),
    totalBallsBowled: (h.totalBallsBowled || 0) + (l.totalBallsBowled || 0),
    bowlingInnings: (h.bowlingInnings || 0) + (l.bowlingInnings || 0),
    centuries: [...(h.centuries || []), ...(l.centuries || [])],
    fifties: [...(h.fifties || []), ...(l.fifties || [])],
    bestBowlingSpells: [...(h.bestBowlingSpells || []), ...(l.bestBowlingSpells || [])],
  };
  return finalizeBlock(merged);
}

async function upsertLiveCareerSummaryForPlayer(playerId) {
  if (!playerId) return null;
  const player = await Player.findById(playerId).select('_id name role').lean();
  if (!player) return null;

  const statsDocs = await PlayerStats.find({ playerId }).lean();
  const opponentIds = [...new Set(statsDocs.map((s) => String(s.opponentUserId || '')).filter(Boolean))];
  const opponents = opponentIds.length
    ? await User.find({ _id: { $in: opponentIds } }).select('_id teamName abbreviation').lean()
    : [];
  const opponentById = new Map(opponents.map((u) => [String(u._id), u.abbreviation || u.teamName || 'Unknown']));
  const ownerTeams = await User.find({ boughtPlayers: playerId }).select('teamName abbreviation').lean();
  const teams = [...new Set(ownerTeams.map((u) => u.abbreviation || u.teamName).filter(Boolean))];

  const playerKey = normName(player.name);
  const live = computeLiveBlockFromStats(statsDocs, opponentById);
  const existing =
    (await PlayerCareerSummary.findOne({ playerId }).lean()) ||
    (await PlayerCareerSummary.findOne({ playerKey }).lean());
  const historical = existing?.historical || emptyBlock();
  const total = mergeBlocks(historical, live);

  const doc = await PlayerCareerSummary.findOneAndUpdate(
    { playerKey },
    {
      $set: {
        playerId: player._id,
        playerName: player.name,
        role: player.role || '',
        teams,
        live,
        historical,
        total,
      },
    },
    { upsert: true, new: true },
  );
  await syncPlayerRankingsFromCareerTotal(player._id, total);
  return doc;
}

async function rebuildAllLiveCareerSummaries() {
  const playerIds = await PlayerStats.distinct('playerId');
  for (const playerId of playerIds) {
    try {
      await upsertLiveCareerSummaryForPlayer(playerId);
    } catch (_) {
      // ignore per-player failures during batch rebuild
    }
  }
}

/**
 * Align milestone totals with stored detail rows for API clients.
 * Old docs can have totalHundreds/totalFifties out of sync with the centuries/fifties arrays
 * (e.g. double-count before dedupe, or partial writes). When the list is shorter than the cap,
 * the array is complete — totals must match deduped list length.
 */
function reconcileCareerTotalsForApi(metricsBlock) {
  const m = metricsBlock || {};
  const centuriesD = dedupeBattingMilestones(m.centuries || []);
  const fiftiesD = dedupeBattingMilestones(m.fifties || []);
  const spellsD = dedupeBowlingSpells(m.bestBowlingSpells || []);

  const centuriesSorted = [...centuriesD].sort(sortCenturies);
  const fiftiesSorted = [...fiftiesD].sort(sortCenturies);
  const spellsSorted = [...spellsD].sort(sortBowling).slice(0, MAX_DETAILS);

  let totalHundreds = m.totalHundreds ?? 0;
  let totalFifties = m.totalFifties ?? 0;
  if (centuriesSorted.length < MAX_DETAILS) {
    totalHundreds = centuriesSorted.length;
  } else {
    totalHundreds = Math.max(totalHundreds, centuriesSorted.length);
  }
  if (fiftiesSorted.length < MAX_DETAILS) {
    totalFifties = fiftiesSorted.length;
  } else {
    totalFifties = Math.max(totalFifties, fiftiesSorted.length);
  }

  const best = spellsSorted[0];
  const bestBowling = best ? `${best.wickets}/${best.runsGiven}` : m.bestBowling || '0/0';

  return {
    ...m,
    totalHundreds,
    totalFifties,
    centuries: centuriesSorted,
    fifties: fiftiesSorted,
    bestBowlingSpells: spellsSorted,
    bestBowling,
  };
}

/**
 * Copy reconciled career totals (historical + live) onto Player so Top Rankings match career APIs.
 * MoM count stays from current DB PlayerStats only (not present on historical rows).
 */
async function syncPlayerRankingsFromCareerTotal(playerId, totalBlock) {
  if (!playerId) return { skipped: true };
  const t = reconcileCareerTotalsForApi(totalBlock || emptyBlock());
  let momCount = 0;
  try {
    momCount = await PlayerStats.countDocuments({ playerId, isMom: true });
  } catch (_) {
    /* ignore */
  }
  await Player.findByIdAndUpdate(playerId, {
    $set: {
      totalRuns: Number(t.totalRuns) || 0,
      totalBalls: Number(t.totalBalls) || 0,
      totalRunsGiven: Number(t.totalRunsGiven) || 0,
      totalBallsBowled: Number(t.totalBallsBowled) || 0,
      totalWickets: Number(t.totalWickets) || 0,
      matchesPlayed: Number(t.innings) || 0,
      momCount,
    },
  });
  return { ok: true };
}

/** Push every linked summary's merged totals to Player (covers historical-only players after seed). */
async function syncAllPlayerRankingsFromCareerSummaries() {
  const summaries = await PlayerCareerSummary.find({
    playerId: { $exists: true, $ne: null },
  }).lean();
  for (const s of summaries) {
    try {
      await syncPlayerRankingsFromCareerTotal(s.playerId, s.total);
    } catch (_) {
      /* ignore per-player */
    }
  }
  return { rankingsPlayersSynced: summaries.length };
}

async function aggregateTotalsFromPlayerTeamHistory() {
  const rows = await PlayerTeamTournamentStat.aggregate([
    {
      $group: {
        _id: '$playerId',
        totalRuns: { $sum: '$totalRuns' },
        totalWickets: { $sum: '$totalWickets' },
        totalMom: { $sum: '$totalMom' },
        matches: { $sum: '$matches' },
      },
    },
  ]);
  return new Map(
    rows.map((row) => [
      String(row._id),
      {
        totalRuns: Number(row.totalRuns) || 0,
        totalWickets: Number(row.totalWickets) || 0,
        totalMom: Number(row.totalMom) || 0,
        matches: Number(row.matches) || 0,
      },
    ]),
  );
}

function buildReconciledCareerTotal(existingTotal, canonicalTotals) {
  const base = existingTotal || emptyBlock();
  return finalizeBlock({
    ...base,
    totalRuns: Number(canonicalTotals.totalRuns) || 0,
    totalWickets: Number(canonicalTotals.totalWickets) || 0,
    innings: Number(canonicalTotals.matches) || 0,
  });
}

async function reconcileCareerAndRankingTotalsFromTeamHistory(options = {}) {
  const includeInactive = options.includeInactive !== false;
  const playerMatch = includeInactive ? {} : { isActive: true };
  const players = await Player.find(playerMatch).select('_id name role isActive').lean();
  const playerIds = players.map((p) => p._id);
  const [totalsByPlayerId, summaries] = await Promise.all([
    aggregateTotalsFromPlayerTeamHistory(),
    PlayerCareerSummary.find({ playerId: { $in: playerIds } }).lean(),
  ]);
  const summaryByPlayerId = new Map(summaries.map((s) => [String(s.playerId), s]));

  let playerUpdates = 0;
  let summaryUpserts = 0;
  for (const player of players) {
    const idStr = String(player._id);
    const canonical = totalsByPlayerId.get(idStr) || {
      totalRuns: 0,
      totalWickets: 0,
      totalMom: 0,
      matches: 0,
    };
    await Player.findByIdAndUpdate(player._id, {
      $set: {
        totalRuns: canonical.totalRuns,
        totalWickets: canonical.totalWickets,
        matchesPlayed: canonical.matches,
        momCount: canonical.totalMom,
      },
    });
    playerUpdates += 1;

    const existingSummary = summaryByPlayerId.get(idStr);
    const playerKey = normName(player.name);
    const historical = existingSummary?.historical || emptyBlock();
    const live = existingSummary?.live || emptyBlock();
    const total = buildReconciledCareerTotal(existingSummary?.total, canonical);

    await PlayerCareerSummary.findOneAndUpdate(
      { playerKey },
      {
        $set: {
          playerKey,
          playerId: player._id,
          playerName: player.name,
          role: player.role || existingSummary?.role || '',
          teams: existingSummary?.teams || [],
          historical,
          live,
          total,
        },
      },
      { upsert: true, new: true },
    );
    summaryUpserts += 1;
  }

  return {
    playersScanned: players.length,
    playerUpdates,
    summaryUpserts,
    sourceRows: totalsByPlayerId.size,
  };
}

async function verifyCareerRankingTeamHistoryConsistency(options = {}) {
  const includeInactive = options.includeInactive !== false;
  const playerMatch = includeInactive ? {} : { isActive: true };
  const players = await Player.find(playerMatch)
    .select('_id name totalRuns totalWickets matchesPlayed momCount')
    .lean();
  const playerIds = players.map((p) => p._id);
  const [totalsByPlayerId, summaries] = await Promise.all([
    aggregateTotalsFromPlayerTeamHistory(),
    PlayerCareerSummary.find({ playerId: { $in: playerIds } }).select('playerId total').lean(),
  ]);
  const summaryByPlayerId = new Map(summaries.map((s) => [String(s.playerId), s]));
  const mismatches = [];

  for (const player of players) {
    const idStr = String(player._id);
    const team = totalsByPlayerId.get(idStr) || { totalRuns: 0, totalWickets: 0, totalMom: 0, matches: 0 };
    const career = summaryByPlayerId.get(idStr)?.total || emptyBlock();

    const ranking = {
      totalRuns: Number(player.totalRuns) || 0,
      totalWickets: Number(player.totalWickets) || 0,
      matches: Number(player.matchesPlayed) || 0,
      totalMom: Number(player.momCount) || 0,
    };
    const careerShared = {
      totalRuns: Number(career.totalRuns) || 0,
      totalWickets: Number(career.totalWickets) || 0,
      matches: Number(career.innings) || 0,
      totalMom: ranking.totalMom,
    };

    const differs =
      ranking.totalRuns !== team.totalRuns ||
      ranking.totalWickets !== team.totalWickets ||
      ranking.matches !== team.matches ||
      ranking.totalMom !== team.totalMom ||
      careerShared.totalRuns !== team.totalRuns ||
      careerShared.totalWickets !== team.totalWickets ||
      careerShared.matches !== team.matches;

    if (differs) {
      mismatches.push({
        playerId: player._id,
        playerName: player.name,
        rankings: ranking,
        career: careerShared,
        teamHistory: team,
      });
    }
  }

  return {
    checkedPlayers: players.length,
    mismatchCount: mismatches.length,
    mismatches,
  };
}

/** API row shape for /api/cpl-report/player-career-summary */
function mapCareerSummaryLeanToApiPlayer(r) {
  const t = reconcileCareerTotalsForApi(r.total);
  return {
    playerId: r.playerId || null,
    playerName: r.playerName,
    role: r.role || '',
    teams: r.teams || [],
    totalRuns: t.totalRuns || 0,
    totalFifties: t.totalFifties || 0,
    totalHundreds: t.totalHundreds || 0,
    highestScore: t.highestScore || 0,
    totalWickets: t.totalWickets || 0,
    bestBowling: t.bestBowling || '0/0',
    battingStrikeRate: t.battingStrikeRate || 0,
    battingAverage: t.battingAverage || 0,
    bowlingAverage: t.bowlingAverage || 0,
    innings: t.innings || 0,
    bowlingInnings: t.bowlingInnings || 0,
    centuries: t.centuries || [],
    fifties: t.fifties || [],
    bestBowlingSpells: t.bestBowlingSpells || [],
  };
}

function emptyCareerApiPlayerFromPlayer(playerLean) {
  return {
    playerId: playerLean._id || null,
    playerName: playerLean.name,
    role: playerLean.role || '',
    teams: [],
    totalRuns: 0,
    totalFifties: 0,
    totalHundreds: 0,
    highestScore: 0,
    totalWickets: 0,
    bestBowling: '0/0',
    battingStrikeRate: 0,
    battingAverage: 0,
    bowlingAverage: 0,
    innings: 0,
    bowlingInnings: 0,
    centuries: [],
    fifties: [],
    bestBowlingSpells: [],
  };
}

module.exports = {
  normName,
  emptyBlock,
  finalizeBlock,
  mergeBlocks,
  upsertLiveCareerSummaryForPlayer,
  rebuildAllLiveCareerSummaries,
  syncPlayerRankingsFromCareerTotal,
  syncAllPlayerRankingsFromCareerSummaries,
  reconcileCareerAndRankingTotalsFromTeamHistory,
  verifyCareerRankingTeamHistoryConsistency,
  mapCareerSummaryLeanToApiPlayer,
  emptyCareerApiPlayerFromPlayer,
};

