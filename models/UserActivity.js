const mongoose = require('mongoose');

const UserActivitySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true }, // 'login', 'bid', 'logout', etc.
  ipAddress: { type: String, required: true },
  userAgent: { type: String, default: null },
  details: { type: mongoose.Schema.Types.Mixed, default: {} }, // Additional action-specific data
  isSuspicious: { type: Boolean, default: false }, // Flag for suspicious activity
  suspiciousReason: { type: String, default: null }, // Reason if suspicious
  timestamp: { type: Date, default: Date.now },
}, { timestamps: true });

// Indexes for efficient queries
UserActivitySchema.index({ userId: 1, timestamp: -1 });
UserActivitySchema.index({ ipAddress: 1, timestamp: -1 });
UserActivitySchema.index({ isSuspicious: 1, timestamp: -1 });
UserActivitySchema.index({ action: 1, timestamp: -1 });

module.exports = mongoose.model('UserActivity', UserActivitySchema);

