const User = require('../models/User');
const { validateTradeForAdminApproval } = require('./tradeApprovalBlockers');
const { setTradeLockOnPlayers, autoRejectTradesInvolvingPlayers } = require('./tradeApprovalShared');
const { invalidateCache } = require('./cache');

async function executeApprovedTrade(trade, adminUserId, note) {
  const validation = await validateTradeForAdminApproval(trade);
  if (!validation.ok) {
    return { ok: false, blockers: validation.blockers };
  }

  const {
    team1,
    team2,
    offeredUP,
    requestedUP,
    newTeam1Purse,
    newTeam2Purse,
  } = validation;

  offeredUP.userId = team2._id;
  requestedUP.userId = team1._id;
  offeredUP.updatedAt = new Date();
  requestedUP.updatedAt = new Date();

  team1.purse = newTeam1Purse;
  team2.purse = newTeam2Purse;

  team1.boughtPlayers = team1.boughtPlayers.filter((id) => !id.equals(trade.offeredPlayer));
  team1.boughtPlayers.push(trade.requestedPlayer);

  team2.boughtPlayers = team2.boughtPlayers.filter((id) => !id.equals(trade.requestedPlayer));
  team2.boughtPlayers.push(trade.offeredPlayer);

  await Promise.all([offeredUP.save(), requestedUP.save(), team1.save(), team2.save()]);

  await setTradeLockOnPlayers([trade.offeredPlayer, trade.requestedPlayer]);
  try {
    invalidateCache('players:data');
  } catch (_) {}

  trade.status = 'completed';
  trade.adminDecision = {
    status: 'approved',
    decidedBy: adminUserId || null,
    decidedAt: new Date(),
    note: note || '',
  };

  try {
    await Promise.all([
      User.findByIdAndUpdate(trade.fromUser, { $inc: { tradesUsed: 1 } }),
      User.findByIdAndUpdate(trade.toUser, { $inc: { tradesUsed: 1 } }),
    ]);
  } catch (_) {}

  await trade.save();

  await autoRejectTradesInvolvingPlayers(
    adminUserId,
    [trade.offeredPlayer, trade.requestedPlayer],
    trade._id
  );

  return { ok: true, trade };
}

module.exports = {
  executeApprovedTrade,
};
