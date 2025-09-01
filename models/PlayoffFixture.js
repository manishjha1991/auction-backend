const mongoose = require('mongoose');

const playoffFixtureSchema = new mongoose.Schema({
  matchId: {
    type: String,
    required: true,
    enum: ['A', 'B', 'C', 'D', 'E', 'F']
  },
  stage: {
    type: String,
    required: true,
    enum: ['ELIMINATOR ROUND', 'QUALIFIER 1', 'ELIMINATOR 2', 'QUALIFIER 2', 'FINALS']
  },
  team1: {
    type: String,
    required: true
  },
  team2: {
    type: String,
    required: true
  },
  team1Score: {
    type: String,
    default: 'TBD'
  },
  team2Score: {
    type: String,
    default: 'TBD'
  },
  winner: {
    type: String,
    default: null
  },
  margin: {
    type: String,
    default: null
  },
  mom: {
    name: {
      type: String,
      default: null
    },
    score: {
      type: Number,
      default: 0
    },
    wickets: {
      type: Number,
      default: 0
    }
  },
  team1Fairness: {
    type: Number,
    default: 0
  },
  team2Fairness: {
    type: Number,
    default: 0
  },
  isCompleted: {
    type: Boolean,
    default: false
  },
  date: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('PlayoffFixture', playoffFixtureSchema);
