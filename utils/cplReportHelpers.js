/**
 * CPL multi-season report (last N databases): point tables + composite index.
 * Used by GET /api/cpl-report/snapshot and optional PDF script.
 */

const mongoose = require('mongoose');
const Tournament = require('../models/Tournament');
const { fetchPointTableFromConnection } = require('./cplHistoryHelpers');

const CPL_FORMULAS = [
  { step: 'Step 1', title: 'Normalise Points', detail: '((Team Points − Min) / (Max − Min)) × 100' },
  { step: 'Step 2', title: 'Normalise NRR', detail: '((Team NRR − Min) / (Max − Min)) × 100' },
  { step: 'Step 3', title: 'Normalise Fairness', detail: '((Team Fair − Min) / (Max − Min)) × 100' },
  { step: 'Step 4', title: 'Season index', detail: '0.5 × Norm(Pts) + 0.3 × Norm(NRR) + 0.2 × Norm(Fair)' },
  { step: 'Step 5', title: 'Per database', detail: 'Compute index for each CPL database using the same method.' },
  { step: 'Step 6', title: 'Combined score', detail: 'Average of season indices where the team appears (qualification / form context).' },
  { step: 'Step 7', title: 'Order teams', detail: 'Higher combined score = stronger recent CPL form (e.g. WC discussion — not official selection).' },
];

/** World Cup pathway — header wording is generic in the UI; body keeps the concrete rules. */
const CPL_WORLD_CUP_NOTES = [
  'To be implemented after World Cup.',
  'Rankings use the last three CPLs as context.',
  'Top 6 qualify automatically for WC.',
  'Remaining 8 enter a knockout phase to select 2 teams to join WC.',
  'KO1: Pos 7 vs 14 · KO2: 8 vs 13 · KO3: 9 vs 12 · KO4: 10 vs 11.',
  'Then KO1 winner vs KO4 winner, KO2 vs KO3; 2 winners join WC.',
  'Parallel KOs during 3rd CPL Eliminator — walkovers if scheduling clashes.',
];

function getReportBaseUri() {
  const uri = process.env.MONGO_URI || '';
  if (!uri) return '';
  return uri.replace(/\?.*$/, '').replace(/\/$/, '');
}

function seasonNumFromDbName(name) {
  const m = String(name || '').match(/^cpl_(\d+)$/i);
  return m ? parseInt(m[1], 10) : null;
}

/** Newest CPL DB the app (or CLI) is using — for “current + previous 2” report windows. */
function getRunningCplDbNameHint() {
  try {
    if (mongoose.connection?.name) return mongoose.connection.name;
  } catch (_) {
    /* optional connection */
  }
  if (process.env.MONGO_DB_NAME) return process.env.MONGO_DB_NAME;
  const uri = process.env.MONGO_URI || '';
  const m = uri.match(/\/(cpl_\d+)(?:\?|[/]|$)/i);
  if (m) return m[1];
  return '';
}

/**
 * Which DBs to load for the composite report (newest first).
 * - If CPL_REPORT_DBS is set → use that comma-separated list (override).
 * - Else → running DB as newest, then N-1 and N-2 (three seasons total).
 *   Example: cpl_19 → cpl_19, cpl_18, cpl_17.
 */
