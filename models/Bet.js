const mongoose = require('mongoose');

const BetSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  team1: {
    type: String,
    required: true
  },
  team2: {
    type: String,
    required: true
  },
  team1UserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  team2UserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  selectedTeam: {
    type: String,
    required: true,
    enum: ['team1', 'team2']
  },
  betAmount: {
    type: Number,
    required: true,
    min: 0
  },
  // Odds based on ranking
  isUnderdog: {
    type: Boolean,
    default: false // true if betting on lower ranked team
  },
  winMultiplier: {
    type: Number,
    required: true // e.g., 1.6 for 60% gain, 1.5 for 50% gain
  },
  loseMultiplier: {
    type: Number,
    required: true // e.g., 0.4 for 40% loss, 0.6 for 60% loss
  },
  // Potential winnings/losses
  potentialWin: {
    type: Number,
    required: true // betAmount * winMultiplier
  },
  potentialLoss: {
    type: Number,
    required: true // betAmount * loseMultiplier
  },
  // Match/fixture reference (optional)
  fixtureId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Fixture'
  },
  // Status
  status: {
    type: String,
    enum: ['pending', 'won', 'lost', 'cancelled'],
    default: 'pending'
  },
  // Settlement
  settledAt: {
    type: Date
  },
  winner: {
    type: String // team1 or team2
  },
  actualPayout: {
    type: Number // Amount credited/debited to purse
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes for performance
BetSchema.index({ userId: 1, status: 1 });
BetSchema.index({ status: 1, createdAt: -1 });
BetSchema.index({ team1: 1, team2: 1, status: 1 });

module.exports = mongoose.model('Bet', BetSchema);





