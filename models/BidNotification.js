const mongoose = require('mongoose');

const bidNotificationSchema = new mongoose.Schema({
  message: {
    type: String,
    required: true
  },
  playername: {
    type: String,
    required: true
  },
  currentBid: {
    type: Number,
    required: true
  },
  currentBidder: {
    type: String,
    required: true
  },
  secondBidder: {
    type: String,
    default: null
  },
  newBid: {
    type: Number,
    required: false
  },
  exitedUser: {
    type: String,
    default: null
  },
  active: {
    type: Boolean,
    default: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('BidNotification', bidNotificationSchema);
