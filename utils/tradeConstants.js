/**
 * Single source of truth for trade / release usage caps (season).
 * Completed trades and approved releases both increment User.tradesUsed.
 *
 * Consumers: routes/trades.js, routes/releases.js, routes/user.js (trades-usage), routes/adminTools.js.
 * Frontend mirror: auction-frontend/src/constants/tradeSeasonCap.js and TradeCenter.js (pending limit).
 */
const TRADE_SEASON_CAP = 6;

/** Max concurrent outgoing trade proposals per user (pending / counter / awaiting admin). */
const MAX_ACTIVE_OUTGOING_TRADES = 6;

/** Negative or invalid DB values must not inflate "remaining" or bypass season caps. */
function clampTradesUsed(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

module.exports = {
  TRADE_SEASON_CAP,
  MAX_ACTIVE_OUTGOING_TRADES,
  clampTradesUsed,
};
