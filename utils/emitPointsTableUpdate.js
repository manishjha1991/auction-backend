/**
 * Broadcast when league points / fixtures change so UIs can refresh point tables live.
 */
const { invalidateCplReportCache } = require('./cplReadCaches');

function emitPointsTableUpdated(req, extra = {}) {
  try {
    invalidateCplReportCache();
  } catch (_) {
    /* ignore */
  }
  try {
    const io = req.app?.get?.('io');
    if (io && typeof io.emit === 'function') {
      io.emit('points_table_updated', {
        at: new Date().toISOString(),
        ...extra,
      });
    }
  } catch (_) {
    /* ignore */
  }
}

module.exports = { emitPointsTableUpdated };
