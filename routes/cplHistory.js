const express = require('express');
const mongoose = require('mongoose');
const {
  fetchPointTableFromConnection,
  fetchPlayoffFinalWinner,
  enrichChampionFromTable,
  buildSeasonInsights,
  fetchSeasonPlayerHighlights,
} = require('../utils/cplHistoryHelpers');

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

async function loadOneHistorySeason(base, dbName) {
  const uri = `${base}/${dbName}?retryWrites=true&w=majority`;
  let conn;
  try {
    conn = mongoose.createConnection(uri, { dbName, maxPoolSize: 4 });
    await new Promise((resolve, reject) => {
      conn.once('connected', resolve);
      conn.once('error', reject);
    });

    const [{ table, fixtureCount }, playoffFinal, playerHighlights] = await Promise.all([
      fetchPointTableFromConnection(conn),
      fetchPlayoffFinalWinner(conn),
      fetchSeasonPlayerHighlights(conn),
    ]);
    await conn.close();

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
    if (conn) {
      try {
        await conn.close();
      } catch (_) {}
    }
    return { ok: false, dbName, message: e.message || String(e) };
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
    const base = getBaseMongoUri();
    if (!base) {
      return res.status(503).json({ message: 'MONGO_URI not configured' });
    }

    const dbNames = resolveHistoryDbNames();
    const results = await mapWithConcurrency(dbNames, HISTORY_PARALLEL, (dbName) =>
      loadOneHistorySeason(base, dbName),
    );

    const seasons = [];
    const errors = [];
    for (const r of results) {
      if (r.ok) seasons.push(r.season);
      else errors.push({ dbName: r.dbName, message: r.message });
    }
    seasons.sort((a, b) => seasonNumFromDbName(b.dbName) - seasonNumFromDbName(a.dbName));

    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      currentSeasonDb: mongoose.connection?.name || null,
      seasons,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    console.error('cpl-history summary error', err);
    res.status(500).json({ message: err.message || 'Failed to load CPL history' });
  }
});

module.exports = router;
