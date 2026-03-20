/**
 * Build CPL qualification report PDF from {@link buildCplReportSnapshot} JSON (same data as the web page).
 */
const PDFDocument = require('pdfkit');

function cplLabel(dbName) {
  const n = String(dbName).replace(/^cpl_/i, '');
  return `CPL ${n}`;
}

function writeFormulasFromSnapshot(doc, formulas, left) {
  doc.fontSize(20).fillColor('#1a365d').text('Qualification overview — methodology', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(9).fillColor('#718096').text('Same steps as the app / workbook', { align: 'center' });
  doc.moveDown(0.8);
  doc.fontSize(10).fillColor('#2d3748');
  (formulas || []).forEach((f) => {
    doc.font('Helvetica-Bold').text(`${f.step}: ${f.title}`, { continued: false });
    if (f.detail) {
      doc.font('Helvetica').fontSize(8).fillColor('#4a5568').text(f.detail, { indent: 10 });
    }
    doc.moveDown(0.35);
    doc.fontSize(10).fillColor('#2d3748');
  });
}

function writePointTablePage(doc, dbName, table, left, colX, colW, rowHeight, tableWidth, generatedAt) {
  const label = cplLabel(dbName);
  doc.x = left;
  doc.fontSize(14).fillColor('#2c5282').text(label, { align: 'left' });
  doc.fontSize(8).fillColor('#718096').text(`MongoDB · ${dbName} · snapshot ${(generatedAt || '').slice(0, 19)}`, {
    align: 'left',
  });
  doc.moveDown(0.45);

  let y = doc.y;
  doc.rect(left, y, tableWidth, rowHeight).fill('#2c5282');
  doc.fillColor('#fff').fontSize(8);
  doc.text('#', colX.rank + 3, y + 4, { width: colW.rank - 6 });
  doc.text('Team', colX.team + 3, y + 4, { width: colW.team - 8 });
  doc.text('Pts', colX.pts + 2, y + 4, { width: colW.pts - 4 });
  doc.text('NRR', colX.nrr + 2, y + 4, { width: colW.nrr - 4 });
  doc.text('Fair', colX.fair + 2, y + 4, { width: colW.fair - 4 });
  doc.text('Pl', colX.played + 2, y + 4, { width: colW.played - 6 });
  doc.text('W', colX.w + 3, y + 4, { width: colW.w - 6 });
  doc.text('L', colX.l + 3, y + 4, { width: colW.l - 6 });
  doc.rect(left, y, tableWidth, rowHeight).stroke();
  y += rowHeight;

  (table || []).forEach((row, idx) => {
    if (y > doc.page.height - 72) {
      doc.addPage();
      y = 50;
    }
    if (idx % 2 === 0) doc.rect(left, y, tableWidth, rowHeight).fill('#f7fafc');
    doc.rect(left, y, tableWidth, rowHeight).stroke();
    doc.fillColor('#2d3748').fontSize(8);
    doc.text(String(row.rank), colX.rank + 3, y + 4, { width: colW.rank - 6 });
    doc.text(String(row.teamName || '').substring(0, 20), colX.team + 3, y + 4, { width: colW.team - 8 });
    doc.text(String(row.points), colX.pts + 2, y + 4, { width: colW.pts - 4 });
    doc.text(String(row.nrr), colX.nrr + 2, y + 4, { width: colW.nrr - 4 });
    doc.text(String(row.fairness), colX.fair + 2, y + 4, { width: colW.fair - 4 });
    doc.text(String(row.matchesPlayed), colX.played + 2, y + 4, { width: colW.played - 6 });
    doc.text(String(row.wins), colX.w + 3, y + 4, { width: colW.w - 6 });
    doc.text(String(row.losses), colX.l + 3, y + 4, { width: colW.l - 6 });
    y += rowHeight;
  });
  doc.y = y + 8;
}

function writeCompositePage(doc, composite, left, generatedAt, opts = {}) {
  if (!opts.skipInitialAddPage) doc.addPage();
  doc.x = left;
  doc.fontSize(14).fillColor('#2c5282').text("Who's in the qualification mix? (combined ranking)", { align: 'left' });
  doc.fontSize(8).fillColor('#718096').text(`Snapshot: ${(generatedAt || '').slice(0, 19)} · PDF does not auto-update`, {
    width: 520,
  });
  doc.moveDown(0.5);
  doc.fontSize(8).fillColor('#4a5568').text(
    'Per-season index = 0.5×Norm(Pts) + 0.3×Norm(NRR) + 0.2×Norm(Fair). Combined = average across seasons.',
    { width: 520 },
  );
  doc.moveDown(0.6);

  const dbLabels = composite.dbOrder.map(cplLabel);
  const rowH = 14;
  let y = doc.y;
  const wRank = 24;
  const wTeam = 92;
  const wCol = 64;
  const wFinal = 56;
  const startX = left;
  const totalW = wRank + wTeam + wCol * dbLabels.length + wFinal;

  // PDFKit: rect().fill(c) updates current fill color — must reset before text or glyphs match the bar/row bg.
  doc.rect(startX, y, totalW, rowH).fill('#2c5282');
  doc.fillColor('#ffffff').fontSize(7);
  doc.text('#', startX + 4, y + 3, { width: wRank });
  doc.text('Team', startX + wRank + 3, y + 3, { width: wTeam });
  let x = startX + wRank + wTeam;
  dbLabels.forEach((lab) => {
    doc.text(lab, x + 2, y + 3, { width: wCol - 4 });
    x += wCol;
  });
  doc.text('Comb.', x + 2, y + 3, { width: wFinal });
  y += rowH;

  composite.rows.forEach((r, idx) => {
    if (y > doc.page.height - 55) {
      doc.addPage();
      y = 50;
    }
    const bg = idx % 2 === 0 ? '#f7fafc' : '#ffffff';
    doc.rect(startX, y, totalW, rowH).fill(bg);
    doc.rect(startX, y, totalW, rowH).stroke();
    doc.fillColor('#2d3748').fontSize(7);
    doc.text(String(idx + 1), startX + 4, y + 3, { width: wRank });
    doc.text((r.teamName || '').substring(0, 14), startX + wRank + 3, y + 3, { width: wTeam });
    x = startX + wRank + wTeam;
    for (const db of composite.dbOrder) {
      const v = r.byDb[db];
      doc.text(v != null ? Number(v).toFixed(2) : '—', x + 2, y + 3, { width: wCol - 4 });
      x += wCol;
    }
    doc.text(Number(r.finalAvg).toFixed(2), x + 2, y + 3, { width: wFinal });
    y += rowH;
  });
}

function writeWorldCupNotes(doc, notes, left) {
  doc.addPage();
  doc.x = left;
  doc.fontSize(14).fillColor('#2c5282').text('Championship qualification — overview (reference)', { align: 'left' });
  doc.moveDown(0.5);
  doc.fontSize(9).fillColor('#2d3748');
  (notes || []).forEach((line) => {
    doc.text(line.startsWith('•') ? line : `• ${line}`, { width: 500 });
    doc.moveDown(0.2);
  });
}

/** @param {object} snapshot - `buildCplReportSnapshot()` result when `ok: true` */
function generateCplReportPdfBuffer(snapshot) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ margin: 36, size: 'A4' });
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 36;
    const colW = { rank: 22, team: 118, pts: 32, nrr: 42, fair: 34, played: 36, w: 22, l: 22 };
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
    const rowHeight = 16;
    const generatedAt = snapshot.generatedAt || new Date().toISOString();

    const composite =
      snapshot.composite && snapshot.composite.rows && snapshot.composite.rows.length
        ? {
            dbOrder: snapshot.composite.columns.map((c) => c.dbName),
            rows: snapshot.composite.rows.map((r) => ({
              teamName: r.teamName,
              byDb: r.byDb,
              finalAvg: r.finalAvg,
            })),
          }
        : { dbOrder: [], rows: [] };

    const allData = (snapshot.seasons || []).map((s) => ({
      dbName: s.dbName,
      table: s.table || [],
      error: s.ok ? undefined : s.error,
    }));

    if (composite.rows.length > 0 && composite.dbOrder.length > 0) {
      writeCompositePage(doc, composite, left, generatedAt, { skipInitialAddPage: true });
      doc.addPage();
    }
    writeFormulasFromSnapshot(doc, snapshot.formulas, left);

    allData.forEach(({ dbName, table, error }) => {
      doc.addPage();
      if (error) {
        doc.x = left;
        doc.fontSize(12).text(cplLabel(dbName));
        doc.fontSize(9).fillColor('#c53030').text(`Error: ${error}`);
        return;
      }
      writePointTablePage(doc, dbName, table, left, colX, colW, rowHeight, tableWidth, generatedAt);
    });

    writeWorldCupNotes(doc, snapshot.worldCupNotes, left);

    doc.end();
  });
}

module.exports = { generateCplReportPdfBuffer };
