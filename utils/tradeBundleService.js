const crypto = require('crypto');
const TradeBundle = require('../models/TradeBundle');
const TradeRequest = require('../models/TradeRequest');
const TradeApprovalAudit = require('../models/TradeApprovalAudit');
const { getTradeApprovalBlockers } = require('./tradeApprovalBlockers');
const { executeApprovedTrade } = require('./tradeExecution');

function generateShareCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 8);
}

async function uniqueShareCode() {
  for (let i = 0; i < 8; i += 1) {
    const code = generateShareCode();
    const exists = await TradeBundle.exists({ shareCode: code });
    if (!exists) return code;
  }
  return `${Date.now().toString(36).toUpperCase()}`;
}

function uniquePartyIds(trades) {
  const ids = new Set();
  for (const t of trades) {
    if (t.fromUser) ids.add(String(t.fromUser._id || t.fromUser));
    if (t.toUser) ids.add(String(t.toUser._id || t.toUser));
  }
  return [...ids];
}

async function loadBundleTrades(bundle) {
  return TradeRequest.find({ _id: { $in: bundle.tradeIds } })
    .populate('fromUser', 'name teamName')
    .populate('toUser', 'name teamName')
    .populate('offeredPlayer', 'name type role profilePicture')
    .populate('requestedPlayer', 'name type role profilePicture');
}

async function syncBundleStatus(bundleId) {
  const bundle = await TradeBundle.findById(bundleId);
  if (!bundle || ['completed', 'cancelled', 'rejected'].includes(bundle.status)) {
    return bundle;
  }

  const trades = await loadBundleTrades(bundle);
  if (!trades.length) {
    bundle.status = 'draft';
    bundle.blockers = [];
    await bundle.save();
    return bundle;
  }

  const allAdminPending = trades.every((t) => t.status === 'admin_pending');
  const anyActive = trades.some((t) => ['pending', 'counter', 'admin_pending'].includes(t.status));

  if (allAdminPending && trades.length >= 2) {
    bundle.status = 'ready_for_admin';
  } else if (anyActive) {
    bundle.status = 'pending_acceptance';
  } else {
    bundle.status = 'draft';
  }

  bundle.partyUserIds = uniquePartyIds(trades).map((id) => id);
  await bundle.save();
  return bundle;
}

async function validateBundleLegs(trades) {
  const blockers = [];
  for (let i = 0; i < trades.length; i += 1) {
    const legBlockers = await getTradeApprovalBlockers(trades[i]);
    for (const b of legBlockers) {
      blockers.push(`Leg ${i + 1}: ${b}`);
    }
  }
  return blockers;
}

async function tryAutoApproveBundle(bundleId, clientIp) {
  const bundle = await TradeBundle.findById(bundleId);
  if (!bundle || bundle.status === 'completed') return { ok: false, skipped: true };

  const trades = await loadBundleTrades(bundle);
  if (trades.length < 2) {
    await syncBundleStatus(bundleId);
    return { ok: false, message: 'Bundle needs at least 2 legs' };
  }

  if (!trades.every((t) => t.status === 'admin_pending')) {
    await syncBundleStatus(bundleId);
    return { ok: false, skipped: true };
  }

  const blockers = await validateBundleLegs(trades);
  if (blockers.length) {
    bundle.status = 'blocked';
    bundle.blockers = blockers;
    bundle.history.push({
      action: 'blocked',
      message: blockers.join(' | '),
      timestamp: new Date(),
    });
    await bundle.save();
    return { ok: false, blockers, bundle };
  }

  for (const trade of trades) {
    const result = await executeApprovedTrade(trade, null, 'Bundle auto-approved');
    if (!result.ok) {
      bundle.status = 'blocked';
      bundle.blockers = result.blockers || ['Execution failed'];
      await bundle.save();
      return { ok: false, blockers: bundle.blockers, bundle };
    }
  }

  bundle.status = 'completed';
  bundle.blockers = [];
  bundle.completedAt = new Date();
  bundle.history.push({
    action: 'auto_approved',
    message: `All ${trades.length} legs executed`,
    timestamp: new Date(),
  });
  await bundle.save();

  await TradeApprovalAudit.create({
    type: 'bundle_auto_approve',
    bundleId: bundle._id,
    tradeIds: trades.map((t) => t._id),
    clientIp: clientIp || null,
    note: 'Bundle auto-approved',
  });

  return { ok: true, bundle };
}

async function cancelBundle(bundle, byUserId, message) {
  const trades = await TradeRequest.find({
    _id: { $in: bundle.tradeIds },
    status: { $in: ['pending', 'counter', 'admin_pending'] },
  });

  for (const trade of trades) {
    trade.status = 'withdrawn';
    trade.history.push({
      byUser: byUserId,
      action: 'withdraw',
      message: message || 'Bundle cancelled',
    });
    await trade.save();
  }

  bundle.status = 'cancelled';
  bundle.history.push({
    action: 'cancelled',
    byUser: byUserId,
    message: message || 'Bundle cancelled',
    timestamp: new Date(),
  });
  await bundle.save();
  return bundle;
}

async function attachTradeToBundle(bundleId, trade) {
  const bundle = await TradeBundle.findById(bundleId);
  if (!bundle || ['completed', 'cancelled', 'rejected'].includes(bundle.status)) {
    return null;
  }
  const tradeIds = new Set(bundle.tradeIds.map(String));
  tradeIds.add(String(trade._id));
  bundle.tradeIds = [...tradeIds];
  const partySet = new Set(bundle.partyUserIds.map(String));
  partySet.add(String(trade.fromUser));
  partySet.add(String(trade.toUser));
  bundle.partyUserIds = [...partySet];
  bundle.history.push({
    action: 'leg_added',
    byUser: trade.fromUser,
    message: `Leg added: ${trade._id}`,
    timestamp: new Date(),
  });
  await bundle.save();
  await syncBundleStatus(bundle._id);
  return bundle;
}

async function buildBundlePayload(bundle) {
  const trades = await loadBundleTrades(bundle);
  const legs = await Promise.all(
    trades.map(async (t, idx) => ({
      legIndex: idx + 1,
      trade: t.toObject({ virtuals: true }),
      approvalWarnings: await getTradeApprovalBlockers(t),
    }))
  );

  const acceptedCount = trades.filter((t) => t.status === 'admin_pending' || t.status === 'completed').length;

  return {
    ...bundle.toObject(),
    legs,
    progress: {
      totalLegs: trades.length,
      acceptedLegs: acceptedCount,
      minLegs: 2,
    },
    shareUrlPath: `/trade/bundle/code/${bundle.shareCode}`,
  };
}

module.exports = {
  uniqueShareCode,
  syncBundleStatus,
  tryAutoApproveBundle,
  cancelBundle,
  attachTradeToBundle,
  buildBundlePayload,
  loadBundleTrades,
  validateBundleLegs,
};
