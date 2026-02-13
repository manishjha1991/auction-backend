const express = require('express');
const router = express.Router();
const AppSettings = require('../models/AppSettings');
const User = require('../models/User');
const Player = require('../models/Player');

async function getSettingsDoc() {
  let doc = await AppSettings.findOne();
  if (!doc) doc = await AppSettings.create({});
  return doc;
}

router.get('/', async (_req, res) => {
  try {
    const doc = await getSettingsDoc();
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
    });
  } catch (e) { res.status(500).json({ message: 'Internal server error' }); }
});

router.post('/', async (req, res) => {
  try {
    const { adminUserId, enableTradeCenter, enableUnsoldPlayers, enablePickButton, enablePlayerRetention, pointsMode, cronSingleBidEnabled, cronSingleBidFinalizerEnabled, cronBulkExitEnabled, cronLockEnabled, lockCheckCategories, worldCupMode, auctionStartAt, auctionAutoModeEnabled, auctionAutoModeCategories } = req.body;
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
    });
  } catch (e) { res.status(500).json({ message: 'Internal server error' }); }
});

module.exports = router;


