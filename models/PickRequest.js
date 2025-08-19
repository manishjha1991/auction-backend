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

module.exports = mongoose.model('PickRequest', PickRequestSchema);


