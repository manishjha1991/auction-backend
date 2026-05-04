const mongoose = require('mongoose');

const matchResultSchema = new mongoose.Schema({
  tournamentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tournament',
    default: null,
    index: true
  },
  matchNumber: {
    type: String,
    required: true
  },
  matchTitle: {
    type: String,
    required: true
  },
  team1: {
    type: String,
    required: true
  },
  team2: {
    type: String,
    required: true
  },
  winner: {
    type: String,
    required: true,
    enum: ['team1', 'team2', 'tie', 'no_result']
  },
  team1Score: {
    type: Number,
    required: true,
    min: 0
  },
  team2Score: {
    type: Number,
    required: true,
    min: 0
  },
  team1Wickets: {
    type: Number,
    default: 0,
    min: 0,
    max: 10
  },
  team2Wickets: {
    type: Number,
    default: 0,
    min: 0,
    max: 10
  },
  team1Overs: {
    type: Number,
    default: 0,
    min: 0
  },
  team2Overs: {
    type: Number,
    default: 0,
    min: 0
  },
  matchDate: {
    type: Date,
    required: true
  },
  matchVenue: {
    type: String,
    required: true
  },
  manOfTheMatch: {
    name: {
      type: String,
      required: true
    },
    playerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Player',
      required: false
    },
    team: {
      type: String,
      required: true
    },
    runs: {
      type: Number,
      default: 0,
      min: 0
    },
    wickets: {
      type: Number,
      default: 0,
      min: 0
    },
    balls: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  trophyName: {
    type: String,
    required: true
  },
  trophyType: {
    type: String,
    enum: ['league', 'playoff', 'final', 'semi_final', 'quarter_final'],
    default: 'league'
  },
  matchType: {
    type: String,
    enum: ['normal', 'playoff', 'final'],
    default: 'normal'
  },
  margin: {
    type: String,
    required: true
  },
  matchStatus: {
    type: String,
    enum: ['completed', 'abandoned', 'cancelled'],
    default: 'completed'
  },
  additionalNotes: {
    type: String,
    default: ''
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  headToHeadSynced: { type: Boolean, default: false } // True once win/loss has been added to TeamHeadToHead
});

// Update the updatedAt field before saving
matchResultSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Virtual for match result summary
matchResultSchema.virtual('resultSummary').get(function() {
  if (this.winner === 'tie') {
    return `Match tied - ${this.team1} vs ${this.team2}`;
  } else if (this.winner === 'no_result') {
    return `No result - ${this.team1} vs ${this.team2}`;
  } else {
    const winningTeam = this.winner === 'team1' ? this.team1 : this.team2;
    const winningScore = this.winner === 'team1' ? this.team1Score : this.team2Score;
    const losingScore = this.winner === 'team1' ? this.team2Score : this.team1Score;
    return `${winningTeam} won by ${this.margin} (${winningScore}/${losingScore})`;
  }
});

// Virtual for MoM summary
matchResultSchema.virtual('momSummary').get(function() {
  const mom = this.manOfTheMatch;
  let summary = `${mom.name} (${mom.team})`;
  if (mom.runs > 0) {
    summary += ` - ${mom.runs} runs`;
  }
  if (mom.wickets > 0) {
    summary += `, ${mom.wickets} wickets`;
  }
  return summary;
});

// One tournament can reuse match numbers from another tournament.
// Apply uniqueness only when tournamentId is present (backward compatible for legacy docs).
matchResultSchema.index(
  { tournamentId: 1, matchNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { tournamentId: { $type: 'objectId' } },
    name: 'unique_match_number_per_tournament'
  }
);
matchResultSchema.index({ matchNumber: 1 });
matchResultSchema.index({ tournamentId: 1, matchDate: -1 });

module.exports = mongoose.model('MatchResult', matchResultSchema);