function parseReportDbs() {
  const envList = process.env.CPL_REPORT_DBS;
  if (envList && String(envList).trim()) {
    return String(envList)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const currentName = getRunningCplDbNameHint();
  const n = seasonNumFromDbName(currentName);
  if (n != null && n >= 1) {
    const out = [];
    for (let i = 0; i < 3; i++) {
      const sn = n - i;
      if (sn >= 1) out.push(`cpl_${sn}`);
    }
    return out;
  }

  return ['cpl_19', 'cpl_18', 'cpl_17'];
}

function parseMilestoneDbs() {
  const envList = process.env.CPL_MILESTONE_DBS;
  if (envList && String(envList).trim()) {
    return String(envList)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return ['cpl_12', 'cpl_13', 'cpl_14', 'cpl_15', 'cpl_16', 'cpl_17', 'cpl_18', 'cpl_19'];
}

function parseCareerSummaryDbs() {
  return parseMilestoneDbs();
}

function normaliser(values) {
  const nums = values.map(Number).filter((v) => !Number.isNaN(v));
  if (nums.length === 0) return () => 100;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min;
  return (v) => {
    if (span === 0) return 100;
    return ((v - min) / span) * 100;
  };
}

function addSeasonIndices(tableRows) {
  const normP = normaliser(tableRows.map((r) => r.points));
  const normN = normaliser(tableRows.map((r) => r.nrr));
  const normF = normaliser(tableRows.map((r) => r.fairness));
  return tableRows.map((r) => ({
    ...r,
    normP: normP(r.points),
    normN: normN(r.nrr),
    normF: normF(r.fairness),
    seasonIndex: 0.5 * normP(r.points) + 0.3 * normN(r.nrr) + 0.2 * normF(r.fairness),
  }));
}

function buildCompositeRows(seasonResults) {
  const dbOrder = seasonResults.map((s) => s.dbName);
  const map = new Map();
  for (const { dbName, indexed } of seasonResults) {
    for (const row of indexed) {
      if (!map.has(row.teamKey)) map.set(row.teamKey, { teamName: row.teamName, byDb: {} });
      map.get(row.teamKey).byDb[dbName] = row.seasonIndex;
    }
  }
  const rows = [...map.entries()].map(([teamKey, { teamName, byDb }]) => {
    const parts = dbOrder.map((d) => byDb[d]).filter((x) => typeof x === 'number');
    const finalAvg = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
    return { teamKey, teamName, byDb, finalAvg };
  });
  rows.sort((a, b) => b.finalAvg - a.finalAvg);
  return { rows, dbOrder };
}

function normalizeReportRowsFromTournamentPointTable(pointTable = []) {
  const rows = (Array.isArray(pointTable) ? pointTable : []).map((r) => ({
    rank: Number(r.rank) || 0,
    teamName: r.teamName || 'Unknown',
    teamKey: String(r.teamName || '').trim().toUpperCase(),
    points: Number(r.points) || 0,
    nrr: Number(r.nrr) || 0,
    fairness: Number(r.fairness) || 0,
    matchesPlayed: Number(r.matches) || 0,
    wins: Number(r.won) || Math.floor((Number(r.points) || 0) / 2),
    losses:
      Number(r.lost) ||
      Math.max((Number(r.matches) || 0) - Math.floor((Number(r.points) || 0) / 2), 0),
  }));

  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if ((b.nrr || 0) !== (a.nrr || 0)) return (b.nrr || 0) - (a.nrr || 0);
    if ((b.fairness || 0) !== (a.fairness || 0)) return (b.fairness || 0) - (a.fairness || 0);
    return (a.teamName || '').localeCompare(b.teamName || '');
  });

  rows.forEach((row, idx) => {
    row.rank = idx + 1;
  });
  return rows;
}

async function loadOneReportTournament(tournament) {
  try {
    const db = mongoose.connection.db;
    const tournamentId = tournament._id;
    const rawRows = normalizeReportRowsFromTournamentPointTable(tournament.pointTable || []);
    const indexed = addSeasonIndices(rawRows);
    const fixtureCount = await db.collection('fixtures').countDocuments({
      tournamentId,
      isActive: true,
      winner: { $ne: null, $exists: true },
    });
    return {
      ok: true,
      dbName: `tournament:${String(tournamentId)}`,
      label: tournament.name || `Tournament ${String(tournamentId).slice(-6)}`,
      fixtureCount,
      table: indexed.map((r) => ({
        rank: r.rank,
        teamName: r.teamName,
        teamKey: r.teamKey,
        points: r.points,
        nrr: r.nrr,
        fairness: r.fairness,
        matchesPlayed: r.matchesPlayed,
        wins: r.wins,
        losses: r.losses,
        seasonIndex: r.seasonIndex,
      })),
      indexed,
    };
  } catch (e) {
    return {
      ok: false,
      dbName: `tournament:${String(tournament?._id || '')}`,
      label: tournament?.name || 'Tournament',
      error: e.message || String(e),
      table: [],
      indexed: [],
    };
  }
}

