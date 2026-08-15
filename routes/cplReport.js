const express = require('express');
const mongoose = require('mongoose');
const { buildCplReportSnapshot } = require('../utils/cplReportHelpers');
const { generateCplReportPdfBuffer } = require('../utils/cplReportPdfFromSnapshot');
const Player = require('../models/Player');
const PlayerCareerSummary = require('../models/PlayerCareerSummary');
const AppSettings = require('../models/AppSettings');
const {
  normName,
  rebuildAllLiveCareerSummaries,
  mapCareerSummaryLeanToApiPlayer,
  emptyCareerApiPlayerFromPlayer,
} = require('../utils/playerCareerSummary');
const {
  getCachedReportSnapshot,
  setCachedReportSnapshot,
  getCachedCareerSummary,
  setCachedCareerSummary,
} = require('../utils/cplReadCaches');
const { invalidateCache } = require('../utils/cache');

const router = express.Router();

/** List API only needs merged totals + identity; historical/live are large and unused here. */
const CAREER_SUMMARY_LIST_PROJECTION = {
  playerKey: 1,
  playerId: 1,
  playerName: 1,
  role: 1,
  teams: 1,
  total: 1,
};

async function getReportSnapshotOrCached() {
  const hit = getCachedReportSnapshot();
  if (hit) return { data: hit, cacheHit: true };
  
  // Load CPL report start database setting
  const settings = await AppSettings.findOne({});
  const startDb = settings?.cplReportStartDb || null;
  
  const data = await buildCplReportSnapshot(startDb);
  if (data.ok) setCachedReportSnapshot(data);
  return { data, cacheHit: false };
}

const DEFAULT_CAREER_SOURCE_LABEL =
  process.env.CPL_CAREER_SOURCE_LABEL ||
  'Same cumulative runs, wickets, and averages as Rankings.';

function buildFallbackCplDatabases() {
  const currentDbName = mongoose.connection?.name || process.env.MONGO_DB_NAME || '';
  const match = String(currentDbName).match(/^cpl_(\d+)$/i);
  if (!match) return currentDbName ? [{ name: currentDbName }] : [];
  const currentNum = parseInt(match[1], 10);
  const start = Math.max(1, currentNum - 10);
  const dbs = [];
  for (let i = start; i <= currentNum; i += 1) {
    dbs.push({ name: `cpl_${i}` });
  }
  return dbs;
}

/** Overlay Rankings Player totals so career stats match /rankings. Keep 50s/100s/highest from innings history. */
function applyPlayerTotalsFromRankings(careerRow, player) {
  if (!careerRow || !player) return careerRow;
  const totalRuns = Number(player.totalRuns) || 0;
  const totalWickets = Number(player.totalWickets) || 0;
  const innings = Number(player.matchesPlayed) || 0;
  const notOutInnings = Number(player.totalNotOutInnings) || 0;
  const dismissals = Math.max(0, innings - notOutInnings);
  const totalBalls = Number(player.totalBalls) || 0;
  const totalRunsGiven = Number(player.totalRunsGiven) || 0;
  const totalHattricks = Number(player.totalHattricks) || 0;
  return {
    ...careerRow,
    totalRuns,
    totalWickets,
    innings,
    notOutInnings,
    dismissals,
    totalHattricks,
    battingStrikeRate: totalBalls ? Number(((totalRuns * 100) / totalBalls).toFixed(2)) : 0,
    battingAverage: dismissals ? Number((totalRuns / dismissals).toFixed(2)) : 0,
    bowlingAverage: totalWickets ? Number((totalRunsGiven / totalWickets).toFixed(2)) : 0,
  };
}

async function getCareerSummaryOrCached({ refresh = false, includeInactive = true } = {}) {
  const cacheKey = ['current-db-player-career-summary-v5-match-rankings', includeInactive ? 'all' : 'active'];
  const hit = refresh ? null : getCachedCareerSummary(cacheKey);
  if (hit) return { data: hit, cacheHit: true };
  const match = includeInactive ? {} : { isActive: true };

  let [summaries, allPlayers] = await Promise.all([
    PlayerCareerSummary.find({}).select(CAREER_SUMMARY_LIST_PROJECTION).lean(),
    Player.find(match)
      .select('_id name role totalRuns totalWickets matchesPlayed totalNotOutInnings totalBalls totalRunsGiven totalBallsBowled totalHattricks')
      .lean(),
  ]);

  // First-time bootstrap: if summary docs are empty, rebuild live blocks only.
  // Do not syncAllPlayerRankingsFromCareerSummaries — Player totals are accumulate-only.
  if (!summaries.length) {
    await rebuildAllLiveCareerSummaries();
    try {
      invalidateCache('players:data');
      invalidateCache('players:data:all');
    } catch (_) {
      /* ignore */
    }
    summaries = await PlayerCareerSummary.find({}).select(CAREER_SUMMARY_LIST_PROJECTION).lean();
  }

  const byPlayerId = new Map();
  const byKey = new Map();
  for (const s of summaries) {
    if (s.playerId) byPlayerId.set(String(s.playerId), s);
    if (s.playerKey) byKey.set(s.playerKey, s);
  }

  const usedSummaryIds = new Set();
  const players = [];

  for (const p of allPlayers) {
    const idStr = String(p._id);
    const key = normName(p.name);
    const s = byPlayerId.get(idStr) || byKey.get(key);
    if (s) usedSummaryIds.add(String(s._id));
    if (s) {
      players.push(applyPlayerTotalsFromRankings(mapCareerSummaryLeanToApiPlayer(s), p));
    } else {
      players.push(applyPlayerTotalsFromRankings(emptyCareerApiPlayerFromPlayer(p), p));
    }
  }

  for (const s of summaries) {
    if (!usedSummaryIds.has(String(s._id))) {
      players.push(mapCareerSummaryLeanToApiPlayer(s));
    }
  }

  players.sort((a, b) => {
    if (b.totalRuns !== a.totalRuns) return b.totalRuns - a.totalRuns;
    if (b.totalWickets !== a.totalWickets) return b.totalWickets - a.totalWickets;
    return String(a.playerName || '').localeCompare(String(b.playerName || ''));
  });

  const data = {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: 'current-db',
    dbNames: ['current-db'],
    /** Human-readable line for the career page (override with CPL_CAREER_SOURCE_LABEL). */
    careerDataSourceLabel: DEFAULT_CAREER_SOURCE_LABEL,
    includeInactive,
    players,
  };
  if (data.ok) setCachedCareerSummary(cacheKey, data);
  return { data, cacheHit: false };
}

