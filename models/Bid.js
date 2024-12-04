// models/Bid.js
const mongoose = require("mongoose");

const bidSchema = new mongoose.Schema(
  {
    playerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Player",
      required: true,
    },
    bidder: {
      id: { type: String, required: true },
      name: { type: String, required: true },
    },
    bidAmount: {
      type: Number,
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Bid", bidSchema);
