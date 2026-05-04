// models/Fixture.js
const mongoose = require('mongoose');

const FixtureSchema = new mongoose.Schema({
  tournamentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tournament',
    default: null,
    index: true
  },
  // Team names (kept for backward compatibility and display)
  team1: { type: String, required: true },
  team2: { type: String, required: true },
  
  // User IDs (new - for referential integrity)
  team1UserId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: false // Not required initially for backward compatibility
  },
  team2UserId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: false // Not required initially for backward compatibility
  },
  
  winner: { type: String, default: null },
  winnerUserId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    default: null 
  },
  margin: { type: String, default: null },
  team1Score: { type: String, default: null },
  team2Score: { type: String, default: null },
  team1Overs: { type: String, default: null }, // Overs played by team1 (e.g., "20.0", "19.3")
  team2Overs: { type: String, default: null }, // Overs played by team2 (e.g., "20.0", "19.3")

  // Separate fairness fields for each team
  team1Fairness: { type: Number, default: 0 },
  team2Fairness: { type: Number, default: 0 },

  mom: { 
    name: { type: String, default: null }, // Only name is mandatory
    score: { type: Number, default: null }, // Optional
    wickets: { type: Number, default: null } // Optional
  },
  createdAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
  group: { type: String, enum: ['A', 'B', null], default: null }, // Track if this is a group stage match
  matchType: { type: String, enum: ['group', 'normal'], default: 'normal' }, // Track match type
  headToHeadSynced: { type: Boolean, default: false } // True once win/loss has been added to TeamHeadToHead
});

// Add indexes for better performance
FixtureSchema.index({ team1: 1, isActive: 1 });
FixtureSchema.index({ team2: 1, isActive: 1 });
FixtureSchema.index({ team1UserId: 1, isActive: 1 });
FixtureSchema.index({ team2UserId: 1, isActive: 1 });
FixtureSchema.index({ isActive: 1, createdAt: 1 });
FixtureSchema.index({ tournamentId: 1, isActive: 1, createdAt: 1 });
FixtureSchema.index({ tournamentId: 1, team1UserId: 1, team2UserId: 1 });

module.exports = mongoose.model('Fixture', FixtureSchema);
