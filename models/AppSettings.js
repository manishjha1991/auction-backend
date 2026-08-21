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
    requiredGames: { type: Number, default: 13 },
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
    // Which categories to check when running lock: ['sapphireEmerald','gold','silver']
    // If empty or missing, checks all (backward compatible). Use only active auction categories.
    lockCheckCategories: { type: [String], default: ['sapphireEmerald', 'gold', 'silver'] },
    // World Cup mode: seeded from CPL composite “qualification mix” top 6 (not points-table cut)
    worldCupMode: { type: Boolean, default: false },
    // Auction start date/time (stored as UTC Date)
    auctionStartAt: { type: Date, default: null },
    // Auto mode: at 10:30 PM enable categories + bulk; at 12:10 AM switch to single-bid windows
    auctionAutoModeEnabled: { type: Boolean, default: false },
    auctionAutoModeCategories: { type: [String], default: ['Gold', 'Silver', 'Sapphire', 'Emerald'] },
    /** Max completed+release "slots" per team per season (also caps concurrent outgoing trade proposals). */
    tradeSeasonCap: { type: Number, default: 3, min: 1, max: 10 },
    /** Max trades between the same two teams (counts completed + any pending/counter/admin_pending), either direction. */
    maxTradesPerOpponentPair: { type: Number, default: 1, min: 1, max: 10 },
    /** any_admin = existing admins can approve standalone trades; commissioner_only = isCommissioner required */
    tradeApprovalMode: { type: String, enum: ['any_admin', 'commissioner_only'], default: 'any_admin' },
    enableTradeBundles: { type: Boolean, default: true },
    /** When true, bundles execute automatically once all legs are admin_pending and valid */
    bundleAutoApprove: { type: Boolean, default: true },
    /** Starting database for CPL composite report (e.g., 'cpl_21'). If not set, uses current DB and goes back 2 seasons. */
    cplReportStartDb: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AppSettings', AppSettingsSchema);


