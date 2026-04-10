const User = require('../models/User');
const ReleaseRequest = require('../models/ReleaseRequest');
const PickRequest = require('../models/PickRequest');
const TradeRequest = require('../models/TradeRequest');
const { getTradeRules } = require('./tradeRules');
const { clampTradesUsed } = require('./tradeConstants');

/**
 * Per-team trade slot accounting: completed trades + releases + standalone picks (picks not linked from a release).
 * Compare to User.tradesUsed for drift detection.
 */
async function getTeamTradeUsageRows() {
  const tradeRules = await getTradeRules();
  const TRADE_CAP = tradeRules.tradeSeasonCap;

  const teams = await User.find({ isActive: true, isAdmin: false })
    .select('_id name teamName tradesUsed')
    .sort({ teamName: 1 })
    .lean();

  const teamIds = teams.map((t) => t._id);

  const [releaseCounts, pickCounts, pairedPickCounts, tradeAsFrom, tradeAsTo] = await Promise.all([
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
    const remaining = Math.max(0, TRADE_CAP - tradesUsed);
    const standalonePicks = Math.max(0, picks - pairedPicks);
    const expectedTradesUsed = trades + releases + standalonePicks;
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
      expectedTradesUsed,
      usageDrift,
      tradesUsed,
      remaining,
      cap: TRADE_CAP,
    };
  });
}

module.exports = { getTeamTradeUsageRows };
