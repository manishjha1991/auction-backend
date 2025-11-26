const express = require('express');
const router = express.Router();
const RetainedPlayer = require('../models/RetainedPlayer');
const User = require('../models/User');
const Player = require('../models/Player');
const UserPlayer = require('../models/UserPlayer');
const Bid = require('../models/Bid');
const BidHistory = require('../models/BidHistory');
const Notification = require('../models/Notification');
const Fixture = require('../models/Fixture');
const Comment = require('../models/Comment');
const PickRequest = require('../models/PickRequest');
const PlayerStats = require('../models/PlayerStats');
const PlayoffFixture = require('../models/PlayoffFixture');
const PostLike = require('../models/PostLike');
const ReleaseRequest = require('../models/ReleaseRequest');
const Schedule = require('../models/Schedule');
const TradeRequest = require('../models/TradeRequest');
const AppSettings = require('../models/AppSettings');

// Helper function to get original base price based on player type
const getOriginalBasePrice = (playerType) => {
  switch (playerType) {
    case 'Silver':
      return 1000000; // 10 lakh (1,000,000)
    case 'Gold':
      return 10000000; // 1 Cr (10,000,000)
    case 'Sapphire':
      return 20000000; // 2 Cr (20,000,000)
    case 'Emerald':
      return 15000000; // 1.5 Cr (15,000,000)
    default:
      return 1000000; // Default to 10 lakh
  }
};

