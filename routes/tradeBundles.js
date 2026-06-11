const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

function isValidObjectId(id) {
  return id != null && mongoose.Types.ObjectId.isValid(String(id));
}
const TradeBundle = require('../models/TradeBundle');
const TradeRequest = require('../models/TradeRequest');
const User = require('../models/User');
const TradeApprovalAudit = require('../models/TradeApprovalAudit');
const { getClientIp } = require('../utils/network');
const { getTradeApprovalSettings } = require('../utils/tradeAdminGuards');
const { assertCanApproveTrades } = require('../utils/tradeAdminGuards');
const {
  uniqueShareCode,
  syncBundleStatus,
  tryAutoApproveBundle,
  cancelBundle,
  deleteDraftBundle,
  rejectBundleByAdmin,
  buildBundlePayload,
  refUserId,
} = require('../utils/tradeBundleService');
const { createTradeProposal } = require('../utils/tradeProposalHelper');

router.post('/', async (req, res) => {
  try {
    const { createdBy, title, commitmentNote, partyUserIds } = req.body;
    if (!createdBy || !title) {
      return res.status(400).json({ message: 'createdBy and title are required' });
    }

    const settings = await getTradeApprovalSettings();
    if (!settings.enableTradeBundles) {
      return res.status(403).json({ message: 'Trade bundles are disabled' });
    }

    const creator = await User.findById(createdBy);
    if (!creator) return res.status(404).json({ message: 'User not found' });

    const shareCode = await uniqueShareCode();
    const parties = Array.isArray(partyUserIds) ? partyUserIds : [];
    if (!parties.map(String).includes(String(createdBy))) {
      parties.push(createdBy);
    }

    const bundle = await TradeBundle.create({
      title: String(title).trim(),
      createdBy,
      partyUserIds: parties,
      commitmentNote: commitmentNote || '',
      shareCode,
      status: 'draft',
      history: [{ action: 'created', byUser: createdBy, message: 'Bundle created' }],
    });

    const payload = await buildBundlePayload(bundle);
    res.status(201).json(payload);
  } catch (err) {
    console.error('Create bundle error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.get('/code/:shareCode', async (req, res) => {
  try {
    const bundle = await TradeBundle.findOne({ shareCode: req.params.shareCode.toUpperCase() });
    if (!bundle) return res.status(404).json({ message: 'Bundle not found' });
    res.json(await buildBundlePayload(bundle));
  } catch (err) {
    console.error('Bundle by code error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.get('/admin/pending', async (req, res) => {
  try {
    const { adminUserId } = req.query;
    if (adminUserId) {
      await assertCanApproveTrades(adminUserId);
    }
    const bundles = await TradeBundle.find({
      status: { $in: ['ready_for_admin', 'blocked', 'pending_acceptance'] },
      tradeIds: { $exists: true, $not: { $size: 0 } },
    }).sort({ updatedAt: -1 });
    const payload = await Promise.all(bundles.map((b) => buildBundlePayload(b)));
    res.json(payload);
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    console.error('Admin pending bundles error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const bundles = await TradeBundle.find({
      $or: [{ createdBy: userId }, { partyUserIds: userId }],
      status: { $nin: ['cancelled'] },
    })
      .sort({ updatedAt: -1 })
      .limit(50);

    const payload = await Promise.all(bundles.map((b) => buildBundlePayload(b)));
    res.json(payload);
  } catch (err) {
    console.error('List user bundles error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.get('/:bundleId', async (req, res) => {
  try {
    const bundle = await TradeBundle.findById(req.params.bundleId);
    if (!bundle) return res.status(404).json({ message: 'Bundle not found' });
    res.json(await buildBundlePayload(bundle));
  } catch (err) {
    console.error('Get bundle error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.post('/:bundleId/invite', async (req, res) => {
  try {
    const { userId, byUserId } = req.body;
    const bundle = await TradeBundle.findById(req.params.bundleId);
    if (!bundle) return res.status(404).json({ message: 'Bundle not found' });
    if (String(bundle.createdBy) !== String(byUserId)) {
      return res.status(403).json({ message: 'Only bundle creator can invite teams' });
    }
    if (!userId) return res.status(400).json({ message: 'userId required' });

    const ids = new Set(bundle.partyUserIds.map(String));
    ids.add(String(userId));
    bundle.partyUserIds = [...ids];
    bundle.history.push({
      action: 'invite',
      byUser: byUserId,
      message: `Invited user ${userId}`,
      timestamp: new Date(),
    });
    await bundle.save();
    res.json(await buildBundlePayload(bundle));
  } catch (err) {
    console.error('Invite to bundle error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.post('/:bundleId/legs', async (req, res) => {
  try {
    const { fromUserId, offeredPlayerId, requestedPlayerId } = req.body;
    if (!isValidObjectId(fromUserId) || !isValidObjectId(offeredPlayerId) || !isValidObjectId(requestedPlayerId)) {
      return res.status(400).json({ message: 'Invalid user or player selection. Refresh and pick players again.' });
    }
    const bundle = await TradeBundle.findById(req.params.bundleId);
    if (!bundle) return res.status(404).json({ message: 'Bundle not found' });
    if (['completed', 'cancelled', 'rejected'].includes(bundle.status)) {
      return res.status(400).json({ message: 'Bundle is closed' });
    }

    const settings = await getTradeApprovalSettings();
    if (!settings.enableTradeBundles) {
      return res.status(403).json({ message: 'Trade bundles are disabled' });
    }

    const result = await createTradeProposal({
      fromUserId,
      offeredPlayerId,
      requestedPlayerId,
      bundleId: bundle._id,
    });

    if (!result.ok) {
      return res.status(result.statusCode || 400).json({ message: result.message, ...result.extra });
    }

    const trade = result.trade;
    const tradeIds = new Set(bundle.tradeIds.map(String));
    tradeIds.add(String(trade._id));
    bundle.tradeIds = [...tradeIds];

    const partySet = new Set(bundle.partyUserIds.map(String));
    partySet.add(String(refUserId(trade.fromUser)));
    partySet.add(String(refUserId(trade.toUser)));
    bundle.partyUserIds = [...partySet];

    bundle.history.push({
      action: 'leg_added',
      byUser: fromUserId,
      message: `Leg added: ${trade._id}`,
      timestamp: new Date(),
    });
    await bundle.save();
    await syncBundleStatus(bundle._id);

    res.status(201).json(await buildBundlePayload(bundle));
  } catch (err) {
    console.error('Add bundle leg error', err);
    const msg =
      err.name === 'CastError'
        ? 'Invalid player or user id — refresh the page and try again.'
        : err.message || 'Internal server error';
    res.status(500).json({ message: msg });
  }
});

router.delete('/:bundleId', async (req, res) => {
  try {
    const byUserId = req.body?.byUserId || req.query?.byUserId;
    if (!byUserId) {
      return res.status(400).json({ message: 'byUserId is required' });
    }
    const result = await deleteDraftBundle(req.params.bundleId, byUserId);
    if (!result.ok) {
      return res.status(result.statusCode || 400).json({ message: result.message });
    }
    res.json({ ok: true, message: 'Bundle deleted' });
  } catch (err) {
    console.error('Delete bundle error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.post('/:bundleId/cancel', async (req, res) => {
  try {
    const { byUserId, message } = req.body;
    const bundle = await TradeBundle.findById(req.params.bundleId);
    if (!bundle) return res.status(404).json({ message: 'Bundle not found' });
    if (String(bundle.createdBy) !== String(byUserId)) {
      return res.status(403).json({ message: 'Only bundle creator can cancel the bundle' });
    }
    const updated = await cancelBundle(bundle, byUserId, message);
    res.json(await buildBundlePayload(updated));
  } catch (err) {
    console.error('Cancel bundle error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.post('/:bundleId/reject', async (req, res) => {
  try {
    const { adminUserId, note } = req.body;
    await assertCanApproveTrades(adminUserId);

    const bundle = await TradeBundle.findById(req.params.bundleId);
    if (!bundle) return res.status(404).json({ message: 'Bundle not found' });

    const updated = await rejectBundleByAdmin(bundle, adminUserId, note || 'Commissioner rejected bundle');

    await TradeApprovalAudit.create({
      type: 'bundle_reject',
      bundleId: bundle._id,
      decidedBy: adminUserId,
      clientIp: getClientIp(req),
      note: note || '',
      tradeIds: bundle.tradeIds,
    });

    res.json(await buildBundlePayload(updated));
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    console.error('Reject bundle error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.post('/:bundleId/retry-auto', async (req, res) => {
  try {
    const result = await tryAutoApproveBundle(req.params.bundleId, getClientIp(req));
    const bundle = await TradeBundle.findById(req.params.bundleId);
    if (!bundle) return res.status(404).json({ message: 'Bundle not found' });
    res.json({ ...result, bundle: await buildBundlePayload(bundle) });
  } catch (err) {
    console.error('Retry auto-approve error', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;
