const express = require('express');
const router = express.Router();
const AppSettings = require('../models/AppSettings');
const User = require('../models/User');

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
      worldCupMode: doc.worldCupMode,
      auctionStartAt: doc.auctionStartAt,
    });
  } catch (e) { res.status(500).json({ message: 'Internal server error' }); }
});

router.post('/', async (req, res) => {
  try {
    const { adminUserId, enableTradeCenter, enableUnsoldPlayers, enablePickButton, enablePlayerRetention, pointsMode, cronSingleBidEnabled, cronSingleBidFinalizerEnabled, cronBulkExitEnabled, cronLockEnabled, worldCupMode, auctionStartAt } = req.body;
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
    if (typeof worldCupMode === 'boolean') doc.worldCupMode = worldCupMode;
    if (auctionStartAt === null) doc.auctionStartAt = null;
    if (typeof auctionStartAt === 'string' && auctionStartAt.trim()) {
      const parsed = new Date(auctionStartAt);
      if (!isNaN(parsed.getTime())) doc.auctionStartAt = parsed;
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
      worldCupMode: doc.worldCupMode,
      auctionStartAt: doc.auctionStartAt,
    });
  } catch (e) { res.status(500).json({ message: 'Internal server error' }); }
});

module.exports = router;


