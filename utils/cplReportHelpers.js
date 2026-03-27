/**
 * CPL multi-season report (last N databases): point tables + composite index.
 * Used by GET /api/cpl-report/snapshot and optional PDF script.
 */

const mongoose = require('mongoose');
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

async function buildCplReportSnapshot() {
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

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    currentSeasonDb: mongoose.connection?.name || null,
    /** DB used to derive “current + 2 prior” when CPL_REPORT_DBS is unset */
    runningDbHint: getRunningCplDbNameHint() || null,
    reportDatabases: dbNames,
    formulas: CPL_FORMULAS,
    worldCupNotes: CPL_WORLD_CUP_NOTES,
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
  seasonNumFromDbName,
  buildCplReportSnapshot,
  addSeasonIndices,
  buildCompositeRows,
};
