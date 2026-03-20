const express = require('express');
const { buildCplReportSnapshot } = require('../utils/cplReportHelpers');
const { generateCplReportPdfBuffer } = require('../utils/cplReportPdfFromSnapshot');
const {
  getCachedReportSnapshot,
  setCachedReportSnapshot,
} = require('../utils/cplReadCaches');

const router = express.Router();

async function getReportSnapshotOrCached() {
  const hit = getCachedReportSnapshot();
  if (hit) return { data: hit, cacheHit: true };
  const data = await buildCplReportSnapshot();
  if (data.ok) setCachedReportSnapshot(data);
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

module.exports = router;
