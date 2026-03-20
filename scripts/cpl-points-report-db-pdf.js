#!/usr/bin/env node
/**
 * CPL Points Report PDF — layout aligned with `cpl-points-table-report 2.xlsx`
 *
 * - Sheet "Formulas"  → methodology page(s)
 * - Sheet "Calculation" → point tables + composite index, but **all numbers from MongoDB** (live)
 * - Sheet "World Cup Selection" (3rd tab) → **not** loaded from DB; static note page only
 *
 * Databases (newest first): default = running CPL + two prior (e.g. cpl_20 → cpl_20,19,18).
 * Hint from MONGO_URI path /cpl_N, MONGO_DB_NAME, or mongoose after connect.
 * Override: CPL_REPORT_DBS=cpl_20,cpl_19,cpl_18
 *
 * Requires: MONGO_URI in .env, pdfkit
 *
 * Usage (from auction-backend/):
 *   node scripts/cpl-points-report-db-pdf.js
 *   CPL_REPORT_DBS=cpl_18,cpl_17,cpl_16 node scripts/cpl-points-report-db-pdf.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { parseReportDbs } = require('../utils/cplReportHelpers');

let PDFDocument;
try {
  PDFDocument = require('pdfkit');
} catch (e) {
  console.error('❌ pdfkit not found. Run: npm install pdfkit');
  process.exit(1);
}

/** From xlsx sheet "Formulas" — methodology only (no DB). */
const FORMULAS_STEPS = [
  ['Step 1', 'Normalise Points', '((Team Points - Min Points) / (Highest points - Min Points)) × 100'],
  ['Step 2', 'Normalise NRR', '((Team NRR - Min NRR) / (Highest NRR - Min NRR)) × 100'],
  ['Step 3', 'Normalise Fairness', '((Team Fairness - Min Fairness) / (Highest Fairness - Min Fairness)) × 100'],
  ['Step 4', 'Calculate Index', '(0.5 × Point Index + 0.3 × NRR index + 0.2 × fairness index)'],
  ['Step 5', 'Calculate Index for all tournaments using above method', ''],
  ['Step 6', 'Take average of tournament indices to reach final Index score', ''],
  ['Step 7', 'Rank users based on final Index', ''],
];

/** Concrete WC rules; PDF section title is generic. */
const WORLD_CUP_NOTES = [
  '• To be implemented after World Cup.',
  '• Rankings based on 3 CPLs.',
  '• Top 6 qualify automatically for WC.',
  '• Remaining 8 enter knockout to select 2 teams for WC.',
  '• KO1: Pos 7 vs 14 · KO2: 8 vs 13 · KO3: 9 vs 12 · KO4: 10 vs 11.',
  '• Then KO1 vs KO4, KO2 vs KO3; 2 winners join WC.',
  '• Parallel KOs during 3rd CPL Eliminator — walkovers if time clashes.',
];

function getBaseUri() {
  const uri = process.env.MONGO_URI || '';
  if (!uri) throw new Error('MONGO_URI missing in .env');
  const noQuery = uri.replace(/\?.*$/, '');
  return noQuery.replace(/\/[^/?]+$/, '').replace(/\/$/, '');
}

function cplLabel(dbName) {
  const n = dbName.replace(/^cpl_/i, '');
  return `CPL ${n}`;
}

// --- NRR (same as routes/user.js / cpl-points-table-pdf.js) ---
const parseRuns = (scoreString) => {
  if (!scoreString) return 0;
  const scoreStr = String(scoreString).trim();
  if (['null', 'TBD', 'NA', '', 'undefined'].includes(scoreStr) || scoreStr.toLowerCase() === 'null') return 0;
  const match = scoreStr.match(/^(\d+)/);
  if (match) return parseInt(match[1], 10) || 0;
  const num = parseFloat(scoreStr);
  return isNaN(num) ? 0 : Math.floor(num);
};

const parseWickets = (scoreString) => {
  if (!scoreString) return 0;
  const scoreStr = String(scoreString).trim();
  if (['null', 'TBD', 'NA', '', 'undefined'].includes(scoreStr) || scoreStr.toLowerCase() === 'null') return 0;
  const slashMatch = scoreStr.match(/\/(\d+)/);
  if (slashMatch) {
    const w = parseInt(slashMatch[1], 10);
    if (!isNaN(w) && w >= 0 && w <= 10) return w;
  }
  const hyphenMatch = scoreStr.match(/-(\d+)/);
  if (hyphenMatch) {
    const w = parseInt(hyphenMatch[1], 10);
    if (!isNaN(w) && w >= 0 && w <= 10) return w;
  }
  return 0;
};

