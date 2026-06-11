const express = require('express');
const router = express.Router();
const AppSettings = require('../models/AppSettings');
const User = require('../models/User');
const Player = require('../models/Player');
const { RULE_MIN, RULE_MAX, getTradeRules } = require('../utils/tradeRules');

async function getSettingsDoc() {
  let doc = await AppSettings.findOne();
  if (!doc) doc = await AppSettings.create({});
  return doc;
}

router.get('/', async (_req, res) => {
  try {
    const doc = await getSettingsDoc();
    const tradeRules = await getTradeRules();
    res.json({ 
      enableTradeCenter: doc.enableTradeCenter, 
      enableUnsoldPlayers: doc.enableUnsoldPlayers, 
      enablePickButton: doc.enablePickButton, 
      enablePlayerRetention: doc.enablePlayerRetention,
      pointsMode: doc.pointsMode,
      cronSingleBidEnabled: doc.cronSingleBidEnabled,
      cronSingleBidFinalizerEnabled: doc.cronSingleBidFinalizerEnabled,
      cronBulkExitEnabled: doc.cronBulkExitEnabled,
      cronLockEnabled: doc.cronLockEnabled,
      lockCheckCategories: doc.lockCheckCategories || ['sapphireEmerald', 'gold', 'silver'],
      worldCupMode: doc.worldCupMode,
      auctionStartAt: doc.auctionStartAt,
      auctionAutoModeEnabled: doc.auctionAutoModeEnabled === true,
      auctionAutoModeCategories: doc.auctionAutoModeCategories || ['Gold', 'Silver', 'Sapphire', 'Emerald'],
      requiredGames: doc.requiredGames ?? 13,
      tradeSeasonCap: tradeRules.tradeSeasonCap,
      maxTradesPerOpponentPair: tradeRules.maxTradesPerOpponentPair,
      tradeApprovalMode: doc.tradeApprovalMode || 'any_admin',
      enableTradeBundles: doc.enableTradeBundles !== false,
      bundleAutoApprove: doc.bundleAutoApprove !== false,
    });
  } catch (e) { res.status(500).json({ message: 'Internal server error' }); }
});

