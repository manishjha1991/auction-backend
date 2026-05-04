const mongoose = require('mongoose');

const ReleaseHistorySchema = new mongoose.Schema(
  {
    byUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, enum: ['propose', 'accept', 'reject', 'withdraw'], required: true },
    message: { type: String },
    timestamp: { type: Date, default: Date.now }
  },
  { _id: false }
);

const ReleaseRequestSchema = new mongoose.Schema(
  {
    tournamentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament',
      default: null,
      index: true
    },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    player: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
    /** Tier of the released player (set on admin approve); used to pair one unsold pick of the same tier without a second tradesUsed. */
    releasedPlayerType: { type: String, enum: ['Sapphire', 'Gold', 'Emerald', 'Silver'] },
    /** Pick request that completed the same-tier replacement for this release (optional). */
    pairedPickRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'PickRequest', default: null },
    status: { type: String, enum: ['pending', 'rejected', 'admin_pending', 'completed', 'withdrawn'], default: 'pending' },
    history: [ReleaseHistorySchema],
    adminDecision: {
      status: { type: String, enum: ['approved', 'rejected'], default: undefined },
      decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      decidedAt: { type: Date },
      note: { type: String }
    }
  },
  { timestamps: true }
);

ReleaseRequestSchema.index({ tournamentId: 1, user: 1, status: 1, createdAt: -1 });
ReleaseRequestSchema.index({ tournamentId: 1, player: 1, status: 1 });

module.exports = mongoose.model('ReleaseRequest', ReleaseRequestSchema);


