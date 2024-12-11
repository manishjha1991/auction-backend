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
  },
  isMom: {
    type: Boolean,
    default: false, // Default value is false
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const PlayerStats = mongoose.model('PlayerStats', playerStatsSchema);

module.exports = PlayerStats;
