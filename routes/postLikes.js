const express = require('express');
const router = express.Router();
const PostLike = require('../models/PostLike');
const User = require('../models/User');

// Middleware to verify user authentication
const authenticateUser = async (req, res, next) => {
  try {
    const userId = req.headers['user-id'];
    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({ error: 'Invalid user' });
    }
    
    req.user = user;
    next();
  } catch (error) {
    res.status(500).json({ error: 'Authentication failed' });
  }
};

// Get likes for a news post
router.get('/news/:newsId', async (req, res) => {
  try {
    const { newsId } = req.params;
    
    const likes = await PostLike.find({ newsId })
      .populate('userId', 'name avatar')
      .sort({ createdAt: -1 });
    
    // Group likes by type
    const likeCounts = {
      like: 0,
      love: 0,
      haha: 0,
      wow: 0,
      sad: 0,
      angry: 0
    };
    
    likes.forEach(like => {
      likeCounts[like.likeType]++;
    });
    
    res.json({
      likes,
      likeCounts,
      total: likes.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch likes' });
  }
});

// Like/unlike a news post
router.post('/news/:newsId', authenticateUser, async (req, res) => {
  try {
    const { newsId } = req.params;
    const { likeType = 'like' } = req.body;
    const userId = req.user._id;
    
    // Validate like type
    const validTypes = ['like', 'love', 'haha', 'wow', 'sad', 'angry'];
    if (!validTypes.includes(likeType)) {
      return res.status(400).json({ error: 'Invalid like type' });
    }
    
    // Check if user already liked this post
    const existingLike = await PostLike.findOne({ newsId, userId });
    
    if (existingLike) {
      if (existingLike.likeType === likeType) {
        // Remove like if same type
        await PostLike.findByIdAndDelete(existingLike._id);
        res.json({ 
          message: 'Post unliked',
          action: 'unliked',
          likeType: null
        });
      } else {
        // Change like type
        existingLike.likeType = likeType;
        await existingLike.save();
        res.json({ 
          message: 'Like type changed',
          action: 'changed',
          likeType: likeType
        });
      }
    } else {
      // Add new like
      const newLike = new PostLike({
        newsId,
        userId,
        likeType
      });
      
      await newLike.save();
      
      res.json({ 
        message: 'Post liked',
        action: 'liked',
        likeType: likeType
      });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to like/unlike post' });
  }
});

// Get user's like for a specific news post
router.get('/news/:newsId/user', authenticateUser, async (req, res) => {
  try {
    const { newsId } = req.params;
    const userId = req.user._id;
    
    const like = await PostLike.findOne({ newsId, userId });
    
    res.json({
      hasLiked: !!like,
      likeType: like ? like.likeType : null
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user like' });
  }
});

// Get like statistics for a news post
router.get('/news/:newsId/stats', async (req, res) => {
  try {
    const { newsId } = req.params;
    
    const stats = await PostLike.aggregate([
      { $match: { newsId: new require('mongoose').Types.ObjectId(newsId) } },
      { $group: { _id: '$likeType', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    
    const likeCounts = {
      like: 0,
      love: 0,
      haha: 0,
      wow: 0,
      sad: 0,
      angry: 0
    };
    
    stats.forEach(stat => {
      likeCounts[stat._id] = stat.count;
    });
    
    res.json({
      likeCounts,
      total: Object.values(likeCounts).reduce((a, b) => a + b, 0)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch like statistics' });
  }
});

module.exports = router;
