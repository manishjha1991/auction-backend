/**
 * Aggregate career matches played & wins per team across many CPL databases (cpl_12 … cpl_20 by default).
 * Sources per DB (deduped by db + teams + date):
 *   - fixtures (league)
 *   - matchresults (trophy / special)
 *   - playofffixtures (CPL + World Cup knockouts / RR when stored here)
 *   - tournaments.tournamentFixtures where name matches World Cup
 */

const mongoose = require('mongoose');
const Tournament = require('../models/Tournament');

const norm = (s) => String(s || '').trim().toLowerCase();

function normalizePair(t1, t2) {
  const a = norm(t1);
  const b = norm(t2);
  if (!a || !b) return null;
  return a <= b ? [a, b] : [b, a];
}

function dateKey(d) {
  if (!d) return 'nodate';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return 'nodate';
  return dt.toISOString().slice(0, 10);
}

function dedupeKey(scopeKey, team1, team2, date) {
  const pair = normalizePair(team1, team2);
  if (!pair) return null;
  return `${scopeKey}|${pair[0]}|${pair[1]}|${dateKey(date)}`;
}

/**
 * Lower priority wins when merging (fixture preferred over match result, etc.)
 */
function mergeRecord(merged, scopeKey, row) {
  const k = dedupeKey(scopeKey, row.team1, row.team2, row.date);
  if (!k) return;
  const prev = merged.get(k);
  if (!prev || row.priority < prev.priority) {
    merged.set(k, row);
  }
}

function resolveWinnerTeamName(row) {
  const w = row.winnerRaw;
  if (row.source === 'matchresult') {
    if (w === 'tie' || w === 'no_result') return null;
    if (w === 'team1') return row.team1;
    if (w === 'team2') return row.team2;
    return null;
  }
  if (!w || typeof w !== 'string') return null;
  const n = norm(w);
  if (n === 'tie' || n === 'no_result' || n === 'tbd') return null;
  return w;
}

function countForTeam(mergedMap, teamKey) {
  const k = norm(teamKey);
  if (!k) return { played: 0, wins: 0 };
  let played = 0;
  let wins = 0;
  for (const row of mergedMap.values()) {
    const t1 = norm(row.team1);
    const t2 = norm(row.team2);
    if (t1 !== k && t2 !== k) continue;
    const winnerName = resolveWinnerTeamName(row);
    if (!winnerName) continue;
    const wn = norm(winnerName);
    if (wn !== t1 && wn !== t2) continue;
    played += 1;
    if (wn === k) wins += 1;
  }
  return { played, wins };
}

/**
 * @returns {string[]}
 */
