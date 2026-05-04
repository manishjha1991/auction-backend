const express = require('express');
const router = express.Router();
const Schedule = require('../models/Schedule');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { getTournamentIdFromRequest, withTournamentFilter } = require('../utils/tournamentScope');

// Get all teams for dropdown
router.get('/teams', async (req, res) => {
  try {
    const teams = await User.find({}, 'teamName timezone').sort({ teamName: 1 });
    res.json({ teams: teams.map(user => ({ _id: user._id, teamName: user.teamName, timezone: user.timezone })) });
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all schedules for a user
router.get('/', async (req, res) => {
  try {
    const tournamentId = getTournamentIdFromRequest(req);
    // Get team name from query parameter
    const { teamName } = req.query;
    
    if (!teamName) {
      return res.status(400).json({ message: 'Team name is required' });
    }

    const schedules = await Schedule.find(withTournamentFilter({
      $or: [
        { requester: teamName },
        { opponent: teamName }
      ]
    }, tournamentId)).sort({ createdAt: -1 });
    
    res.json(schedules);
  } catch (error) {
    console.error('Error fetching schedules:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a new schedule
router.post('/', async (req, res) => {
  try {
    const tournamentId = getTournamentIdFromRequest(req);
    const { opponent, date, time, timezone, requester } = req.body;
    
    // For now, use requester from request body since we don't have auth middleware
    if (!requester) {
      return res.status(400).json({ message: 'Requester team name is required' });
    }

    // Check if opponent exists
    const opponentTeam = await User.findOne({ teamName: opponent });
    if (!opponentTeam) {
      return res.status(400).json({ message: 'Opponent team not found' });
    }

    // Create schedule
    const schedule = new Schedule({
      tournamentId: tournamentId || null,
      requester: requester,
      opponent,
      date: new Date(date),
      time,
      timezone,
      status: 'pending'
    });

    await schedule.save();

    // Create notification for opponent
    const notification = new Notification({
      recipient: opponent,
      sender: requester,
      type: 'match_invitation',
      scheduleId: schedule._id,
      title: 'Match Invitation',
      message: `${requester} has invited you for a match`,
      metadata: {
        opponent: requester,
        date: new Date(date),
        time,
        timezone
      }
    });

    await notification.save();

    res.status(201).json({ 
      message: 'Schedule created successfully',
      schedule,
      notification
    });
  } catch (error) {
    console.error('Error creating schedule:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Accept a schedule
router.post('/:id/accept', async (req, res) => {
  try {
    const tournamentId = getTournamentIdFromRequest(req);
    const schedule = await Schedule.findOne(withTournamentFilter({ _id: req.params.id }, tournamentId));
    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }

    schedule.status = 'accepted';
    await schedule.save();

    // Create notification for requester
    const notification = new Notification({
      recipient: schedule.requester,
      sender: schedule.opponent,
      type: 'match_accepted',
      scheduleId: schedule._id,
      title: 'Match Accepted',
      message: `${schedule.opponent} has accepted your match invitation`,
      metadata: {
        opponent: schedule.opponent,
        date: schedule.date,
        time: schedule.time,
        timezone: schedule.timezone
      }
    });

    await notification.save();

    // Deactivate ALL notifications for this schedule to prevent multiple notifications
    await Notification.updateMany(
      { scheduleId: schedule._id },
      { isActive: false, isRead: true }
    );

    res.json({ message: 'Schedule accepted successfully' });
  } catch (error) {
    console.error('Error accepting schedule:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Reject a schedule with new time slot
router.post('/:id/reject', async (req, res) => {
  try {
    const tournamentId = getTournamentIdFromRequest(req);
    const { newTimeSlot, newDate, newTimezone } = req.body;
    const schedule = await Schedule.findOne(withTournamentFilter({ _id: req.params.id }, tournamentId));
    
    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }

    schedule.status = 'rejected';
    schedule.newTimeSlot = newTimeSlot;
    if (newDate) {
      schedule.newDate = new Date(newDate);
    }
    if (newTimezone) {
      schedule.newTimezone = newTimezone;
    }
    await schedule.save();

    // Create notification for requester with new time slot
    const notification = new Notification({
      recipient: schedule.requester,
      sender: schedule.opponent,
      type: 'new_time_slot',
      scheduleId: schedule._id,
      title: 'New Time Slot Suggested',
      message: `${schedule.opponent} has suggested a new time slot: ${newTimeSlot}`,
      metadata: {
        opponent: schedule.opponent,
        date: schedule.date,
        time: schedule.time,
        timezone: schedule.timezone,
        newTimeSlot,
        newDate: newDate ? new Date(newDate) : null,
        newTimezone: newTimezone || schedule.timezone
      }
    });

    await notification.save();

    // Deactivate the original notification
    await Notification.updateMany(
      { scheduleId: schedule._id, type: 'match_invitation' },
      { isActive: false }
    );

    res.json({ message: 'Schedule rejected with new time slot' });
  } catch (error) {
    console.error('Error rejecting schedule:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update schedule with new time slot
router.put('/:id/update-time', async (req, res) => {
  try {
    const tournamentId = getTournamentIdFromRequest(req);
    const { newTime, newDate } = req.body;
    const schedule = await Schedule.findOne(withTournamentFilter({ _id: req.params.id }, tournamentId));
    
    if (!schedule) {
      return res.status(404).json({ message: 'Schedule not found' });
    }

    schedule.time = newTime;
    if (newDate) {
      schedule.date = new Date(newDate);
    }
    schedule.status = 'pending';
    schedule.newTimeSlot = null;
    await schedule.save();

    // Create new notification for opponent
    const notification = new Notification({
      recipient: schedule.opponent,
      sender: schedule.requester,
      type: 'match_invitation',
      scheduleId: schedule._id,
      title: 'Updated Match Invitation',
      message: `${schedule.requester} has updated the match time`,
      metadata: {
        opponent: schedule.requester,
        date: schedule.date,
        time: schedule.time,
        timezone: schedule.timezone
      }
    });

    await notification.save();

    res.json({ message: 'Schedule updated successfully' });
  } catch (error) {
    console.error('Error updating schedule:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
