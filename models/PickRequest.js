const mongoose = require('mongoose');

const PickHistorySchema = new mongoose.Schema(
  {
    byUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, enum: ['propose', 'accept', 'reject'], required: true },
    message: { type: String },
    timestamp: { type: Date, default: Date.now }
  },
  { _id: false }
);

const PickRequestSchema = new mongoose.Schema(
  {
    tournamentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament',
      default: null,
      index: true
    },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    player: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
    status: { type: String, enum: ['pending', 'admin_pending', 'completed', 'rejected'], default: 'pending' },
    history: [PickHistorySchema],
    adminDecision: {
      status: { type: String, enum: ['approved', 'rejected'], default: undefined },
      decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      decidedAt: { type: Date },
      note: { type: String }
    }
  },
  { timestamps: true }
);

PickRequestSchema.index({ tournamentId: 1, user: 1, status: 1, createdAt: -1 });
PickRequestSchema.index({ tournamentId: 1, player: 1, status: 1 });

module.exports = mongoose.model('PickRequest', PickRequestSchema);


