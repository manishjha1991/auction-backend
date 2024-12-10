const mongoose = require("mongoose");

const UserPlayerSchema = new mongoose.Schema({
  playerId: { type: mongoose.Schema.Types.ObjectId, ref: "Player", required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  bidValue: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true }, // Admin field added
});

module.exports = mongoose.model("UserPlayer", UserPlayerSchema);
