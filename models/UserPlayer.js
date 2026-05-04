const mongoose = require("mongoose");

const UserPlayerSchema = new mongoose.Schema({
  tournamentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Tournament",
    default: null,
    index: true,
  },
  playerId: { type: mongoose.Schema.Types.ObjectId, ref: "Player", required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  bidValue: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true }, // Admin field added
});

// Add compound indexes for better performance
UserPlayerSchema.index({ playerId: 1, isActive: 1 });
UserPlayerSchema.index({ userId: 1, isActive: 1 });
UserPlayerSchema.index({ isActive: 1 });
UserPlayerSchema.index({ tournamentId: 1, userId: 1, isActive: 1 });
UserPlayerSchema.index({ tournamentId: 1, playerId: 1, isActive: 1 });

// Unique index to prevent duplicate active sales (same player sold twice to same user)
// This is a partial unique index that only applies when isActive is true
// and tournamentId is present (migration-safe for legacy docs).
UserPlayerSchema.index(
  { tournamentId: 1, playerId: 1, userId: 1 },
  { 
    unique: true, 
    partialFilterExpression: { 
      isActive: true,
      tournamentId: { $type: "objectId" }
    },
    name: 'unique_active_player_user_per_tournament'
  }
);

module.exports = mongoose.model("UserPlayer", UserPlayerSchema);
