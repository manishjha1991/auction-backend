const mongoose = require('mongoose');

const PlayoffSubmissionSchema = new mongoose.Schema(
  {
    matchId: {
      type: String,
      required: true,
    },
    stage: { type: String, default: '' },
    /** When set, approval writes Tournament.tournamentFixtures instead of PlayoffFixture */
    isWorldCupTournament: { type: Boolean, default: false },
    tournamentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament',
      default: null,
    },
    fixtureIndex: { type: Number, default: null },
    tournamentName: { type: String, default: '' },
    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    submitterName: { type: String, default: '' },
    submitterTeamName: { type: String, default: '' },

    team1: { type: String, required: true },
    team2: { type: String, required: true },
    winner: { type: String, default: null },
    winnerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    margin: { type: String, default: null },
    team1Score: { type: String, default: null },
    team2Score: { type: String, default: null },
    team1Overs: { type: String, default: null },
    team2Overs: { type: String, default: null },
    mom: {
      name: { type: String, default: null },
      score: { type: Number, default: null },
      wickets: { type: Number, default: null },
    },
    team1Fairness: { type: Number, default: 0 },
    team2Fairness: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
    },
    adminDecision: {
      status: { type: String, enum: ['approved', 'rejected'] },
      decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      decidedAt: { type: Date },
      decidedByRole: { type: String, enum: ['admin', 'opponent'], default: 'admin' },
      note: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

PlayoffSubmissionSchema.index({ status: 1, createdAt: -1 });
PlayoffSubmissionSchema.index({ submittedBy: 1, createdAt: -1 });
PlayoffSubmissionSchema.index({ matchId: 1, status: 1 });

module.exports = mongoose.model('PlayoffSubmission', PlayoffSubmissionSchema);
