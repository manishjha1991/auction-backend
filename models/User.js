const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  teamName: { type: String },
  teamImage: { type: String },
  purse: { type: mongoose.Schema.Types.Decimal128, default: 1000000000 },
  betWallet: { type: mongoose.Schema.Types.Decimal128, default: 1000000000 }, // Separate wallet for betting (100 CR) - purse is never touched
  boughtPlayers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }],
  currentBids: [
    {
      playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' },
      amount: Number,
    },
  ], // Array to track bids on up to 4 players
  isAdmin: { type: Boolean, default: false },
  isCommissioner: { type: Boolean, default: false },
  tradesUsed: { type: Number, default: 0 },
  points: { type: Number, default: 0 }, // Store total points
  matchesPlayed: { type: Number, default: 0 }, // Store total matches played
  /** Career totals across seasons (cpl_12…cpl_20 + live bumps); reconcile with sync script */
  careerMatchesPlayed: { type: Number, default: 0 },
  careerWins: { type: Number, default: 0 },
  fairnessPoint:{ type: Number, default: 0 },
  isActive:{ type: Boolean, default: true },
  isParticipating: { type: Boolean, default: true }, // Whether team is participating in current season
  abbreviation: { type: String, default: null },
  group: { type: String, enum: ['A', 'B', null], default: null },
  isLocked: { type: Boolean, default: false },
  isRetentionLocked: { type: Boolean, default: false }, // NEW: Lock for retention functionality
  isTournamentReady: { type: Boolean, default: false }, // NEW: Only true when user is ready for tournament
  timezone: { type: String, default: 'Asia/Kolkata' }, // User's preferred timezone
  streamLink: { type: String, default: null }, // User's streaming URL
  allPlayersReleased: { type: Boolean, default: false }, // NEW: Track if all players are released for this user
  // Anti-proxy bidding fields
  lastLoginIP: { type: String, default: null }, // IP address of last login
  lastLoginTime: { type: Date, default: null }, // Timestamp of last login
  lastBidIP: { type: String, default: null }, // IP address of last bid
  lastBidTime: { type: Date, default: null }, // Timestamp of last bid
  activeSessionId: { type: String, default: null }, // Unique session identifier
  suspiciousActivityCount: { type: Number, default: 0 }, // Count of suspicious activities
  knownIPs: [{ type: String }], // Array of known IP addresses for this user
  knownDevices: [{ type: String }], // Array of known device fingerprints for this user
  lastDeviceFingerprint: { type: String, default: null }, // Last device fingerprint used
  captainPlayerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', default: null },
  /** Custom colours for Team Squads page cards / modal (hex #rrggbb); null = use default palette */
  themePrimary: { type: String, default: null },
  themeSecondary: { type: String, default: null },
  /** One-click league forfeit snapshot so admin can Restore prior results */
  leagueForfeit: {
    active: { type: Boolean, default: false },
    forfeitedAt: { type: Date, default: null },
    snapshot: [
      {
        fixtureId: { type: mongoose.Schema.Types.ObjectId, ref: 'Fixture' },
        winner: { type: String, default: null },
        winnerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        team1Score: { type: String, default: null },
        team2Score: { type: String, default: null },
        team1Overs: { type: String, default: null },
        team2Overs: { type: String, default: null },
        margin: { type: String, default: null },
        mom: {
          name: { type: String, default: null },
          score: { type: Number, default: null },
          wickets: { type: Number, default: null },
        },
        team1Fairness: { type: Number, default: 0 },
        team2Fairness: { type: Number, default: 0 },
        pointsTableApplied: { type: Boolean, default: false },
      },
    ],
  },
});

function applyActiveFilter(next) {
  const options = (typeof this.getOptions === 'function' ? this.getOptions() : this.options) || {};
  if (!options.includeInactive) {
    this.where({ isActive: { $ne: false } });
  }
  next();
}

UserSchema.pre('find', applyActiveFilter);
UserSchema.pre('findOne', applyActiveFilter);
UserSchema.pre('findOneAndUpdate', applyActiveFilter);
UserSchema.pre('count', applyActiveFilter);
UserSchema.pre('countDocuments', applyActiveFilter);

UserSchema.query.includeInactive = function () {
  return this.setOptions({ includeInactive: true });
};

UserSchema.statics.findIncludingInactive = function (filter = {}) {
  return this.find(filter).setOptions({ includeInactive: true });
};

// Add indexes for better performance
UserSchema.index({ teamName: 1 });
UserSchema.index({ isActive: 1, isAdmin: 1 });
UserSchema.index({ isTournamentReady: 1 });
UserSchema.index({ allPlayersReleased: 1 });
UserSchema.index({ isParticipating: 1 });

module.exports = mongoose.model('User', UserSchema);
