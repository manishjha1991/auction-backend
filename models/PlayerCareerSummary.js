const mongoose = require('mongoose');

const inningsMilestoneSchema = new mongoose.Schema(
  {
    runs: { type: Number, default: 0 },
    balls: { type: Number, default: 0 },
    opponentTeam: { type: String, default: '' },
    date: { type: Date, default: null },
  },
  { _id: false },
);

const bowlingSpellSchema = new mongoose.Schema(
  {
    wickets: { type: Number, default: 0 },
    runsGiven: { type: Number, default: 0 },
    ballsBowled: { type: Number, default: 0 },
    opponentTeam: { type: String, default: '' },
    date: { type: Date, default: null },
  },
  { _id: false },
);

const metricsBlockSchema = new mongoose.Schema(
  {
    totalRuns: { type: Number, default: 0 },
    totalBalls: { type: Number, default: 0 },
    innings: { type: Number, default: 0 },
    totalFifties: { type: Number, default: 0 },
    totalHundreds: { type: Number, default: 0 },
    highestScore: { type: Number, default: 0 },
    totalWickets: { type: Number, default: 0 },
    totalRunsGiven: { type: Number, default: 0 },
    totalBallsBowled: { type: Number, default: 0 },
    bowlingInnings: { type: Number, default: 0 },
    battingStrikeRate: { type: Number, default: 0 },
    battingAverage: { type: Number, default: 0 },
    bowlingAverage: { type: Number, default: 0 },
    bestBowling: { type: String, default: '0/0' },
    centuries: { type: [inningsMilestoneSchema], default: [] },
    fifties: { type: [inningsMilestoneSchema], default: [] },
    bestBowlingSpells: { type: [bowlingSpellSchema], default: [] },
  },
  { _id: false },
);

const playerCareerSummarySchema = new mongoose.Schema(
  {
    playerKey: { type: String, required: true, unique: true, index: true },
    playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', index: true, default: null },
    playerName: { type: String, required: true },
    role: { type: String, default: '' },
    teams: { type: [String], default: [] },
    historical: { type: metricsBlockSchema, default: () => ({}) },
    live: { type: metricsBlockSchema, default: () => ({}) },
    total: { type: metricsBlockSchema, default: () => ({}) },
  },
  { timestamps: true },
);

// Career list API sorts by runs/wickets; list reads only `total` (not historical/live).
playerCareerSummarySchema.index({ 'total.totalRuns': -1, 'total.totalWickets': -1, playerName: 1 });
playerCareerSummarySchema.index({ updatedAt: -1 });

module.exports = mongoose.model('PlayerCareerSummary', playerCareerSummarySchema);

