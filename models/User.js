const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  teamName: { type: String },
  teamImage: { type: String },
  purse: { type: mongoose.Schema.Types.Decimal128, default: 1000000000 },
  boughtPlayers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }],
  currentBids: [
    {
      playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' },
      amount: Number,
    },
  ], // Array to track bids on up to 4 players
  isAdmin: { type: Boolean, default: false },
  tradesUsed: { type: Number, default: 0 },
  points: { type: Number, default: 0 }, // Store total points
  matchesPlayed: { type: Number, default: 0 }, // Store total matches played
  fairnessPoint:{ type: Number, default: 0 },
  isActive:{ type: Boolean, default: true },
  abbreviation: { type: String, default: null },
  group: { type: String, enum: ['A', 'B', null], default: null },
  isLocked: { type: Boolean, default: false },
  isTournamentReady: { type: Boolean, default: false }, // NEW: Only true when user is ready for tournament
  timezone: { type: String, default: 'Asia/Kolkata' }, // User's preferred timezone
  streamLink: { type: String, default: null }, // User's streaming URL
  
  // Team showcase fields
  captain: { type: String, default: null }, // Captain player name
  viceCaptain: { type: String, default: null }, // Vice-captain player name
  teamColor: { type: String, default: '#3B82F6' }, // Team primary color
  teamBrief: { type: String, default: 'A formidable team ready to conquer the tournament!' }, // 2-line team description
  trophiesWon: { type: Number, default: 0 }, // Number of trophies won
  teamMotto: { type: String, default: 'Victory through Unity' }, // Team motto
});

module.exports = mongoose.model('User', UserSchema);
