#!/usr/bin/env node
/**
 * CPL Points Table PDF Generator
 *
 * Pulls point table data from cpl_17, cpl_18, cpl_19, cpl_20 and generates a PDF
 * showing standings (Points, Fairness, NRR, Matches Played) for each season.
 *
 * Usage:
 *   node scripts/cpl-points-table-pdf.js
 *
 * Requires: npm install pdfkit (or add to package.json)
 * Output: cpl-points-table-report.pdf in current directory
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// PDFKit - install with: npm install pdfkit
let PDFDocument;
try {
  PDFDocument = require('pdfkit');
} catch (e) {
  console.error('❌ pdfkit not found. Run: npm install pdfkit');
  process.exit(1);
}
const HARD_CODED_URI =
  'mongodb+srv://sudha1793:eLyeXqVAC1kdCfUn@auction-app.z20al.mongodb.net/?retryWrites=true&w=majority&appName=auction-app';

const BASE_URI = (HARD_CODED_URI || '')
  .replace(/\?.*$/, '')
  .replace(/\/$/, '');
// Most recent first (cpl_20 at top)
const DATABASES = ['cpl_20', 'cpl_19', 'cpl_18', 'cpl_17'];

// --- NRR calculation helpers (same logic as user.js) ---
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
  let totalRunsScored = 0, totalRunsConceded = 0, totalOversFaced = 0, totalOversBowled = 0;
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

    let isTeam1 = false, isTeam2 = false;
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

// --- Fetch point table for a database ---
async function fetchPointTable(conn) {
  const db = conn.db;
  const users = await db.collection('users').find({
    teamName: { $exists: true, $ne: null, $ne: 'NA' },
    isActive: true,
    isAdmin: { $ne: true }
  }).project({ _id: 1, teamName: 1, abbreviation: 1, points: 1, matchesPlayed: 1, fairnessPoint: 1 }).toArray();

  const fixtures = await db.collection('fixtures').find({
    isActive: true,
    winner: { $ne: null, $exists: true }
  }).project({ team1: 1, team2: 1, team1UserId: 1, team2UserId: 1, team1Score: 1, team2Score: 1, team1Overs: 1, team2Overs: 1, winner: 1 }).toArray();

  const table = users.map((user) => {
    const matchesPlayed = user.matchesPlayed || 0;
    const points = user.points || 0;
    const fairness = user.fairnessPoint || 0;
    const nrr = calculateNRR(fixtures, user.teamName, user._id);
    const displayName = user.abbreviation || user.teamName || 'Unknown';
    return {
      rank: 0,
      teamName: displayName,
      points,
      fairness,
      nrr,
      matchesPlayed,
      wins: Math.floor(points / 2),
      losses: matchesPlayed - Math.floor(points / 2)
    };
  });

  table.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const nrrA = a.nrr || 0, nrrB = b.nrr || 0;
    if (nrrB !== nrrA) return nrrB - nrrA;
    if (b.fairness !== a.fairness) return b.fairness - a.fairness;
    if (a.matchesPlayed !== b.matchesPlayed) return a.matchesPlayed - b.matchesPlayed;
    return (a.teamName || '').localeCompare(b.teamName || '');
  });

  table.forEach((t, i) => { t.rank = i + 1; });
  return table;
}

// --- Generate PDF ---
function generatePDF(allData) {
  return new Promise((resolve, reject) => {
    const outputPath = path.resolve(__dirname, '..', 'cpl-points-table-report.pdf');
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const stream = fs.createWriteStream(outputPath);

    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
    doc.pipe(stream);

    const pageWidth = 595;
    const left = 40;
    const colW = { rank: 28, team: 130, pts: 38, nrr: 52, fair: 42, played: 48, w: 32, l: 32 };
    const colX = {
      rank: left,
      team: left + colW.rank,
      pts: left + colW.rank + colW.team,
      nrr: left + colW.rank + colW.team + colW.pts,
      fair: left + colW.rank + colW.team + colW.pts + colW.nrr,
      played: left + colW.rank + colW.team + colW.pts + colW.nrr + colW.fair,
      w: left + colW.rank + colW.team + colW.pts + colW.nrr + colW.fair + colW.played,
      l: left + colW.rank + colW.team + colW.pts + colW.nrr + colW.fair + colW.played + colW.w
    };
    const tableWidth = colW.rank + colW.team + colW.pts + colW.nrr + colW.fair + colW.played + colW.w + colW.l;
    const rowHeight = 20;

    // Title
    doc.fontSize(24).fillColor('#1a365d').text('CPL Points Table Report', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#718096').text(`All Seasons • Generated ${new Date().toLocaleDateString()}`, { align: 'center' });
    doc.moveDown(1.5);

    allData.forEach(({ db, table, error }) => {
      const seasonNum = db.replace('cpl_', '');
      const sectionTitle = `CPL ${seasonNum}`;

      // Section header - reset x to left margin (cursor stays at right after table)
      doc.x = left;
      doc.fontSize(16).fillColor('#2c5282').text(sectionTitle, { align: 'left' });
      doc.moveDown(0.5);

      if (error) {
        doc.fontSize(10).fillColor('#c53030').text(`Error: ${error}`);
        doc.moveDown(1.2);
        return;
      }

      if (table.length === 0) {
        doc.fontSize(10).fillColor('#718096').text('No teams found');
        doc.moveDown(1.2);
        return;
      }

      let y = doc.y;

      // Table header - filled background
      doc.rect(left, y, tableWidth, rowHeight).fill('#2c5282');
      doc.fillColor('#fff').fontSize(10);
      doc.text('#', colX.rank + 6, y + 5, { width: colW.rank - 8 });
      doc.text('Team', colX.team + 6, y + 5, { width: colW.team - 8 });
      doc.text('Pts', colX.pts + 4, y + 5, { width: colW.pts - 8 });
      doc.text('NRR', colX.nrr + 4, y + 5, { width: colW.nrr - 8 });
      doc.text('Fair', colX.fair + 4, y + 5, { width: colW.fair - 8 });
      doc.text('Played', colX.played + 2, y + 5, { width: colW.played - 8 });
      doc.text('W', colX.w + 6, y + 5, { width: colW.w - 8 });
      doc.text('L', colX.l + 6, y + 5, { width: colW.l - 8 });
      doc.rect(left, y, tableWidth, rowHeight).stroke();
      y += rowHeight;

      // Data rows with alternating background
      table.forEach((row, idx) => {
        const isEven = idx % 2 === 0;
        if (isEven) doc.rect(left, y, tableWidth, rowHeight).fill('#f7fafc');
        doc.rect(left, y, tableWidth, rowHeight).stroke();
        doc.fillColor('#2d3748').fontSize(10);
        doc.text(String(row.rank), colX.rank + 6, y + 5, { width: colW.rank - 8 });
        doc.text((row.teamName || '').substring(0, 20), colX.team + 6, y + 5, { width: colW.team - 12 });
        doc.text(String(row.points), colX.pts + 4, y + 5, { width: colW.pts - 8 });
        doc.text(String(row.nrr), colX.nrr + 4, y + 5, { width: colW.nrr - 8 });
        doc.text(String(row.fairness), colX.fair + 4, y + 5, { width: colW.fair - 8 });
        doc.text(String(row.matchesPlayed), colX.played + 2, y + 5, { width: colW.played - 8 });
        doc.text(String(row.wins), colX.w + 6, y + 5, { width: colW.w - 8 });
        doc.text(String(row.losses), colX.l + 6, y + 5, { width: colW.l - 8 });
        y += rowHeight;
      });

      doc.y = y;
      doc.moveDown(1.5);
    });

    doc.end();
  });
}

// --- Main ---
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('CPL Points Table PDF Generator');
  console.log('='.repeat(60));
  console.log('Databases:', DATABASES.join(', '));
  console.log('='.repeat(60) + '\n');

  const baseUri = BASE_URI.replace(/\?.*$/, '').replace(/\/$/, '');
  const getUri = (db) => `${baseUri}/${db}?retryWrites=true&w=majority`;

  const allData = [];

  for (const dbName of DATABASES) {
    try {
      const conn = mongoose.createConnection(getUri(dbName), { dbName });
      await new Promise((resolve, reject) => {
        conn.on('connected', resolve);
        conn.on('error', reject);
      });

      const table = await fetchPointTable(conn);
      await conn.close();

      allData.push({ db: dbName, table });
      console.log(`✅ ${dbName}: ${table.length} teams`);
    } catch (err) {
      console.error(`❌ ${dbName}:`, err.message);
      allData.push({ db: dbName, table: [], error: String(err.message) });
    }
  }

  const outputPath = await generatePDF(allData);
  console.log('\n✅ PDF saved to:');
  console.log('   ', outputPath);
  console.log('\n   Open with: open "' + outputPath + '"');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
