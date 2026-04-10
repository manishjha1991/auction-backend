/**
 * Shared helpers for trade / release usage (User.tradesUsed).
 * Season caps and per-opponent limits live in AppSettings — use utils/tradeRules.getTradeRules().
 */
const { DEFAULT_TRADE_SEASON_CAP } = require('./tradeRules');

/** Legacy default when settings doc is missing; prefer getTradeRules().tradeSeasonCap. */
const TRADE_SEASON_CAP = DEFAULT_TRADE_SEASON_CAP;

/** @deprecated Use getTradeRules().maxActiveOutgoingTrades */
const MAX_ACTIVE_OUTGOING_TRADES = DEFAULT_TRADE_SEASON_CAP;

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
