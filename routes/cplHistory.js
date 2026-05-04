const express = require('express');
const mongoose = require('mongoose');
const Tournament = require('../models/Tournament');
const {
  fetchPointTableFromConnection,
  fetchPlayoffFinalWinner,
  enrichChampionFromTable,
  buildSeasonInsights,
  fetchSeasonPlayerHighlights,
} = require('../utils/cplHistoryHelpers');
const { getCachedHistorySummary, setCachedHistorySummary } = require('../utils/cplReadCaches');

const router = express.Router();

function getBaseMongoUri() {
  const uri = process.env.MONGO_URI || '';
  return uri.replace(/\?.*$/, '').replace(/\/$/, '');
}

/**
 * Databases to include: CPL_HISTORY_DBS=cpl_15,cpl_16,cpl_17,cpl_18
 * Or auto: all cpl_N from 15 up to (currentSeason - 1) e.g. cpl_19 → cpl_15..cpl_18
 */
function seasonNumFromDbName(name) {
  const m = String(name).match(/^cpl_(\d+)$/i);
  return m ? parseInt(m[1], 10) : 0;
}

function resolveHistoryDbNames() {
  const envList = process.env.CPL_HISTORY_DBS;
  if (envList && envList.trim()) {
    const arr = envList.split(',').map((s) => s.trim()).filter(Boolean);
    arr.sort((a, b) => seasonNumFromDbName(b) - seasonNumFromDbName(a));
    return arr;
  }

  const currentName = mongoose.connection?.name || process.env.MONGO_DB_NAME || 'cpl_19';
  const m = String(currentName).match(/^cpl_(\d+)$/i);
  const num = m ? parseInt(m[1], 10) : 19;
  const out = [];
  for (let i = 15; i < num; i++) {
    out.push(`cpl_${i}`);
  }
  if (out.length === 0) {
    return ['cpl_18', 'cpl_17', 'cpl_16', 'cpl_15'];
  }
  return out.reverse();
}

/** Parallel season loads; cap simultaneous DB connections (Atlas-friendly). */
const HISTORY_PARALLEL = Math.max(1, Math.min(12, parseInt(process.env.CPL_HISTORY_PARALLEL || '6', 10) || 6));

function seasonNumFromTournamentName(name) {
  const m = String(name || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function normalizeTournamentPointTableRows(pointTable = []) {
  const rows = (Array.isArray(pointTable) ? pointTable : []).map((row) => ({
    rank: Number(row.rank) || 0,
    teamName: row.teamName || 'Unknown',
    fullTeamName: row.teamName || 'Unknown',
    points: Number(row.points) || 0,
    fairness: Number(row.fairness) || 0,
    nrr: Number(row.nrr) || 0,
    matchesPlayed: Number(row.matches) || 0,
    wins: Number(row.won) || Math.floor((Number(row.points) || 0) / 2),
    losses:
      Number(row.lost) ||
      Math.max((Number(row.matches) || 0) - Math.floor((Number(row.points) || 0) / 2), 0),
  }));

  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if ((b.nrr || 0) !== (a.nrr || 0)) return (b.nrr || 0) - (a.nrr || 0);
    if ((b.fairness || 0) !== (a.fairness || 0)) return (b.fairness || 0) - (a.fairness || 0);
    return (a.teamName || '').localeCompare(b.teamName || '');
  });
  rows.forEach((r, idx) => {
    r.rank = idx + 1;
  });
  return rows;
}

async function loadOneHistorySeason(_base, dbName) {
  try {
    // IMPORTANT (Atlas M0-friendly):
    // Reuse the existing mongoose pool instead of opening new TCP pools per DB.
    // `useDb(..., { useCache: true })` gives a connection-like object backed by the same client.
    if (mongoose.connection?.readyState !== 1) {
      throw new Error('MongoDB not connected');
    }

    const conn = mongoose.connection.useDb(dbName, { useCache: true });

    const [{ table, fixtureCount }, playoffFinal, playerHighlights] = await Promise.all([
      fetchPointTableFromConnection(conn),
      fetchPlayoffFinalWinner(conn),
      fetchSeasonPlayerHighlights(conn),
    ]);

    const seasonNum = dbName.replace(/^cpl_/i, '');
    const insights = buildSeasonInsights(table);
    const leagueLeader = table[0] || null;
    const playoffChampion = playoffFinal ? enrichChampionFromTable(playoffFinal, table) : null;
    const displayChampion = playoffChampion || leagueLeader;

    if (insights && leagueLeader && playoffChampion) {
      const a = String(leagueLeader.teamName || '').toLowerCase().trim();
      const b = String(playoffChampion.teamName || '').toLowerCase().trim();
      if (a && b && a !== b) {
        insights.playoffNote = `Playoff winner (${playoffChampion.teamName}) differed from league leader (${leagueLeader.teamName}).`;
      }
    }

    return {
      ok: true,
      season: {
        dbName,
        label: `CPL ${seasonNum}`,
        seasonNumber: Number(seasonNum) || seasonNum,
        teamCount: table.length,
        completedFixtures: fixtureCount,
        champion: displayChampion,
        leagueLeader,
        playoffChampion,
        topSix: table.slice(0, 6),
        table,
        insights,
        playerHighlights,
      },
    };
  } catch (e) {
    return { ok: false, dbName, message: e.message || String(e) };
  }
}

