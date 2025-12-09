// models/Fixture.js
const mongoose = require('mongoose');

const FixtureSchema = new mongoose.Schema({
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

  // Separate fairness fields for each team
  team1Fairness: { type: Number, default: 0 },
  team2Fairness: { type: Number, default: 0 },

  mom: { 
    name: { type: String, default: null }, 
    score: { type: Number }, 
    wickets: { type: Number } 
  },
  createdAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
  group: { type: String, enum: ['A', 'B', null], default: null }, // Track if this is a group stage match
  matchType: { type: String, enum: ['group', 'normal'], default: 'normal' } // Track match type
});

// Add indexes for better performance
FixtureSchema.index({ team1: 1, isActive: 1 });
FixtureSchema.index({ team2: 1, isActive: 1 });
FixtureSchema.index({ team1UserId: 1, isActive: 1 });
FixtureSchema.index({ team2UserId: 1, isActive: 1 });
FixtureSchema.index({ isActive: 1, createdAt: 1 });

module.exports = mongoose.model('Fixture', FixtureSchema);