const parseOvers = (oversString) => {
  if (!oversString) return null;
  const oversStr = String(oversString).trim();
  if (['null', 'TBD', 'NA', '', 'undefined'].includes(oversStr) || oversStr.toLowerCase() === 'null') return null;
  const decimalMatch = oversStr.match(/^(\d+)\.(\d+)$/);
  if (decimalMatch) {
    const overs = parseInt(decimalMatch[1], 10);
    const balls = parseInt(decimalMatch[2], 10);
    if (!isNaN(overs) && !isNaN(balls) && balls >= 0 && balls <= 5) return overs + balls / 6;
  }
  const wholeMatch = oversStr.match(/^(\d+)$/);
  if (wholeMatch) return parseInt(wholeMatch[1], 10) || null;
  const num = parseFloat(oversStr);
  return !isNaN(num) && num >= 0 ? num : null;
};

const DEFAULT_OVERS = 20;
const calculateNRR = (fixtures, teamName, userId) => {
  let totalRunsScored = 0,
    totalRunsConceded = 0,
    totalOversFaced = 0,
    totalOversBowled = 0;
  const userIdStr = userId ? userId.toString() : null;

  fixtures.forEach((fx) => {
    if (!fx.winner) return;
    const team1Runs = parseRuns(fx.team1Score);
    const team2Runs = parseRuns(fx.team2Score);
    if (team1Runs === 0 && team2Runs === 0) return;

    const team1Wickets = parseWickets(fx.team1Score);
    const team2Wickets = parseWickets(fx.team2Score);
    let team1OversActual = parseOvers(fx.team1Overs) ?? DEFAULT_OVERS;
    let team2OversActual = parseOvers(fx.team2Overs) ?? DEFAULT_OVERS;

    const team1OversFaced = team1Wickets === 10 ? DEFAULT_OVERS : team1OversActual;
    const team2OversFaced = team2Wickets === 10 ? DEFAULT_OVERS : team2OversActual;
    const team1OversBowled = team2Wickets === 10 ? DEFAULT_OVERS : team2OversActual;
    const team2OversBowled = team1Wickets === 10 ? DEFAULT_OVERS : team1OversActual;

    const team1UserIdStr = fx.team1UserId ? fx.team1UserId.toString() : null;
    const team2UserIdStr = fx.team2UserId ? fx.team2UserId.toString() : null;

    let isTeam1 = false,
      isTeam2 = false;
    if (userIdStr) {
      if (team1UserIdStr === userIdStr) isTeam1 = true;
      else if (team2UserIdStr === userIdStr) isTeam2 = true;
    }
    if (!isTeam1 && !isTeam2) {
      if (fx.team1 && fx.team1.trim().toLowerCase() === (teamName || '').trim().toLowerCase()) isTeam1 = true;
      else if (fx.team2 && fx.team2.trim().toLowerCase() === (teamName || '').trim().toLowerCase()) isTeam2 = true;
    }
    if (!isTeam1 && !isTeam2) return;

    if (isTeam1) {
      totalRunsScored += team1Runs;
      totalRunsConceded += team2Runs;
      totalOversFaced += team1OversFaced;
      totalOversBowled += team1OversBowled;
    } else {
      totalRunsScored += team2Runs;
      totalRunsConceded += team1Runs;
      totalOversFaced += team2OversFaced;
      totalOversBowled += team2OversBowled;
    }
  });

  if (totalOversFaced === 0 || totalOversBowled === 0) return 0;
  const runsScoredPerOver = totalRunsScored / totalOversFaced;
  const runsConcededPerOver = totalRunsConceded / totalOversBowled;
  return parseFloat((runsScoredPerOver - runsConcededPerOver).toFixed(3));
};