function resolveCareerDbNames() {
  const env = process.env.CPL_TEAM_CAREER_DBS;
  if (env && String(env).trim()) {
    return String(env)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const out = [];
  for (let i = 12; i <= 20; i += 1) {
    out.push(`cpl_${i}`);
  }
  return out;
}

const PARALLEL_DBS = Math.max(1, Math.min(12, parseInt(process.env.CPL_TEAM_CAREER_PARALLEL || '6', 10) || 6));

function useLegacyCareerMode() {
  const mode = String(process.env.CPL_TEAM_CAREER_SOURCE || '').toLowerCase();
  return mode === 'legacy-db' || mode === 'legacy-dbs' || mode === 'legacy';
}

async function loadMergedMatchesForDb(dbName) {
  const conn = mongoose.connection.useDb(dbName, { useCache: true });
  const merged = new Map();

  const fixturesCol = conn.db.collection('fixtures');
  const fixtures = await fixturesCol
    .find({
      isActive: { $ne: false },
      winner: {
        $exists: true,
        $nin: [null, '', 'tie', 'no_result', 'TBD', 'tbd'],
      },
    })
    .project({ team1: 1, team2: 1, winner: 1, createdAt: 1 })
    .toArray();

  fixtures.forEach((f) => {
    mergeRecord(merged, dbName, {
      team1: f.team1,
      team2: f.team2,
      date: f.createdAt,
      winnerRaw: f.winner,
      source: 'fixture',
      priority: 0,
    });
  });

  const mrCol = conn.db.collection('matchresults');
  const mrs = await mrCol
    .find({})
    .project({ team1: 1, team2: 1, winner: 1, matchDate: 1 })
    .toArray();

  mrs.forEach((m) => {
    if (!m.winner || m.winner === 'tie' || m.winner === 'no_result') return;
    mergeRecord(merged, dbName, {
      team1: m.team1,
      team2: m.team2,
      date: m.matchDate,
      winnerRaw: m.winner,
      source: 'matchresult',
      priority: 1,
    });
  });

  const pfCol = conn.db.collection('playofffixtures');
  const pfs = await pfCol
    .find({
      isCompleted: true,
      winner: { $exists: true, $nin: [null, '', 'TBD', 'tbd'] },
    })
    .project({ team1: 1, team2: 1, winner: 1, date: 1, createdAt: 1 })
    .toArray();

  pfs.forEach((p) => {
    mergeRecord(merged, dbName, {
      team1: p.team1,
      team2: p.team2,
      date: p.date || p.createdAt,
      winnerRaw: p.winner,
      source: 'playoff',
      priority: 2,
    });
  });

  const tCol = conn.db.collection('tournaments');
  const tours = await tCol
    .find({
      name: { $regex: /^World Cup/i },
      tournamentFixtures: { $exists: true, $ne: [] },
    })
    .project({ tournamentFixtures: 1, startDate: 1 })
    .toArray();

  tours.forEach((t) => {
    (t.tournamentFixtures || []).forEach((fx) => {
      if (!fx.winner || norm(fx.winner) === 'tie' || norm(fx.winner) === 'no_result') return;
      mergeRecord(merged, dbName, {
        team1: fx.team1,
        team2: fx.team2,
        date: fx.createdAt || t.startDate,
        winnerRaw: fx.winner,
        source: 'tournament_wc',
        priority: 3,
      });
    });
  });

  return merged;
}

async function resolveCareerTournamentIds() {
  const explicit = String(process.env.CPL_TEAM_CAREER_TOURNAMENT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;
  const rows = await Tournament.find({ isActive: true })
    .select('_id endDate updatedAt')
    .sort({ endDate: -1, updatedAt: -1 })
    .lean();
  return rows.map((r) => String(r._id));
}

async function loadMergedMatchesForTournament(tournamentId) {
  const merged = new Map();
  const db = mongoose.connection.db;
  const tid = new mongoose.Types.ObjectId(String(tournamentId));
  const scopeKey = `t:${String(tournamentId)}`;

  const fixtures = await db
    .collection('fixtures')
    .find({
      tournamentId: tid,
      isActive: { $ne: false },
      winner: { $exists: true, $nin: [null, '', 'tie', 'no_result', 'TBD', 'tbd'] },
    })
    .project({ team1: 1, team2: 1, winner: 1, createdAt: 1 })
    .toArray();
  fixtures.forEach((f) => {
    mergeRecord(merged, scopeKey, {
      team1: f.team1,
      team2: f.team2,
      date: f.createdAt,
      winnerRaw: f.winner,
      source: 'fixture',
      priority: 0,
    });
  });

  const mrs = await db
    .collection('matchresults')
    .find({ tournamentId: tid })
    .project({ team1: 1, team2: 1, winner: 1, matchDate: 1 })
    .toArray();
  mrs.forEach((m) => {
    if (!m.winner || m.winner === 'tie' || m.winner === 'no_result') return;
    mergeRecord(merged, scopeKey, {
      team1: m.team1,
      team2: m.team2,
      date: m.matchDate,
      winnerRaw: m.winner,
      source: 'matchresult',
      priority: 1,
    });
  });

  const pfs = await db
    .collection('playofffixtures')
    .find({
      tournamentId: tid,
      isCompleted: true,
      winner: { $exists: true, $nin: [null, '', 'TBD', 'tbd'] },
    })
    .project({ team1: 1, team2: 1, winner: 1, date: 1, createdAt: 1 })
    .toArray();
  pfs.forEach((p) => {
    mergeRecord(merged, scopeKey, {
      team1: p.team1,
      team2: p.team2,
      date: p.date || p.createdAt,
      winnerRaw: p.winner,
      source: 'playoff',
      priority: 2,
    });
  });

  const wcTournament = await db.collection('tournaments').findOne({
    _id: tid,
    name: { $regex: /^World Cup/i },
    tournamentFixtures: { $exists: true, $ne: [] },
  });
  if (wcTournament) {
    (wcTournament.tournamentFixtures || []).forEach((fx) => {
      if (!fx.winner || norm(fx.winner) === 'tie' || norm(fx.winner) === 'no_result') return;
      mergeRecord(merged, scopeKey, {
        team1: fx.team1,
        team2: fx.team2,
        date: fx.createdAt || wcTournament.startDate,
        winnerRaw: fx.winner,
        source: 'tournament_wc',
        priority: 3,
      });
    });
  }

  return merged;
}

async function mapWithConcurrency(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const part = await Promise.all(batch.map(fn));
    out.push(...part);
  }
  return out;
}

/**
 * @param {string[]} teamNames
 * @returns {Promise<Record<string, { careerPlayed: number, careerWins: number }>>}
 */
async function aggregateCareerStatsForTeams(teamNames) {
  const uniqueKeys = [...new Set(teamNames.map(norm).filter(Boolean))];
  const totals = Object.fromEntries(
    uniqueKeys.map((k) => [k, { careerPlayed: 0, careerWins: 0 }])
  );

  if (uniqueKeys.length === 0) return totals;
  if (mongoose.connection.readyState !== 1) return totals;

  if (useLegacyCareerMode()) {
    const dbNames = resolveCareerDbNames();
    await mapWithConcurrency(dbNames, PARALLEL_DBS, async (dbName) => {
      try {
        const merged = await loadMergedMatchesForDb(dbName);
        uniqueKeys.forEach((tk) => {
          const { played, wins } = countForTeam(merged, tk);
          totals[tk].careerPlayed += played;
          totals[tk].careerWins += wins;
        });
      } catch (e) {
        console.warn(`[teamCareerStats] skip ${dbName}:`, e.message);
      }
    });
    return totals;
  }

  const tournamentIds = await resolveCareerTournamentIds();
  await mapWithConcurrency(tournamentIds, PARALLEL_DBS, async (tournamentId) => {
    try {
      const merged = await loadMergedMatchesForTournament(tournamentId);
      uniqueKeys.forEach((tk) => {
        const { played, wins } = countForTeam(merged, tk);
        totals[tk].careerPlayed += played;
        totals[tk].careerWins += wins;
      });
    } catch (e) {
      console.warn(`[teamCareerStats] skip tournament ${tournamentId}:`, e.message);
    }
  });

  return totals;
}

let cache = { key: '', at: 0, data: null };
const TTL_MS = Math.max(
  30_000,
  Math.min(600_000, parseInt(process.env.CPL_TEAM_CAREER_CACHE_SEC || '180', 10) || 180) * 1000
);

function cacheKeyForTeams(teamNames) {
  return [...new Set(teamNames.map(norm).filter(Boolean))].sort().join('\0');
}

/**
 * Cached aggregate (same team set hits memory for TTL).
 */
async function getCachedCareerStatsForTeams(teamNames) {
  const key = cacheKeyForTeams(teamNames);
  if (cache.data && cache.key === key && Date.now() - cache.at < TTL_MS) {
    return cache.data;
  }
  const data = await aggregateCareerStatsForTeams(teamNames);
  cache = { key, at: Date.now(), data };
  return data;
}

module.exports = {
  resolveCareerDbNames,
  resolveCareerTournamentIds,
  aggregateCareerStatsForTeams,
  getCachedCareerStatsForTeams,
  norm,
};