router.get('/trade-commissioners', async (req, res) => {
  try {
    const doc = await getSettingsDoc();
    const candidates = await User.find({
      isActive: { $ne: false },
      $or: [{ isAdmin: true }, { teamName: { $in: [null, ''] } }, { teamName: { $exists: false } }],
    })
      .select('name email teamName isCommissioner isAdmin')
      .sort({ isCommissioner: -1, isAdmin: -1, name: 1 })
      .lean();
    res.json({
      tradeApprovalMode: doc.tradeApprovalMode || 'any_admin',
      enableTradeBundles: doc.enableTradeBundles !== false,
      bundleAutoApprove: doc.bundleAutoApprove !== false,
      admins: candidates,
      candidates,
      commissionerUserId: candidates.find((a) => a.isCommissioner)?._id || null,
    });
  } catch (e) {
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.post('/trade-commissioners', async (req, res) => {
  try {
    const { adminUserId, commissionerUserId, tradeApprovalMode, enableTradeBundles, bundleAutoApprove } = req.body;
    const admin = await User.findById(adminUserId);
    if (!admin || !admin.isAdmin) {
      return res.status(403).json({ message: 'Only admin can update trade commissioner settings' });
    }

    const doc = await getSettingsDoc();
    if (tradeApprovalMode === 'any_admin' || tradeApprovalMode === 'commissioner_only') {
      doc.tradeApprovalMode = tradeApprovalMode;
    }
    if (typeof enableTradeBundles === 'boolean') {
      doc.enableTradeBundles = enableTradeBundles;
    }
    if (typeof bundleAutoApprove === 'boolean') {
      doc.bundleAutoApprove = bundleAutoApprove;
    }
    await doc.save();

    if (commissionerUserId) {
      const target = await User.findById(commissionerUserId);
      if (!target) return res.status(404).json({ message: 'Commissioner user not found' });
      await User.updateMany({}, { $set: { isCommissioner: false } });
      target.isCommissioner = true;
      target.isAdmin = true;
      await target.save();
    }

    const admins = await User.find({ isAdmin: true })
      .select('name email teamName isCommissioner isAdmin')
      .sort({ name: 1 })
      .lean();

    res.json({
      message: 'Trade commissioner settings saved',
      tradeApprovalMode: doc.tradeApprovalMode || 'any_admin',
      enableTradeBundles: doc.enableTradeBundles !== false,
      bundleAutoApprove: doc.bundleAutoApprove !== false,
      admins,
      commissionerUserId: admins.find((a) => a.isCommissioner)?._id || null,
    });
  } catch (e) {
    console.error('trade-commissioners save error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.post('/revoke-team-owner-admins', async (req, res) => {
  try {
    const { adminUserId } = req.body;
    const admin = await User.findById(adminUserId);
    if (!admin || !admin.isAdmin) {
      return res.status(403).json({ message: 'Only admin can revoke team owner admin access' });
    }

    const result = await User.updateMany(
      {
        isAdmin: true,
        teamName: { $exists: true, $nin: [null, ''] },
      },
      { $set: { isAdmin: false, isCommissioner: false } }
    );

    res.json({
      message: `Removed admin access from ${result.modifiedCount} team-owner account(s). Commissioner/neutral admin accounts (no team) are unchanged.`,
      modifiedCount: result.modifiedCount,
    });
  } catch (e) {
    console.error('revoke-team-owner-admins error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { adminUserId, enableTradeCenter, enableUnsoldPlayers, enablePickButton, enablePlayerRetention, pointsMode, cronSingleBidEnabled, cronSingleBidFinalizerEnabled, cronBulkExitEnabled, cronLockEnabled, lockCheckCategories, worldCupMode, auctionStartAt, auctionAutoModeEnabled, auctionAutoModeCategories, requiredGames, tradeSeasonCap, maxTradesPerOpponentPair, tradeApprovalMode, enableTradeBundles, bundleAutoApprove } = req.body;
    const admin = await User.findById(adminUserId);
    if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Only admin can update settings' });
    const doc = await getSettingsDoc();
    if (typeof enableTradeCenter === 'boolean') doc.enableTradeCenter = enableTradeCenter;
    if (typeof enableUnsoldPlayers === 'boolean') doc.enableUnsoldPlayers = enableUnsoldPlayers;
    if (typeof enablePickButton === 'boolean') doc.enablePickButton = enablePickButton;
    if (typeof enablePlayerRetention === 'boolean') doc.enablePlayerRetention = enablePlayerRetention;
    if (typeof pointsMode === 'string' && ['overall', 'groups'].includes(pointsMode)) doc.pointsMode = pointsMode;
    if (typeof cronSingleBidEnabled === 'boolean') doc.cronSingleBidEnabled = cronSingleBidEnabled;
    if (typeof cronSingleBidFinalizerEnabled === 'boolean') doc.cronSingleBidFinalizerEnabled = cronSingleBidFinalizerEnabled;
    if (typeof cronBulkExitEnabled === 'boolean') doc.cronBulkExitEnabled = cronBulkExitEnabled;
    if (typeof cronLockEnabled === 'boolean') doc.cronLockEnabled = cronLockEnabled;
    if (Array.isArray(lockCheckCategories)) {
      const valid = ['sapphireEmerald', 'gold', 'silver'];
      doc.lockCheckCategories = lockCheckCategories.filter((c) => valid.includes(c));
      if (doc.lockCheckCategories.length === 0) doc.lockCheckCategories = valid;
    }
    if (typeof worldCupMode === 'boolean') doc.worldCupMode = worldCupMode;
    if (auctionStartAt === null) doc.auctionStartAt = null;
    if (typeof auctionStartAt === 'string' && auctionStartAt.trim()) {
      const parsed = new Date(auctionStartAt);
      if (!isNaN(parsed.getTime())) doc.auctionStartAt = parsed;
    }
    if (typeof auctionAutoModeEnabled === 'boolean') doc.auctionAutoModeEnabled = auctionAutoModeEnabled;
    if (typeof requiredGames === 'number' && requiredGames >= 1 && requiredGames <= 20) doc.requiredGames = requiredGames;
    if (tradeSeasonCap != null && tradeSeasonCap !== '') {
      const n = Number(tradeSeasonCap);
      if (Number.isFinite(n) && n >= RULE_MIN && n <= RULE_MAX) doc.tradeSeasonCap = Math.floor(n);
    }
    if (maxTradesPerOpponentPair != null && maxTradesPerOpponentPair !== '') {
      const n = Number(maxTradesPerOpponentPair);
      if (Number.isFinite(n) && n >= RULE_MIN && n <= RULE_MAX) doc.maxTradesPerOpponentPair = Math.floor(n);
    }
    if (tradeApprovalMode === 'any_admin' || tradeApprovalMode === 'commissioner_only') {
      doc.tradeApprovalMode = tradeApprovalMode;
    }
    if (typeof enableTradeBundles === 'boolean') {
      doc.enableTradeBundles = enableTradeBundles;
    }
    if (typeof bundleAutoApprove === 'boolean') {
      doc.bundleAutoApprove = bundleAutoApprove;
    }
    if (Array.isArray(auctionAutoModeCategories)) {
      const valid = ['Gold', 'Silver', 'Sapphire', 'Emerald'];
      doc.auctionAutoModeCategories = auctionAutoModeCategories.filter((c) => valid.includes(String(c).trim()));
      if (doc.auctionAutoModeCategories.length === 0) doc.auctionAutoModeCategories = valid;
      // Only apply to Players when Auto Mode is ON – turning Auto Mode OFF must not change Player Availability
      if (doc.auctionAutoModeEnabled === true) {
        for (const type of valid) {
          const enable = doc.auctionAutoModeCategories.includes(type);
          try {
            await Player.updateMany({ type, isSold: false }, { $set: { isActive: enable } });
          } catch (e) {
            console.error(`Failed to update Player isActive for ${type}:`, e.message);
          }
        }
      }
    }
    await doc.save();
    const tradeRules = await getTradeRules();
    res.json({ 
      enableTradeCenter: doc.enableTradeCenter, 
      enableUnsoldPlayers: doc.enableUnsoldPlayers, 
      enablePickButton: doc.enablePickButton, 
      enablePlayerRetention: doc.enablePlayerRetention,
      pointsMode: doc.pointsMode,
      cronSingleBidEnabled: doc.cronSingleBidEnabled,
      cronSingleBidFinalizerEnabled: doc.cronSingleBidFinalizerEnabled,
      cronBulkExitEnabled: doc.cronBulkExitEnabled,
      cronLockEnabled: doc.cronLockEnabled,
      lockCheckCategories: doc.lockCheckCategories || ['sapphireEmerald', 'gold', 'silver'],
      worldCupMode: doc.worldCupMode,
      auctionStartAt: doc.auctionStartAt,
      auctionAutoModeEnabled: doc.auctionAutoModeEnabled === true,
      auctionAutoModeCategories: doc.auctionAutoModeCategories || ['Gold', 'Silver', 'Sapphire', 'Emerald'],
      requiredGames: doc.requiredGames ?? 13,
      tradeSeasonCap: tradeRules.tradeSeasonCap,
      maxTradesPerOpponentPair: tradeRules.maxTradesPerOpponentPair,
      tradeApprovalMode: doc.tradeApprovalMode || 'any_admin',
      enableTradeBundles: doc.enableTradeBundles !== false,
      bundleAutoApprove: doc.bundleAutoApprove !== false,
    });
  } catch (e) { res.status(500).json({ message: 'Internal server error' }); }
});

module.exports = router;


