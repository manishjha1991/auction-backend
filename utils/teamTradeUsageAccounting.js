const User = require('../models/User');
const ReleaseRequest = require('../models/ReleaseRequest');
const PickRequest = require('../models/PickRequest');
const TradeRequest = require('../models/TradeRequest');
const { getTradeRules, isTradeWindowOpen } = require('./tradeRules');
const { clampTradesUsed } = require('./tradeConstants');
const { moveTiersByUser, slotsForTiers, emptyTiers } = require('./tradeWindowBalance');

/**
 * While the trade window is open, swaps count, and a release plus a same-category pick count as one trade.
 * While it is closed, only completed swaps count. Stored tradesUsed is compared for drift.
 */
async function getTeamTradeUsageRows() {
  const [tradeRules, tradeWindowOpen] = await Promise.all([getTradeRules(), isTradeWindowOpen()]);
  const TRADE_CAP = tradeRules.tradeSeasonCap;

  const teams = await User.find({ isActive: true, isAdmin: false })
    .select('_id name teamName tradesUsed')
    .sort({ teamName: 1 })
    .lean();

  const teamIds = teams.map((t) => t._id);

  const [releaseCounts, pickCounts, pairedPickCounts, tradeAsFrom, tradeAsTo, tierMoves] = await Promise.all([
    ReleaseRequest.aggregate([
      { $match: { user: { $in: teamIds }, status: 'completed' } },
      { $group: { _id: '$user', count: { $sum: 1 } } },
    ]),
    PickRequest.aggregate([
      { $match: { user: { $in: teamIds }, status: 'completed' } },
      { $group: { _id: '$user', count: { $sum: 1 } } },
    ]),
    ReleaseRequest.aggregate([
      {
        $match: {
          user: { $in: teamIds },
          status: 'completed',
          pairedPickRequest: { $exists: true, $ne: null },
        },
      },
      { $group: { _id: '$user', count: { $sum: 1 } } },
    ]),
    TradeRequest.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: '$fromUser', count: { $sum: 1 } } },
    ]),
    TradeRequest.aggregate([
      { $match: { status: 'completed' } },
      { $group: { _id: '$toUser', count: { $sum: 1 } } },
    ]),
    moveTiersByUser(teamIds),
  ]);

  const releaseMap = new Map(releaseCounts.map((r) => [r._id.toString(), r.count]));
  const pickMap = new Map(pickCounts.map((p) => [p._id.toString(), p.count]));
  const pairedPickMap = new Map(pairedPickCounts.map((p) => [p._id.toString(), p.count]));
  const tradeMap = new Map();
  [...tradeAsFrom, ...tradeAsTo].forEach(({ _id, count }) => {
    const uid = _id.toString();
    tradeMap.set(uid, (tradeMap.get(uid) || 0) + count);
  });

  return teams.map((team) => {
    const uid = team._id.toString();
    const releases = releaseMap.get(uid) || 0;
    const picks = pickMap.get(uid) || 0;
    const pairedPicks = pairedPickMap.get(uid) || 0;
    const trades = tradeMap.get(uid) || 0;
    const tradesUsed = clampTradesUsed(team.tradesUsed);
    const standalonePicks = Math.max(0, picks - pairedPicks);
    const categorySlots = slotsForTiers(
      tierMoves.releaseMap.get(uid) || emptyTiers(),
      tierMoves.pickMap.get(uid) || emptyTiers()
    );
    const expectedTradesUsed = tradeWindowOpen ? trades + categorySlots : trades;
    const usageDrift = tradesUsed - expectedTradesUsed;
    return {
      userId: uid,
      teamName: team.teamName || team.name || 'Unknown',
      name: team.name,
      picks,
      releases,
      trades,
      pairedPicks,
      standalonePicks,
      tradeWindowOpen,
      expectedTradesUsed,
      usageDrift,
      tradesUsed,
      remaining: TRADE_CAP - expectedTradesUsed,
      cap: TRADE_CAP,
    };
  });
}

module.exports = { getTeamTradeUsageRows };