async function fetchPointTable(conn) {
  const db = conn.db;
  const users = await db
    .collection('users')
    .find({
      teamName: { $exists: true, $ne: null, $ne: 'NA' },
      isActive: true,
      isAdmin: { $ne: true },
    })
    .project({ _id: 1, teamName: 1, abbreviation: 1, points: 1, matchesPlayed: 1, fairnessPoint: 1 })
    .toArray();

  const fixtures = await db
    .collection('fixtures')
    .find({
      isActive: true,
      winner: { $ne: null, $exists: true },
    })
    .project({
      team1: 1,
      team2: 1,
      team1UserId: 1,
      team2UserId: 1,
      team1Score: 1,
      team2Score: 1,
      team1Overs: 1,
      team2Overs: 1,
      winner: 1,
    })
    .toArray();

  const table = users.map((user) => {
    const matchesPlayed = user.matchesPlayed || 0;
    const points = user.points || 0;
    const fairness = user.fairnessPoint || 0;
    const nrr = calculateNRR(fixtures, user.teamName, user._id);
    const displayName = (user.abbreviation || user.teamName || 'Unknown').trim();
    return {
      rank: 0,
      teamKey: displayName.toUpperCase(),
      teamName: displayName,
      points,
      fairness,
      nrr,
      matchesPlayed,
      wins: Math.floor(points / 2),
      losses: matchesPlayed - Math.floor(points / 2),
    };
  });

  table.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const nrrA = a.nrr || 0,
      nrrB = b.nrr || 0;
    if (nrrB !== nrrA) return nrrB - nrrA;
    if (b.fairness !== a.fairness) return b.fairness - a.fairness;
    if (a.matchesPlayed !== b.matchesPlayed) return a.matchesPlayed - b.matchesPlayed;
    return (a.teamName || '').localeCompare(b.teamName || '');
  });

  table.forEach((t, i) => {
    t.rank = i + 1;
  });
  return table;
}

function normaliser(values) {
  const nums = values.map(Number).filter((v) => !Number.isNaN(v));
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min;
  return (v) => {
    if (span === 0) return 100;
    return ((v - min) / span) * 100;
  };
}

/** Per team: composite index for one season (xlsx Step 4). */
function addSeasonIndices(table) {
  const normP = normaliser(table.map((r) => r.points));
  const normN = normaliser(table.map((r) => r.nrr));
  const normF = normaliser(table.map((r) => r.fairness));
  return table.map((r) => ({
    teamKey: r.teamKey,
    teamName: r.teamName,
    points: r.points,
    nrr: r.nrr,
    fairness: r.fairness,
    matchesPlayed: r.matchesPlayed,
    wins: r.wins,
    losses: r.losses,
    rank: r.rank,
    normP: normP(r.points),
    normN: normN(r.nrr),
    normF: normF(r.fairness),
    seasonIndex: 0.5 * normP(r.points) + 0.3 * normN(r.nrr) + 0.2 * normF(r.fairness),
  }));
}

function buildCompositeRows(seasonResults) {
  /** @type {Map<string, { teamName: string, byDb: Record<string, number> }>} */
  const map = new Map();
  for (const { dbName, indexed } of seasonResults) {
    for (const row of indexed) {
      if (!map.has(row.teamKey)) map.set(row.teamKey, { teamName: row.teamName, byDb: {} });
      map.get(row.teamKey).byDb[dbName] = row.seasonIndex;
    }
  }
  const dbOrder = seasonResults.map((s) => s.dbName);
  const rows = [...map.entries()].map(([teamKey, { teamName, byDb }]) => {
    const parts = dbOrder.map((d) => byDb[d]).filter((x) => typeof x === 'number');
    const finalAvg = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
    return { teamKey, teamName, byDb, finalAvg };
  });
  rows.sort((a, b) => b.finalAvg - a.finalAvg);
  return { rows, dbOrder };
}

