const mongoose = require('mongoose');

const scheduleSchema = new mongoose.Schema({
  tournamentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Tournament',
    default: null,
    index: true
  },
  requester: {
    type: String,
    required: true
  },
  opponent: {
    type: String,
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  time: {
    type: String,
    required: true
  },
  timezone: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected'],
    default: 'pending'
  },
  newTimeSlot: {
    type: String,
    default: null
  },
  newDate: {
    type: Date,
    default: null
  },
  newTimezone: {
    type: String,
    default: null
  },
  message: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

scheduleSchema.index({ tournamentId: 1, status: 1, date: 1 });
scheduleSchema.index({ tournamentId: 1, requester: 1, opponent: 1 });

module.exports = mongoose.model('Schedule', scheduleSchema);
