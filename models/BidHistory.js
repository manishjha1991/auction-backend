const mongoose = require("mongoose");

const BidHistorySchema = new mongoose.Schema({
  playerId: { type: mongoose.Schema.Types.ObjectId, ref: "Player", required: true },
  bidID: { type: mongoose.Schema.Types.ObjectId, required: true },
  bids: [
    {
      userID: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      bidAmount: { type: Number, required: true },
      status: { type: Boolean, required: true, default: false },
      createdAt: { type: Date, default: Date.now },
      updatedAt: { type: Date, default: Date.now }
    },
  ],
});

module.exports = mongoose.model("BidHistory", BidHistorySchema);