function writeFormulasPage(doc, left, pageWidth) {
  doc.fontSize(20).fillColor('#1a365d').text('CPL Points Table Report', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#718096').text('Methodology (from workbook: Formulas sheet)', { align: 'center' });
  doc.moveDown(1);
  doc.fontSize(11).fillColor('#2d3748');
  FORMULAS_STEPS.forEach(([step, title, detail]) => {
    doc.font('Helvetica-Bold').text(`${step}: ${title}`, { continued: false });
    if (detail) {
      doc.font('Helvetica').fontSize(9).fillColor('#4a5568').text(detail, { indent: 12 });
    }
    doc.moveDown(0.4);
    doc.fontSize(11).fillColor('#2d3748');
  });
}

function writePointTablePage(doc, dbName, table, left, colX, colW, rowHeight, tableWidth) {
  const label = cplLabel(dbName);
  doc.x = left;
  doc.fontSize(16).fillColor('#2c5282').text(label, { align: 'left' });
  doc.fontSize(9).fillColor('#718096').text(`Source: MongoDB • ${dbName} • ${new Date().toISOString().slice(0, 10)}`, {
    align: 'left',
  });
  doc.moveDown(0.6);

  let y = doc.y;
  doc.rect(left, y, tableWidth, rowHeight).fill('#2c5282');
  doc.fillColor('#fff').fontSize(9);
  doc.text('#', colX.rank + 4, y + 5, { width: colW.rank - 8 });
  doc.text('Team', colX.team + 4, y + 5, { width: colW.team - 8 });
  doc.text('Pts', colX.pts + 2, y + 5, { width: colW.pts - 6 });
  doc.text('NRR', colX.nrr + 2, y + 5, { width: colW.nrr - 6 });
  doc.text('Fair', colX.fair + 2, y + 5, { width: colW.fair - 6 });
  doc.text('Played', colX.played + 2, y + 5, { width: colW.played - 8 });
  doc.text('W', colX.w + 4, y + 5, { width: colW.w - 8 });
  doc.text('L', colX.l + 4, y + 5, { width: colW.l - 8 });
  doc.rect(left, y, tableWidth, rowHeight).stroke();
  y += rowHeight;

  table.forEach((row, idx) => {
    if (y > doc.page.height - 80) {
      doc.addPage();
      y = 50;
    }
    const isEven = idx % 2 === 0;
    if (isEven) doc.rect(left, y, tableWidth, rowHeight).fill('#f7fafc');
    doc.rect(left, y, tableWidth, rowHeight).stroke();
    doc.fillColor('#2d3748').fontSize(9);
    doc.text(String(row.rank), colX.rank + 4, y + 5, { width: colW.rank - 8 });
    doc.text((row.teamName || '').substring(0, 22), colX.team + 4, y + 5, { width: colW.team - 10 });
    doc.text(String(row.points), colX.pts + 2, y + 5, { width: colW.pts - 6 });
    doc.text(String(row.nrr), colX.nrr + 2, y + 5, { width: colW.nrr - 6 });
    doc.text(String(row.fairness), colX.fair + 2, y + 5, { width: colW.fair - 6 });
    doc.text(String(row.matchesPlayed), colX.played + 2, y + 5, { width: colW.played - 8 });
    doc.text(String(row.wins), colX.w + 4, y + 5, { width: colW.w - 8 });
    doc.text(String(row.losses), colX.l + 4, y + 5, { width: colW.l - 8 });
    y += rowHeight;
  });
  doc.y = y + 10;
}

function writeCompositePage(doc, composite, left, opts = {}) {
  if (!opts.skipInitialAddPage) doc.addPage();
  doc.x = left;
  doc.fontSize(16).fillColor('#2c5282').text('Qualification-style combined ranking (live from DB)', { align: 'left' });
  doc.fontSize(9).fillColor('#718096').text('Per-season index = 0.5×Norm(Pts) + 0.3×Norm(NRR) + 0.2×Norm(Fair). Combined = average across seasons.', {
    width: 520,
  });
  doc.moveDown(0.8);

  const dbLabels = composite.dbOrder.map(cplLabel);
  const rowH = 16;
  let y = doc.y;
  const wRank = 28;
  const wTeam = 100;
  const wCol = 72;
  const wFinal = 78;
  const startX = left;

  doc.fontSize(8).fillColor('#fff');
  doc.rect(startX, y, wRank + wTeam + wCol * dbLabels.length + wFinal, rowH).fill('#2c5282');
  doc.text('#', startX + 6, y + 4, { width: wRank });
  doc.text('Team', startX + wRank + 4, y + 4, { width: wTeam });
  let x = startX + wRank + wTeam;
  dbLabels.forEach((lab) => {
    doc.text(lab, x + 2, y + 4, { width: wCol - 4 });
    x += wCol;
  });
  doc.text('Combined', x + 2, y + 4, { width: wFinal });
  y += rowH;

  doc.fillColor('#2d3748').fontSize(8);
  composite.rows.forEach((r, idx) => {
    if (y > doc.page.height - 60) {
      doc.addPage();
      y = 50;
    }
    const bg = idx % 2 === 0 ? '#f7fafc' : '#ffffff';
    doc.rect(startX, y, wRank + wTeam + wCol * dbLabels.length + wFinal, rowH).fill(bg);
    doc.rect(startX, y, wRank + wTeam + wCol * dbLabels.length + wFinal, rowH).stroke();
    doc.text(String(idx + 1), startX + 6, y + 4, { width: wRank });
    doc.text((r.teamName || '').substring(0, 16), startX + wRank + 4, y + 4, { width: wTeam });
    x = startX + wRank + wTeam;
    for (const db of composite.dbOrder) {
      const v = r.byDb[db];
      doc.text(v != null ? v.toFixed(2) : '—', x + 2, y + 4, { width: wCol - 4 });
      x += wCol;
    }
    doc.text(r.finalAvg.toFixed(2), x + 2, y + 4, { width: wFinal });
    y += rowH;
  });
}

function writeWorldCupNotePage(doc, left) {
  doc.addPage();
  doc.x = left;
  doc.fontSize(16).fillColor('#2c5282').text('Championship qualification — overview (reference)', { align: 'left' });
  doc.moveDown(0.6);
  doc.fontSize(10).fillColor('#2d3748');
  WORLD_CUP_NOTES.forEach((line) => {
    doc.font(line.startsWith('•') ? 'Helvetica' : 'Helvetica').text(line || ' ', { width: 500 });
    doc.moveDown(0.25);
  });
}

function generatePdf(allData, composite, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const stream = fs.createWriteStream(outputPath);
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
    doc.pipe(stream);

    const left = 40;
    const colW = { rank: 26, team: 128, pts: 36, nrr: 48, fair: 40, played: 44, w: 28, l: 28 };
    const colX = {
      rank: left,
      team: left + colW.rank,
      pts: left + colW.rank + colW.team,
      nrr: left + colW.rank + colW.team + colW.pts,
      fair: left + colW.rank + colW.team + colW.pts + colW.nrr,
      played: left + colW.rank + colW.team + colW.pts + colW.nrr + colW.fair,
      w: left + colW.rank + colW.team + colW.pts + colW.nrr + colW.fair + colW.played,
      l: left + colW.rank + colW.team + colW.pts + colW.nrr + colW.fair + colW.played + colW.w,
    };
    const tableWidth = Object.values(colW).reduce((a, b) => a + b, 0);
    const rowHeight = 18;

    if (composite.rows.length > 0 && composite.dbOrder.length > 0) {
      writeCompositePage(doc, composite, left, { skipInitialAddPage: true });
      doc.addPage();
    }
    writeFormulasPage(doc, left, 595);

    allData.forEach(({ dbName, table, error }, i) => {
      doc.addPage();
      if (error) {
        doc.x = left;
        doc.fontSize(14).text(cplLabel(dbName));
        doc.fontSize(10).fillColor('#c53030').text(`Error: ${error}`);
        return;
      }
      writePointTablePage(doc, dbName, table, left, colX, colW, rowHeight, tableWidth);
    });

    writeWorldCupNotePage(doc, left);

    doc.end();
  });
}

