const mongoose = require('mongoose');

const postLikeSchema = new mongoose.Schema({
  newsId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'News',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  likeType: {
    type: String,
    enum: ['like', 'love', 'haha', 'wow', 'sad', 'angry'],
    default: 'like'
  }
}, {
  timestamps: true
});

// Compound index to ensure one user can only like a post once
postLikeSchema.index({ newsId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('PostLike', postLikeSchema);
