// models/Fixture.js
const mongoose = require('mongoose');

const FixtureSchema = new mongoose.Schema({
  team1: { type: String, required: true },
  team2: { type: String, required: true },
  winner: { type: String, default: null },
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

module.exports = mongoose.model('Fixture', FixtureSchema);
