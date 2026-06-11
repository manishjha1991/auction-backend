const mongoose = require('mongoose');

const TradeApprovalAuditSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['standalone_approve', 'standalone_reject', 'bundle_auto_approve', 'bundle_reject'],
      required: true,
    },
    tradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradeRequest' },
    bundleId: { type: mongoose.Schema.Types.ObjectId, ref: 'TradeBundle' },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    clientIp: { type: String },
    note: { type: String },
    tradeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'TradeRequest' }],
    blockers: [String],
  },
  { timestamps: true }
);

TradeApprovalAuditSchema.index({ createdAt: -1 });

module.exports = mongoose.model('TradeApprovalAudit', TradeApprovalAuditSchema);
