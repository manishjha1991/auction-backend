const mongoose = require('mongoose');

const AppSettingsSchema = new mongoose.Schema(
  {
    enableTradeCenter: { type: Boolean, default: true },
    enableUnsoldPlayers: { type: Boolean, default: true },
    enablePickButton: { type: Boolean, default: true },
    enablePlayerRetention: { type: Boolean, default: true },
    // overall: default single table; groups: split standings by groups
    pointsMode: { type: String, enum: ['overall', 'groups'], default: 'overall' },
    // Number of games required before playoffs can be initialized
    requiredGames: { type: Number, default: 12 },
    // Track when admin has released players to disable undo option
    adminReleasedPlayers: { type: Boolean, default: false },
    adminReleasedPlayersAt: { type: Date },
    // Track which teams have been released by admin
    releasedTeams: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Track when ALL players are released for any user
    allPlayersReleased: { type: Boolean, default: false },
    cronSingleBidEnabled: { type: Boolean, default: true },
    cronSingleBidFinalizerEnabled: { type: Boolean, default: true },
    cronBulkExitEnabled: { type: Boolean, default: true },
    cronLockEnabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AppSettings', AppSettingsSchema);


