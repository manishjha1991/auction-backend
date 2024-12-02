const mongoose = require('mongoose');

const PlayerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  role: { type: String, required: true },
  style: { type: String, required: true },
  basePrice: { type: Number, required: true },
  type: { type: String, enum: ['Gold', 'Silver', 'Emerald', 'Sapphire'], required: true },
  image: { type: String, required: true }, // Path to uploaded image
  currentBid: { type: Number, default: 0 },
  currentBidder: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  sold: { type: Boolean, default: false },
});

module.exports = mongoose.model('Player', PlayerSchema);
