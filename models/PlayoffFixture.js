const mongoose = require('mongoose');

const playoffFixtureSchema = new mongoose.Schema({
  matchId: {
    type: String,
    required: true,
    enum: [
      // Normal mode
      'A', 'B', 'C', 'D', 'E', 'F', 
      // Groups mode
      'Q1', 'Q2', 'SF1', 'SF2',
      // World Cup mode - round-robin (28 matches)
      'WC1', 'WC2', 'WC3', 'WC4', 'WC5', 'WC6', 'WC7', 'WC8', 'WC9', 'WC10',
      'WC11', 'WC12', 'WC13', 'WC14', 'WC15', 'WC16', 'WC17', 'WC18', 'WC19', 'WC20',
      'WC21', 'WC22', 'WC23', 'WC24', 'WC25', 'WC26', 'WC27', 'WC28',
      // World Cup mode - semi-finals and final
      'WCSF1', 'WCSF2', 'WCF'
    ]
  },
  stage: {
    type: String,
    required: true,
    enum: [
      // Normal mode
      'ELIMINATOR ROUND', 'QUALIFIER 1', 'ELIMINATOR 2', 'QUALIFIER 2', 'FINALS',
      // Groups mode
      'SEMI-FINAL 1', 'SEMI-FINAL 2', 'FINAL',
      // World Cup mode
      'WORLD CUP ROUND-ROBIN', 'WORLD CUP SEMI-FINAL 1', 'WORLD CUP SEMI-FINAL 2', 'WORLD CUP FINAL'
    ]
  },
  team1: {
    type: String,
    required: true
  },
  team2: {
    type: String,
    required: true
  },
  team1UserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  team2UserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  description: {
    type: String,
    default: null
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
  winnerUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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
  },
  headToHeadSynced: { type: Boolean, default: false }
}, {
  timestamps: true
});

module.exports = mongoose.model('PlayoffFixture', playoffFixtureSchema);