/**
 * GET /api/cpl-report/snapshot
 * Live point tables for CPL_REPORT_DBS (default cpl_19,cpl_18,cpl_17), methodology + WC notes, composite index.
 */
router.get('/snapshot', async (_req, res) => {
  try {
    const { data, cacheHit } = await getReportSnapshotOrCached();
    if (!data.ok) {
      return res.status(503).json(data);
    }
    res.set('X-CPL-Report-Cache', cacheHit ? 'HIT' : 'MISS');
    // Short private cache when served from server cache; still refreshes after TTL + invalidation on points updates
    res.set('Cache-Control', cacheHit ? 'private, max-age=15' : 'private, max-age=5');
    res.json(data);
  } catch (err) {
    console.error('cpl-report snapshot error', err);
    res.status(500).json({ ok: false, message: err.message || 'Failed to build report' });
  }
});

/**
 * GET /api/cpl-report/pdf
 * PDF export — same data as /snapshot at request time (static file once downloaded).
 */
router.get('/pdf', async (_req, res) => {
  try {
    const { data, cacheHit } = await getReportSnapshotOrCached();
    if (!data.ok) {
      return res.status(503).json(data);
    }
    const buf = await generateCplReportPdfBuffer(data);
    const day = new Date().toISOString().slice(0, 10);
    const filename = `cpl-qualification-overview-${day}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-CPL-Report-Cache', cacheHit ? 'HIT' : 'MISS');
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.send(buf);
  } catch (err) {
    console.error('cpl-report pdf error', err);
    res.status(500).json({ ok: false, message: err.message || 'Failed to generate PDF' });
  }
});

/**
 * GET /api/cpl-report/player-career-summary
 * Player career summary across configured historical CPL databases (mobile-friendly page consumer).
 */
router.get('/player-career-summary', async (req, res) => {
  try {
    const refresh = String(req.query.refresh || '') === '1';
    const includeInactive = String(req.query.includeInactive || 'true') !== 'false';
    const { data, cacheHit } = await getCareerSummaryOrCached({ refresh, includeInactive });
    if (!data.ok) return res.status(503).json(data);
    res.set('X-CPL-Career-Cache', cacheHit ? 'HIT' : 'MISS');
    res.set('Cache-Control', cacheHit ? 'private, max-age=30' : 'private, max-age=10');
    res.json(data);
  } catch (err) {
    console.error('cpl-report player-career-summary error', err);
    res.status(500).json({ ok: false, message: err.message || 'Failed to build player career summary' });
  }
});

/**
 * GET /api/cpl-report/config
 * Get CPL report configuration (starting database for composite report)
 */
router.get('/config', async (_req, res) => {
  try {
    const settings = await AppSettings.findOne({});
    res.json({
      cplReportStartDb: settings?.cplReportStartDb || '',
    });
  } catch (err) {
    console.error('cpl-report config error', err);
    res.status(500).json({ ok: false, message: err.message || 'Failed to load config' });
  }
});

/**
 * GET /api/cpl-report/databases
 * List available CPL databases for admin config dropdowns.
 */
router.get('/databases', async (_req, res) => {
  try {
    const adminDb = mongoose.connection.db.admin();
    const { databases } = await adminDb.listDatabases();
    const cplDbs = (databases || [])
      .map((db) => db.name)
      .filter((name) => /^cpl_\d+$/i.test(name))
      .sort((a, b) =>
        String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
      );
    res.json({
      databases: cplDbs.map((name) => ({ name })),
      currentDatabase: mongoose.connection.name || null,
    });
  } catch (err) {
    console.error('cpl-report databases error', err);
    res.json({
      databases: buildFallbackCplDatabases(),
      currentDatabase: mongoose.connection.name || process.env.MONGO_DB_NAME || null,
      warning: 'Database listing failed, using fallback CPL database list',
    });
  }
});

/**
 * POST /api/cpl-report/config
 * Set CPL report configuration (starting database for composite report)
 */
router.post('/config', async (req, res) => {
  try {
    const { cplReportStartDb } = req.body;
    
    let settings = await AppSettings.findOne({});
    if (!settings) {
      settings = new AppSettings();
    }
    
    settings.cplReportStartDb = cplReportStartDb || '';
    await settings.save();
    
    // Invalidate cache so next report request uses new setting
    const { invalidateCache } = require('../utils/cache');
    try {
      invalidateCache('cpl-report:snapshot');
    } catch (_) {
      /* ignore */
    }
    
    res.json({
      success: true,
      cplReportStartDb: settings.cplReportStartDb,
      message: 'CPL report configuration updated',
    });
  } catch (err) {
    console.error('cpl-report config update error', err);
    res.status(500).json({ ok: false, message: err.message || 'Failed to update config' });
  }
});

module.exports = router;