async function loadOneReportSeason(base, dbName) {
  try {
    if (mongoose.connection?.readyState !== 1) {
      throw new Error('MongoDB not connected');
    }
    // Reuse the existing mongoose pool across DBs (Atlas M0-safe)
    const conn = mongoose.connection.useDb(dbName, { useCache: true });
    const { table: rawPointTable, fixtureCount } = await fetchPointTableFromConnection(conn);

    const rows = rawPointTable.map((t) => ({
      rank: t.rank,
      teamName: t.teamName,
      teamKey: String(t.teamName || '').trim().toUpperCase(),
      points: t.points,
      nrr: t.nrr,
      fairness: t.fairness,
      matchesPlayed: t.matchesPlayed,
      wins: t.wins,
      losses: t.losses,
    }));

    const indexed = addSeasonIndices(rows);
    const tableWithIndex = indexed.map((r) => ({
      rank: r.rank,
      teamName: r.teamName,
      teamKey: r.teamKey,
      points: r.points,
      nrr: r.nrr,
      fairness: r.fairness,
      matchesPlayed: r.matchesPlayed,
      wins: r.wins,
      losses: r.losses,
      seasonIndex: r.seasonIndex,
    }));
    const seasonNum = dbName.replace(/^cpl_/i, '');
    return {
      ok: true,
      dbName,
      label: `CPL ${seasonNum}`,
      fixtureCount,
      table: tableWithIndex,
      indexed,
    };
  } catch (e) {
    return {
      ok: false,
      dbName,
      label: `CPL ${dbName.replace(/^cpl_/i, '')}`,
      error: e.message || String(e),
      table: [],
      indexed: [],
    };
  }
}

async function countMilestonesForDb(dbName) {
  if (mongoose.connection?.readyState !== 1) throw new Error('MongoDB not connected');
  const conn = mongoose.connection.useDb(dbName, { useCache: true });
  const col = conn.db.collection('playerstats');
  const baseMatch = {
    playerId: { $exists: true, $ne: null },
    userId: { $exists: true, $ne: null },
    'battingStats.runs': { $exists: true, $ne: null },
  };
  const [hundredsDocs, fiftiesDocs] = await Promise.all([
    col
      .aggregate([
        { $match: { ...baseMatch, 'battingStats.runs': { $gte: 100 } } },
        { $count: 'cnt' },
      ])
      .toArray(),
    col
      .aggregate([
        { $match: { ...baseMatch, 'battingStats.runs': { $gte: 50, $lt: 100 } } },
        { $count: 'cnt' },
      ])
      .toArray(),
  ]);
  return {
    dbName,
    hundreds: hundredsDocs[0]?.cnt || 0,
    fifties: fiftiesDocs[0]?.cnt || 0,
  };
}

async function buildMilestonesSummary() {
  const dbNames = parseMilestoneDbs();
  const perDb = [];
  let totalHundreds = 0;
  let totalFifties = 0;
  for (const dbName of dbNames) {
    try {
      const row = await countMilestonesForDb(dbName);
      perDb.push(row);
      totalHundreds += row.hundreds;
      totalFifties += row.fifties;
    } catch (_) {
      perDb.push({ dbName, hundreds: 0, fifties: 0 });
    }
  }
  return { dbNames, perDb, totalHundreds, totalFifties };
}

async function buildMilestonesSummaryFromTournaments(tournaments) {
  const db = mongoose.connection.db;
  const perDb = [];
  let totalHundreds = 0;
  let totalFifties = 0;
  for (const tournament of tournaments) {
    const tournamentId = tournament._id;
    try {
      const [hundreds, fifties] = await Promise.all([
        db.collection('playerstats').countDocuments({
          tournamentId,
          playerId: { $exists: true, $ne: null },
          userId: { $exists: true, $ne: null },
          'battingStats.runs': { $gte: 100 },
        }),
        db.collection('playerstats').countDocuments({
          tournamentId,
          playerId: { $exists: true, $ne: null },
          userId: { $exists: true, $ne: null },
          'battingStats.runs': { $gte: 50, $lt: 100 },
        }),
      ]);
      const row = {
        dbName: `tournament:${String(tournamentId)}`,
        label: tournament.name || `Tournament ${String(tournamentId).slice(-6)}`,
        hundreds,
        fifties,
      };
      perDb.push(row);
      totalHundreds += hundreds;
      totalFifties += fifties;
    } catch (_) {
      perDb.push({
        dbName: `tournament:${String(tournamentId)}`,
        label: tournament.name || `Tournament ${String(tournamentId).slice(-6)}`,
        hundreds: 0,
        fifties: 0,
      });
    }
  }
  return { dbNames: perDb.map((p) => p.dbName), perDb, totalHundreds, totalFifties };
}

