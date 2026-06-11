const crypto = require('crypto');
const mongoose = require('mongoose');
const TradeBundle = require('../models/TradeBundle');
const TradeRequest = require('../models/TradeRequest');
const TradeApprovalAudit = require('../models/TradeApprovalAudit');
const {
  getTradeApprovalBlockers,
  getBundleLegAcceptBlockers,
  computeBundleTradeApproval,
} = require('./tradeApprovalBlockers');
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

function refUserId(ref) {
  if (ref == null) return null;
  if (ref._id != null) return ref._id;
  return ref;
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

function sanitizeObjectIdList(ids) {
  if (!Array.isArray(ids)) return [];
  return ids.filter((id) => {
    const s = String(id);
    return mongoose.Types.ObjectId.isValid(s) && s.length === 24;
  });
}

async function reconcileBundleTradeIds(bundle) {
  if (!bundle) return bundle;
  const cleanParties = sanitizeObjectIdList(bundle.partyUserIds);
  if (cleanParties.length !== (bundle.partyUserIds || []).length) {
    bundle.partyUserIds = cleanParties;
    await bundle.save();
  }
  const linked = await TradeRequest.find({ bundleId: bundle._id }).select('_id').lean();
  const idSet = new Set((bundle.tradeIds || []).map(String));
  let changed = false;
  for (const t of linked) {
    const sid = String(t._id);
    if (!idSet.has(sid)) {
      idSet.add(sid);
      changed = true;
    }
  }
  if (changed) {
    bundle.tradeIds = [...idSet];
    await bundle.save();
  }
  return bundle;
}

async function syncBundleStatus(bundleId) {
  const bundle = await TradeBundle.findById(bundleId);
  if (!bundle || ['completed', 'cancelled', 'rejected'].includes(bundle.status)) {
    return bundle;
  }

  await reconcileBundleTradeIds(bundle);
  const trades = await loadBundleTrades(bundle);
  if (!trades.length) {
    bundle.status = 'draft';
    bundle.blockers = [];
    await bundle.save();
    return bundle;
  }

  const hasRejectedLeg = trades.some((t) => t.status === 'rejected');
  const hasWithdrawnLeg = trades.some((t) => t.status === 'withdrawn');
  const hasActiveLeg = trades.some((t) =>
    ['pending', 'counter', 'admin_pending'].includes(t.status)
  );
  if ((hasRejectedLeg || hasWithdrawnLeg) && hasActiveLeg) {
    const legStatus = hasRejectedLeg ? 'rejected' : 'withdrawn';
    const legAction = hasRejectedLeg ? 'reject' : 'withdraw';
    const bundleStatus = hasRejectedLeg ? 'rejected' : 'cancelled';
    for (const t of trades) {
      if (['pending', 'counter', 'admin_pending'].includes(t.status)) {
        t.status = legStatus;
        t.history.push({
          action: legAction,
          message: hasRejectedLeg
            ? 'Bundle rejected — another leg in this bundle was rejected'
            : 'Bundle withdrawn — another leg in this bundle was withdrawn',
        });
        await t.save();
      }
    }
    bundle.status = bundleStatus;
    bundle.blockers = [];
    bundle.history.push({
      action: bundleStatus === 'rejected' ? 'rejected' : 'cancelled',
      message: 'Bundle closed — one leg was rejected or withdrawn',
      timestamp: new Date(),
    });
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
  if (!trades.length) return [];
  const bundleId = trades[0].bundleId;
  if (bundleId) {
    const { blockers } = await computeBundleTradeApproval(bundleId, trades[0]);
    return blockers;
  }
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
    const result = await executeApprovedTrade(trade, null, 'Bundle auto-approved', {
      bundleBatchApproved: true,
    });
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

async function deleteDraftBundle(bundleId, byUserId) {
  const bundle = await TradeBundle.findById(bundleId);
  if (!bundle) {
    return { ok: false, statusCode: 404, message: 'Bundle not found' };
  }
  if (String(bundle.createdBy) !== String(byUserId)) {
    return { ok: false, statusCode: 403, message: 'Only the bundle creator can delete it' };
  }
  if (['completed', 'cancelled', 'rejected'].includes(bundle.status)) {
    return { ok: false, statusCode: 400, message: 'This bundle is already closed' };
  }

  const trades = await TradeRequest.find({
    $or: [{ _id: { $in: bundle.tradeIds || [] } }, { bundleId: bundle._id }],
  });

  const hasAcceptedLeg = trades.some((t) => ['admin_pending', 'completed'].includes(t.status));
  if (hasAcceptedLeg) {
    return {
      ok: false,
      statusCode: 400,
      message: 'Cannot delete — at least one leg was already accepted. Cancel the bundle instead.',
    };
  }

  for (const trade of trades) {
    if (['pending', 'counter', 'admin_pending'].includes(trade.status)) {
      trade.status = 'withdrawn';
      trade.bundleId = null;
      trade.history.push({
        byUser: byUserId,
        action: 'withdraw',
        message: 'Bundle deleted by creator',
      });
      await trade.save();
    } else {
      trade.bundleId = null;
      await trade.save();
    }
  }

  await TradeBundle.findByIdAndDelete(bundle._id);
  return { ok: true };
}

async function loadActiveBundleTrades(bundle) {
  await reconcileBundleTradeIds(bundle);
  return TradeRequest.find({
    $or: [{ _id: { $in: bundle.tradeIds || [] } }, { bundleId: bundle._id }],
    status: { $in: ['pending', 'counter', 'admin_pending'] },
  });
}

/**
 * One leg withdrawn/rejected → entire bundle collapses (all active legs same outcome).
 */
async function collapseBundleOnLegAction(bundleId, triggerTradeId, byUserId, mode) {
  const bundle = await TradeBundle.findById(bundleId);
  if (!bundle || ['completed', 'cancelled', 'rejected'].includes(bundle.status)) {
    return { bundle, collapsed: false, legsUpdated: 0 };
  }

  const isReject = mode === 'reject';
  const legStatus = isReject ? 'rejected' : 'withdrawn';
  const legAction = isReject ? 'reject' : 'withdraw';
  const bundleStatus = isReject ? 'rejected' : 'cancelled';
  const bundleHistoryAction = isReject ? 'rejected' : 'cancelled';
  const defaultMsg = isReject
    ? 'Bundle rejected — one leg was rejected by a team'
    : 'Bundle withdrawn — one leg was withdrawn by the proposer';

  const trades = await loadActiveBundleTrades(bundle);
  for (const t of trades) {
    const isTrigger = String(t._id) === String(triggerTradeId);
    t.status = legStatus;
    t.history.push({
      byUser: byUserId,
      action: legAction,
      message: isTrigger
        ? defaultMsg
        : `Bundle ${isReject ? 'rejected' : 'withdrawn'} because another leg was ${isReject ? 'rejected' : 'withdrawn'}`,
    });
    await t.save();
  }

  bundle.status = bundleStatus;
  bundle.blockers = [];
  bundle.history.push({
    action: bundleHistoryAction,
    byUser: byUserId,
    message: defaultMsg,
    timestamp: new Date(),
  });
  await bundle.save();
  return { bundle, collapsed: true, legsUpdated: trades.length };
}

async function rejectBundleByAdmin(bundle, adminUserId, note) {
  if (!bundle || ['completed', 'cancelled', 'rejected'].includes(bundle.status)) {
    return bundle;
  }
  const msg = note || 'Commissioner rejected bundle';
  const trades = await loadActiveBundleTrades(bundle);
  for (const trade of trades) {
    trade.status = 'rejected';
    trade.adminDecision = {
      status: 'rejected',
      decidedBy: adminUserId,
      decidedAt: new Date(),
      note: msg,
    };
    trade.history.push({
      byUser: adminUserId,
      action: 'reject',
      message: msg,
    });
    await trade.save();
  }
  bundle.status = 'rejected';
  bundle.blockers = [];
  bundle.history.push({
    action: 'rejected',
    byUser: adminUserId,
    message: msg,
    timestamp: new Date(),
  });
  await bundle.save();
  return bundle;
}

async function cancelBundle(bundle, byUserId, message) {
  const trades = await loadActiveBundleTrades(bundle);

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
  partySet.add(String(refUserId(trade.fromUser)));
  partySet.add(String(refUserId(trade.toUser)));
  bundle.partyUserIds = [...partySet];
  bundle.history.push({
    action: 'leg_added',
    byUser: refUserId(trade.fromUser),
    message: `Leg added: ${trade._id}`,
    timestamp: new Date(),
  });
  await bundle.save();
  await syncBundleStatus(bundle._id);
  return bundle;
}

async function buildBundlePayload(bundle) {
  await reconcileBundleTradeIds(bundle);
  const trades = await loadBundleTrades(bundle);
  let bundleApprovalWarnings = [];
  if (trades.length && trades[0].bundleId) {
    try {
      const { blockers } = await computeBundleTradeApproval(trades[0].bundleId, trades[0]);
      bundleApprovalWarnings = blockers;
    } catch (e) {
      console.error('Bundle approval warnings error', e);
      bundleApprovalWarnings = ['Could not validate this bundle right now.'];
    }
  }

  const legs = await Promise.all(
    trades.map(async (t, idx) => {
      let acceptBlockers = [];
      try {
        acceptBlockers = await getBundleLegAcceptBlockers(t);
      } catch (e) {
        console.error('Bundle leg accept blockers error', e);
        acceptBlockers = ['Could not validate this leg right now.'];
      }
      return {
        legIndex: idx + 1,
        trade: t.toObject({ virtuals: true }),
        approvalWarnings: bundleApprovalWarnings,
        acceptBlockers,
      };
    })
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
  refUserId,
  syncBundleStatus,
  tryAutoApproveBundle,
  cancelBundle,
  collapseBundleOnLegAction,
  rejectBundleByAdmin,
  deleteDraftBundle,
  attachTradeToBundle,
  buildBundlePayload,
  loadBundleTrades,
  validateBundleLegs,
};
