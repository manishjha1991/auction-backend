const mongoose = require("mongoose");

const QueueEntrySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    maxBid: { type: Number, required: true },
    status: {
      type: String,
      enum: ["queued", "active_proxy", "done"],
      default: "queued",
    },
    /** Full max amount deducted from purse at enqueue time */
    lockedAmount: { type: Number, required: true },
    joinedAt: { type: Date, default: Date.now },
    /** When <= 3 increments from losing by max, user must raise max or will be dropped */
    maxEditTradesRemaining: { type: Number, default: null },
 },
  { _id: true }
);

const BidPlayerQueueSchema = new mongoose.Schema({
  playerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Player",
    required: true,
    unique: true,
  },
  entries: [QueueEntrySchema],
  updatedAt: { type: Date, default: Date.now },
});

// Hot-path indexes for queue APIs/services
BidPlayerQueueSchema.index({ playerId: 1 }, { unique: true });
BidPlayerQueueSchema.index({ "entries.userId": 1 });
BidPlayerQueueSchema.index({ "entries.status": 1, updatedAt: -1 });

BidPlayerQueueSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("BidPlayerQueue", BidPlayerQueueSchema);
