const mongoose = require('mongoose');

/**
 * VenueMatchEntry
 *
 * Persistent, append-only ledger of every player contribution that has
 * been recorded with a venue. PlayerStats is wiped at the end of each
 * tournament/season, so we cannot rely on it for long-term venue
 * analytics ("most runs scored at MCG", "wickets fallen at Eden", etc.).
 *
 * One document per (player save event). Whenever savePlayerStatsEntry
 * persists a new or updated PlayerStats row that has a venue, we upsert
 * the equivalent row here keyed by `sourcePlayerStatsId` so re-saves
 * within the same season do NOT create duplicates. When the tournament
 * ends and PlayerStats is wiped, these rows survive untouched and keep
 * powering `/venue-aggregate` going forward.
 */
const battingBlock = new mongoose.Schema(
  {
    runs: { type: Number, default: 0 },
    balls: { type: Number, default: 0 },
  },
  { _id: false }
);

const bowlingBlock = new mongoose.Schema(
  {
    wickets: { type: Number, default: 0 },
    runsGiven: { type: Number, default: 0 },
    ballsBowled: { type: Number, default: 0 },
  },
  { _id: false }
);

const venueMatchEntrySchema = new mongoose.Schema(
  {
    playerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Player',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    opponentUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    venue: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    tournamentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tournament',
      default: null,
      index: true,
    },
    /**
     * Stable identifier shared by every player save belonging to the
     * SAME real-world match. Used by /venue-aggregate to count distinct
     * matches at a venue (not distinct player-innings rows).
     *
     * Format from OCR Extractor:  `${matchKeyBase}-${timestamp}`
     * For older rows missing this, the migration script synthesises it
     * from (venue + createdAt minute-bucket + sorted team pair).
     */
    matchId: { type: String, default: null, index: true },
    /** 1 = this userId’s team batted first in the match, 2 = second; null if unknown. */
    teamInningsOrder: { type: Number, default: null, min: 1, max: 2 },

    isPlayoffScore: { type: Boolean, default: false },
    isWcScore: { type: Boolean, default: false },
    /** Mirrored from PlayerStats.isMom for venue leaderboards (MoM count per ground). */
    isMom: { type: Boolean, default: false },
    wcStage: {
      type: String,
      enum: ['super8', 'semi', 'final', null],
      default: null,
    },

    battingStats: { type: battingBlock, default: () => ({}) },
    bowlingStats: { type: bowlingBlock, default: () => ({}) },

    /**
     * Traceability link to the PlayerStats row at the time of recording.
     * Used as the upsert key so that re-saves within the same season
     * overwrite the same ledger row instead of duplicating it. The
     * referenced PlayerStats document may be deleted later (tournament
     * reset) — that is expected and the ledger entry remains.
     */
    sourcePlayerStatsId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
      index: true,
    },
  },
  { timestamps: true } // createdAt / updatedAt — that's our recording time.
);

// Common analytics queries — group by venue, optionally scoped to a user / tournament.
venueMatchEntrySchema.index({ venue: 1, createdAt: -1 });
venueMatchEntrySchema.index({ userId: 1, venue: 1 });
venueMatchEntrySchema.index({ tournamentId: 1, venue: 1, playerId: 1 });
// Tournament drill-down: one venue, all players.
venueMatchEntrySchema.index({ venue: 1, playerId: 1 });
// Per-user squad breakdown: $match userId then $group by venue + playerId.
venueMatchEntrySchema.index({ userId: 1, venue: 1, playerId: 1 });
// Match card: team totals + batting order per match.
venueMatchEntrySchema.index({ matchId: 1, userId: 1 });

module.exports = mongoose.model('VenueMatchEntry', venueMatchEntrySchema);