async function loadOneTournamentSeason(tournament) {
  const tournamentId = tournament?._id;
  const seasonLabel = tournament?.name || `Tournament ${String(tournamentId || '').slice(-6)}`;
  try {
    const db = mongoose.connection.db;
    const table = normalizeTournamentPointTableRows(tournament?.pointTable || []);
    const fixtureCount = await db.collection('fixtures').countDocuments({
      tournamentId,
      isActive: true,
      winner: { $ne: null, $exists: true },
    });

    const [playoffFinal, playerHighlights] = await Promise.all([
      fetchPlayoffFinalWinner(mongoose.connection, { tournamentId }),
      fetchSeasonPlayerHighlights(mongoose.connection, { tournamentId }),
    ]);

    const insights = buildSeasonInsights(table);
    const leagueLeader = table[0] || null;
    const playoffChampion = playoffFinal ? enrichChampionFromTable(playoffFinal, table) : null;
    const displayChampion = playoffChampion || leagueLeader;

    if (insights && leagueLeader && playoffChampion) {
      const a = String(leagueLeader.teamName || '').toLowerCase().trim();
      const b = String(playoffChampion.teamName || '').toLowerCase().trim();
      if (a && b && a !== b) {
        insights.playoffNote = `Playoff winner (${playoffChampion.teamName}) differed from league leader (${leagueLeader.teamName}).`;
      }
    }

    return {
      ok: true,
      season: {
        dbName: `tournament:${String(tournamentId)}`,
        label: seasonLabel,
        seasonNumber: seasonNumFromTournamentName(seasonLabel) || null,
        tournamentId: String(tournamentId),
        teamCount: table.length,
        completedFixtures: fixtureCount,
        champion: displayChampion,
        leagueLeader,
        playoffChampion,
        topSix: table.slice(0, 6),
        table,
        insights,
        playerHighlights,
      },
    };
  } catch (e) {
    return { ok: false, dbName: `tournament:${String(tournamentId)}`, message: e.message || String(e) };
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const part = await Promise.all(chunk.map((item, j) => fn(item, i + j)));
    out.push(...part);
  }
  return out;
}

/**
 * GET /api/cpl-history/summary
 * Public read-only summary of previous CPL seasons (historical DBs).
 */
router.get('/summary', async (req, res) => {
  try {
    const source = String(req.query.source || '').toLowerCase();
    const forceLegacyDbMode = source === 'legacy-db' || source === 'legacy';

    if (!forceLegacyDbMode) {
      const tournaments = await Tournament.find({
        isActive: true,
        status: 'completed',
      })
        .select('_id name pointTable endDate updatedAt')
        .sort({ endDate: -1, updatedAt: -1 })
        .lean();

      if (tournaments.length) {
        const tournamentKeys = tournaments.map((t) => String(t._id));
        const cached = getCachedHistorySummary(tournamentKeys);
        if (cached && cached.ok) {
          res.set('X-CPL-History-Cache', 'HIT');
          res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
          return res.json(cached);
        }

        const results = await mapWithConcurrency(tournaments, HISTORY_PARALLEL, (t) =>
          loadOneTournamentSeason(t),
        );

        const seasons = [];
        const errors = [];
        for (const r of results) {
          if (r.ok) seasons.push(r.season);
          else errors.push({ dbName: r.dbName, message: r.message });
        }

        const payload = {
          ok: true,
          source: 'single-db',
          generatedAt: new Date().toISOString(),
          currentSeasonDb: mongoose.connection?.name || null,
          seasons,
          errors: errors.length ? errors : undefined,
        };
        setCachedHistorySummary(tournamentKeys, payload);

        res.set('X-CPL-History-Cache', 'MISS');
        res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
        return res.json(payload);
      }
    }

    const dbNames = resolveHistoryDbNames();
    const cached = getCachedHistorySummary(dbNames);
    if (cached && cached.ok) {
      res.set('X-CPL-History-Cache', 'HIT');
      res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
      return res.json(cached);
    }

    const results = await mapWithConcurrency(dbNames, HISTORY_PARALLEL, (dbName) =>
      loadOneHistorySeason(null, dbName),
    );

    const seasons = [];
    const errors = [];
    for (const r of results) {
      if (r.ok) seasons.push(r.season);
      else errors.push({ dbName: r.dbName, message: r.message });
    }
    seasons.sort((a, b) => seasonNumFromDbName(b.dbName) - seasonNumFromDbName(a.dbName));

    const payload = {
      ok: true,
      source: 'legacy-dbs',
      generatedAt: new Date().toISOString(),
      currentSeasonDb: mongoose.connection?.name || null,
      seasons,
      errors: errors.length ? errors : undefined,
    };
    setCachedHistorySummary(dbNames, payload);

    res.set('X-CPL-History-Cache', 'MISS');
    res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
    res.json(payload);
  } catch (err) {
    console.error('cpl-history summary error', err);
    res.status(500).json({ message: err.message || 'Failed to load CPL history' });
  }
});

module.exports = router;
