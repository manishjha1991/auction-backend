const mongoose = require('mongoose');

// Stores cumulative head-to-head wins between team pairs.
// Persists even if fixtures/match results are deleted.
const TeamHeadToHeadSchema = new mongoose.Schema({
  tournamentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tournament',
    default: null,
    index: true,
  },
  team1UserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  team2UserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  team1Name: { type: String, required: true },
  team2Name: { type: String, required: true },
  team1Wins: { type: Number, default: 0 },
  team2Wins: { type: Number, default: 0 },
  draws: { type: Number, default: 0 },
  lastSyncedAt: { type: Date, default: Date.now },
}, { timestamps: true });

TeamHeadToHeadSchema.index({ team1UserId: 1, team2UserId: 1 });
TeamHeadToHeadSchema.index(
  { tournamentId: 1, team1UserId: 1, team2UserId: 1 },
  {
    unique: true,
    partialFilterExpression: { tournamentId: { $type: 'objectId' } },
    name: 'unique_h2h_pair_per_tournament',
  }
);

module.exports = mongoose.model('TeamHeadToHead', TeamHeadToHeadSchema);
