const mongoose = require('mongoose');

const FixtureSchema = new mongoose.Schema({
  team1: { type: String, required: true },
  team2: { type: String, required: true },
  winner: { type: String, default: null },
  margin: { type: String, default: null },
  team1Score: { type: String, default: null },
  team2Score: { type: String, default: null },
  mom: { 
    name: { type: String, default: null }, 
    score: { type: Number, default: 0 }, 
    wickets: { type: Number, default: 0 } 
  }, // Detailed MoM information
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Fixture', FixtureSchema);
