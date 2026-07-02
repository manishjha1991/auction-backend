const mongoose = require('mongoose');

const playerTeamTournamentStatSchema = new mongoose.Schema(
  {
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    playerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Player',
      required: true,
      index: true,
    },
    tournamentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament',
      default: null,
      index: true,
    },
    tournamentKey: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    totalRuns: { type: Number, default: 0 },
    totalWickets: { type: Number, default: 0 },
    totalMom: { type: Number, default: 0 },
    matches: { type: Number, default: 0 },
    sourcePlayerStatsId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PlayerStats',
      default: null,
      index: true,
    },
    sourceDatabase: { type: String, default: null, trim: true },
  },
  { timestamps: true }
);

playerTeamTournamentStatSchema.index(
  { teamId: 1, playerId: 1, tournamentKey: 1 },
  { unique: true }
);
playerTeamTournamentStatSchema.index({ playerId: 1, totalRuns: -1 });
playerTeamTournamentStatSchema.index({ playerId: 1, totalWickets: -1 });

module.exports = mongoose.model('PlayerTeamTournamentStat', playerTeamTournamentStatSchema);
