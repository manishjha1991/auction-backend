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
  currentBid: {
    playerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' },
    amount: Number,
  },
  isAdmin: { type: Boolean, default: false }, // Admin field added
});
// UserSchema.pre('save', async function (next) {
//   if (!this.isModified('password')) return next();
//   this.password = await bcrypt.hash(this.password, 10);
//   next();
// });
module.exports = mongoose.model('User', UserSchema);
