const mongoose = require("mongoose");

const UserPlayerSchema = new mongoose.Schema({
  playerId: { type: mongoose.Schema.Types.ObjectId, ref: "Player", required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  bidValue: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true }, // Admin field added
});

// Add compound indexes for better performance
UserPlayerSchema.index({ playerId: 1, isActive: 1 });
UserPlayerSchema.index({ userId: 1, isActive: 1 });
UserPlayerSchema.index({ isActive: 1 });

module.exports = mongoose.model("UserPlayer", UserPlayerSchema);