async function main() {
  const databases = parseReportDbs();
  const base = getBaseUri();
  console.log('\nCPL DB PDF report (xlsx-aligned layout)');
  console.log('Databases (newest → oldest):', databases.join(', '));
  console.log('World Cup tab: notes only (no DB fetch)\n');

  const allData = [];
  const seasonResults = [];

  for (const dbName of databases) {
    const uri = `${base}/${dbName}?retryWrites=true&w=majority`;
    try {
      const conn = mongoose.createConnection(uri, { dbName });
      await new Promise((resolve, reject) => {
        conn.once('connected', resolve);
        conn.once('error', reject);
      });
      const table = await fetchPointTable(conn);
      await conn.close();
      allData.push({ dbName, table });
      const indexed = addSeasonIndices(table);
      seasonResults.push({ dbName, indexed });
      console.log(`✅ ${dbName}: ${table.length} teams`);
    } catch (err) {
      console.error(`❌ ${dbName}:`, err.message);
      allData.push({ dbName, table: [], error: err.message });
    }
  }

  const composite = buildCompositeRows(seasonResults.filter((s) => s.indexed && s.indexed.length));
  const outputPath = path.resolve(__dirname, '..', 'cpl-points-table-report-from-db.pdf');
  await generatePdf(allData, composite, outputPath);
  console.log('\n✅ PDF:', outputPath);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