// NEW: Fix all player base prices to correct values
router.post('/fix-base-prices', async (req, res) => {
  try {
    console.log('🔧 Starting comprehensive base price fix...');
    
    // Get all players
    const players = await Player.find({});
    let playerUpdates = [];
    let userPlayerUpdates = [];
    let updatedPlayers = 0;
    let updatedUserPlayers = 0;
    
    for (const player of players) {
      const correctBasePrice = getOriginalBasePrice(player.type);
      
      // Update Player basePrice if needed
      if (player.basePrice !== correctBasePrice) {
        console.log(`Updating Player ${player.name} (${player.type}): ${player.basePrice} → ${correctBasePrice}`);
        
        playerUpdates.push({
          updateOne: {
            filter: { _id: player._id },
            update: { 
              $set: { 
                basePrice: correctBasePrice,
                currentBid: correctBasePrice
              }
            }
          }
        });
        updatedPlayers++;
      }
    }
    
    // Update UserPlayer bidValue for sold players
    const userPlayers = await UserPlayer.find({ isActive: true }).populate('playerId');
    for (const userPlayer of userPlayers) {
      if (userPlayer.playerId) {
        const correctBasePrice = getOriginalBasePrice(userPlayer.playerId.type);
        
        if (userPlayer.bidValue !== correctBasePrice) {
          console.log(`Updating UserPlayer ${userPlayer.playerId.name} (${userPlayer.playerId.type}): ${userPlayer.bidValue} → ${correctBasePrice}`);
          
          userPlayerUpdates.push({
            updateOne: {
              filter: { _id: userPlayer._id },
              update: { 
                $set: { 
                  bidValue: correctBasePrice
                }
              }
            }
          });
          updatedUserPlayers++;
        }
      }
    }
    
    // Execute bulk updates
    if (playerUpdates.length > 0) {
      await Player.bulkWrite(playerUpdates);
      console.log(`✅ Updated ${updatedPlayers} players`);
    }
    
    if (userPlayerUpdates.length > 0) {
      await UserPlayer.bulkWrite(userPlayerUpdates);
      console.log(`✅ Updated ${updatedUserPlayers} user players`);
    }
    
    res.json({
      message: `Successfully fixed base prices for ${updatedPlayers} players and ${updatedUserPlayers} user players`,
      updatedPlayers,
      updatedUserPlayers,
      totalUpdated: updatedPlayers + updatedUserPlayers,
      correctPrices: {
        Silver: '10 lakh (1,000,000)',
        Gold: '1 Cr (10,000,000)',
        Sapphire: '2 Cr (20,000,000)',
        Emerald: '1.5 Cr (15,000,000)'
      }
    });
  } catch (error) {
    console.error('Error fixing base prices:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Retain a player
router.post('/retain', async (req, res) => {
  try {
    const { userId, playerId } = req.body;
    
    if (!userId || !playerId) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Check if player retention is enabled
    const settings = await AppSettings.findOne();
    if (!settings || !settings.enablePlayerRetention) {
      return res.status(403).json({ message: 'Player retention feature is currently disabled by admin' });
    }

    // Check if user exists and is active
    const user = await User.findById(userId).includeInactive();
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (!user.isActive) {
      return res.status(403).json({ message: 'User account is inactive. Cannot retain players.' });
    }

    // Check if user retention is locked
    if (user.isRetentionLocked) {
      return res.status(403).json({ message: 'Your team retention is locked by admin. You cannot retain players.' });
    }

    // Check if player exists and is sold to this user
    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ message: 'Player not found' });
    }

    // Check if user owns this player
    const userPlayer = await UserPlayer.findOne({ 
      userId, 
      playerId, 
      isActive: true 
    });
    if (!userPlayer) {
      return res.status(400).json({ message: 'You do not own this player' });
    }

    // Check if player is already retained
    const existingRetained = await RetainedPlayer.findOne({ 
      userId, 
      playerId, 
      isActive: true 
    });
    if (existingRetained) {
      return res.status(400).json({ message: 'Player is already retained' });
    }

    // Check maximum retention limit (4 players)
    const currentRetainedCount = await RetainedPlayer.countDocuments({ 
      userId, 
      isActive: true 
    });
    if (currentRetainedCount >= 4) {
      return res.status(400).json({ message: 'You can only retain a maximum of 4 players' });
    }

    // Check if user already has a player from this category
    const existingCategoryRetained = await RetainedPlayer.findOne({ 
      userId, 
      playerType: player.type,
      isActive: true 
    });
    if (existingCategoryRetained) {
      return res.status(400).json({ 
        message: `You already have a ${player.type} player retained. You can only retain one player from each category.` 
      });
    }

    // All players cost 17 crores to retain
    const retentionValue = 170000000; // 17 crores for all players

    // Note: Purse deduction will happen when admin releases all other players
    // For now, just create the retention record without deducting from purse

    // Create retained player record
    const retainedPlayer = await RetainedPlayer.create({
      playerId,
      userId,
      retainedValue: retentionValue,
      playerType: player.type,
      playerName: player.name,
      playerRole: player.role
    });

    res.status(201).json({
      message: 'Player retained successfully',
      retainedPlayer,
      note: 'Purse will be deducted when admin releases all other players'
    });

  } catch (error) {
    console.error('Error retaining player:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get retained players for a user
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const retainedPlayers = await RetainedPlayer.find({ 
      userId, 
      isActive: true 
    }).populate('playerId', 'name type role profilePicture');

    res.json(retainedPlayers);
  } catch (error) {
    console.error('Error fetching retained players:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get all retained players (admin view)
router.get('/all', async (req, res) => {
  try {
    const retainedPlayers = await RetainedPlayer.find({ isActive: true })
      .populate('userId', 'name teamName abbreviation')
      .populate('playerId', 'name type role profilePicture');

    // Group by team
    const groupedByTeam = retainedPlayers.reduce((acc, retained) => {
      const teamName = retained.userId.teamName || 'Unknown Team';
      const teamId = retained.userId._id;
      if (!acc[teamName]) {
        acc[teamName] = {
          teamId,
          teamName,
          teamAbbreviation: retained.userId.abbreviation,
          players: []
        };
      }
      acc[teamName].players.push(retained);
      return acc;
    }, {});

    // Check if admin has released players
    let settings = await AppSettings.findOne();
    
    // If no settings document exists, create one with default values
    if (!settings) {
      console.log('No AppSettings document found, creating one...');
      settings = await AppSettings.create({
        enableTradeCenter: true,
        enableUnsoldPlayers: true,
        enablePickButton: true,
        enablePlayerRetention: true,
        pointsMode: 'overall',
        requiredGames: 12,
        adminReleasedPlayers: false,
        adminReleasedPlayersAt: null
      });
    }
    
    const adminReleasedPlayers = settings ? settings.adminReleasedPlayers : false;
    const releasedTeams = settings ? (settings.releasedTeams || []) : [];
    const allPlayersReleased = settings ? settings.allPlayersReleased : false;
    
    console.log('Admin release status check:', {
      settingsFound: !!settings,
      adminReleasedPlayers: adminReleasedPlayers,
      releasedTeams: releasedTeams,
      allPlayersReleased: allPlayersReleased,
      settingsData: settings
    });

    res.json({
      totalRetained: retainedPlayers.length,
      teams: Object.values(groupedByTeam),
      adminReleasedPlayers,
      releasedTeams: releasedTeams.map(id => id.toString()),
      allPlayersReleased
    });
  } catch (error) {
    console.error('Error fetching all retained players:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Release all other players (admin only)
router.post('/release-all-others', async (req, res) => {
  try {
    const { adminUserId } = req.body;
    
    // Verify admin
    const admin = await User.findById(adminUserId);
    if (!admin || !admin.isAdmin) {
      return res.status(403).json({ message: 'Only admin can release all other players' });
    }

    // Get all retained player IDs
    const retainedPlayers = await RetainedPlayer.find({ isActive: true });
    const initialRetainedPlayerIds = retainedPlayers.map(rp => rp.playerId);

    // Get all sold players that are NOT retained
    const allSoldPlayers = await Player.find({ isSold: true });
    const playersToRelease = allSoldPlayers.filter(player => 
      !initialRetainedPlayerIds.includes(player._id)
    );

    let releasedCount = 0;
    let totalRefunded = 0;

    // Process each player to be released
    for (const player of playersToRelease) {
      try {
        // Find the user who owns this player
        const userPlayer = await UserPlayer.findOne({ 
          playerId: player._id, 
          isActive: true 
        });
        
        if (userPlayer) {
          const user = await User.findById(userPlayer.userId);
          if (user) {
            // Refund the player's bid value
            const bidValue = parseFloat(userPlayer.bidValue);
            const currentPurse = parseFloat(user.purse.toString());
            user.purse = currentPurse + bidValue;
            await user.save();
            totalRefunded += bidValue;

            // Remove from user's boughtPlayers
            await User.findByIdAndUpdate(userPlayer.userId, {
              $pull: { boughtPlayers: player._id }
            });

            // Deactivate UserPlayer entry
            userPlayer.isActive = false;
            await userPlayer.save();
          }
        }

        // Update player status and revert base price to original
        const originalBasePrice = getOriginalBasePrice(player.type);
        player.isSold = false;
        player.isActive = false;
        player.basePrice = originalBasePrice;
        player.currentBid = originalBasePrice;
        player.currentBidder = null;
        await player.save();

        // Clean up related data
        await Promise.all([
          Bid.deleteMany({ playerId: player._id }),
          BidHistory.deleteMany({ playerId: player._id }),
          Notification.deleteMany({ 
            $or: [
              { 'metadata.playerId': player._id },
              { 'metadata.relatedPlayerId': player._id }
            ]
          }),
          Comment.deleteMany({ playerId: player._id }),
          PickRequest.deleteMany({ playerId: player._id }),
          PlayerStats.deleteMany({ playerId: player._id }),
          PostLike.deleteMany({ playerId: player._id }),
          ReleaseRequest.deleteMany({ player: player._id }),
          TradeRequest.deleteMany({ 
            $or: [
              { playerId: player._id },
              { requestedPlayerId: player._id }
            ]
          })
        ]);

        releasedCount++;
      } catch (playerError) {
        console.error(`Error processing player ${player._id}:`, playerError);
      }
    }

    // Reset all users' points, matches played, and set purse to 100 crores
    await User.updateMany({}, {
      $set: {
        points: 0,
        matchesPlayed: 0,
        fairnessPoint: 0,
        currentBids: [],
        purse: 1000000000 // 100 crores
      }
    });

    // Now deduct retention costs from users who have retained players
    const allRetainedPlayers = await RetainedPlayer.find({ isActive: true });
    const retentionCostPerPlayer = 170000000; // 17 crores per player
    
    for (const retained of allRetainedPlayers) {
      try {
        const user = await User.findById(retained.userId);
        if (user) {
          const currentPurse = parseFloat(user.purse.toString());
          const newPurse = currentPurse - retentionCostPerPlayer;
          user.purse = newPurse;
          await user.save();
        }
      } catch (userError) {
        console.error(`Error updating purse for user ${retained.userId}:`, userError);
      }
    }

    // Update retained players' base price to 17 Cr
    for (const retained of allRetainedPlayers) {
      try {
        const player = await Player.findById(retained.playerId);
        if (player) {
          player.basePrice = 170000000; // 17 Cr
          await player.save();
        }
      } catch (playerError) {
        console.error(`Error updating base price for player ${retained.playerId}:`, playerError);
      }
    }

    // Clear all fixtures, schedules, and playoff fixtures
    await Promise.all([
      Fixture.deleteMany({}),
      Schedule.deleteMany({}),
      PlayoffFixture.deleteMany({})
    ]);

    // COMPREHENSIVE BID CLEANUP: Remove ALL bids except for retained players
    console.log('Starting comprehensive bid cleanup...');
    
    // Get all retained player IDs (reuse existing allRetainedPlayers)
    const cleanupRetainedPlayerIds = allRetainedPlayers.map(rp => rp.playerId);
    
    // Get all users who have retained players
    const usersWithRetainedPlayers = allRetainedPlayers.map(rp => rp.userId);
    
    // Clean up ALL bid data except for retained players
    const bidCleanupResults = await Promise.all([
      // Delete all bids except for retained players
      Bid.deleteMany({ 
        playerId: { $nin: cleanupRetainedPlayerIds } 
      }),
      // Delete all bid history except for retained players
      BidHistory.deleteMany({ 
        playerId: { $nin: cleanupRetainedPlayerIds } 
      }),
      // Delete all bid notifications except for retained players
      Notification.deleteMany({
        $and: [
          { type: { $in: ['bid', 'bid_notification', 'bid_update'] } },
          { 'metadata.playerId': { $nin: teamCleanupRetainedPlayerIds } }
        ]
      }),
      // Delete all comments except for retained players
      Comment.deleteMany({ 
        playerId: { $nin: cleanupRetainedPlayerIds } 
      }),
      // Delete all pick requests except for retained players
      PickRequest.deleteMany({ 
        playerId: { $nin: cleanupRetainedPlayerIds } 
      }),
      // Delete all player stats except for retained players
      PlayerStats.deleteMany({ 
        playerId: { $nin: cleanupRetainedPlayerIds } 
      }),
      // Delete all post likes except for retained players
      PostLike.deleteMany({ 
        playerId: { $nin: cleanupRetainedPlayerIds } 
      }),
      // Delete all release requests except for retained players
      ReleaseRequest.deleteMany({ 
        player: { $nin: cleanupRetainedPlayerIds } 
      }),
      // Delete all trade requests except for retained players
      TradeRequest.deleteMany({ 
        $or: [
          { playerId: { $nin: cleanupRetainedPlayerIds } },
          { requestedPlayerId: { $nin: cleanupRetainedPlayerIds } }
        ]
      })
    ]);
    
    console.log('Bid cleanup results:', {
      bidsDeleted: bidCleanupResults[0].deletedCount,
      bidHistoryDeleted: bidCleanupResults[1].deletedCount,
      notificationsDeleted: bidCleanupResults[2].deletedCount,
      commentsDeleted: bidCleanupResults[3].deletedCount,
      pickRequestsDeleted: bidCleanupResults[4].deletedCount,
      playerStatsDeleted: bidCleanupResults[5].deletedCount,
      postLikesDeleted: bidCleanupResults[6].deletedCount,
      releaseRequestsDeleted: bidCleanupResults[7].deletedCount,
      tradeRequestsDeleted: bidCleanupResults[8].deletedCount
    });

    // Mark that admin has released players to disable undo option
    await AppSettings.findOneAndUpdate(
      {},
      { 
        adminReleasedPlayers: true,
        adminReleasedPlayersAt: new Date(),
        allPlayersReleased: true
      },
      { upsert: true }
    );

    // Set allPlayersReleased: true for ALL users
    console.log('Setting allPlayersReleased: true for all users...');
    
    // First, let's check how many users match the criteria
    const usersToUpdate = await User.find({ isActive: true, isAdmin: false });
    console.log(`Found ${usersToUpdate.length} users to update:`, usersToUpdate.map(u => ({ id: u._id, name: u.name, teamName: u.teamName })));
    
    const updateResult = await User.updateMany(
      { isActive: true, isAdmin: false }, // Only active non-admin users
      { allPlayersReleased: true }
    );
    console.log(`Update result:`, updateResult);
    console.log(`Updated ${updateResult.modifiedCount} users with allPlayersReleased: true`);
    
    // Verify the update worked
    const updatedUsers = await User.find({ isActive: true, isAdmin: false, allPlayersReleased: true });
    console.log(`Verification: ${updatedUsers.length} users now have allPlayersReleased: true`);

    // Clear all data from PlayerStats and Fixture collections
    console.log('Clearing all PlayerStats data...');
    const playerStatsResult = await PlayerStats.deleteMany({});
    console.log(`Deleted ${playerStatsResult.deletedCount} PlayerStats records`);

    console.log('Clearing all Fixture data...');
    const fixtureResult = await Fixture.deleteMany({});
    console.log(`Deleted ${fixtureResult.deletedCount} Fixture records`);

    res.json({
      message: 'All non-retained players released successfully. PlayerStats and Fixture data cleared.',
      releasedCount,
      totalRefunded,
      retainedCount: retainedPlayers.length,
      dataCleared: {
        playerStatsDeleted: playerStatsResult.deletedCount,
        fixtureDeleted: fixtureResult.deletedCount
      },
      purseReset: 'All users purse reset to ₹100 Cr',
      retentionDeduction: `₹${(retainedPlayers.length * 17).toFixed(2)} Cr deducted from users with retained players`,
      bidCleanup: {
        bidsDeleted: bidCleanupResults[0].deletedCount,
        bidHistoryDeleted: bidCleanupResults[1].deletedCount,
        notificationsDeleted: bidCleanupResults[2].deletedCount,
        commentsDeleted: bidCleanupResults[3].deletedCount,
        pickRequestsDeleted: bidCleanupResults[4].deletedCount,
        playerStatsDeleted: bidCleanupResults[5].deletedCount,
        postLikesDeleted: bidCleanupResults[6].deletedCount,
        releaseRequestsDeleted: bidCleanupResults[7].deletedCount,
        tradeRequestsDeleted: bidCleanupResults[8].deletedCount
      }
    });

  } catch (error) {
    console.error('Error releasing all other players:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Undo retention (user can undo their own retained players)
router.post('/undo/:retainedPlayerId', async (req, res) => {
  try {
    const { retainedPlayerId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ message: 'User ID is required' });
    }

    // Check if admin has already released players
    const settings = await AppSettings.findOne();
    if (settings && settings.adminReleasedPlayers) {
      return res.status(403).json({ 
        message: 'Cannot undo retained players after admin has released all other players. This action is no longer available.' 
      });
    }

    const retainedPlayer = await RetainedPlayer.findById(retainedPlayerId);
    if (!retainedPlayer) {
      return res.status(404).json({ message: 'Retained player not found' });
    }

    // Check if user owns this retained player
    if (retainedPlayer.userId.toString() !== userId) {
      return res.status(403).json({ message: 'You can only undo your own retained players' });
    }

    // Check if user retention is locked
    const user = await User.findById(userId);
    if (user && user.isRetentionLocked) {
      return res.status(403).json({ message: 'Your team retention is locked by admin. You cannot undo retained players.' });
    }

    // Deactivate the retained player
    retainedPlayer.isActive = false;
    await retainedPlayer.save();

    res.json({ message: 'Retained player undone successfully' });
  } catch (error) {
    console.error('Error undoing retained player:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Withdraw retention (user can withdraw their retained players - requires admin approval)
router.post('/withdraw/:retainedPlayerId', async (req, res) => {
  try {
    const { retainedPlayerId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ message: 'User ID is required' });
    }

    // Find the retained player
    const retainedPlayer = await RetainedPlayer.findById(retainedPlayerId);
    if (!retainedPlayer) {
      return res.status(404).json({ message: 'Retained player not found' });
    }

    // Check if user owns this retained player
    if (retainedPlayer.userId.toString() !== userId) {
      return res.status(403).json({ message: 'You can only withdraw your own retained players' });
    }

    // Check if already withdrawn
    if (retainedPlayer.status === 'withdrawn') {
      return res.status(400).json({ message: 'This player has already been withdrawn' });
    }

    // Check if admin has already released players
    const settings = await AppSettings.findOne();
    if (settings && settings.adminReleasedPlayers) {
      return res.status(400).json({ message: 'Cannot withdraw after admin has released all other players' });
    }

    // Update retained player status to withdrawn
    const updatedRetainedPlayer = await RetainedPlayer.findByIdAndUpdate(
      retainedPlayerId,
      { 
        status: 'withdrawn',
        withdrawnAt: new Date()
      },
      { new: true }
    );

    // Create notification for admin
    await Notification.create({
      userId: null, // Admin notification
      type: 'withdrawal_request',
      title: 'Player Withdrawal Request',
      message: `User ${retainedPlayer.userId} has requested to withdraw ${retainedPlayer.playerName}`,
      metadata: {
        retainedPlayerId: retainedPlayerId,
        playerName: retainedPlayer.playerName,
        playerType: retainedPlayer.playerType,
        withdrawnBy: userId
      }
    });

    res.json({ 
      message: 'Withdrawal request submitted successfully. Waiting for admin approval.',
      retainedPlayer: updatedRetainedPlayer
    });

  } catch (error) {
    console.error('Error withdrawing retention:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get withdrawal requests (admin only)
router.get('/withdrawals', async (req, res) => {
  try {
    const withdrawals = await RetainedPlayer.find({ status: 'withdrawn' })
      .populate('userId', 'teamName email')
      .populate('playerId', 'name type role basePrice')
      .sort({ withdrawnAt: -1 });

    res.json(withdrawals);
  } catch (error) {
    console.error('Error fetching withdrawal requests:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Approve withdrawal and release all other players (admin only)
router.post('/approve-withdrawal/:retainedPlayerId', async (req, res) => {
  try {
    const { retainedPlayerId } = req.params;
    const { adminUserId } = req.body;

    if (!adminUserId) {
      return res.status(400).json({ message: 'Admin user ID is required' });
    }

    // Verify admin
    const admin = await User.findById(adminUserId);
    if (!admin || !admin.isAdmin) {
      return res.status(403).json({ message: 'Only admin can approve withdrawals' });
    }

    // Find the withdrawn player
    const withdrawnPlayer = await RetainedPlayer.findById(retainedPlayerId);
    if (!withdrawnPlayer) {
      return res.status(404).json({ message: 'Withdrawn player not found' });
    }

    if (withdrawnPlayer.status !== 'withdrawn') {
      return res.status(400).json({ message: 'This player is not in withdrawn status' });
    }

    // Get all active retained players
    const allRetainedPlayers = await RetainedPlayer.find({ isActive: true });
    const retainedPlayerIds = allRetainedPlayers.map(rp => rp.playerId);

    // COMPREHENSIVE DATA CLEANUP: Remove ALL data except for retained players
    console.log('Starting comprehensive data cleanup after withdrawal approval...');
    const cleanupResults = await Promise.all([
      // Remove bids for non-retained players
      Bid.deleteMany({ playerId: { $nin: retainedPlayerIds } }),
      BidHistory.deleteMany({ playerId: { $nin: retainedPlayerIds } }),
      
      // Remove notifications for non-retained players
      Notification.deleteMany({
        $and: [
          { type: { $in: ['bid', 'bid_notification', 'bid_update'] } },
          { 'metadata.playerId': { $nin: retainedPlayerIds } }
        ]
      }),
      
      // Remove other related data
      Comment.deleteMany({ playerId: { $nin: retainedPlayerIds } }),
      PickRequest.deleteMany({ playerId: { $nin: retainedPlayerIds } }),
      PlayerStats.deleteMany({ playerId: { $nin: retainedPlayerIds } }),
      PostLike.deleteMany({ playerId: { $nin: retainedPlayerIds } }),
      ReleaseRequest.deleteMany({ player: { $nin: retainedPlayerIds } }),
      TradeRequest.deleteMany({
        $or: [
          { playerId: { $nin: retainedPlayerIds } },
          { requestedPlayerId: { $nin: retainedPlayerIds } }
        ]
      })
    ]);

    // Set all non-retained players as not sold
    await Player.updateMany(
      { _id: { $nin: retainedPlayerIds } },
      { isSold: false }
    );

    // Update user purses - refund retention costs
    for (const retainedPlayer of allRetainedPlayers) {
      await User.findByIdAndUpdate(
        retainedPlayer.userId,
        { $inc: { purse: retainedPlayer.retainedValue } }
      );
    }

    // Update AppSettings to mark admin has released players
    await AppSettings.findOneAndUpdate(
      {},
      { 
        adminReleasedPlayers: true,
        adminReleasedPlayersAt: new Date(),
        allPlayersReleased: true
      },
      { upsert: true }
    );

    // Update withdrawn player status
    await RetainedPlayer.findByIdAndUpdate(
      retainedPlayerId,
      { status: 'approved' }
    );

    console.log('Data cleanup completed:', {
      bidsDeleted: cleanupResults[0].deletedCount,
      bidHistoryDeleted: cleanupResults[1].deletedCount,
      notificationsDeleted: cleanupResults[2].deletedCount,
      commentsDeleted: cleanupResults[3].deletedCount,
      pickRequestsDeleted: cleanupResults[4].deletedCount,
      playerStatsDeleted: cleanupResults[5].deletedCount,
      postLikesDeleted: cleanupResults[6].deletedCount,
      releaseRequestsDeleted: cleanupResults[7].deletedCount,
      tradeRequestsDeleted: cleanupResults[8].deletedCount
    });

    res.json({ 
      message: 'Withdrawal approved and all other players released successfully',
      cleanupResults: {
        bidsDeleted: cleanupResults[0].deletedCount,
        bidHistoryDeleted: cleanupResults[1].deletedCount,
        notificationsDeleted: cleanupResults[2].deletedCount,
        commentsDeleted: cleanupResults[3].deletedCount,
        pickRequestsDeleted: cleanupResults[4].deletedCount,
        playerStatsDeleted: cleanupResults[5].deletedCount,
        postLikesDeleted: cleanupResults[6].deletedCount,
        releaseRequestsDeleted: cleanupResults[7].deletedCount,
        tradeRequestsDeleted: cleanupResults[8].deletedCount
      }
    });

  } catch (error) {
    console.error('Error approving withdrawal:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Lock/Unlock team retention (admin only)
router.post('/lock-retention', async (req, res) => {
  try {
    const { adminUserId, userId, isRetentionLocked } = req.body;

    if (!adminUserId || !userId || typeof isRetentionLocked !== 'boolean') {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Verify admin
    const admin = await User.findById(adminUserId);
    if (!admin || !admin.isAdmin) {
      return res.status(403).json({ message: 'Only admin can lock/unlock team retention' });
    }

    // Update user retention lock status
    const user = await User.findByIdAndUpdate(
      userId,
      { isRetentionLocked },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({ 
      message: `Team retention ${isRetentionLocked ? 'locked' : 'unlocked'} successfully`,
      isRetentionLocked: user.isRetentionLocked
    });
  } catch (error) {
    console.error('Error locking/unlocking team retention:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Remove retained player (admin only)
router.delete('/:retainedPlayerId', async (req, res) => {
  try {
    const { retainedPlayerId } = req.params;
    const { adminUserId } = req.body;

    // Verify admin
    const admin = await User.findById(adminUserId);
    if (!admin || !admin.isAdmin) {
      return res.status(403).json({ message: 'Only admin can remove retained players' });
    }

    const retainedPlayer = await RetainedPlayer.findById(retainedPlayerId);
    if (!retainedPlayer) {
      return res.status(404).json({ message: 'Retained player not found' });
    }

    // Deactivate the retained player
    retainedPlayer.isActive = false;
    await retainedPlayer.save();

    res.json({ message: 'Retained player removed successfully' });
  } catch (error) {
    console.error('Error removing retained player:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Release all players for a specific team (admin only)
router.post('/release-team-players', async (req, res) => {
  try {
    console.log('=== RELEASE TEAM PLAYERS START ===');
    const { adminUserId, teamId, teamName } = req.body;
    
    console.log('Release team players request body:', req.body);
    console.log('Admin user ID:', adminUserId);
    console.log('Team ID:', teamId);
    console.log('Team Name:', teamName);

    if (!adminUserId || !teamId) {
      console.log('Missing required fields - adminUserId:', adminUserId, 'teamId:', teamId);
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Verify admin
    console.log('Verifying admin...');
    const admin = await User.findById(adminUserId);
    console.log('Admin found:', admin ? 'Yes' : 'No');
    if (!admin || !admin.isAdmin) {
      console.log('Admin verification failed');
      return res.status(403).json({ message: 'Only admin can release team players' });
    }
    console.log('Admin verified successfully');

    // Find the team
    console.log('Finding team...');
    const team = await User.findById(teamId);
    console.log('Team found:', team ? 'Yes' : 'No');
    if (!team) {
      console.log('Team not found');
      return res.status(404).json({ message: 'Team not found' });
    }
    console.log('Team found successfully:', team.teamName);

    // Get retained players for this team
    const retainedPlayers = await RetainedPlayer.find({ 
      userId: teamId, 
      isActive: true 
    });

    // Get all active players for this team
    const userPlayers = await UserPlayer.find({ 
      userId: teamId, 
      isActive: true 
    }).populate('playerId');

    // Get retained player IDs
    const teamRetainedPlayerIds = retainedPlayers.map(rp => rp.playerId.toString());

    let releasedCount = 0;
    let totalRefunded = 0;

    // Release only NON-RETAINED players
    for (const userPlayer of userPlayers) {
      try {
        const player = userPlayer.playerId;
        
        // Skip if this player is retained
        if (teamRetainedPlayerIds.includes(player._id.toString())) {
          continue;
        }
        
        if (player) {
        // Refund the player's bid value
        const bidValue = parseFloat(userPlayer.bidValue);
        const currentPurse = parseFloat(team.purse.toString());
        team.purse = currentPurse + bidValue;
        totalRefunded += bidValue;

        // Remove from team's boughtPlayers
        await User.findByIdAndUpdate(teamId, {
          $pull: { boughtPlayers: player._id }
        });

        // Deactivate UserPlayer entry
        userPlayer.isActive = false;
        await userPlayer.save();

        // Update player status and revert base price to original
        const originalBasePrice = getOriginalBasePrice(player.type);
        player.isSold = false;
        player.isActive = false;
        player.basePrice = originalBasePrice;
        player.currentBid = originalBasePrice;
        player.currentBidder = null;
        await player.save();

        // Clean up related data for this player
        await Promise.all([
          Bid.deleteMany({ playerId: player._id }),
          BidHistory.deleteMany({ playerId: player._id }),
          Notification.deleteMany({ 
            $or: [
              { 'metadata.playerId': player._id },
              { 'metadata.relatedPlayerId': player._id }
            ]
          }),
          Comment.deleteMany({ playerId: player._id }),
          PickRequest.deleteMany({ playerId: player._id }),
          PlayerStats.deleteMany({ playerId: player._id }),
          PostLike.deleteMany({ playerId: player._id }),
          ReleaseRequest.deleteMany({ player: player._id }),
          TradeRequest.deleteMany({ 
            $or: [
              { playerId: player._id },
              { requestedPlayerId: player._id }
            ]
          })
        ]);

        releasedCount++;
        }
      } catch (playerError) {
        console.error(`Error processing player ${userPlayer.playerId}:`, playerError);
        // Continue with other players even if one fails
      }
    }

    // Reset team purse to 100 Cr and deduct retention costs
    const retentionCost = retainedPlayers.length * 170000000; // 17 Cr per retained player
    team.purse = 1000000000 - retentionCost; // 100 Cr - retention costs

    // Update retained players' base price to 17 Cr
    for (const retainedPlayer of retainedPlayers) {
      const player = await Player.findById(retainedPlayer.playerId);
      if (player) {
        player.basePrice = 170000000; // 17 Cr
        await player.save();
      }
    }

    // Save team with updated purse
    await team.save();

    // Set allPlayersReleased: true for this specific team
    console.log('Setting allPlayersReleased: true for team:', teamId);
    await User.findByIdAndUpdate(teamId, {
      $set: {
        allPlayersReleased: true
      }
    });
    console.log('Successfully set allPlayersReleased: true for team:', teamId);

    // Reset team statistics
    await User.findByIdAndUpdate(teamId, {
      $set: {
        points: 0,
        matchesPlayed: 0,
        fairnessPoint: 0,
        currentBids: []
      }
    });

    // Add team to released teams list
    console.log('Adding team to released teams list:', teamId, typeof teamId);
    try {
      await AppSettings.findOneAndUpdate(
        {},
        { $addToSet: { releasedTeams: teamId } },
        { upsert: true }
      );
      console.log('Successfully added team to released teams list');
      
      // Check if all teams are now released
      const updatedSettings = await AppSettings.findOne();
      const allTeams = await User.find({ isActive: true, isAdmin: false });
      const allTeamIds = allTeams.map(team => team._id.toString());
      const releasedTeamIds = (updatedSettings.releasedTeams || []).map(id => id.toString());
      
      const allTeamsReleased = allTeamIds.every(teamId => releasedTeamIds.includes(teamId));
      
      if (allTeamsReleased) {
        console.log('All teams have been released, setting allPlayersReleased to true');
        await AppSettings.findOneAndUpdate(
          {},
          { allPlayersReleased: true },
          { upsert: true }
        );
        
        // Set allPlayersReleased: true for ALL users
        console.log('Setting allPlayersReleased: true for all users...');
        
        // First, let's check how many users match the criteria
        const usersToUpdate = await User.find({ isActive: true, isAdmin: false });
        console.log(`Found ${usersToUpdate.length} users to update:`, usersToUpdate.map(u => ({ id: u._id, name: u.name, teamName: u.teamName })));
        
        const updateResult = await User.updateMany(
          { isActive: true, isAdmin: false }, // Only active non-admin users
          { allPlayersReleased: true }
        );
        console.log(`Update result:`, updateResult);
        console.log(`Updated ${updateResult.modifiedCount} users with allPlayersReleased: true`);
        
        // Verify the update worked
        const updatedUsers = await User.find({ isActive: true, isAdmin: false, allPlayersReleased: true });
        console.log(`Verification: ${updatedUsers.length} users now have allPlayersReleased: true`);
      }
    } catch (error) {
      console.error('Error adding team to released teams list:', error);
      throw error;
    }

    // COMPREHENSIVE BID CLEANUP: Remove ALL bids except for retained players
    console.log('Starting comprehensive bid cleanup for team release...');
    
    // Get all retained player IDs (reuse existing retainedPlayers)
    const allRetainedPlayersForCleanup = await RetainedPlayer.find({ isActive: true });
    const teamCleanupRetainedPlayerIds = allRetainedPlayersForCleanup.map(rp => rp.playerId);
    
    // Clean up ALL bid data except for retained players
    const bidCleanupResults = await Promise.all([
      // Delete all bids except for retained players
      Bid.deleteMany({ 
        playerId: { $nin: teamCleanupRetainedPlayerIds } 
      }),
      // Delete all bid history except for retained players
      BidHistory.deleteMany({ 
        playerId: { $nin: teamCleanupRetainedPlayerIds } 
      }),
      // Delete all bid notifications except for retained players
      Notification.deleteMany({
        $and: [
          { type: { $in: ['bid', 'bid_notification', 'bid_update'] } },
          { 'metadata.playerId': { $nin: teamCleanupRetainedPlayerIds } }
        ]
      }),
      // Delete all comments except for retained players
      Comment.deleteMany({ 
        playerId: { $nin: teamCleanupRetainedPlayerIds } 
      }),
      // Delete all pick requests except for retained players
      PickRequest.deleteMany({ 
        playerId: { $nin: teamCleanupRetainedPlayerIds } 
      }),
      // Delete all player stats except for retained players
      PlayerStats.deleteMany({ 
        playerId: { $nin: teamCleanupRetainedPlayerIds } 
      }),
      // Delete all post likes except for retained players
      PostLike.deleteMany({ 
        playerId: { $nin: teamCleanupRetainedPlayerIds } 
      }),
      // Delete all release requests except for retained players
      ReleaseRequest.deleteMany({ 
        player: { $nin: teamCleanupRetainedPlayerIds } 
      }),
      // Delete all trade requests except for retained players
      TradeRequest.deleteMany({ 
        $or: [
          { playerId: { $nin: teamCleanupRetainedPlayerIds } },
          { requestedPlayerId: { $nin: teamCleanupRetainedPlayerIds } }
        ]
      })
    ]);
    
    console.log('Team release bid cleanup results:', {
      bidsDeleted: bidCleanupResults[0].deletedCount,
      bidHistoryDeleted: bidCleanupResults[1].deletedCount,
      notificationsDeleted: bidCleanupResults[2].deletedCount,
      commentsDeleted: bidCleanupResults[3].deletedCount,
      pickRequestsDeleted: bidCleanupResults[4].deletedCount,
      playerStatsDeleted: bidCleanupResults[5].deletedCount,
      postLikesDeleted: bidCleanupResults[6].deletedCount,
      releaseRequestsDeleted: bidCleanupResults[7].deletedCount,
      tradeRequestsDeleted: bidCleanupResults[8].deletedCount
    });

    // Mark that admin has released players to disable undo option
    await AppSettings.findOneAndUpdate(
      {},
      { 
        adminReleasedPlayers: true,
        adminReleasedPlayersAt: new Date()
      },
      { upsert: true }
    );

    // Clear all data from PlayerStats and Fixture collections
    console.log('Clearing all PlayerStats data...');
    const playerStatsResult = await PlayerStats.deleteMany({});
    console.log(`Deleted ${playerStatsResult.deletedCount} PlayerStats records`);

    console.log('Clearing all Fixture data...');
    const fixtureResult = await Fixture.deleteMany({});
    console.log(`Deleted ${fixtureResult.deletedCount} Fixture records`);

    res.json({ 
      message: `Successfully released ${releasedCount} non-retained players for ${teamName}. ${retainedPlayers.length} retained players kept. Team's allPlayersReleased status set to true. PlayerStats and Fixture data cleared.`,
      releasedCount,
      retainedCount: retainedPlayers.length,
      allPlayersReleased: true,
      dataCleared: {
        playerStatsDeleted: playerStatsResult.deletedCount,
        fixtureDeleted: fixtureResult.deletedCount
      },
      totalRefunded: totalRefunded / 10000000, // Convert to Cr
      retentionCost: retentionCost / 10000000, // Convert to Cr
      finalPurse: (1000000000 - retentionCost) / 10000000, // Convert to Cr
      teamName,
      bidCleanup: {
        bidsDeleted: bidCleanupResults[0].deletedCount,
        bidHistoryDeleted: bidCleanupResults[1].deletedCount,
        notificationsDeleted: bidCleanupResults[2].deletedCount,
        commentsDeleted: bidCleanupResults[3].deletedCount,
        pickRequestsDeleted: bidCleanupResults[4].deletedCount,
        playerStatsDeleted: bidCleanupResults[5].deletedCount,
        postLikesDeleted: bidCleanupResults[6].deletedCount,
        releaseRequestsDeleted: bidCleanupResults[7].deletedCount,
        tradeRequestsDeleted: bidCleanupResults[8].deletedCount
      }
    });
  } catch (error) {
    console.error('Error releasing team players:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Debug route to check AppSettings
router.get('/debug-settings', async (req, res) => {
  try {
    let settings = await AppSettings.findOne();
    
    // If no settings document exists, create one with default values
    if (!settings) {
      console.log('No AppSettings document found, creating one...');
      settings = await AppSettings.create({
        enableTradeCenter: true,
        enableUnsoldPlayers: true,
        enablePickButton: true,
        enablePlayerRetention: true,
        pointsMode: 'overall',
        requiredGames: 12,
        adminReleasedPlayers: false,
        adminReleasedPlayersAt: null
      });
    }
    
    res.json({
      settingsFound: !!settings,
      settings: settings,
      adminReleasedPlayers: settings ? settings.adminReleasedPlayers : false
    });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Migration route to add allPlayersReleased field to existing users
router.post('/migrate-users', async (req, res) => {
  try {
    console.log('Starting migration to add allPlayersReleased field to existing users...');
    
    // Find all users that don't have the allPlayersReleased field
    const usersWithoutField = await User.find({
      isActive: true,
      isAdmin: false,
      allPlayersReleased: { $exists: false }
    });
    
    console.log(`Found ${usersWithoutField.length} users without allPlayersReleased field`);
    
    if (usersWithoutField.length > 0) {
      // Add the field to all users that don't have it
      const updateResult = await User.updateMany(
        { 
          isActive: true, 
          isAdmin: false,
          allPlayersReleased: { $exists: false }
        },
        { $set: { allPlayersReleased: false } }
      );
      
      console.log(`Migration result:`, updateResult);
      console.log(`Added allPlayersReleased field to ${updateResult.modifiedCount} users`);
    }
    
    // Now check all users
    const allUsers = await User.find({ isActive: true, isAdmin: false });
    console.log(`All users after migration:`, allUsers.map(u => ({ 
      id: u._id, 
      name: u.name, 
      allPlayersReleased: u.allPlayersReleased,
      hasField: u.allPlayersReleased !== undefined
    })));
    
    res.json({
      message: 'Migration completed',
      usersProcessed: usersWithoutField.length,
      usersUpdated: updateResult?.modifiedCount || 0,
      totalUsers: allUsers.length
    });
  } catch (error) {
    console.error('Error in migration route:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Test route to check user update functionality
router.post('/test-user-update', async (req, res) => {
  try {
    console.log('Testing user update functionality...');
    
    // First, let's check current users
    const usersBefore = await User.find({ isActive: true, isAdmin: false });
    console.log(`Found ${usersBefore.length} users before update:`, usersBefore.map(u => ({ id: u._id, name: u.name, allPlayersReleased: u.allPlayersReleased })));
    
    // Try to update one user first
    const testUserId = usersBefore[0]?._id;
    if (testUserId) {
      console.log(`Testing update on user: ${testUserId}`);
      const updateResult = await User.findByIdAndUpdate(
        testUserId,
        { allPlayersReleased: true },
        { new: true }
      );
      console.log('Single user update result:', updateResult);
    }
    
    // Now try updateMany
    const updateResult = await User.updateMany(
      { isActive: true, isAdmin: false },
      { allPlayersReleased: true }
    );
    console.log('UpdateMany result:', updateResult);
    
    // Check after update
    const usersAfter = await User.find({ isActive: true, isAdmin: false });
    console.log(`Found ${usersAfter.length} users after update:`, usersAfter.map(u => ({ id: u._id, name: u.name, allPlayersReleased: u.allPlayersReleased })));
    
    res.json({
      message: 'Test completed',
      usersBefore: usersBefore.length,
      usersAfter: usersAfter.length,
      updateResult: updateResult
    });
  } catch (error) {
    console.error('Error in test route:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Reset allPlayersReleased to false for all users (admin only)
router.post('/reset-all-players-released', async (req, res) => {
  try {
    const { adminUserId } = req.body;
    
    // Verify admin
    const admin = await User.findById(adminUserId);
    if (!admin || !admin.isAdmin) {
      return res.status(403).json({ message: 'Only admin can reset allPlayersReleased status' });
    }

    // Reset allPlayersReleased to false for all users
    console.log('Resetting allPlayersReleased to false for all users...');
    const updateResult = await User.updateMany(
      { isActive: true, isAdmin: false }, // Only active non-admin users
      { allPlayersReleased: false }
    );
    console.log(`Updated ${updateResult.modifiedCount} users with allPlayersReleased: false`);

    // Also reset AppSettings
    await AppSettings.findOneAndUpdate(
      {},
      { allPlayersReleased: false },
      { upsert: true }
    );

    res.json({
      message: 'Successfully reset allPlayersReleased to false for all users',
      usersUpdated: updateResult.modifiedCount
    });
  } catch (error) {
    console.error('Error resetting allPlayersReleased:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;
