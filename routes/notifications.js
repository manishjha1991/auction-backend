const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const Schedule = require('../models/Schedule');

// Get pending notifications for a user
router.get('/pending', async (req, res) => {
  try {
    // Get team name from query parameter
    const { teamName } = req.query;
    
    if (!teamName) {
      return res.status(400).json({ message: 'Team name is required' });
    }

    const notifications = await Notification.find({
      recipient: teamName,
      isActive: true,
      isRead: false
    }).populate('scheduleId').sort({ createdAt: -1 });
    
    // Ensure scheduleId is populated or use metadata as fallback
    const processedNotifications = notifications.map(notification => {
      if (!notification.scheduleId && notification.metadata) {
        // Create a mock scheduleId object from metadata
        notification.scheduleId = {
          date: notification.metadata.date,
          time: notification.metadata.time,
          timezone: notification.metadata.timezone,
          newTimeSlot: notification.metadata.newTimeSlot,
          requester: notification.sender,
          opponent: notification.recipient,
          status: 'pending'
        };
      } else if (notification.scheduleId && notification.metadata?.newTimeSlot) {
        // Ensure newTimeSlot is included in scheduleId
        notification.scheduleId.newTimeSlot = notification.metadata.newTimeSlot;
      }
      return notification;
    });
    
    res.json(processedNotifications);
  } catch (error) {
    console.error('Error fetching pending notifications:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get all notifications for a user
router.get('/', async (req, res) => {
  try {
    // For now, return empty array since we don't have auth middleware
    const notifications = [];
    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Accept a notification (match invitation or new time slot)
router.post('/:id/accept', async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    // Update the schedule
    const schedule = await Schedule.findById(notification.scheduleId);
    if (schedule) {
      if (notification.type === 'new_time_slot') {
        // Accepting new time slot - update the time and set as accepted
        schedule.time = schedule.newTimeSlot;
        schedule.newTimeSlot = null;
        schedule.status = 'accepted';
      } else {
        // Accepting original invitation
        schedule.status = 'accepted';
      }
      await schedule.save();
    }

    // Only create acceptance notification for original match invitations, not for new time slots
    if (notification.type === 'match_invitation') {
      const acceptanceNotification = new Notification({
        recipient: notification.sender,
        sender: notification.recipient,
        type: 'match_accepted',
        scheduleId: notification.scheduleId,
        title: 'Match Accepted',
        message: `${notification.recipient} has accepted your match invitation`,
        metadata: notification.metadata
      });

      await acceptanceNotification.save();
    }

    // Mark original notification as read and inactive
    notification.isRead = true;
    notification.isActive = false;
    await notification.save();

    // Also deactivate ALL other notifications for this schedule to prevent multiple notifications
    await Notification.updateMany(
      { scheduleId: notification.scheduleId, _id: { $ne: notification._id } },
      { isActive: false, isRead: true }
    );

    res.json({ message: 'Notification accepted successfully' });
  } catch (error) {
    console.error('Error accepting notification:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Reject a notification with new time slot
router.post('/:id/reject', async (req, res) => {
  try {
    const { newTimeSlot } = req.body;
    console.log('Rejecting notification:', req.params.id, 'with new time:', newTimeSlot);
    
    const notification = await Notification.findById(req.params.id);
    
    if (!notification) {
      console.log('Notification not found:', req.params.id);
      return res.status(404).json({ message: 'Notification not found' });
    }
    
    console.log('Found notification:', notification.type, 'for schedule:', notification.scheduleId);

    // Update the schedule
    const schedule = await Schedule.findById(notification.scheduleId);
    if (schedule) {
      if (notification.type === 'new_time_slot') {
        // Rejecting new time slot - allow the person to propose their own new time
        schedule.status = 'rejected';
        schedule.newTimeSlot = newTimeSlot; // Set the new time slot proposed by the rejector
        await schedule.save();

        // Create notification back to the person who originally proposed the time
        const rejectionNotification = new Notification({
          recipient: notification.sender, // The person who originally proposed the time
          sender: notification.recipient, // The person who rejected it and proposed new time
          type: 'new_time_slot',
          scheduleId: notification.scheduleId,
          title: 'New Time Slot Suggested',
          message: `${notification.recipient} has suggested a new time slot: ${newTimeSlot}`,
          metadata: {
            ...notification.metadata,
            newTimeSlot,
            originalTime: schedule.time,
            previousRejectedTime: notification.metadata?.newTimeSlot
          }
        });

        await rejectionNotification.save();
      } else {
        // Rejecting original invitation - propose new time
        schedule.status = 'rejected';
        schedule.newTimeSlot = newTimeSlot;
        await schedule.save();

        // Create rejection notification for sender with new time slot
        const rejectionNotification = new Notification({
          recipient: notification.sender,
          sender: notification.recipient,
          type: 'new_time_slot',
          scheduleId: notification.scheduleId,
          title: 'New Time Slot Suggested',
          message: `${notification.recipient} has suggested a new time slot: ${newTimeSlot}`,
          metadata: {
            ...notification.metadata,
            newTimeSlot
          }
        });

        await rejectionNotification.save();
      }
    }

    // Mark original notification as read and inactive
    notification.isRead = true;
    notification.isActive = false;
    await notification.save();

    console.log('Notification rejected successfully');
    res.json({ message: 'Notification rejected successfully' });
  } catch (error) {
    console.error('Error rejecting notification:', error);
    console.error('Error details:', error.message, error.stack);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Mark notification as read
router.put('/:id/read', async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    notification.isRead = true;
    await notification.save();

    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete notification
router.delete('/:id', async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    await Notification.findByIdAndDelete(req.params.id);

    res.json({ message: 'Notification deleted successfully' });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;