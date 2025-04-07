const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');

// GET API: fetch all notifications that are active
router.get('/', async (req, res) => {
  try {
    const notifications = await Notification.find({ active: true }).sort({ createdAt: -1 });
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ message: "Error fetching notifications" });
  }
});

// CLEAR API: update all active notifications to inactive (active: false)
router.post('/clear', async (req, res) => {
  try {
    const result = await Notification.updateMany({ active: true }, { active: false });
    res.json({ message: "Notifications cleared", result });
  } catch (err) {
    res.status(500).json({ message: "Error clearing notifications" });
  }
});

module.exports = router;
