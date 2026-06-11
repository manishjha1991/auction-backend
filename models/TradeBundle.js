const mongoose = require('mongoose');

const TradeBundleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tradeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TradeRequest' }],
    partyUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    commitmentNote: { type: String, default: '' },
    shareCode: { type: String, unique: true, sparse: true },
    status: {
      type: String,
      enum: ['draft', 'pending_acceptance', 'ready_for_admin', 'blocked', 'completed', 'cancelled', 'rejected'],
      default: 'draft',
    },
    blockers: [String],
    completedAt: { type: Date },
    history: [
      {
        action: String,
        byUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        message: String,
        timestamp: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model('TradeBundle', TradeBundleSchema);
