const express = require('express');
const router = express.Router();
const Comment = require('../models/Comment');

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

// Get comments for a news post
router.get('/news/:newsId', async (req, res) => {
  try {
    const { newsId } = req.params;
    const { page = 1, limit = 10 } = req.query;
    
    const skip = (page - 1) * limit;
    
    const comments = await Comment.find({ newsId })
      .populate('userId', 'name avatar')
      .populate('replies.userId', 'name avatar')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await Comment.countDocuments({ newsId });
    
    res.json({
      comments,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// Add a comment to a news post
router.post('/news/:newsId', authenticateUser, async (req, res) => {
  try {
    const { newsId } = req.params;
    const { content, parentCommentId } = req.body;
    const userId = req.user._id;
    
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment content is required' });
    }
    
    if (parentCommentId) {
      // Adding a reply to an existing comment
      const parentComment = await Comment.findById(parentCommentId);
      if (!parentComment) {
        return res.status(404).json({ error: 'Parent comment not found' });
      }
      
      const reply = {
        userId: userId,
        userName: req.user.name,
        userAvatar: req.user.avatar || null,
        content: content.trim(),
        likes: [],
        createdAt: new Date()
      };
      
      parentComment.replies.push(reply);
      await parentComment.save();
      
      // Populate the userId field for the reply
      const populatedReply = {
        ...reply,
        userId: {
          _id: req.user._id,
          name: req.user.name,
          avatar: req.user.avatar
        }
      };
      
      res.json({ message: 'Reply added successfully', reply: populatedReply });
    } else {
      // Adding a new comment
      const comment = new Comment({
        newsId,
        userId,
        userName: req.user.name,
        userAvatar: req.user.avatar || null,
        content: content.trim()
      });
      
      await comment.save();
      
      const populatedComment = await Comment.findById(comment._id)
        .populate('userId', 'name avatar');
      
      res.status(201).json({ message: 'Comment added successfully', comment: populatedComment });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// Update a comment
router.put('/:commentId', authenticateUser, async (req, res) => {
  try {
    const { commentId } = req.params;
    const { content } = req.body;
    const userId = req.user._id;
    
    if (!content || content.trim().length === 0) {
      return res.status(400).json({ error: 'Comment content is required' });
    }
    
    const comment = await Comment.findById(commentId);
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    
    if (comment.userId.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'You can only edit your own comments' });
    }
    
    comment.content = content.trim();
    comment.isEdited = true;
    comment.editedAt = new Date();
    
    await comment.save();
    
    res.json({ message: 'Comment updated successfully', comment });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update comment' });
  }
});

// Delete a comment
router.delete('/:commentId', authenticateUser, async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user._id;
    
    const comment = await Comment.findById(commentId);
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    
    if (comment.userId.toString() !== userId.toString()) {
      return res.status(403).json({ error: 'You can only delete your own comments' });
    }
    
    await Comment.findByIdAndDelete(commentId);
    
    res.json({ message: 'Comment deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

// Like/unlike a comment
router.post('/:commentId/like', authenticateUser, async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user._id;
    
    const comment = await Comment.findById(commentId);
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    
    const likeIndex = comment.likes.indexOf(userId);
    if (likeIndex > -1) {
      // Unlike
      comment.likes.splice(likeIndex, 1);
    } else {
      // Like
      comment.likes.push(userId);
    }
    
    await comment.save();
    
    res.json({ 
      message: likeIndex > -1 ? 'Comment unliked' : 'Comment liked',
      likes: comment.likes.length,
      isLiked: likeIndex === -1
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to like/unlike comment' });
  }
});

// Like/unlike a reply
router.post('/:commentId/replies/:replyIndex/like', authenticateUser, async (req, res) => {
  try {
    const { commentId, replyIndex } = req.params;
    const userId = req.user._id;
    
    const comment = await Comment.findById(commentId);
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    
    if (replyIndex < 0 || replyIndex >= comment.replies.length) {
      return res.status(404).json({ error: 'Reply not found' });
    }
    
    const reply = comment.replies[replyIndex];
    const likeIndex = reply.likes.indexOf(userId);
    
    if (likeIndex > -1) {
      // Unlike
      reply.likes.splice(likeIndex, 1);
    } else {
      // Like
      reply.likes.push(userId);
    }
    
    await comment.save();
    
    res.json({ 
      message: likeIndex > -1 ? 'Reply unliked' : 'Reply liked',
      likes: reply.likes.length,
      isLiked: likeIndex === -1
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to like/unlike reply' });
  }
});

module.exports = router;
