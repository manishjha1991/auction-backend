/**
 * In-memory caches for CPL report + CPL history summary (heavy multi-DB reads).
 * Invalidated when league points / fixtures change (see emitPointsTableUpdate).
 */
const NodeCache = require('node-cache');
const { registerExtraCache } = require('./cache');

const reportTtl = Math.max(15, Math.min(300, parseInt(process.env.CPL_REPORT_CACHE_TTL_SEC || '45', 10) || 45));
const historyTtl = Math.max(30, Math.min(600, parseInt(process.env.CPL_HISTORY_CACHE_TTL_SEC || '120', 10) || 120));
const careerTtl = Math.max(
  60,
  Math.min(900, parseInt(process.env.CPL_CAREER_CACHE_TTL_SEC || '300', 10) || 300),
);

const reportSnapshotCache = new NodeCache({ stdTTL: reportTtl, checkperiod: Math.floor(reportTtl / 3), useClones: false });
const historySummaryCache = new NodeCache({ stdTTL: historyTtl, checkperiod: Math.floor(historyTtl / 3), useClones: false });
const careerSummaryCache = new NodeCache({ stdTTL: careerTtl, checkperiod: Math.floor(careerTtl / 3), useClones: false });

registerExtraCache(reportSnapshotCache);
registerExtraCache(historySummaryCache);
registerExtraCache(careerSummaryCache);

const REPORT_SNAPSHOT_KEY = 'cpl-report:snapshot:v1';

function getCachedReportSnapshot() {
  return reportSnapshotCache.get(REPORT_SNAPSHOT_KEY);
}

function setCachedReportSnapshot(data) {
  if (data && data.ok) {
    reportSnapshotCache.set(REPORT_SNAPSHOT_KEY, data);
  }
}

function historySummaryCacheKey(dbNames) {
  return dbNames && dbNames.length ? dbNames.join('|') : 'default';
}

function getCachedHistorySummary(dbNames) {
  return historySummaryCache.get(historySummaryCacheKey(dbNames));
}

function setCachedHistorySummary(dbNames, payload) {
  if (payload && payload.ok) {
    historySummaryCache.set(historySummaryCacheKey(dbNames), payload);
  }
}

function getCachedCareerSummary(dbNames) {
  return careerSummaryCache.get(historySummaryCacheKey(dbNames));
}

function setCachedCareerSummary(dbNames, payload) {
  if (payload && payload.ok) {
    careerSummaryCache.set(historySummaryCacheKey(dbNames), payload);
  }
}

function invalidateCareerSummaryCache() {
  try {
    careerSummaryCache.flushAll();
  } catch (_) {
    /* ignore */
  }
}

/** After fixture / points / fairness updates on the live DB — report snapshot spans current+prior seasons. */
function invalidateCplReportCache() {
  try {
    reportSnapshotCache.flushAll();
    careerSummaryCache.flushAll();
  } catch (_) {
    /* ignore */
  }
}

/** Flush both (e.g. rare admin ops or clearAllCaches already flushes registered caches). */
function invalidateCplReadCaches() {
  try {
    reportSnapshotCache.flushAll();
    historySummaryCache.flushAll();
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  getCachedReportSnapshot,
  setCachedReportSnapshot,
  getCachedHistorySummary,
  setCachedHistorySummary,
  getCachedCareerSummary,
  setCachedCareerSummary,
  invalidateCareerSummaryCache,
  historySummaryCacheKey,
  invalidateCplReportCache,
  invalidateCplReadCaches,
};
