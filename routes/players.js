const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Player = require('../models/Player');
const upload = require('../config/multerConfig'); // Import Multer configuration
const Bid = require("../models/Bid");
const BidNotification = require("../models/BidNotification");
const User = require("../models/User");
const UserPlayer = require("../models/UserPlayer");
const ReleaseRequest = require("../models/ReleaseRequest");
const { cacheConfig, invalidateCache, flushStatsOverviewCache } = require('../utils/cache');
const multerMemory = require('../config/multerMemory');
const { saveProfilePictureLocal } = require('../utils/saveProfilePictureLocal');
const { removeLocalProfilePictureIfSafe } = require('../utils/removeLocalProfilePictureIfSafe');
const router = express.Router();
const formatPrice = (value) => {
  if (value >= 10000000) {
    return `${(value / 10000000).toFixed(1)} cr`; // Convert to crores if >= 1 crore
  } else if (value >= 100000) {
    return `${(value / 100000).toFixed(1)} lakh`; // Convert to lakhs if >= 1 lakh
  }
  return `${value}`; // Return raw value for smaller amounts
};
// Insert Player
router.post('/player', upload.single('profilePicture'), async (req, res) => {
  try {
    const { name, type, role, basePrice, basePriceUnit, overallScore, style } = req.body;

    const profilePicture = req.file ? req.file.path : null;

    // Split the full name into first and last name
    const [firstName, lastName] = name.split(' ');

    // Check if a player with the same first and last name already exists
    const existingPlayer = await Player.findOne({ name: { $regex: `^${firstName} ${lastName}$`, $options: 'i' } });
    if (existingPlayer) {
      return res.status(400).json({ error: 'Player with the same name already exists' });
    }

    // Format the base price
    const newPlayer = new Player({
      playerID: uuidv4(),
      name,
      type,
      role,
      basePrice, // Save the formatted base price
      overallScore,
      profilePicture,
      style,
    });

    await newPlayer.save();

    res.status(201).json({ message: 'Player created successfully', player: newPlayer });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Edit Player
router.put('/player/:playerID', upload.single('profilePicture'), async (req, res) => {
  try {
    const { playerID } = req.params;
    const existing = await Player.findOne({ playerID }).select('profilePicture');
    if (!existing) {
      return res.status(404).json({ message: 'Player not found' });
    }

    const updates = { ...req.body };
    let previousPicture = null;
    if (req.file) {
      previousPicture = existing.profilePicture;
      updates.profilePicture = req.file.path;
    }

    const updatedPlayer = await Player.findOneAndUpdate(
      { playerID },
      { $set: updates, updatedAt: new Date() },
      { new: true }
    );

    if (req.file && previousPicture) {
      await removeLocalProfilePictureIfSafe(previousPicture);
    }

    res.status(200).json({ message: 'Player updated successfully', player: updatedPlayer });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Delete Player
router.delete('/player/:playerID', async (req, res) => {
  try {
    const { playerID } = req.params;

    const deletedPlayer = await Player.findOneAndDelete({ playerID });

    if (!deletedPlayer) {
      return res.status(404).json({ message: 'Player not found' });
    }

    res.status(200).json({ message: 'Player deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
router.get("/:playerId/bids", async (req, res) => {
  const { playerId } = req.params;
  const viewerUserId = req.query.viewerUserId || req.query.userId;
  try {
    // 1. Check if the player exists
    // 🚀 PERFORMANCE: Use .lean() for faster queries (read-only)
    const player = await Player.findById(playerId).lean();
    if (!player) {
      return res.status(404).json({ message: "Player not found." });
    }

    let viewerOwnsPlayer = false;
    if (viewerUserId) {
      const viewer = await User.findById(viewerUserId).select('boughtPlayers').lean();
      if (viewer?.boughtPlayers?.length) {
        viewerOwnsPlayer = viewer.boughtPlayers.some(
          (id) => String(id) === String(player._id)
        );
      }
    }

    // 2. Fetch all bids for the player
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const allBids = await Bid.find({ playerId })
      .select('bidder bidAmount isBidOn timestamp')
      .populate("bidder", "name email") // Populate bidder's name and email
      .sort({ bidAmount: -1 }) // Sort by bid value (descending)
      .lean()
      .exec();

    // 2.1 Fetch last exit notification time for this player
    const lastExit = await BidNotification.findOne({
      message: { $regex: 'Bid exit', $options: 'i' },
      $or: [
        { playerId: player._id },
        { playername: player.name }
      ]
    })
      .sort({ timestamp: -1 })
      .select('timestamp exitedUser exitBy')
      .lean();

    // 3. Get the top two bids
    const lastTwoBids = allBids ? allBids.slice(0, 2) : [];

    // 4. Respond with player's info + top bids + all bids
    res.status(200).json({
      viewerOwnsPlayer,
      player: {
        id: player._id,
        name: player.name,
        type: player.type,
        role: player.role,
        battingStyle: player.style || null,
        score: player.overallScore || null,
        status: player.isSold,
        isActive: player.isActive,
        basePrice: player.basePrice,
        lastExitTime: lastExit?.timestamp || null,
        lastExitUser: lastExit?.exitedUser || null,
        lastExitBy: player.lastExitBy || lastExit?.exitBy || null,
        // NEW FIELDS (assuming they exist in your Player schema)
        totalRuns: player.totalRuns || 0,
        totalWickets: player.totalWickets || 0,
        profilePicture: player.profilePicture || null,
        momCount: player.momCount ?? 0,
      },
      topTwoBids: lastTwoBids.map((bid) => ({
        id: bid._id,
        bidder: bid.bidder,
        bidAmount: bid.bidAmount,
        createdAt: bid.timestamp,
        isBidOn: bid.isBidOn
      })),
      allBids: allBids.map((bid) => ({
        id: bid._id,
        bidder: bid.bidder,
        bidAmount: bid.bidAmount,
        createdAt: bid.timestamp,
        isBidOn: bid.isBidOn
      })),
    });
  } catch (error) {
    console.error("Error fetching bids for player:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

// Admin: deactivate a player (only if unsold and active)
router.post('/:playerId/deactivate', async (req, res) => {
  try {
    const { playerId } = req.params;
    const { adminUserId } = req.body;
    if (!adminUserId) {
      return res.status(400).json({ message: 'Admin user ID is required' });
    }
    const admin = await User.findById(adminUserId).select('isAdmin name');
    if (!admin || !admin.isAdmin) {
      return res.status(403).json({ message: 'Only admin can deactivate players' });
    }

    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ message: 'Player not found' });
    }
    if (player.isSold) {
      return res.status(400).json({ message: 'Cannot deactivate a sold player' });
    }
    if (!player.isActive) {
      return res.status(400).json({ message: 'Player is already inactive' });
    }

    player.isActive = false;
    await player.save();

    invalidateCache('players:data');

    return res.json({ message: 'Player deactivated', playerId: player._id, isActive: false });
  } catch (error) {
    console.error('Deactivate player error', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

async function handleAdminProfilePictureLocal(req, res) {
  try {
    const { playerId } = req.params;
    const actingUserId = req.body?.userId || req.body?.adminUserId;
    if (!actingUserId) {
      return res.status(400).json({ message: 'userId is required' });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ message: 'Image file required (field name: profilePicture)' });
    }
    const actor = await User.findById(actingUserId).select('isAdmin boughtPlayers').lean();
    if (!actor) {
      return res.status(404).json({ message: 'User not found' });
    }
    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ message: 'Player not found' });
    }
    const ownsPlayer = (actor.boughtPlayers || []).some(
      (id) => String(id) === String(player._id)
    );
    if (!actor.isAdmin && !ownsPlayer) {
      return res.status(403).json({
        message: 'You can only replace photos for players on your team',
      });
    }
    const previousPath = player.profilePicture;
    const { relativePath } = await saveProfilePictureLocal({
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
      playerId,
    });
    player.profilePicture = relativePath;
    player.updatedAt = new Date();
    await player.save();
    await removeLocalProfilePictureIfSafe(previousPath);
    invalidateCache('players:data');
    invalidateCache('players:data:all');
    invalidateCache('user-purses');
    invalidateCache('user-details:');
    flushStatsOverviewCache();
    return res.json({
      message: 'Profile picture updated',
      profilePicture: relativePath,
      playerId: player._id,
    });
  } catch (err) {
    console.error('Profile picture (local) error', err);
    return res.status(500).json({ message: err.message || 'Upload failed' });
  }
}

router.post(
  '/:playerId/admin/profile-picture',
  multerMemory.single('profilePicture'),
  handleAdminProfilePictureLocal
);

router.get("/players/data", async (req, res) => {
  // 🚀 PERFORMANCE: Check cache first (2 minute cache for players data)
  const includeInactive = req.query.includeInactive === 'true';
  const cacheKey = includeInactive ? 'players:data:all' : 'players:data';
  const skipCache =
    req.query.nocache === '1' ||
    req.query.nocache === 'true' ||
    req.query.nocache === 'yes';
  if (!skipCache) {
    const cached = cacheConfig.medium.get(cacheKey);
    if (cached) {
      console.log(`✅ Players data cache HIT`);
      return res.status(200).json(cached);
    }
  }

  try {
    // Use aggregation pipeline for better performance
    const matchStage = includeInactive ? {} : { isActive: true };
    const players = await Player.aggregate([
      { $match: matchStage },
      {
        $lookup: {
          from: 'userplayers',
          let: { playerId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$playerId', '$$playerId'] }, { $eq: ['$isActive', true] }] } } },
            { $limit: 1 }
          ],
          as: 'userPlayer'
        }
      },
      {
        $lookup: {
          from: 'users',
          let: { userId: { $arrayElemAt: ['$userPlayer.userId', 0] } },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$_id', '$$userId'] },
                isActive: true,
              },
            },
            { $project: { name: 1, teamName: 1, teamImage: 1 } }
          ],
          as: 'user'
        }
      },
      {
        $lookup: {
          from: 'bids',
          let: { playerId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$playerId', '$$playerId'] },
                isBidOn: true,
                isActive: true
              }
            },
            { $sort: { bidAmount: -1 } },
            { $limit: 1 },
            {
              $lookup: {
                from: 'users',
                let: { bidderId: '$bidder' },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ['$_id', '$$bidderId'] },
                      isActive: true,
                    },
                  },
                  { $project: { _id: 1, name: 1, teamName: 1 } }
                ],
                as: 'bidder'
              }
            }
          ],
          as: 'highestBid'
        }
      },
      {
        $project: {
          id: '$_id',
          name: 1,
          type: 1,
          role: 1,
          basePrice: {
            $cond: {
              if: { $gt: [{ $size: '$userPlayer' }, 0] },
              then: { $toString: { $arrayElemAt: ['$userPlayer.bidValue', 0] } },
              else: {
                $cond: {
                  if: { $gt: [{ $size: '$highestBid' }, 0] },
                  then: { $toString: { $arrayElemAt: ['$highestBid.bidAmount', 0] } },
                  else: { $toString: '$basePrice' }
                }
              }
            }
          },
          currentBidder: {
            $cond: {
              if: { $gt: [{ $size: '$userPlayer' }, 0] },
              then: { $arrayElemAt: ['$user.name', 0] },
              else: {
                $cond: {
                  if: { $gt: [{ $size: '$highestBid' }, 0] },
                  then: { $arrayElemAt: ['$highestBid.bidder.name', 0] },
                  else: 'N/A'
                }
              }
            }
          },
          currentBidderId: {
            $cond: {
              if: { $gt: [{ $size: '$userPlayer' }, 0] },
              then: { $arrayElemAt: ['$userPlayer.userId', 0] },
              else: {
                $cond: {
                  if: { $gt: [{ $size: '$highestBid' }, 0] },
                  then: { $arrayElemAt: ['$highestBid.bidder._id', 0] },
                  else: null
                }
              }
            }
          },
          teamName: {
            $cond: {
              if: { $gt: [{ $size: '$userPlayer' }, 0] },
              then: { $arrayElemAt: ['$user.teamName', 0] },
              else: {
                $cond: {
                  if: { $gt: [{ $size: '$highestBid' }, 0] },
                  then: { $arrayElemAt: ['$highestBid.bidder.teamName', 0] },
                  else: 'N/A'
                }
              }
            }
          },
          status: {
            $cond: {
              if: { $gt: [{ $size: '$userPlayer' }, 0] },
              then: 'Sold',
              else: 'Unsold'
            }
          },
          totalRuns: { $ifNull: ['$totalRuns', 0] },
          totalWickets: { $ifNull: ['$totalWickets', 0] },
          matchesPlayed: { $ifNull: ['$matchesPlayed', 0] },
          overallScore: { $ifNull: ['$overallScore', 0] },
          teamLogo: {
            $cond: {
              if: { $gt: [{ $size: '$user' }, 0] },
              then: { $arrayElemAt: ['$user.teamImage', 0] },
              else: null
            }
          },
          profilePicture: { $ifNull: ['$profilePicture', null] },
          tradeLocked: { $ifNull: ['$tradeLocked', false] },
          tradeLockedUntil: 1
        }
      },
      {
        $addFields: {
          sortOrder: {
            $cond: {
              if: { $ne: ['$currentBidder', 'N/A'] },
              then: 0,
              else: 1
            }
          }
        }
      },
      { $sort: { sortOrder: 1 } }
    ]);

    // 🚀 PERFORMANCE: Cache the response (2 minute cache)
    cacheConfig.medium.set(cacheKey, players);
    console.log(`💾 Players data cached`);

    res.status(200).json(players);
  } catch (error) {
    console.error("Error fetching player data:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

// Add Trade Player API
router.post('/trade-player', async (req, res) => {
  const { player1Id, player2Id } = req.body;

  if (!player1Id || !player2Id) {
    return res.status(400).json({ message: 'Player IDs are required.' });
  }

  try {
    // Fetch both players and their associated teams
    const [player1, player2] = await Promise.all([
      UserPlayer.findOne({ playerId: player1Id, isActive: true }).populate('userId'),
      UserPlayer.findOne({ playerId: player2Id, isActive: true }).populate('userId')
    ]);

    if (!player1 || !player2) {
      return res.status(404).json({ message: 'One or both players not found.' });
    }

    const team1 = player1.userId; // Team associated with player1
    const team2 = player2.userId; // Team associated with player2

    if (!team1 || !team2) {
      return res.status(404).json({ message: 'One or both teams not found.' });
    }

    // Validate purse sufficiency
    // if (Number(team2.purse) < player1.bidValue || Number(team1.purse) < player2.bidValue) {
    //   return res.status(400).json({ message: 'Insufficient purse for the trade.' });
    // }

    // Update players
    player1.userId = team2._id;
    player2.userId = team1._id;
    player1.updatedAt = new Date();
    player2.updatedAt = new Date();

    // Update user purse
    team1.purse = (Number(team1.purse) + player1.bidValue - player2.bidValue).toFixed(2);
    team2.purse = (Number(team2.purse) + player2.bidValue - player1.bidValue).toFixed(2);

    // Update boughtPlayers list
    team1.boughtPlayers = team1.boughtPlayers.filter(id => !id.equals(player1Id));
    team1.boughtPlayers.push(player2Id);

    team2.boughtPlayers = team2.boughtPlayers.filter(id => !id.equals(player2Id));
    team2.boughtPlayers.push(player1Id);

    // Save updates
    await Promise.all([
      player1.save(),
      player2.save(),
      team1.save(),
      team2.save()
    ]);

    res.json({ message: 'Trade completed successfully.' });
  } catch (error) {
    console.error('Error trading players:', error);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Admin: release a player immediately
router.post('/release-player', async (req, res) => {
  try {
    const { adminUserId, userId, playerId } = req.body;
    if (!adminUserId || !userId || !playerId) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    const admin = await User.findById(adminUserId);
    if (!admin || !admin.isAdmin) {
      return res.status(403).json({ message: 'Only admin can release players' });
    }
    const up = await UserPlayer.findOne({ userId, playerId, isActive: true });
    if (!up) {
      return res.status(404).json({ message: 'Ownership not found or already inactive' });
    }
    // Refund the player's bid value back to the user's purse
    const bidValue = Number(up.bidValue || 0);
    if (bidValue > 0) {
      try {
        await User.findByIdAndUpdate(userId, { 
          $inc: { purse: bidValue }
        });
      } catch {}
    }
    
    up.isActive = false;
    up.updatedAt = new Date();
    await up.save();

    // CRITICAL FIX: Remove player from user's boughtPlayers array
    try {
      await User.findByIdAndUpdate(userId, {
        $pull: { boughtPlayers: playerId }
      });
    } catch (userUpdateError) {
      console.error('Error removing player from boughtPlayers:', userUpdateError);
    }

    // If a pending release request exists, mark it approved
    const rr = await ReleaseRequest.findOne({ user: userId, player: playerId, status: { $in: ['pending', 'admin_pending'] } });
    if (rr) {
      rr.status = 'completed';
      rr.adminDecision = { status: 'approved', decidedBy: adminUserId, decidedAt: new Date(), note: 'Released by admin endpoint' };
      await rr.save();
    }

    return res.json({ message: 'Player released successfully' });
  } catch (e) {
    console.error('Admin release-player error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});




module.exports = router;
