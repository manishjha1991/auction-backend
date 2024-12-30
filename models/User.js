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
  points: { type: Number, default: 0 }, // Store total points
  matchesPlayed: { type: Number, default: 0 }, // Store total matches played
});

module.exports = mongoose.model('User', UserSchema);
