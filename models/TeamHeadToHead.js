const mongoose = require('mongoose');

// Stores cumulative head-to-head wins between team pairs.
// Persists even if fixtures/match results are deleted.
const TeamHeadToHeadSchema = new mongoose.Schema({
  team1UserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  team2UserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  team1Name: { type: String, required: true },
  team2Name: { type: String, required: true },
  team1Wins: { type: Number, default: 0 },
  team2Wins: { type: Number, default: 0 },
  draws: { type: Number, default: 0 },
  lastSyncedAt: { type: Date, default: Date.now },
}, { timestamps: true });

TeamHeadToHeadSchema.index({ team1UserId: 1, team2UserId: 1 }, { unique: true });

module.exports = mongoose.model('TeamHeadToHead', TeamHeadToHeadSchema);
