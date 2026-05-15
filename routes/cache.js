const express = require('express');
const router = express.Router();
const { invalidateCache, clearAllCaches } = require('../utils/cache');

// POST /api/cache/invalidate - Invalidate specific cache patterns
router.post('/invalidate', async (req, res) => {
  try {
    const { pattern } = req.body;
    
    if (pattern) {
      invalidateCache(pattern);
      res.json({ success: true, message: `Cache invalidated for pattern: ${pattern}` });
    } else {
      // If no pattern, clear all caches
      clearAllCaches();
      res.json({ success: true, message: 'All caches cleared' });
    }
  } catch (error) {
    console.error('Error invalidating cache:', error);
    res.status(500).json({ success: false, message: 'Failed to invalidate cache' });
  }
});

// POST /api/cache/clear - Clear all caches
router.post('/clear', async (req, res) => {
  try {
    clearAllCaches();
    res.json({ success: true, message: 'All caches cleared successfully' });
  } catch (error) {
    console.error('Error clearing cache:', error);
    res.status(500).json({ success: false, message: 'Failed to clear cache' });
  }
});

module.exports = router;
