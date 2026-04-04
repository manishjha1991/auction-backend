/**
 * Single source of truth for trade / release usage caps (season).
 * Completed trades and approved releases both increment User.tradesUsed.
 *
 * Only validation thresholds changed (was 6 → 4); no schema or increment logic changed.
 * Consumers: routes/trades.js, routes/releases.js, routes/user.js (trades-usage), routes/adminTools.js.
 * Frontend mirror: auction-frontend/src/components/TradeCenter.js (TRADE_SEASON_CAP, MAX_ACTIVE_PENDING_REQUESTS).
 */
const TRADE_SEASON_CAP = 4;

/** Max concurrent outgoing trade proposals per user (pending / counter / awaiting admin). */
const MAX_ACTIVE_OUTGOING_TRADES = 4;

module.exports = {
  TRADE_SEASON_CAP,
  MAX_ACTIVE_OUTGOING_TRADES,
};
