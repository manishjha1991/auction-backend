const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema(
  {
    message: { type: String, required: true },
    playername: { type: String, required: true },
    currentBid: { type: Number, required: true },
    currentBidder: { type: String, required: true },
    secondBidder: { type: String },
    newBid: { type: Object },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Notification', NotificationSchema);
