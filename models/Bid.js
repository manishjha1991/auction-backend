const mongoose = require('mongoose');

const BidSchema = new mongoose.Schema({
    playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
    bidder: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    bidAmount: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now },
    isBidOn:{ type: Boolean, default: true },
    isActive:{ type: Boolean, default: true }
});

// Add indexes for better performance
BidSchema.index({ playerId: 1 });
BidSchema.index({ bidder: 1 });
BidSchema.index({ bidAmount: -1 });
BidSchema.index({ isActive: 1 });

module.exports = mongoose.model('Bid', BidSchema);
