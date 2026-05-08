const mongoose = require('mongoose');

const PlayerSchema = new mongoose.Schema({
    playerID: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    type: { type: String, enum: ["Emerald", "Silver", "Gold", "Sapphire"], required: true },
    role: { type: String, enum: ["Batsman", "Bowler", "Allrounder", "WicketKeeper"], required: true },
    basePrice: { type: Number, required: true },
    style:{ type: String, required: true },
    overallScore: { type: Number, required: true },
    profilePicture: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    isSold: { type: Boolean, default: false },
    isActive:{ type: Boolean, default: true },
    currentBid: { type: Number, default: null },
    currentBidder: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    tradeLocked: { type: Boolean, default: false },
    tradeLockedUntil: { type: Date, default: null },
    releasedAt: { type: Date, default: null }, // When released; pick-from-unsold blocked for 48h after this
    lastBidAt: { type: Date, default: null },
    lastExitAt: { type: Date, default: null },
    lastExitBy: { type: String, enum: ['user', 'system'], default: null },
      // NEW FIELDS:
    totalRuns: { type: Number, default: 0 },
    totalBalls: { type: Number, default: 0 },
    totalRunsGiven: { type: Number, default: 0 },
    totalBallsBowled: { type: Number, default: 0 },
    totalWickets: { type: Number, default: 0 },
    momCount: { type: Number, default: 0 },
    matchesPlayed: { type: Number, default: 0 },
});

// Add indexes for better performance
PlayerSchema.index({ isActive: 1 });
PlayerSchema.index({ isSold: 1 });
PlayerSchema.index({ type: 1 });
// Career / rankings style: filter active roster + name
PlayerSchema.index({ isActive: 1, name: 1 });

module.exports = mongoose.model('Player', PlayerSchema);
