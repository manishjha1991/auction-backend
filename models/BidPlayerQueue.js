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
  tournamentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Tournament",
    default: null,
    index: true,
  },
  playerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Player",
    required: true,
  },
  entries: [QueueEntrySchema],
  updatedAt: { type: Date, default: Date.now },
});

BidPlayerQueueSchema.index({ playerId: 1 });
BidPlayerQueueSchema.index(
  { tournamentId: 1, playerId: 1 },
  {
    unique: true,
    partialFilterExpression: { tournamentId: { $type: "objectId" } },
    name: "unique_queue_player_per_tournament",
  }
);

BidPlayerQueueSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("BidPlayerQueue", BidPlayerQueueSchema);
