const mongoose = require('mongoose');

const scheduleSchema = new mongoose.Schema({
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

module.exports = mongoose.model('Schedule', scheduleSchema);
