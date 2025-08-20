const express = require('express');
const router = express.Router();
const ReleaseRequest = require('../models/ReleaseRequest');
const UserPlayer = require('../models/UserPlayer');
const User = require('../models/User');

// Create release request
router.post('/', async (req, res) => {
  try {
    const { userId, playerId } = req.body;
    if (!userId || !playerId) return res.status(400).json({ message: 'Missing required fields' });
    // Guard: user cannot exceed 4 total trades (trade + release combined)
    const u = await (await require('../models/User')).findById(userId).select('tradesUsed');
    if (u && Number(u.tradesUsed || 0) >= 4) {
      return res.status(400).json({ message: 'You have used all 4 trades.' });
    }
    const ownership = await UserPlayer.findOne({ userId, playerId, isActive: true });
    if (!ownership) return res.status(400).json({ message: 'You do not own this player' });
    const rr = await ReleaseRequest.create({ user: userId, player: playerId, status: 'pending', history: [{ byUser: userId, action: 'propose' }] });
    res.status(201).json(rr);
  } catch (e) {
    console.error('Release create error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// List my release requests
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const list = await ReleaseRequest.find({ user: userId })
      .populate('player', 'name type role')
      .sort({ createdAt: -1 });
    res.json(list);
  } catch (e) {
    console.error('Release list error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Admin: pending
router.get('/admin/pending', async (req, res) => {
  try {
    const list = await ReleaseRequest.find({ status: { $in: ['pending', 'admin_pending'] } })
      .populate('user', 'name teamName')
      .populate('player', 'name type role')
      .sort({ updatedAt: -1 });
    res.json(list);
  } catch (e) {
    console.error('Release pending error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Admin decide
router.post('/admin/:releaseId/decide', async (req, res) => {
  try {
    const { releaseId } = req.params;
    const { adminUserId, decision, note } = req.body;
    const item = await ReleaseRequest.findById(releaseId);
    if (!item) return res.status(404).json({ message: 'Release request not found' });
    if (decision === 'approve') {
      // deactivate ownership
      const up = await UserPlayer.findOne({ userId: item.user, playerId: item.player, isActive: true });
      if (up) { 
        up.isActive = false; 
        up.updatedAt = new Date(); 
        await up.save(); 
        
        // Refund the player's bid value back to the user's purse
        const bidValue = Number(up.bidValue || 0);
        if (bidValue > 0) {
          try {
            await User.findByIdAndUpdate(item.user, { 
              $inc: { purse: bidValue }
            });
          } catch {}
        }
      }
      
      item.status = 'completed';
      item.adminDecision = { status: 'approved', decidedBy: adminUserId, decidedAt: new Date(), note };
      
      // Increment user's trade usage ONLY when admin approves (completed)
      try {
        await User.findByIdAndUpdate(item.user, { $inc: { tradesUsed: 1 } });
      } catch {}
    } else if (decision === 'reject') {
      item.status = 'rejected';
      item.adminDecision = { status: 'rejected', decidedBy: adminUserId, decidedAt: new Date(), note };
      
      // Admin rejection does NOT affect trade count - no increment/decrement
      // The release request was pending, so it doesn't count towards tradesUsed
    } else {
      return res.status(400).json({ message: 'Invalid decision' });
    }
    await item.save();
    res.json(item);
  } catch (e) {
    console.error('Release decide error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Withdraw release request
router.post('/:releaseId/withdraw', async (req, res) => {
  try {
    const { releaseId } = req.params;
    const { byUserId } = req.body;
    
    const item = await ReleaseRequest.findById(releaseId);
    if (!item) {
      return res.status(404).json({ message: 'Release request not found' });
    }
    
    // Only the user who created the request can withdraw it
    if (String(item.user) !== String(byUserId)) {
      return res.status(403).json({ message: 'You can only withdraw your own release requests' });
    }
    
    // Only pending requests can be withdrawn
    if (!['pending', 'admin_pending'].includes(item.status)) {
      return res.status(400).json({ message: 'Only pending requests can be withdrawn' });
    }
    
    // Update status and add to history
    item.status = 'withdrawn';
    item.history.push({ 
      byUser: byUserId, 
      action: 'withdraw', 
      message: 'Request withdrawn by user',
      timestamp: new Date()
    });
    
    await item.save();
    
    // Return populated release request
    const populatedItem = await ReleaseRequest.findById(releaseId)
      .populate('player', 'name type role')
      .populate('user', 'name teamName');
    
    res.json(populatedItem);
  } catch (e) {
    console.error('Release withdraw error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Admin: history (approved/rejected)
router.get('/admin/history', async (req, res) => {
  try {
    const list = await ReleaseRequest.find({ 'adminDecision.status': { $in: ['approved', 'rejected'] } })
      .populate('user', 'name teamName')
      .populate('player', 'name type role')
      .populate('adminDecision.decidedBy', 'name email')
      .sort({ 'adminDecision.decidedAt': -1 });
    res.json(list);
  } catch (e) {
    console.error('Release history error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;


