const mongoose = require('mongoose');

const TradeHistorySchema = new mongoose.Schema(
  {
    byUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, enum: ['propose', 'counter', 'accept', 'reject', 'withdraw'], required: true },
    message: { type: String },
    offeredPlayer: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' },
    requestedPlayer: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' },
    timestamp: { type: Date, default: Date.now }
  },
  { _id: false }
);

const TradeRequestSchema = new mongoose.Schema(
  {
    fromUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    toUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    offeredPlayer: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
    requestedPlayer: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
    status: {
      type: String,
      enum: ['pending', 'counter', 'rejected', 'withdrawn', 'admin_pending', 'completed'],
      default: 'pending'
    },
    history: [TradeHistorySchema],
    adminDecision: {
      status: { type: String, enum: ['approved', 'rejected'], default: undefined },
      decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      decidedAt: { type: Date },
      note: { type: String }
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('TradeRequest', TradeRequestSchema);


