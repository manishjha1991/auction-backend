const express = require('express');
const { buildCplReportSnapshot } = require('../utils/cplReportHelpers');
const { generateCplReportPdfBuffer } = require('../utils/cplReportPdfFromSnapshot');
const Player = require('../models/Player');
const PlayerCareerSummary = require('../models/PlayerCareerSummary');
const {
  normName,
  rebuildAllLiveCareerSummaries,
  syncAllPlayerRankingsFromCareerSummaries,
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

async function getReportSnapshotOrCached({ source = '' } = {}) {
  const forceLegacy = String(source || '').toLowerCase() === 'legacy-db' || String(source || '').toLowerCase() === 'legacy-dbs' || String(source || '').toLowerCase() === 'legacy';
  if (forceLegacy) {
    const data = await buildCplReportSnapshot({ source });
    return { data, cacheHit: false };
  }
  const hit = getCachedReportSnapshot();
  if (hit) return { data: hit, cacheHit: true };
  const data = await buildCplReportSnapshot({ source });
  if (data.ok) setCachedReportSnapshot(data);
  return { data, cacheHit: false };
}

const DEFAULT_CAREER_SOURCE_LABEL =
  process.env.CPL_CAREER_SOURCE_LABEL ||
  'Data from cpl_15 to the current CPL (historical + live).';

async function getCareerSummaryOrCached({ refresh = false, includeInactive = true } = {}) {
  const cacheKey = ['current-db-player-career-summary-v3', includeInactive ? 'all' : 'active'];
  const hit = refresh ? null : getCachedCareerSummary(cacheKey);
  if (hit) return { data: hit, cacheHit: true };
  const match = includeInactive ? {} : { isActive: true };

  let [summaries, allPlayers] = await Promise.all([
    PlayerCareerSummary.find({}).select(CAREER_SUMMARY_LIST_PROJECTION).lean(),
    Player.find(match).select('_id name role').lean(),
  ]);

  // First-time bootstrap: if summary docs are empty, rebuild from current DB playerstats.
  if (!summaries.length) {
    await rebuildAllLiveCareerSummaries();
    await syncAllPlayerRankingsFromCareerSummaries();
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
    players.push(s ? mapCareerSummaryLeanToApiPlayer(s) : emptyCareerApiPlayerFromPlayer(p));
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
router.get('/snapshot', async (req, res) => {
  try {
    const { data, cacheHit } = await getReportSnapshotOrCached({ source: req.query.source });
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
router.get('/pdf', async (req, res) => {
  try {
    const { data, cacheHit } = await getReportSnapshotOrCached({ source: req.query.source });
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

module.exports = router;
