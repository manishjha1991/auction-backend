const mongoose = require('mongoose');

const playerStatsSchema = new mongoose.Schema({
  playerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Player', // Reference to Player collection
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Reference to User collection (Who is adding the stats)
    required: true,
  },
  opponentUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User', // Reference to User collection (Opponent team user ID)
    required: true,
  },
  tournamentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tournament',
    default: null,
    index: true,
  },
  venue: {
    type: String,
    default: null,
    trim: true,
    index: true,
  },
  /**
   * Which team innings this side batted in the match (T20: 1 = first dig, 2 = second).
   * Set from scorecard entry (e.g. OCR). Null when unknown or legacy rows.
   */
  teamInningsOrder: {
    type: Number,
    default: null,
    min: 1,
    max: 2,
  },
  battingStats: {
    runs: {
      type: Number,
      required: false, // Optional, can be null if no batting stats
    },
    balls: {
      type: Number,
      required: false,
    },
  },
  bowlingStats: {
    runsGiven: {
      type: Number,
      required: false, // Optional, can be null if no bowling stats
    },
    ballsBowled: {
      type: Number,
      required: false,
    },
    wickets: {
      type: Number,
      required: false,
      default: 0,
    },
  },
  isMom: {
    type: Boolean,
    default: false, // Default value is false
  },
  metadata: {
    economy: {
      type: Number,
      required: false,
    },
    extras: {
      type: Number,
      required: false,
    },
    isPlayoffScore: {
      type: Boolean,
      default: false,
    },
    isWcScore: {
      type: Boolean,
      default: false,
    },
    wcStage: {
      type: String,
      enum: ['super8', 'semi', 'final', null],
      default: null,
    },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const PlayerStats = mongoose.model('PlayerStats', playerStatsSchema);

module.exports = PlayerStats;