function normName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function safeDiv(a, b) {
  if (!b) return 0;
  return a / b;
}

async function buildCplCareerPlayerSummary() {
  const dbNames = parseCareerSummaryDbs();
  const players = new Map();

  for (const dbName of dbNames) {
    try {
      if (mongoose.connection?.readyState !== 1) throw new Error('MongoDB not connected');
      const conn = mongoose.connection.useDb(dbName, { useCache: true });
      const db = conn.db;

      const [statsDocs, playerDocs, userDocs] = await Promise.all([
        db
          .collection('playerstats')
          .find({ playerId: { $exists: true, $ne: null }, userId: { $exists: true, $ne: null } })
          .project({
            playerId: 1,
            userId: 1,
            battingStats: 1,
            bowlingStats: 1,
          })
          .toArray(),
        db.collection('players').find({}).project({ _id: 1, name: 1, role: 1 }).toArray(),
        db.collection('users').find({}).project({ _id: 1, teamName: 1, abbreviation: 1 }).toArray(),
      ]);

      const playerById = new Map(playerDocs.map((p) => [String(p._id), { name: p.name, role: p.role }]));
      const teamByUserId = new Map(userDocs.map((u) => [String(u._id), u.abbreviation || u.teamName || '']));

      for (const row of statsDocs) {
        const pMeta = playerById.get(String(row.playerId));
        if (!pMeta || !pMeta.name) continue;
        const key = normName(pMeta.name);
        if (!key) continue;

        const runs = Number(row?.battingStats?.runs) || 0;
        const balls = Number(row?.battingStats?.balls) || 0;
        const wickets = Number(row?.bowlingStats?.wickets) || 0;
        const runsGiven = Number(row?.bowlingStats?.runsGiven) || 0;
        const ballsBowled = Number(row?.bowlingStats?.ballsBowled) || 0;
        const teamLabel = teamByUserId.get(String(row.userId)) || '';

        if (!players.has(key)) {
          players.set(key, {
            playerName: pMeta.name,
            role: pMeta.role || '',
            teams: new Set(),
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
            bestBowlingWkts: 0,
            bestBowlingRuns: Number.POSITIVE_INFINITY,
          });
        }

        const agg = players.get(key);
        if (teamLabel) agg.teams.add(teamLabel);

        agg.totalRuns += runs;
        agg.totalBalls += balls;
        agg.totalRunsGiven += runsGiven;
        agg.totalBallsBowled += ballsBowled;
        agg.totalWickets += wickets;
        agg.innings += 1;
        if (ballsBowled > 0 || runsGiven > 0 || wickets > 0) agg.bowlingInnings += 1;

        if (runs >= 100) agg.totalHundreds += 1;
        else if (runs >= 50 && runs < 100) agg.totalFifties += 1;
        if (runs > agg.highestScore) agg.highestScore = runs;

        // Best bowling: prioritize wickets; tie-break by fewer runs conceded.
        if (
          wickets > agg.bestBowlingWkts ||
          (wickets === agg.bestBowlingWkts && runsGiven < agg.bestBowlingRuns)
        ) {
          agg.bestBowlingWkts = wickets;
          agg.bestBowlingRuns = runsGiven;
        }
      }
    } catch (e) {
      // continue with remaining DBs
    }
  }

  const rows = Array.from(players.values()).map((p) => {
    const strikeRate = safeDiv(p.totalRuns * 100, p.totalBalls);
    const battingAverage = safeDiv(p.totalRuns, p.innings);
    const bowlingAverage = p.totalWickets > 0 ? safeDiv(p.totalRunsGiven, p.totalWickets) : 0;
    const bestBowling =
      p.bestBowlingWkts > 0 || Number.isFinite(p.bestBowlingRuns)
        ? `${p.bestBowlingWkts}/${Number.isFinite(p.bestBowlingRuns) ? p.bestBowlingRuns : 0}`
        : '0/0';

    return {
      playerName: p.playerName,
      role: p.role || null,
      teams: Array.from(p.teams),
      totalRuns: p.totalRuns,
      totalFifties: p.totalFifties,
      totalHundreds: p.totalHundreds,
      highestScore: p.highestScore,
      totalWickets: p.totalWickets,
      bestBowling,
      battingStrikeRate: Number(strikeRate.toFixed(2)),
      battingAverage: Number(battingAverage.toFixed(2)),
      bowlingAverage: Number(bowlingAverage.toFixed(2)),
      innings: p.innings,
      bowlingInnings: p.bowlingInnings,
    };
  });

  rows.sort((a, b) => {
    if (b.totalRuns !== a.totalRuns) return b.totalRuns - a.totalRuns;
    if (b.totalWickets !== a.totalWickets) return b.totalWickets - a.totalWickets;
    return a.playerName.localeCompare(b.playerName);
  });

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    dbNames,
    players: rows,
  };
}

