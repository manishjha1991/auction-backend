const mongoose = require('mongoose');

const BidSchema = new mongoose.Schema({
    playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
    bidder: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    bidAmount: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now },
    isBidOn:{ type: Boolean, default: true },
});

module.exports = mongoose.model('Bid', BidSchema);
