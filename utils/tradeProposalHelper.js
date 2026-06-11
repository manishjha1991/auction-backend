const TradeRequest = require('../models/TradeRequest');
const User = require('../models/User');
const UserPlayer = require('../models/UserPlayer');
const Player = require('../models/Player');
const { clampTradesUsed } = require('./tradeConstants');
const { getTradeRules, assertPairAllowsNewProposal } = require('./tradeRules');
const { assertHasTradeSlotRemaining } = require('./tradeSlotReservation');
const { isTradeLocked, TRADE_LOCK_HOURS } = require('./tradeApprovalShared');
const { getTradeApprovalBlockers } = require('./tradeApprovalBlockers');

async function getOwnerOfPlayer(playerId) {
  const up = await UserPlayer.findOne({ playerId, isActive: true }).populate('userId').lean();
  return up ? up.userId : null;
}

async function createTradeProposal({ fromUserId, offeredPlayerId, requestedPlayerId, bundleId = null }) {
  if (!fromUserId || !offeredPlayerId || !requestedPlayerId) {
    return { ok: false, statusCode: 400, message: 'Missing required fields.' };
  }

  const rules = await getTradeRules();

  const activeCount = await TradeRequest.countDocuments({
    fromUser: fromUserId,
    status: { $in: ['pending', 'counter', 'admin_pending'] },
  });
  if (activeCount >= rules.maxActiveOutgoingTrades) {
    return {
      ok: false,
      statusCode: 400,
      message: `Trade limit reached: You can have at most ${rules.maxActiveOutgoingTrades} active trade requests.`,
    };
  }

  try {
    await assertHasTradeSlotRemaining(fromUserId, rules);
  } catch (e) {
    return { ok: false, statusCode: e.statusCode || 400, message: e.message };
  }

  const activeTrade = await TradeRequest.findOne({
    status: { $in: ['pending', 'counter', 'admin_pending'] },
    $or: [
      { offeredPlayer: offeredPlayerId },
      { requestedPlayer: requestedPlayerId },
      { offeredPlayer: requestedPlayerId },
      { requestedPlayer: offeredPlayerId },
    ],
  })
    .populate('offeredPlayer', 'name')
    .populate('requestedPlayer', 'name')
    .populate('fromUser', 'teamName')
    .populate('toUser', 'teamName')
    .lean();

  if (activeTrade) {
    const off = activeTrade.offeredPlayer?.name || 'a player';
    const req = activeTrade.requestedPlayer?.name || 'a player';
    const fromTeam = activeTrade.fromUser?.teamName || 'Another team';
    const toTeam = activeTrade.toUser?.teamName || 'Another team';
    return {
      ok: false,
      statusCode: 409,
      message: `${off} ↔ ${req} is already in an active trade (${fromTeam} → ${toTeam}).`,
      extra: {
        blockingTradeId: String(activeTrade._id),
        blockingTradeStatus: activeTrade.status,
      },
    };
  }

  const [fromUser, offeredOwner, requestedOwner] = await Promise.all([
    User.findById(fromUserId),
    getOwnerOfPlayer(offeredPlayerId),
    getOwnerOfPlayer(requestedPlayerId),
  ]);

  if (!fromUser || !offeredOwner || !requestedOwner) {
    return { ok: false, statusCode: 404, message: 'User or players not found.' };
  }

  if (fromUser.isParticipating === false) {
    return {
      ok: false,
      statusCode: 403,
      message: 'You are not participating in the current season. You cannot make trades.',
    };
  }

  if (requestedOwner.isParticipating === false) {
    return {
      ok: false,
      statusCode: 403,
      message: 'The target team is not participating in the current season. You cannot trade with them.',
    };
  }

  if (String(offeredOwner._id) !== String(fromUser._id)) {
    return { ok: false, statusCode: 403, message: 'You do not own the offered player.' };
  }

  if (String(requestedOwner._id) === String(fromUser._id)) {
    return { ok: false, statusCode: 400, message: 'Requested player is already in your team.' };
  }

  try {
    await assertPairAllowsNewProposal(
      fromUserId,
      requestedOwner._id,
      rules.maxTradesPerOpponentPair,
      bundleId || null
    );
  } catch (e) {
    return { ok: false, statusCode: e.statusCode || 400, message: e.message };
  }

  const [offeredPlayer, requestedPlayer, offeredUP, requestedUP] = await Promise.all([
    Player.findById(offeredPlayerId).lean(),
    Player.findById(requestedPlayerId).lean(),
    UserPlayer.findOne({ playerId: offeredPlayerId, isActive: true }).populate('userId').lean(),
    UserPlayer.findOne({ playerId: requestedPlayerId, isActive: true }).populate('userId').lean(),
  ]);

  if (!offeredUP || !requestedUP) {
    return { ok: false, statusCode: 400, message: 'One or both players are not available for trade.' };
  }

  const lockHint = `Trade-locked for ${TRADE_LOCK_HOURS} hours after a completed trade or after being picked from unsold`;
  if (await isTradeLocked(offeredPlayer)) {
    return {
      ok: false,
      statusCode: 409,
      message: `Your offered player cannot be traded yet (${lockHint}).`,
    };
  }
  if (await isTradeLocked(requestedPlayer)) {
    return {
      ok: false,
      statusCode: 409,
      message: `The requested player cannot be traded yet (${lockHint}).`,
    };
  }

  const tradeData = {
    fromUser: fromUser._id,
    toUser: requestedOwner._id,
    offeredPlayer: offeredPlayer._id,
    requestedPlayer: requestedPlayer._id,
    status: 'pending',
    history: [
      {
        byUser: fromUser._id,
        action: 'propose',
        message: bundleId ? 'Proposal inside bundle' : 'Initial proposal',
        offeredPlayer: offeredPlayer._id,
        requestedPlayer: requestedPlayer._id,
      },
    ],
  };

  if (bundleId) {
    tradeData.bundleId = bundleId;
  }

  const trade = await TradeRequest.create(tradeData);

  const populatedDoc = await TradeRequest.findById(trade._id)
    .populate('fromUser', 'name teamName')
    .populate('toUser', 'name teamName')
    .populate('offeredPlayer', 'name type role profilePicture')
    .populate('requestedPlayer', 'name type role profilePicture');

  const createdObj = populatedDoc.toObject({ virtuals: true });
  createdObj.approvalWarnings = await getTradeApprovalBlockers(populatedDoc);

  return { ok: true, trade: populatedDoc, payload: createdObj };
}

module.exports = {
  createTradeProposal,
  getOwnerOfPlayer,
};