async function buildCplReportSnapshot(options = {}) {
  const source = String(options.source || '').toLowerCase();
  const forceLegacyDbMode = source === 'legacy-db' || source === 'legacy-dbs' || source === 'legacy';
  if (!forceLegacyDbMode) {
    const tournaments = await Tournament.find({
      isActive: true,
      status: 'completed',
    })
      .select('_id name pointTable endDate updatedAt')
      .sort({ endDate: -1, updatedAt: -1 })
      .lean();

    if (tournaments.length) {
      const seasons = [];
      for (const t of tournaments) {
        seasons.push(await loadOneReportTournament(t));
      }

      const okSeasons = seasons.filter((s) => s.ok && s.indexed.length);
      const composite =
        okSeasons.length > 0
          ? buildCompositeRows(okSeasons.map((s) => ({ dbName: s.dbName, indexed: s.indexed })))
          : { rows: [], dbOrder: [] };
      const milestones = await buildMilestonesSummaryFromTournaments(tournaments);

      return {
        ok: true,
        source: 'single-db',
        generatedAt: new Date().toISOString(),
        currentSeasonDb: mongoose.connection?.name || null,
        runningDbHint: getRunningCplDbNameHint() || null,
        reportDatabases: tournaments.map((t) => `tournament:${String(t._id)}`),
        formulas: CPL_FORMULAS,
        worldCupNotes: CPL_WORLD_CUP_NOTES,
        milestones,
        seasons,
        composite: {
          columns: composite.dbOrder.map((d) => {
            const hit = seasons.find((s) => s.dbName === d);
            return { dbName: d, label: hit?.label || d };
          }),
          rows: composite.rows.map((r, i) => ({
            rank: i + 1,
            teamName: r.teamName,
            teamKey: r.teamKey,
            byDb: r.byDb,
            finalAvg: r.finalAvg,
          })),
        },
      };
    }
  }

  const base = getReportBaseUri();
  if (!base) {
    return {
      ok: false,
      message: 'MONGO_URI not configured',
      generatedAt: new Date().toISOString(),
    };
  }

  const dbNames = parseReportDbs();
  const seasons = [];
  for (const dbName of dbNames) {
    seasons.push(await loadOneReportSeason(base, dbName));
  }

  const okSeasons = seasons.filter((s) => s.ok && s.indexed.length);
  const composite =
    okSeasons.length > 0
      ? buildCompositeRows(okSeasons.map((s) => ({ dbName: s.dbName, indexed: s.indexed })))
      : { rows: [], dbOrder: [] };
  const milestones = await buildMilestonesSummary();

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    currentSeasonDb: mongoose.connection?.name || null,
    /** DB used to derive “current + 2 prior” when CPL_REPORT_DBS is unset */
    runningDbHint: getRunningCplDbNameHint() || null,
    reportDatabases: dbNames,
    formulas: CPL_FORMULAS,
    worldCupNotes: CPL_WORLD_CUP_NOTES,
    milestones,
    seasons,
    composite: {
      columns: composite.dbOrder.map((d) => ({ dbName: d, label: `CPL ${d.replace(/^cpl_/i, '')}` })),
      rows: composite.rows.map((r, i) => ({
        rank: i + 1,
        teamName: r.teamName,
        teamKey: r.teamKey,
        byDb: r.byDb,
        finalAvg: r.finalAvg,
      })),
    },
  };
}

module.exports = {
  CPL_FORMULAS,
  CPL_WORLD_CUP_NOTES,
  getReportBaseUri,
  getRunningCplDbNameHint,
  parseReportDbs,
  parseMilestoneDbs,
  parseCareerSummaryDbs,
  seasonNumFromDbName,
  buildCplReportSnapshot,
  buildCplCareerPlayerSummary,
  addSeasonIndices,
  buildCompositeRows,
};
