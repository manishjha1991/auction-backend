const mongoose = require('mongoose');

const TournamentSchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: true,
    trim: true 
  },
  description: { 
    type: String, 
    default: '' 
  },
  startDate: { 
    type: Date, 
    required: true 
  },
  endDate: { 
    type: Date, 
    required: true 
  },
  maxSlots: { 
    type: Number, 
    required: true, 
    min: 1, 
    max: 20 
  },
  status: { 
    type: String, 
    enum: ['upcoming', 'running', 'completed'], 
    default: 'upcoming' 
  },
  tournamentImage: { 
    type: String, 
    default: null 
  },
  subscribedTeams: [{
    userId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User',
      required: true 
    },
    teamName: { 
      type: String, 
      required: true 
    },
    teamImage: { 
      type: String, 
      default: null 
    },
    subscribedAt: { 
      type: Date, 
      default: Date.now 
    }
  }],
  createdBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    required: true 
  },
  isActive: { 
    type: Boolean, 
    default: true 
  },
  isLocked: { 
    type: Boolean, 
    default: false 
  },
  tournamentFixtures: [{
    // Team names (kept for backward compatibility and display)
    team1: { type: String, required: true },
    team2: { type: String, required: true },
    
    // User IDs (new - for referential integrity)
    team1UserId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User', 
      required: false // Not required initially for backward compatibility
    },
    team2UserId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User', 
      required: false // Not required initially for backward compatibility
    },
    
    winner: { type: String, default: null },
    winnerUserId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: 'User', 
      default: null 
    },
    margin: { type: String, default: null },
    team1Score: { type: String, default: null },
    team2Score: { type: String, default: null },
    team1Fairness: { type: Number, default: 0 },
    team2Fairness: { type: Number, default: 0 },
    mom: {
      name: { type: String, default: null },
      score: { type: Number, default: null },
      wickets: { type: Number, default: null }
    },
    createdAt: { type: Date, default: Date.now }
  }],
  pointTable: [{
    teamName: { type: String, required: true },
    matches: { type: Number, default: 0 },
    won: { type: Number, default: 0 },
    lost: { type: Number, default: 0 },
    points: { type: Number, default: 0 },
    fairness: { type: Number, default: 0 },
    nrr: { type: Number, default: 0 }
  }],
  winner: {
    teamName: { type: String, default: null },
    teamImage: { type: String, default: null },
    wonAt: { type: Date, default: null }
  }
}, {
  timestamps: true
});

// Indexes for better performance
TournamentSchema.index({ status: 1, startDate: 1 });
TournamentSchema.index({ 'subscribedTeams.userId': 1 });
TournamentSchema.index({ isActive: 1 });

// Virtual for slots left
TournamentSchema.virtual('slotsLeft').get(function() {
  return this.maxSlots - this.subscribedTeams.length;
});

// Virtual for subscription count
TournamentSchema.virtual('subscriptionCount').get(function() {
  return this.subscribedTeams.length;
});

// Method to check if user is subscribed
TournamentSchema.methods.isUserSubscribed = function(userId) {
  return this.subscribedTeams.some(team => team.userId.toString() === userId.toString());
};

// Method to subscribe user to tournament
TournamentSchema.methods.subscribeUser = function(userId, teamName, teamImage) {
  if (this.subscribedTeams.length >= this.maxSlots) {
    throw new Error('Tournament is full');
  }
  
  if (this.isUserSubscribed(userId)) {
    throw new Error('User already subscribed to this tournament');
  }
  
  this.subscribedTeams.push({
    userId,
    teamName,
    teamImage,
    subscribedAt: new Date()
  });
  
  return this.save();
};

// Method to unsubscribe user from tournament
TournamentSchema.methods.unsubscribeUser = function(userId) {
  if (this.isLocked) {
    throw new Error('Cannot withdraw from locked tournament');
  }
  
  this.subscribedTeams = this.subscribedTeams.filter(
    team => team.userId.toString() !== userId.toString()
  );
  
  return this.save();
};

// Method to remove team subscription (admin only)
TournamentSchema.methods.removeTeamSubscription = function(userId) {
  this.subscribedTeams = this.subscribedTeams.filter(
    team => team.userId.toString() !== userId.toString()
  );
  
  return this.save();
};

// Method to lock/unlock tournament (admin only)
TournamentSchema.methods.toggleLock = function() {
  this.isLocked = !this.isLocked;
  return this.save();
};

// Pre-save middleware to update status based on dates
TournamentSchema.pre('save', function(next) {
  const now = new Date();
  
  if (this.startDate <= now && this.endDate >= now) {
    this.status = 'running';
  } else if (this.endDate < now) {
    this.status = 'completed';
  } else {
    this.status = 'upcoming';
  }
  
  next();
});

// Ensure virtual fields are serialized
TournamentSchema.set('toJSON', { virtuals: true });
TournamentSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Tournament', TournamentSchema);
