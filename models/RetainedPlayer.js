const mongoose = require('mongoose');

const RetainedPlayerSchema = new mongoose.Schema({
  playerId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Player', 
    required: true 
  },
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  retainedValue: { 
    type: Number, 
    required: true,
    default: 170000000 // 17 crores in paise
  },
  playerType: { 
    type: String, 
    enum: ["Emerald", "Silver", "Gold", "Sapphire"], 
    required: true 
  },
  playerName: { 
    type: String, 
    required: true 
  },
  playerRole: { 
    type: String, 
    enum: ["Batsman", "Bowler", "Allrounder", "WicketKeeper"], 
    required: true 
  },
  retainedAt: { 
    type: Date, 
    default: Date.now 
  },
  isActive: { 
    type: Boolean, 
    default: true 
  },
  status: {
    type: String,
    enum: ['active', 'withdrawn', 'approved', 'rejected'],
    default: 'active'
  },
  withdrawnAt: {
    type: Date
  }
});

// Add compound indexes for better performance
RetainedPlayerSchema.index({ userId: 1, isActive: 1 });
RetainedPlayerSchema.index({ playerId: 1, isActive: 1 });
RetainedPlayerSchema.index({ userId: 1, playerType: 1 });

// One active retention per player and per category. Double-submit / retry
// used to insert a second row and deduct 17 Cr again.
RetainedPlayerSchema.index(
  { userId: 1, playerId: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true },
    name: 'uniq_active_retention_per_player',
  }
);
RetainedPlayerSchema.index(
  { userId: 1, playerType: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true },
    name: 'uniq_active_retention_per_type',
  }
);

module.exports = mongoose.model('RetainedPlayer', RetainedPlayerSchema);

