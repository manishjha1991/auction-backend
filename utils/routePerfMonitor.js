const { performance } = require('perf_hooks');

const MAX_SAMPLES_PER_ROUTE = 200;
const routeStats = new Map();

function getRouteKey(req) {
  const base = req.baseUrl || '';
  const routePath = req.route?.path;
  if (routePath) {
    return `${req.method} ${base}${routePath}`;
  }
  const pathOnly = (req.originalUrl || req.url || '').split('?')[0];
  return `${req.method} ${pathOnly}`;
}

function ensureRouteRow(key) {
  let row = routeStats.get(key);
  if (!row) {
    row = {
      route: key,
      count: 0,
      totalMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0,
      lastMs: 0,
      lastStatus: null,
      lastAt: null,
      samples: [],
    };
    routeStats.set(key, row);
  }
  return row;
}

function toPercentile(samples, pct) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length));
  return sorted[idx];
}

function routePerfMiddleware(req, res, next) {
  if (!req.path?.startsWith('/api/')) return next();
  const started = performance.now();
  res.on('finish', () => {
    const elapsed = performance.now() - started;
    const key = getRouteKey(req);
    const row = ensureRouteRow(key);
    row.count += 1;
    row.totalMs += elapsed;
    row.minMs = Math.min(row.minMs, elapsed);
    row.maxMs = Math.max(row.maxMs, elapsed);
    row.lastMs = elapsed;
    row.lastStatus = res.statusCode;
    row.lastAt = new Date().toISOString();
    row.samples.push(elapsed);
    if (row.samples.length > MAX_SAMPLES_PER_ROUTE) {
      row.samples.shift();
    }
  });
  next();
}

function getRoutePerfSnapshot({ limit = 50, contains = '', method = '' } = {}) {
  const containsNeedle = String(contains || '').trim().toLowerCase();
  const methodNeedle = String(method || '').trim().toUpperCase();

  const rows = Array.from(routeStats.values())
    .filter((row) => {
      if (containsNeedle && !row.route.toLowerCase().includes(containsNeedle)) {
        return false;
      }
      if (methodNeedle && !row.route.startsWith(`${methodNeedle} `)) {
        return false;
      }
      return true;
    })
    .map((row) => {
    const avgMs = row.count > 0 ? row.totalMs / row.count : 0;
    return {
      route: row.route,
      count: row.count,
      avgMs: Number(avgMs.toFixed(2)),
      minMs: Number((Number.isFinite(row.minMs) ? row.minMs : 0).toFixed(2)),
      maxMs: Number(row.maxMs.toFixed(2)),
      p50Ms: Number(toPercentile(row.samples, 50).toFixed(2)),
      p95Ms: Number(toPercentile(row.samples, 95).toFixed(2)),
      lastMs: Number(row.lastMs.toFixed(2)),
      lastStatus: row.lastStatus,
      lastAt: row.lastAt,
      sampleCount: row.samples.length,
    };
    });

  rows.sort((a, b) => b.avgMs - a.avgMs);
  return rows.slice(0, Math.max(1, limit));
}

function resetRoutePerfStats() {
  routeStats.clear();
}

module.exports = {
  routePerfMiddleware,
  getRoutePerfSnapshot,
  resetRoutePerfStats,
};

