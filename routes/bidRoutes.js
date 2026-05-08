const express = require("express");
const Bid = require("../models/Bid");
const Player = require("../models/Player");
const UserPlayer = require("../models/UserPlayer");
const router = express.Router();
const BidHistory = require("../models/BidHistory.js");
const validateUser = require("../config/validation.js")
const User = require("../models/User.js");
const mongoose = require("mongoose");
const BidNotification = require('../models/BidNotification');
const BidPlayerQueue = require('../models/BidPlayerQueue');
const authenticateJWT = require('../middleware/authJWT');
const { generateDeviceFingerprint } = require('../utils/deviceFingerprint');
const { getClientIp } = require('../utils/network');
const RetainedPlayer = require('../models/RetainedPlayer');
const { invalidateCache } = require('../utils/cache');
const { placeBidCore, countQueuedSlotsForUser, TYPE_LIMIT } = require('../services/bidPlacement');
const bidQueueService = require('../services/bidQueueService');
const { getTopWatchedPlayers, getWatchCountFromAdapter } = require('../utils/playerWatchSocket');
const NodeCache = require('node-cache');

// Tiny hot-path cache for watch-card player lookups (name/profilePicture).
// Keeps UI real-time while avoiding repeated Player.findById calls.
const playerWatchCardCache = new NodeCache({ stdTTL: 30, checkperiod: 60 });
// Very short cache only to absorb burst polling on auction hub.
const auctionHubBurstCache = new NodeCache({ stdTTL: 5, checkperiod: 10 });

async function getPlayerWatchCard(playerId) {
  if (!playerId) return { playerName: '?', profilePicture: null };
  const key = `watch-card:${String(playerId)}`;
  const cached = playerWatchCardCache.get(key);
  if (cached) return cached;
  const pl = await Player.findById(playerId).select('name profilePicture').lean();
  const value = {
    playerName: pl?.name || '?',
    profilePicture: pl?.profilePicture || null,
  };
  playerWatchCardCache.set(key, value);
  return value;
}

async function getCachedQueueMemberships(userId) {
  const key = `queue-memberships:${String(userId)}`;
  const cached = auctionHubBurstCache.get(key);
  if (cached) return cached;
  const value = await bidQueueService.listMyQueueMemberships(userId);
  auctionHubBurstCache.set(key, value);
  return value;
}

async function hasQueuedWaiters(playerId) {
  if (!mongoose.isValidObjectId(playerId)) return false;
  const waitingDoc = await BidPlayerQueue.findOne({
    playerId,
    'entries.status': 'queued',
  })
    .select('_id')
    .lean();
  return !!waitingDoc;
}

// Place a bid
router.put("/:playerId/bid", authenticateJWT, async (req, res) => {
  const { playerId } = req.params;
  const { bidder } = req.body;
  
  // Get IP address and device fingerprint from request
  const clientIP = getClientIp(req);
  const userAgent = req.get('User-Agent') || 'Unknown';
  const extraDeviceInfo = {
    acceptLanguage: req.get('accept-language') || '',
    secChUA: req.get('sec-ch-ua') || '',
    secChPlatform: req.get('sec-ch-ua-platform') || '',
    secChMobile: req.get('sec-ch-ua-mobile') || '',
  };
  const deviceFingerprint = generateDeviceFingerprint(userAgent, clientIP, extraDeviceInfo);
  
  // Verify bidder matches authenticated user
  const authenticatedUserId = req.authenticatedUser._id.toString();
  const bidderId = bidder ? bidder.toString() : null;
  
  if (!bidderId || bidderId !== authenticatedUserId) {
    return res.status(403).json({ 
      message: 'Unauthorized: You can only bid on your own behalf. Bidder ID does not match authenticated user.' 
    });
  }
  
  // Check IP address and device mismatch (warning only, don't block - allow bidding to continue)
  const user = req.authenticatedUser;
  let isSuspiciousIP = false;
  let suspiciousReason = null;
  
  // Skip device/IP checks for admin accounts
  if (!user.isAdmin) {
    // Check device fingerprint mismatch
    if (user.lastDeviceFingerprint && user.lastDeviceFingerprint !== deviceFingerprint) {
      isSuspiciousIP = true;
      if (suspiciousReason) {
        suspiciousReason += ` | Device mismatch: Expected ${user.lastDeviceFingerprint.substring(0, 8)}... but got ${deviceFingerprint.substring(0, 8)}...`;
      } else {
        suspiciousReason = `Device mismatch: Expected ${user.lastDeviceFingerprint.substring(0, 8)}... but got ${deviceFingerprint.substring(0, 8)}...`;
      }
      console.warn(`⚠️ Device Mismatch for user ${user.name} (${user.email})`);
    }
    
    // Check if this device is being used by multiple accounts
    const recentLoginTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const otherUsersSameDevice = await User.find({
      _id: { $ne: user._id },
      isAdmin: false,
      lastDeviceFingerprint: deviceFingerprint,
      lastLoginTime: { $gte: recentLoginTime }
    }).select('name email teamName').limit(3).lean();
    
    if (otherUsersSameDevice.length > 0) {
      isSuspiciousIP = true;
      const otherAccounts = [...new Set(otherUsersSameDevice.map(u => u.teamName || u.name))];
      if (suspiciousReason) {
        suspiciousReason += ` | Device shared with: ${otherAccounts.join(', ')}`;
      } else {
        suspiciousReason = `Device shared with: ${otherAccounts.join(', ')}`;
      }
    }
  }

  try {
    // Manual-bid guard: queue slots also consume active bid capacity.
    // If a user already used remaining slots via queue, block new manual entry.
    const playerForCapacity = await Player.findById(playerId).select('type');
    if (playerForCapacity) {
      const userForCapacity = await User.findById(authenticatedUserId).select('boughtPlayers currentBids');
      const alreadyBiddingThisPlayer = !!userForCapacity?.currentBids?.some(
        (bid) => bid.playerId.toString() === playerId
      );

      if (userForCapacity && !alreadyBiddingThisPlayer) {
        const { totalQueued, byType } = await countQueuedSlotsForUser(authenticatedUserId, null);
        const currentBidPlayerIds = (userForCapacity.currentBids || []).map((bid) => bid.playerId);
        const [boughtPlayersOfThisType, playersOfThisTypeInCurrentBids] = await Promise.all([
          Player.countDocuments({
            _id: { $in: userForCapacity.boughtPlayers || [] },
            type: playerForCapacity.type,
          }),
          Player.countDocuments({
            _id: { $in: currentBidPlayerIds },
            type: playerForCapacity.type,
          }),
        ]);

        if (playerForCapacity.type === 'Gold' || playerForCapacity.type === 'Silver') {
          const maxConcurrentBids = TYPE_LIMIT[playerForCapacity.type] - boughtPlayersOfThisType;
          const queuedOfThisType = byType[playerForCapacity.type] || 0;
          if (playersOfThisTypeInCurrentBids + queuedOfThisType >= maxConcurrentBids) {
            return res.status(400).json({
              message: `Manual bid blocked: your ${playerForCapacity.type} slots are already occupied by active bids + queue entries. Exit a ${playerForCapacity.type} bid/queue slot first.`,
            });
          }
        } else if (playerForCapacity.type === 'Emerald' || playerForCapacity.type === 'Sapphire') {
          const queuedOfThisType = byType[playerForCapacity.type] || 0;
          const maxConcurrentTypeBids = TYPE_LIMIT[playerForCapacity.type] - boughtPlayersOfThisType;
          if (playersOfThisTypeInCurrentBids + queuedOfThisType >= maxConcurrentTypeBids) {
            return res.status(400).json({
              message: `Manual bid blocked: your ${playerForCapacity.type} slots are already occupied by active bids + queue entries. Exit a ${playerForCapacity.type} bid/queue slot first.`,
            });
          }

          const [combinedESBought, combinedESInCurrentBids] = await Promise.all([
            Player.countDocuments({
              _id: { $in: userForCapacity.boughtPlayers || [] },
              type: { $in: ['Emerald', 'Sapphire'] },
            }),
            Player.countDocuments({
              _id: { $in: currentBidPlayerIds },
              type: { $in: ['Emerald', 'Sapphire'] },
            }),
          ]);
          const queuedES = (byType.Emerald || 0) + (byType.Sapphire || 0);
          const maxConcurrentESBids = 5 - combinedESBought;
          if (combinedESInCurrentBids + queuedES >= maxConcurrentESBids) {
            return res.status(400).json({
              message: 'Manual bid blocked: Emerald + Sapphire slots are already occupied by active bids + queue entries. Exit one first.',
            });
          }
        } else if ((userForCapacity.currentBids || []).length + totalQueued >= 6) {
          return res.status(400).json({
            message: 'Manual bid blocked: your concurrent bid slots are occupied by active bids + queue entries. Exit one first.',
          });
        }
      }
    }

    const blocked = await bidQueueService.shouldBlockManualBid(playerId, authenticatedUserId);
    if (blocked) {
      return res.status(409).json({
        message:
          "Manual bidding is paused for this player while users are in the bid queue. Join the queue or wait until it clears. Only the two active bidders may bid.",
      });
    }

    const proxyBidder = await bidQueueService.isPromotedProxyBidder(
      playerId,
      authenticatedUserId
    );
    if (proxyBidder) {
      return res.status(403).json({
        message:
          "You were promoted from the bid queue: auto-bidding is active up to your max. You cannot place manual bids — use Exit to leave the auction.",
      });
    }

    const io = req.app.get("io");
    const result = await placeBidCore({
      playerId,
      bidderId: bidder,
      clientIP,
      deviceFingerprint,
      isSuspiciousIP,
      io,
    });

    if (!result.ok) {
      return res.status(result.status).json({ message: result.message });
    }

    await bidQueueService.afterBidPlaced(playerId, io);
    await bidQueueService.triggerProxyAfterOpponentBid(playerId, io);

    res.json({
      message: "Bid placed successfully",
      currentBid: result.player.currentBid,
      currentBidder: result.player.currentBidder,
      newBid: result.newBid,
    });
  } catch (error) {
    console.error("Error placing bid:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});


// Exit From Bid
router.post("/:playerId/exit", authenticateJWT, async (req, res) => {
  const { playerId } = req.params;
  const userId = req.authenticatedUser._id.toString();

  try {
    // Find the player
    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ message: "Player not found" });
    }

    // Check if the player is already sold
    if (player.isSold) {
      return res.status(400).json({ message: "Cannot exit bid for a sold player." });
    }

    // Fetch the user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    // Fetch all active bids for the player
    const activeBids = await Bid.find({ playerId, isActive: true })
      .select('bidder bidAmount')
      .sort({ bidAmount: -1 })
      .lean();

    if (!activeBids || activeBids.length === 0) {
      return res.status(400).json({ message: "No active bids found for this player." });
    }

    // Check if the user is an admin
    if (user.isAdmin) {
      if (activeBids.length > 1) {
        const secondHighestBid = activeBids[1]; // Second-highest bidder
        const secondHighestBidder = await User.findById(secondHighestBid.bidder);

        if (secondHighestBidder) {
          const lockedAmount = secondHighestBidder.currentBids.find(
            (bid) => bid.playerId.toString() === playerId
          ).amount;

          const purse = parseFloat(secondHighestBidder.purse.toString());
          secondHighestBidder.purse = mongoose.Types.Decimal128.fromString(
            (purse + lockedAmount).toString()
          );

          // Remove the second-highest bid from their current bids
          secondHighestBidder.currentBids = secondHighestBidder.currentBids.filter(
            (bid) => bid.playerId.toString() !== playerId
          );
          await secondHighestBidder.save();

          // Mark the second-highest bid as inactive
          await Bid.updateMany(
            { playerId, bidder: secondHighestBid.bidder },
            { $set: { isActive: false, isBidOn: false } }
          );

          // Update the player's current bid and bidder
          const remainingBidders = activeBids.filter((bid) => bid.bidder.toString() !== secondHighestBid.bidder);
          if (remainingBidders.length > 0) {
            const newHighestBid = remainingBidders[0];
            player.currentBid = newHighestBid.bidAmount;
            player.currentBidder = newHighestBid.bidder;
          } else {
            // If no other bidders, reset the player's current bid
            player.currentBid = null;
            player.currentBidder = null;
          }
          await player.save();

          const ioAdmin = req.app.get("io");
          await bidQueueService.tryPromoteNextQueued(playerId, ioAdmin);

          return res.json({
            message: "The second-highest bidder has exited successfully. Locked amount refunded.",
            currentBid: player.currentBid,
            currentBidder: player.currentBidder,
          });
        }
      } else {
        return res.status(400).json({ message: "No second-highest bidder to exit." });
      }
    }

    // Check if the user has placed a bid on this player
    const userBid = user.currentBids.find((bid) => bid.playerId.toString() === playerId);
    if (!userBid) {
      return res.status(400).json({ message: "You cannot exit as you have not placed a bid on this player." });
    }

    // Ensure the user is not the highest bidder
    const highestBid = activeBids[0];
    if (highestBid.bidder.toString() === userId) {
      return res.status(400).json({ message: "The highest bidder cannot exit the bid." });
    }

    // Unlock the amount locked for this player
    const lockedAmount = userBid.amount;
    const purse = parseFloat(user.purse.toString()); // Convert Decimal128 to Number
    user.purse = mongoose.Types.Decimal128.fromString((purse + lockedAmount).toString());

    // Remove the bid from user's current bids
    user.currentBids = user.currentBids.filter((bid) => bid.playerId.toString() !== playerId);
    await user.save();

    // Mark the user's bid for this player as inactive
    await Bid.updateMany({ playerId, bidder: userId }, { $set: { isActive: false, isBidOn: false } });

    // Update the player's current bid and bidder
    const otherBidders = activeBids.filter((bid) => bid.bidder.toString() !== userId);
    if (otherBidders.length > 0) {
      const newHighestBid = otherBidders[0];
      player.currentBid = newHighestBid.bidAmount;
      player.currentBidder = newHighestBid.bidder;
    } else {
      // If no other bidders, reset the player's current bid
      player.currentBid = null;
      player.currentBidder = null;
    }
    await player.save();
    // Emit exit notification for admin branch
    const io = req.app.get('io');
    const notificationData = {
      message: `Bid exit: ${user.name} (2nd highest) has exited the bid on ${player.name}. Locked amount refunded.`,
      playername: player.name,
      playerId: player._id,
      currentBid: player.currentBid,
      currentBidder: player.currentBidder,
      exitedUser: user.name,
      exitBy: user.isAdmin ? 'system' : 'user'
    };
    // Save notification to database
    const newNotification = new BidNotification(notificationData);
    await newNotification.save();

    // 🚀 NOTIFICATION: Emit real-time notification ONLY to remaining bidders (not the exited user)
    const { getSocketIdsForUsers } = require('../utils/socketUserMap');
    
    // Get remaining active bidders (excluding the exited user)
    const remainingActiveBids = await Bid.find({ playerId, isActive: true, isBidOn: true })
      .select('bidder')
      .lean();
    const remainingBidders = remainingActiveBids.map(bid => bid.bidder.toString());
    
    // Only notify remaining bidders (exclude the user who exited)
    const socketIds = getSocketIdsForUsers(remainingBidders);
    
    if (socketIds.length > 0) {
      socketIds.forEach(socketId => {
        io.to(socketId).emit('bid_exit_notification', notificationData);
      });
      console.log(`📢 Exit notification sent to ${socketIds.length} remaining bidders for player ${player.name}`);
    } else {
      // Fallback: if no sockets found, broadcast
      console.warn(`⚠️ No remaining bidder sockets found, broadcasting to all`);
      io.emit('bid_exit_notification', notificationData);
    }
    
    // 🚀 PERFORMANCE: Invalidate caches when bid is exited
    invalidateCache('user-purses');
    invalidateCache('players:data');
    
    // 🚀 REALTIME: Broadcast player bid update to all clients
    io.emit('player_bid_update', {
      playerId: playerId.toString(),
      currentBid: player.currentBid,
      currentBidder: player.currentBidder,
      playerName: player.name
    });

    await bidQueueService.tryPromoteNextQueued(playerId, io);
    
    res.json({
      message: "You have exited the bid successfully. Locked amount refunded.",
      currentBid: player.currentBid,
      currentBidder: player.currentBidder,
    });
  } catch (error) {
    console.error("Error exiting bid:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Sold the player 
router.post("/bid/sold", async (req, res) => {
  try {
    // The UI can send either:
    // 1) { playerID: "..." } for a single player
    // 2) { playerIDs: ["...", "..."] } for multiple players
    const { playerID, playerIDs } = req.body;

    // Determine which IDs to process
    let idsToSell = [];

    if (Array.isArray(playerIDs) && playerIDs.length > 0) {
      // If user passed an array of IDs
      idsToSell = playerIDs;
    } else if (playerID) {
      // If user passed a single ID
      idsToSell = [playerID];
    } else {
      return res.status(400).json({ message: "No player ID(s) provided." });
    }

    // We'll store the result for each player
    const results = [];

    // Process each player ID with the EXACT same logic as your single "sold" code
    for (const pid of idsToSell) {
      try {
        // 1. Find the player
        const player = await Player.findById(pid);
        if (!player) {
          results.push({
            playerID: pid,
            status: "error",
            message: "Player not found",
          });
          continue;
        }

        // 2. Check if the player is already sold
        if (player.isSold) {
          results.push({
            playerID: pid,
            status: "error",
            message: "Player is already sold.",
          });
          continue;
        }

        // 3. Fetch only active/in-progress bids to find the highest bid
        const allBids = await Bid.find({
          playerId: pid,
          isActive: true,
          isBidOn: true
        }).sort({ bidAmount: -1 });
        if (!allBids || allBids.length === 0) {
          results.push({
            playerID: pid,
            status: "error",
            message: "No active bids found for this player.",
          });
          continue;
        }

        if (await hasQueuedWaiters(pid)) {
          results.push({
            playerID: pid,
            status: "error",
            message: "Cannot sell: players with waiting queue users must not be sold until queue clears.",
          });
          continue;
        }

        // Safety guard: never allow manual sell while 2+ active bidders exist.
        const uniqueBidders = new Set(allBids.map((b) => b.bidder?.toString()).filter(Boolean));
        if (uniqueBidders.size > 1) {
          results.push({
            playerID: pid,
            status: "error",
            message: "Cannot sell: second bidder has not exited. Only sell when one bidder remains.",
          });
          continue;
        }

        // 4. Highest bid (regardless of active status)
        const highestBid = allBids[0];
        
        // Get all users who have this player in their currentBids (for cleanup)
        const usersWithBidsOnThisPlayer = await User.find({
          'currentBids.playerId': pid
        }).select('_id purse currentBids');

        // 5. Mark all bids as inactive
        await Bid.updateMany({ playerId: pid }, { $set: { isActive: false } });

        // 6. Check if there's already a UserPlayer doc
        const existingUserPlayer = await UserPlayer.findOne({
          playerId: pid,
          userId: highestBid.bidder,
          isActive: true,
        });
        if (existingUserPlayer) {
          results.push({
            playerID: pid,
            status: "error",
            message:
              "User already has this player active sold on last click. Stop clicking sold, it's already sold.",
          });
          continue;
        }

        // 7. Otherwise, create a new UserPlayer doc
        const newUserPlayer = new UserPlayer({
          playerId: pid,
          userId: highestBid.bidder,
          bidValue: highestBid.bidAmount,
          isActive: true,
        });
        await newUserPlayer.save();

        // 8. Log the sold bid in the BidHistory schema
        const bidHistory = await BidHistory.findOne({ playerId: pid });
        if (!bidHistory) {
          await new BidHistory({
            playerId: pid,
            bidID: highestBid._id,
            bids: allBids.map((bid) => ({
              userID: bid.bidder,
              bidAmount: bid.bidAmount,
              status: bid._id.toString() === highestBid._id.toString(),
              createdAt: bid.createdAt,
              updatedAt: bid.updatedAt,
            })),
          }).save();
        } else {
          bidHistory.bids.forEach((history) => {
            if (history._id.toString() === highestBid._id.toString()) {
              history.status = true;
            }
          });
          await bidHistory.save();
        }

        // 9. Fetch the winning user
        const winningUser = await User.findById(highestBid.bidder);
        if (!winningUser) {
          results.push({
            playerID: pid,
            status: "error",
            message: "Winning bidder not found.",
          });
          continue;
        }

        // 10. Ensure user has enough balance
        const winningBid = winningUser.currentBids.find(
          (bid) => bid.playerId.toString() === pid
        );
        const lockedAmount = winningBid ? winningBid.amount : 0;
        const totalPurse = parseFloat(winningUser.purse.toString());

        if (totalPurse + lockedAmount < highestBid.bidAmount) {
          results.push({
            playerID: pid,
            status: "error",
            message: "Insufficient purse balance for the winning bidder.",
          });
          continue;
        }

        // 11. Deduct the bid amount and update user's current bids
        winningUser.purse = mongoose.Types.Decimal128.fromString(
          (totalPurse + lockedAmount - highestBid.bidAmount).toString()
        );
        winningUser.currentBids = winningUser.currentBids.filter(
          (bid) => bid.playerId.toString() !== pid
        );
        winningUser.boughtPlayers.push(pid);
        await winningUser.save();

        // 12. Refund other bidders and clean up currentBids (excluding the winner)
        for (const user of usersWithBidsOnThisPlayer) {
          // Skip the winner as they were already processed above
          if (user._id.equals(highestBid.bidder)) {
            continue;
          }
          
          const userBid = user.currentBids.find(cb => cb.playerId.equals(pid));
          if (userBid) {
            const lockedAmount = userBid.amount || 0;
            const purse = parseFloat(user.purse.toString());
            
            // Refund the locked amount
            user.purse = mongoose.Types.Decimal128.fromString((purse + lockedAmount).toString());
            
            // Remove this player from currentBids
            user.currentBids = user.currentBids.filter(cb => !cb.playerId.equals(pid));
            await user.save();
          }
        }

        // 13. Mark the player as sold - GUARANTEED to set both isSold and isActive to true
        let playerStatusUpdated = false;
        
        try {
          // Method 1: Direct save
          player.isSold = true;
          player.isActive = true;
          player.currentBid = highestBid.bidAmount;
          player.currentBidder = highestBid.bidder;
          if (player.currentBids !== undefined) delete player.currentBids;
          await player.save();
          playerStatusUpdated = true;
          console.log(`✅ Player ${pid} marked as sold and active (method 1)`);
        } catch (playerUpdateError) {
          console.error(`❌ Method 1 failed for player ${pid}:`, playerUpdateError);
          
          try {
            // Method 2: findByIdAndUpdate
            await Player.findByIdAndUpdate(pid, {
              $set: {
                isSold: true,
                isActive: true,
                currentBid: highestBid.bidAmount,
                currentBidder: highestBid.bidder
              },
              $unset: { currentBids: "" }
            });
            playerStatusUpdated = true;
            console.log(`✅ Player ${pid} marked as sold and active (method 2)`);
          } catch (fallbackError) {
            console.error(`❌ Method 2 failed for player ${pid}:`, fallbackError);
            
            try {
              // Method 3: Direct MongoDB update
              await Player.updateOne(
                { _id: pid },
                {
                  $set: {
                    isSold: true,
                    isActive: true,
                    currentBid: highestBid.bidAmount,
                    currentBidder: highestBid.bidder
                  },
                  $unset: { currentBids: "" }
                }
              );
              playerStatusUpdated = true;
              console.log(`✅ Player ${pid} marked as sold and active (method 3)`);
            } catch (finalError) {
              console.error(`❌ ALL METHODS FAILED for player ${pid}:`, finalError);
              throw new Error(`Failed to update player status after all attempts: ${finalError.message}`);
            }
          }
        }
        
        // Verify the update was successful
        if (playerStatusUpdated) {
          const verifyPlayer = await Player.findById(pid);
          if (verifyPlayer && verifyPlayer.isSold === true && verifyPlayer.isActive === true) {
            console.log(`✅ VERIFIED: Player ${pid} is correctly sold and active`);
          } else {
            console.error(`❌ VERIFICATION FAILED: Player ${pid} status is incorrect`, {
              isSold: verifyPlayer?.isSold,
              isActive: verifyPlayer?.isActive
            });
            throw new Error(`Player status verification failed for ${pid}`);
          }
        }

        results.push({
          playerID: pid,
          status: "success",
          message: "Player sold successfully.",
          player: player.name,
          highestBid,
          soldTo: highestBid.bidder,
        });
      } catch (err) {
        console.error(`Error selling player ${pid}:`, err);
        results.push({
          playerID: pid,
          status: "error",
          message: err.message || "Internal server error for this player.",
        });
      }
    }

    // Emit socket event for player sold (affects purse values)
    const io = req.app.get('io');
    if (io) {
      io.emit('player_sold', {
        message: 'Player(s) sold - purse values updated',
        timestamp: new Date()
      });
    }

    // 🚀 PERFORMANCE: Invalidate caches when player is sold
    invalidateCache('user-purses');
    invalidateCache('players:data');
    
    // 🚀 REALTIME: Broadcast player sold updates to all clients
    if (io) {
      idsToSell.forEach(pid => {
        io.emit('player_sold_update', {
          playerId: pid.toString(),
          status: 'Sold'
        });
      });
    }
    
    // Return the array of results for each player
    res.status(200).json({ results });
  } catch (error) {
    console.error("Error marking player(s) as sold:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

// Release Sold Player
router.post("/release-player", async (req, res) => {
  const { playerId } = req.body;

  try {
    // Find the player
    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ message: "Player not found." });
    }

    // Check if the player is sold
    if (!player.isSold) {
      return res.status(400).json({ message: "Player is not sold and cannot be released." });
    }

    // Find the user who owns the player
    const userPlayerEntry = await UserPlayer.findOne({ playerId, isActive: true });
    if (!userPlayerEntry) {
      return res.status(400).json({ message: "No active owner found for this player." });
    }

    const userId = userPlayerEntry.userId;

    // Find the user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "Owner not found." });
    }

    // Revert the money spent on the player back to the user's purse
    const spentAmount = parseFloat(userPlayerEntry.bidValue); // Amount spent on the player
    const purse = parseFloat(user.purse.toString());

    user.purse = mongoose.Types.Decimal128.fromString((purse + spentAmount).toString());

    // Remove the player from the user's boughtPlayers
    const playerIndex = user.boughtPlayers.findIndex(
      (pId) => pId.toString() === playerId.toString()
    );
    if (playerIndex !== -1) {
      user.boughtPlayers.splice(playerIndex, 1);
    }

    await user.save();

    // Update the player's status
    player.isSold = false;
    player.currentBid = player.basePrice; // Reset bidding to start from the base price
    player.currentBidder = null; // Clear the current bidder
    player.releasedAt = new Date(); // Pick-from-unsold blocked for 48h after release
    await player.save();

    // Mark the UserPlayer entry as inactive
    userPlayerEntry.isActive = false;
    await userPlayerEntry.save();

    // Delete all bids for this player from the Bid collection
    await Bid.deleteMany({ playerId });

    res.status(200).json({
      message:
        "Player released successfully, money reverted, bidding reset to base price, and all bids cleared.",
      player,
    });
  } catch (error) {
    console.error("Error releasing player:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

// exit second highest user from player 
// Function: Exit second-highest bidder for a single player
async function exitSecondHighestForPlayerSingle(playerId, io = null) {
  try {
    // Find the player
    const player = await Player.findById(playerId);
    if (!player) {
      return { error: "Player not found" };
    }

    // Check if the player is already sold
    if (player.isSold) {
      return { error: "Cannot exit bid for a sold player." };
    }

    // Fetch all active bids for the player
    const activeBids = await Bid.find({ playerId, isActive: true }).sort({ bidAmount: -1 });
    
    if (activeBids.length > 1) {
      const secondHighestBid = activeBids[1]; // Second-highest bidder
      const secondHighestBidder = await User.findById(secondHighestBid.bidder);

      if (secondHighestBidder) {
        const lockedAmount = secondHighestBidder.currentBids.find(
          (bid) => bid.playerId.toString() === playerId
        )?.amount;

        if (lockedAmount) {
          const purse = parseFloat(secondHighestBidder.purse.toString());
          secondHighestBidder.purse = mongoose.Types.Decimal128.fromString(
            (purse + lockedAmount).toString()
          );

          // Remove the second-highest bid from their current bids
          secondHighestBidder.currentBids = secondHighestBidder.currentBids.filter(
            (bid) => bid.playerId.toString() !== playerId
          );
          await secondHighestBidder.save();
        }

        // Mark the second-highest bid as inactive
        await Bid.updateMany(
          { playerId, bidder: secondHighestBid.bidder },
          { $set: { isActive: false, isBidOn: false } }
        );

        // Update the player's current bid and bidder
        const remainingBidders = activeBids.filter((bid) => bid.bidder.toString() !== secondHighestBid.bidder);
        if (remainingBidders.length > 0) {
          const newHighestBid = remainingBidders[0];
          player.currentBid = newHighestBid.bidAmount;
          player.currentBidder = newHighestBid.bidder;
        } else {
          // If no other bidders, reset the player's current bid
          player.currentBid = null;
          player.currentBidder = null;
        }
        player.lastExitAt = new Date();
        player.lastExitBy = 'system';
        await player.save();

        // If queue has waiters and exactly one active bidder remains, auto-promote next queued user.
        await bidQueueService.tryPromoteNextQueued(playerId, io);

        return {
          message: "The second-highest bidder has exited successfully. Locked amount refunded.",
          currentBid: player.currentBid,
          currentBidder: player.currentBidder,
        };
      }
    }
    return { message: "No second-highest bidder to exit." };
  } catch (error) {
    console.error("Error exiting second-highest bidder:", error);
    throw error;
  }
}

router.post("/:playerId/exit-second-highest", authenticateJWT, async (req, res) => {
  try {
    if (!req.authenticatedUser.isAdmin) {
      return res.status(403).json({ message: "Only admin can exit the second-highest bidder." });
    }
    const { playerId } = req.params;
    const result = await exitSecondHighestForPlayerSingle(playerId, req.app.get('io'));
    
    if (result.error) {
      return res.status(result.error === "Player not found" ? 404 : 400).json({ message: result.error });
    }
    
    return res.json(result);
  } catch (error) {
    console.error("Error bulk-exiting second-highest bidders:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});


// Function: Get unsold players
async function getUnsoldPlayers() {
  try {
    const players = await Player.find({ isSold: false, isActive: true });
    return {
      count: players.length,
      players
    };
  } catch (error) {
    console.error("Error fetching players:", error);
    throw error;
  }
}

router.get('/players', async (req, res) => {
  try {
    let players;
    if (req.query.filter === 'unsold') {
      const result = await getUnsoldPlayers();
      return res.json(result);
    } else {
      players = await Player.find();
      return res.json({
        count: players.length,
        players
      });
    }
  } catch (error) {
    console.error("Error fetching players:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});


// Function: Get bidder count for a player
// Returns: count=0 when ONLY ONE active bidder (second has exited) → SELL
//          count=1 when TWO+ active bidders (second hasn't exited) → EXIT first, never sell
async function getBidderCount(playerId) {
  try {
    const activeBids = await Bid.find({
      playerId,
      isActive: true,
      isBidOn: true,
    }).select('bidder').lean();

    if (activeBids.length === 0) {
      return { count: 1 }; // no bids → keep polling, don't sell
    }

    const uniqueBidders = new Set(activeBids.map((b) => b.bidder?.toString()).filter(Boolean));

    // count=0: one bidder only (second exited) → scheduler will SELL
    // count=1: two+ bidders (second hasn't exited) → scheduler will EXIT, never sell
    const count = uniqueBidders.size === 1 ? 0 : 1;

    return { count };
  } catch (error) {
    console.error("Error fetching bidder count:", error);
    throw error;
  }
}

router.get('/players/:playerId/bidders', async (req, res) => {
  try {
    const { playerId } = req.params;
    const result = await getBidderCount(playerId);
    return res.json(result);
  } catch (error) {
    console.error("Error fetching bidder count:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});



// Function: Sell a single player (used by cron)
async function sellPlayer(playerId, io = null) {
  try {
    // Filter out invalid IDs & already‐sold players
    if (!mongoose.isValidObjectId(playerId)) {
      return {
        playerID: playerId,
        status: 'error',
        message: 'Invalid player ID.'
      };
    }
    
    // Early validation (for performance - atomic operations below handle race conditions)
    const pl = await Player.findById(playerId).select('isSold');
    if (!pl) {
      return {
        playerID: playerId,
        status: 'error',
        message: 'Player not found.'
      };
    }
    if (pl.isSold) {
      return {
        playerID: playerId,
        status: 'error',
        message: 'Player already sold.'
      };
    }

    if (await hasQueuedWaiters(playerId)) {
      return {
        playerID: playerId,
        status: 'error',
        message: 'Cannot sell: queue has waiting users for this player.',
      };
    }

    // b) Fetch only active/in-progress bids to find the highest bid
    const allBids = await Bid.find({
      playerId: playerId,
      isActive: true,
      isBidOn: true
    }).sort({ bidAmount: -1 });
    if (!allBids.length) {
      return { playerID: playerId, status: 'error', message: 'No active bids found.' };
    }

    // CRITICAL: Never sell when second bidder is still active (2+ bidders)
    const uniqueBidders = new Set(allBids.map((b) => b.bidder?.toString()).filter(Boolean));
    if (uniqueBidders.size > 1) {
      console.warn(`🛑 BLOCKED SELL: Player ${playerId} has ${uniqueBidders.size} active bidders – refusing to sell until second exits`);
      return {
        playerID: playerId,
        status: 'error',
        message: 'Cannot sell: second bidder has not exited. Only sell when one bidder remains.'
      };
    }

    // Find the highest bid (regardless of active status)
    const highestBid = allBids[0];
    
    // Get all users who have this player in their currentBids (for cleanup)
    const usersWithBidsOnThisPlayer = await User.find({
      'currentBids.playerId': playerId
    }).select('_id purse currentBids');

    // c) Deactivate all bids
    await Bid.updateMany({ playerId: playerId }, { $set: { isActive: false } });

    // d) ATOMIC OPERATION: Atomically check and create UserPlayer
    // Use findOneAndUpdate with upsert to atomically check if UserPlayer exists and create if not
    // The unique index on (playerId, userId, isActive: true) will prevent duplicates at DB level
    try {
      // First, atomically check if Player is still unsold and mark as sold in one operation
      const playerUpdateResult = await Player.findOneAndUpdate(
        {
          _id: playerId,
          isSold: false  // Only update if not already sold (atomic check)
        },
        {
          $set: {
            isSold: true,
            isActive: true,
            currentBid: highestBid.bidAmount,
            currentBidder: highestBid.bidder,
            updatedAt: new Date()
          },
          $unset: { currentBids: "" }
        },
        {
          new: true,
          runValidators: true
        }
      );

      // If player was already sold (update returned null), check for existing UserPlayer
      if (!playerUpdateResult) {
        const existingUP = await UserPlayer.findOne({
          playerId: playerId,
          userId: highestBid.bidder,
          isActive: true
        });
        if (existingUP) {
          return {
            playerID: playerId,
            status: 'error',
            message: 'Player already sold to this user.'
          };
        }
        return {
          playerID: playerId,
          status: 'error',
          message: 'Player was already sold by another process.'
        };
      }

      // Now atomically create UserPlayer - the unique index will prevent duplicates
      // Use findOneAndUpdate with upsert: false to ensure we only create if it doesn't exist
      const existingUserPlayer = await UserPlayer.findOne({
        playerId: playerId,
        userId: highestBid.bidder,
        isActive: true
      });

      if (existingUserPlayer) {
        // Another process created it between our checks - this is rare but possible
        return {
          playerID: playerId,
          status: 'error',
          message: 'Player already sold to this user (race condition detected).'
        };
      }

      // Create UserPlayer - unique index will prevent duplicates if two processes reach here simultaneously
      try {
        await new UserPlayer({
          playerId: playerId,
          userId: highestBid.bidder,
          bidValue: highestBid.bidAmount,
          isActive: true
        }).save();
      } catch (saveError) {
        // Handle unique index violation (duplicate key error)
        if (saveError.code === 11000 || saveError.code === 11001) {
          return {
            playerID: playerId,
            status: 'error',
            message: 'Player already sold to this user (unique constraint prevented duplicate).'
          };
        }
        // Re-throw other errors
        throw saveError;
      }
    } catch (error) {
      // If Player update failed, rollback is not needed since we use atomic operations
      throw error;
    }

    // f) Log BidHistory
    let bidHist = await BidHistory.findOne({ playerId: playerId });
    if (!bidHist) {
      await new BidHistory({
        playerId: playerId,
        bidID: highestBid._id,
        bids: allBids.map(b => ({
          userID: b.bidder,
          bidAmount: b.bidAmount,
          status: b._id.equals(highestBid._id),
          createdAt: b.createdAt,
          updatedAt: b.updatedAt
        }))
      }).save();
    } else {
      bidHist.bids = bidHist.bids.map(h => ({
        ...h.toObject(),
        status: h._id.equals(highestBid._id)
      }));
      await bidHist.save();
    }

    // g) Adjust winner's purse & currentBids
    const winner = await User.findById(highestBid.bidder);
    const locked = winner.currentBids.find(cb => cb.playerId.equals(playerId))?.amount || 0;
    const purse = parseFloat(winner.purse.toString());
    winner.purse = mongoose.Types.Decimal128.fromString(
      (purse + locked - highestBid.bidAmount).toString()
    );
    winner.currentBids = winner.currentBids.filter(cb => !cb.playerId.equals(playerId));
    winner.boughtPlayers.push(playerId);
    await winner.save();

    // h) Refund other bidders and clean up currentBids (excluding the winner)
    for (const user of usersWithBidsOnThisPlayer) {
      // Skip the winner as they were already processed above
      if (user._id.equals(highestBid.bidder)) {
        continue;
      }
      
      const userBid = user.currentBids.find(cb => cb.playerId.equals(playerId));
      if (userBid) {
        const lockedAmount = userBid.amount || 0;
        const purse = parseFloat(user.purse.toString());
        
        // Refund the locked amount
        user.purse = mongoose.Types.Decimal128.fromString((purse + lockedAmount).toString());
        
        // Remove this player from currentBids
        user.currentBids = user.currentBids.filter(cb => !cb.playerId.equals(playerId));
        await user.save();
      }
    }

    // i) Player is already marked as sold atomically in step (d) above
    // Verify the update was successful
    const verifyPlayer = await Player.findById(playerId);
    if (verifyPlayer && verifyPlayer.isSold === true && verifyPlayer.isActive === true) {
      console.log(`✅ VERIFIED: Player ${playerId} is correctly sold and active`);
    } else {
      console.error(`❌ VERIFICATION FAILED: Player ${playerId} status is incorrect`, {
        isSold: verifyPlayer?.isSold,
        isActive: verifyPlayer?.isActive
      });
      throw new Error(`Player status verification failed for ${playerId}`);
    }

    return {
      playerID: playerId,
      status: 'success',
      message: 'Player sold successfully.',
      soldTo: highestBid.bidder.toString(),
      bidAmount: highestBid.bidAmount
    };
  } catch (err) {
    console.error(`❌ Error selling player ${playerId}:`, err);
    return {
      playerID: playerId,
      status: 'error',
      message: err.message || 'Internal error for this player.',
      errorType: err.name || 'Unknown'
    };
  }
}

router.post('/players/:playerId?/soldcrone', async (req, res) => {
  try {
    const { playerId: paramId } = req.params;
    const { resultMain, playerIDs, playerID } = req.body;
    const io = req.app.get('io');

    // 1) Gather all candidate IDs
    let idsToSell = [];
    if (Array.isArray(resultMain) && resultMain.length) {
      idsToSell = resultMain;
    } else if (Array.isArray(playerIDs) && playerIDs.length) {
      idsToSell = playerIDs;
    } else if (playerID) {
      idsToSell = [playerID];
    } else if (paramId) {
      idsToSell = [paramId];
    } else {
      return res.status(400).json({ message: 'No player ID(s) provided.' });
    }

    // 2) Filter out invalid IDs & already‐sold players
    const unsoldIds = [];
    for (const pid of idsToSell) {
      if (!mongoose.isValidObjectId(pid)) continue;
      const pl = await Player.findById(pid).select('isSold');
      if (pl && !pl.isSold) unsoldIds.push(pid);
    }

    if (unsoldIds.length === 0) {
      return res
        .status(200)
        .json({ message: 'No unsold players to process.', results: [] });
    }

    const results = [];

    // 3) Process players in batches of 5 for cron selling to prevent overwhelming the system
    const BATCH_SIZE = 5;
    const totalPlayers = unsoldIds.length;
    let processedCount = 0;
    
    console.log(`🔄 CRON: Starting batch processing: ${totalPlayers} players in batches of ${BATCH_SIZE}`);
    
    for (let i = 0; i < unsoldIds.length; i += BATCH_SIZE) {
      const batch = unsoldIds.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(unsoldIds.length / BATCH_SIZE);
      
      console.log(`📦 CRON: Processing batch ${batchNumber}/${totalBatches}: ${batch.length} players`);
      
      // Process each player in the current batch
      for (const pid of batch) {
        const result = await sellPlayer(pid, io);
        results.push(result);
        processedCount++;
        if (result.status === 'success') {
          console.log(`✅ CRON: Player ${pid} sold successfully (${processedCount}/${totalPlayers})`);
        } else {
          console.error(`❌ CRON: Error selling player ${pid}:`, result.message);
        }
      }
      
      // Add a small delay between batches to prevent overwhelming the system
      if (i + BATCH_SIZE < unsoldIds.length) {
        console.log(`⏳ CRON: Batch ${batchNumber} completed. Waiting 1 second before next batch...`);
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
      }
    }
    
    console.log(`🎉 CRON: Batch processing completed: ${processedCount}/${totalPlayers} players processed`);

    // 4) Send back detailed results
    return res.status(200).json({ results });
  } catch (error) {
    console.error('Error in soldcrone handler:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
});


// Function: Get players with exactly one active bid
async function getSingleBidPlayers() {
  try {
    const result = await Bid.aggregate([
      {
        $group: {
          _id: '$playerId',
          totalBids: { $sum: 1 },
          activeBidsCount: {
            $sum: {
              $cond: [ '$isActive', 1, 0 ]
            }
          }
        }
      },
    
      // 2) Keep only players with exactly 1 bid total, and that bid must be active
      {
        $match: {
          totalBids: 1,
          activeBidsCount: 1
        }
      },
    
      // 3) Project just the playerId
      {
        $project: {
          _id: 0,
          playerID: '$_id'
        }
      }
    ]);
    const resultMain = result.map(r => r.playerID);
    return { resultMain };
  } catch (err) {
    console.log(err);
    throw err;
  }
}

router.post("/players/singlebid", async (req, res) => {
  try {
    const result = await getSingleBidPlayers();
    res.status(200).json(result);
  } catch (err) {
    console.log(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

/**
 * POST /api/bids/exit-second-highest/all
 *
 * Loops through all unsold players, and for each with 2+ active bids,
 * removes the second-highest bidder and refunds their locked amount.
 * Returns a summary of how many players were processed.
 */

// Helper: encapsulate your existing exit logic into a function
async function exitBidForUserOnPlayer(userId, playerId, io = null, exitBy = 'user') {
  // 1) Load player
  const player = await Player.findById(playerId);
  if (!player)   return { playerId, userId, error: "Player not found" };
  if (player.isSold) return { playerId, userId, error: "Player already sold" };

  // 2) Load user
  const user = await User.findById(userId);
  if (!user)     return { playerId, userId, error: "User not found" };

  // 3) Fetch active bids (descending)
  const activeBids = await Bid.find({ playerId, isActive: true }).sort({ bidAmount: -1 });
  if (!activeBids.length) return { playerId, userId, error: "No active bids" };

  // — Admin branch: remove second-highest bidder only —
  

  // — Non-admin branch: user exits own bid —
  const myBid = user.currentBids.find(b => b.playerId.toString() === playerId);
  if (!myBid) {
    return { playerId, userId, error: "User has no bid to exit" };
  }
  if (activeBids[0].bidder.toString() === userId) {
    return { playerId, userId, error: "Highest bidder cannot exit" };
  }

  // Refund user's locked amount
  const lockedAmt = myBid.amount;
  const purse1    = parseFloat(user.purse.toString());
  user.purse      = mongoose.Types.Decimal128.fromString((purse1 + lockedAmt).toString());
  user.currentBids = user.currentBids.filter(b => b.playerId.toString() !== playerId);
  await user.save();

  // Deactivate all bids by this user on that player
  await Bid.updateMany(
    { playerId, bidder: userId },
    { $set: { isActive: false, isBidOn: false } }
  );

  // Recompute player's top bid
  const others = activeBids.filter(b => b.bidder.toString() !== userId);
  if (others.length) {
    player.currentBid    = others[0].bidAmount;
    player.currentBidder = others[0].bidder;
  } else {
    player.currentBid    = null;
    player.currentBidder = null;
  }
  player.lastExitAt = new Date();
  player.lastExitBy = exitBy;
  // Defensive: remove accidental currentBids field if present
  if (player.currentBids !== undefined) delete player.currentBids;
  await player.save();

  // Keep queue flow deterministic for bulk/system exits too.
  await bidQueueService.tryPromoteNextQueued(playerId, io);

  // Create and save notification
  const notificationData = {
    message:      `Bid exit: ${user.name} exited on ${player.name}.`,
    playername:   player.name,
    playerId:     player._id,
    currentBid:   player.currentBid,
    currentBidder:player.currentBidder,
    exitedUser:   user.name,
    exitBy
  };
  
  const newNotification = new BidNotification(notificationData);
  await newNotification.save();
  
  // 🚀 NOTIFICATION: Emit real-time notification ONLY to relevant users
  if (io) {
    const { getSocketIdsForUsers } = require('../utils/socketUserMap');
    
    // Get remaining active bidders (excluding the exited user)
    const remainingActiveBids = await Bid.find({ playerId, isActive: true, isBidOn: true }).lean();
    const remainingBidders = remainingActiveBids.map(bid => bid.bidder.toString());
    
    // Only notify remaining bidders (exclude the user who exited - they don't need notification about their own exit)
    const socketIds = getSocketIdsForUsers(remainingBidders);
    
    if (socketIds.length > 0) {
      socketIds.forEach(socketId => {
        io.to(socketId).emit('bid_exit_notification', notificationData);
      });
      console.log(`📢 Exit notification sent to ${socketIds.length} users for player ${player.name}`);
    } else {
      // Fallback: if no sockets found, broadcast
      console.warn(`⚠️ No user sockets found, broadcasting to all`);
      io.emit('bid_exit_notification', notificationData);
    }
  }

  return {
    playerId,
    userId,
    message:    "User bid exited",
    currentBid: player.currentBid,
    currentBidder: player.currentBidder
  };
}

// Bulk exit function - can be called directly or via API
async function runBulkExitAll(io = null) {
  try {
    const users = await User.find().select('_id isAdmin');
    const players = await Player.find({ isSold: false }).select('_id');

    const report = [];
    for (const userDoc of users) {
      const userId = userDoc._id;
      const isAdmin = userDoc.isAdmin;
      if (isAdmin) {
        // skip any admin user entirely
        continue;
      }
      for (const playerDoc of players) {
        const playerId = playerDoc._id;
        const result = await exitBidForUserOnPlayer(userId.toString(), playerId.toString(), io, 'system');
        report.push(result);
      }
    }

    return {
      message: 'Batch exit-all complete',
      details: report
    };
  } catch (err) {
    console.error('Batch exit-all error:', err);
    throw err;
  }
}

// New batch endpoint
router.post('/exit-second-highest/all', authenticateJWT, async (req, res) => {
  try {
    if (!req.authenticatedUser.isAdmin) {
      return res.status(403).json({ message: "Only admin can run bulk bid exits." });
    }
    const io = req.app.get('io');
    const result = await runBulkExitAll(io);
    return res.json(result);
  } catch (err) {
    console.error('Batch exit-all error:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});


// new endpoint: loop through every user, then every player they’ve bid on




/**
 * POST /lock-under-limit/all
 * Loops through every user and, if they hold FEWER than the
 * minimum required players of ANY type, flips `isLocked` to true.
 *
 * Response  ➜  { totalLocked, details: [ { userId, missing: { Gold: 3 … } } ] }
 */
// Function: Lock users under limit
// options: { lockCheckCategories?: string[] } - from AppSettings. If empty/missing, checks all.
async function lockUnderLimitAll(options = {}) {
  try {
    // ── 0. FETCH LOCK CATEGORIES FROM SETTINGS ───────────────────────────────
    const AppSettings = require('../models/AppSettings');
    const settings = await AppSettings.findOne().lean();
    const raw = options.lockCheckCategories ?? settings?.lockCheckCategories;
    const categories = Array.isArray(raw) && raw.length > 0 ? raw : ['sapphireEmerald', 'gold', 'silver'];
    const checkGold = categories.includes('gold');
    const checkSilver = categories.includes('silver');
    const checkSapphireEmerald = categories.includes('sapphireEmerald');

    // ── 1. RULES ─────────────────────────────────────────────────────────────
    // Gold type minimum requirement:
    // - Users must have MINIMUM 8 Gold players total (bought + bidding)
    // - If they have less than 8, they will be locked
    const GOLD_MINIMUM_TOTAL = 8; // Minimum 8 Gold players total (bought + bidding)
    
    // Silver type minimum requirement:
    // - Users must have MINIMUM 6 Silver players total (bought + bidding)
    // - If they have 1 retained Silver (in boughtPlayers), they need 5 bidding
    // - If they have 0 retained, they need 6 bidding
    // - Total must be 6 Silver players at any cost
    const SILVER_MINIMUM_TOTAL = 6; // Minimum 6 Silver players total (bought + bidding)

    // Sapphire + Emerald combined requirement:
    // Valid combinations:
    // ✅ 2 Sapphire + 2 Emerald
    // ✅ 2 Sapphire + 3 Emerald
    // ✅ 1 Sapphire + 3 Emerald
    // ✅ 1 Sapphire + 4 Emerald
    // Rule: Sapphire >= 1 AND Emerald >= 2 AND (Sapphire + Emerald) >= 4
    const SAPPHIRE_MINIMUM_TOTAL = 1;
    const EMERALD_MINIMUM_TOTAL = 2;
    const SAPPHIRE_EMERALD_MINIMUM_TOTAL = 4;

    // ── 2. SCAN EVERY USER ───────────────────────────────────────────────────
    const users = await User.find({}, { boughtPlayers: 1, currentBids: 1, isAdmin: 1 }).lean();

    const toLock  = [];     // array of ObjectId
    const details = [];     // { userId, reason, data }

    for (const user of users) {
      if (user.isAdmin) continue;
      const playerIds = [
        ...user.boughtPlayers,
        ...user.currentBids.map(b => b.playerId),
      ];

      // shortcut: owns nothing → fails the minimum test immediately
      if (playerIds.length === 0) {
        toLock.push(user._id);
        details.push({ userId: user._id, reason: 'noPlayers' });
        continue;
      }

      // fetch only the player types once
      const players = await Player.find(
        { _id: { $in: playerIds } },
        { type: 1 }
      ).lean();

      const counts = players.reduce((acc, p) => {
        acc[p.type] = (acc[p.type] || 0) + 1;
        return acc;
      }, {});

      // ── 2-a. Check Gold type minimum requirement ─────────────────────────────
      if (checkGold) {
        const goldBought = counts['Gold'] || 0;
        const goldBidding = user.currentBids.filter(bid => {
          // Count only Gold players in current bids
          return players.find(p => p._id.toString() === bid.playerId.toString())?.type === 'Gold';
        }).length;
        const goldTotal = goldBought + goldBidding;
        
        // Lock user if they have less than minimum 8 Gold total
        if (goldTotal < GOLD_MINIMUM_TOTAL) {
          toLock.push(user._id);
          details.push({
            userId: user._id,
            reason: 'goldRequirement',
            data: {
              goldBought,
              goldBidding,
              goldTotal,
              minimumRequired: GOLD_MINIMUM_TOTAL,
              explanation: `Has ${goldTotal} Gold total (${goldBought} bought + ${goldBidding} bidding), needs minimum ${GOLD_MINIMUM_TOTAL} Gold total`
            }
          });
        }
      }

      // ── 2-b. Check Silver type minimum requirement ────────────────────────────
      if (checkSilver) {
        // Count retained Silver players (they are in boughtPlayers)
        const retainedSilverCount = await RetainedPlayer.countDocuments({
          userId: user._id,
          playerType: 'Silver',
          isActive: true
        });

        // Count all Silver players in boughtPlayers (includes retained)
        const silverBought = counts['Silver'] || 0;
        
        // Count Silver players in current bids
        const silverBidding = user.currentBids.filter(bid => {
          return players.find(p => p._id.toString() === bid.playerId.toString())?.type === 'Silver';
        }).length;
        
        const silverTotal = silverBought + silverBidding;
        
        // Lock user if they have less than minimum 6 Silver total
        // Example: 1 retained + 5 bidding = 6 total ✓
        // Example: 0 retained + 6 bidding = 6 total ✓
        // Example: 1 retained + 4 bidding = 5 total ✗ (LOCK)
        // Example: 0 retained + 5 bidding = 5 total ✗ (LOCK)
        if (silverTotal < SILVER_MINIMUM_TOTAL) {
          toLock.push(user._id);
          details.push({
            userId: user._id,
            reason: 'silverRequirement',
            data: {
              retainedSilver: retainedSilverCount,
              silverBought,
              silverBidding,
              silverTotal,
              minimumRequired: SILVER_MINIMUM_TOTAL,
              explanation: `Has ${silverTotal} Silver total (${retainedSilverCount} retained + ${silverBought - retainedSilverCount} other bought + ${silverBidding} bidding), needs minimum ${SILVER_MINIMUM_TOTAL} Silver total`
            }
          });
        }
      }

      // ── 2-c. Check Sapphire + Emerald combined requirement ──────────────────
      if (checkSapphireEmerald) {
        const sapphireBought = counts['Sapphire'] || 0;
        const emeraldBought = counts['Emerald'] || 0;

        const sapphireBidding = user.currentBids.filter(bid => {
          return players.find(p => p._id.toString() === bid.playerId.toString())?.type === 'Sapphire';
        }).length;
        const emeraldBidding = user.currentBids.filter(bid => {
          return players.find(p => p._id.toString() === bid.playerId.toString())?.type === 'Emerald';
        }).length;

        const sapphireTotal = sapphireBought + sapphireBidding;
        const emeraldTotal = emeraldBought + emeraldBidding;
        const sapphireEmeraldTotal = sapphireTotal + emeraldTotal;

        if (
          sapphireTotal < SAPPHIRE_MINIMUM_TOTAL ||
          emeraldTotal < EMERALD_MINIMUM_TOTAL ||
          sapphireEmeraldTotal < SAPPHIRE_EMERALD_MINIMUM_TOTAL
        ) {
          toLock.push(user._id);
          details.push({
            userId: user._id,
            reason: 'sapphireEmeraldRequirement',
            data: {
              sapphireBought,
              sapphireBidding,
              sapphireTotal,
              emeraldBought,
              emeraldBidding,
              emeraldTotal,
              sapphireEmeraldTotal,
              minimumRequired: {
                sapphire: SAPPHIRE_MINIMUM_TOTAL,
                emerald: EMERALD_MINIMUM_TOTAL,
                total: SAPPHIRE_EMERALD_MINIMUM_TOTAL
              },
              explanation: `Has ${sapphireTotal} Sapphire total (${sapphireBought} bought + ${sapphireBidding} bidding) and ${emeraldTotal} Emerald total (${emeraldBought} bought + ${emeraldBidding} bidding); needs Sapphire >= ${SAPPHIRE_MINIMUM_TOTAL}, Emerald >= ${EMERALD_MINIMUM_TOTAL}, and total >= ${SAPPHIRE_EMERALD_MINIMUM_TOTAL}`
            }
          });
        }
      }
    }

    // ── 3. BULK UPDATE ───────────────────────────────────────────────────────
    if (toLock.length) {
      await User.updateMany(
        { _id: { $in: toLock } },
        { $set: { isLocked: true } }
      );
    }

    // ── 4. RESPONSE ──────────────────────────────────────────────────────────
    const goldLocked = details.filter(d => d.reason === 'goldRequirement').length;
    const silverLocked = details.filter(d => d.reason === 'silverRequirement').length;
    const sapphireEmeraldLocked = details.filter(d => d.reason === 'sapphireEmeraldRequirement').length;
    const checkedWhat = [
      checkSapphireEmerald && 'Sapphire+Emerald',
      checkGold && 'Gold',
      checkSilver && 'Silver'
    ].filter(Boolean).join(', ');
    
    return {
      message     : `Locked ${toLock.length} user(s) [checked: ${checkedWhat}]: ${goldLocked} for Gold, ${silverLocked} for Silver, ${sapphireEmeraldLocked} for Sapphire/Emerald.`,
      totalLocked : toLock.length,
      details,
      lockCheckCategories: categories,
    };
  } catch (err) {
    console.error('[lock-under-limit] fatal:', err);
    throw err;
  }
}

router.post('/lock-under-limit/all', async (_req, res) => {
  try {
    const result = await lockUnderLimitAll();
    return res.json(result);
  } catch (err) {
    console.error('[lock-under-limit] fatal:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});






// Get all active bids for live dashboard
router.get('/live-dashboard', async (req, res) => {
  try {
    // Get all active bids with player and bidder information
    const activeBids = await Bid.find({ isActive: true, isBidOn: true })
      .select('playerId bidder bidAmount timestamp')
      .populate('playerId', 'name type role basePrice profilePicture')
      .populate('bidder', 'name teamName')
      .sort({ bidAmount: -1 })
      .lean();

    // Group bids by playerId to get top 2 bidders per player
    const bidsByPlayer = {};
    
    activeBids.forEach(bid => {
      const playerId = bid.playerId._id.toString();
      if (!bidsByPlayer[playerId]) {
        bidsByPlayer[playerId] = {
          player: bid.playerId,
          bids: []
        };
      }
      bidsByPlayer[playerId].bids.push({
        bidder: bid.bidder,
        bidAmount: bid.bidAmount,
        timestamp: bid.timestamp
      });
    });

    // Sort bids for each player and get top 2
    const result = Object.values(bidsByPlayer).map(({ player, bids }) => {
      // Sort bids by amount descending
      bids.sort((a, b) => b.bidAmount - a.bidAmount);
      
      return {
        playerId: player._id,
        playerName: player.name,
        playerType: player.type,
        playerRole: player.role,
        basePrice: player.basePrice,
        profilePicture: player.profilePicture,
        highestBid: bids[0] || null,
        secondBid: bids[1] || null,
        bidCount: bids.length
      };
    });

    res.json({ activeBids: result });
  } catch (error) {
    console.error('Error fetching live dashboard data:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get all users with purse and active bids for user-grouped dashboard
router.get('/users-dashboard', async (req, res) => {
  try {
    const bidderAbbr = (bidder) =>
      bidder?.abbreviation ||
      bidder?.teamName?.substring(0, 3).toUpperCase() ||
      bidder?.name?.substring(0, 3).toUpperCase() ||
      'N/A';

    const upsertTopTwoByPlayer = (bucket, playerId, bidRow) => {
      const current = bucket[playerId];
      if (!current) {
        bucket[playerId] = { top1: bidRow, top2: null };
        return;
      }
      if (!current.top1 || bidRow.bidAmount > current.top1.bidAmount) {
        current.top2 = current.top1;
        current.top1 = bidRow;
        return;
      }
      if (!current.top2 || bidRow.bidAmount > current.top2.bidAmount) {
        current.top2 = bidRow;
      }
    };

    // Get all non-admin users with their purse and abbreviation
    const users = await User.find({
      isAdmin: { $ne: true },
      teamName: { $exists: true, $ne: null }
    })
      .select('name teamName purse _id abbreviation')
      .lean();

    // Get all active bids with player and bidder info (including abbreviation)
    const activeBids = await Bid.find({ isActive: true, isBidOn: true })
      .select('playerId bidder bidAmount timestamp isActive isBidOn')
      .populate('playerId', 'name type role basePrice profilePicture')
      .populate('bidder', 'name teamName _id abbreviation')
      .sort({ bidAmount: -1 })
      .lean();

    // Fetch last exit info for players shown in dashboard
    const activePlayerIds = [...new Set(activeBids.map(bid => bid.playerId?._id).filter(Boolean))];
    const exitNotifications = activePlayerIds.length > 0
      ? await BidNotification.find({
          playerId: { $in: activePlayerIds },
          exitedUser: { $ne: null }
        })
          .select('playerId exitedUser exitBy timestamp')
          .sort({ timestamp: -1 })
          .lean()
      : [];
    const lastExitByPlayer = new Map();
    exitNotifications.forEach((entry) => {
      const key = entry.playerId?.toString();
      if (key && !lastExitByPlayer.has(key)) {
        lastExitByPlayer.set(key, entry);
      }
    });

    // First, track top-2 bids by player in O(n)
    const bidsByPlayerTopTwo = {};
    
    activeBids.forEach(bid => {
      const playerId = bid.playerId._id.toString();
      upsertTopTwoByPlayer(bidsByPlayerTopTwo, playerId, {
        bidderId: bid.bidder._id.toString(),
        bidderName: bid.bidder.name,
        bidderAbbreviation: bidderAbbr(bid.bidder),
        bidAmount: bid.bidAmount,
        timestamp: bid.timestamp
      });
    });

    // Group active bids by bidder (user) with winning/losing status
    const bidsByUser = {};
    const bidsByUserPlayerMap = {};
    
    activeBids.forEach(bid => {
      const bidderId = bid.bidder._id.toString();
      const playerId = bid.playerId._id.toString();
      const topTwo = bidsByPlayerTopTwo[playerId] || {};
      const top1 = topTwo.top1 || null;
      const top2 = topTwo.top2 || null;
      
      if (!bidsByUser[bidderId]) {
        bidsByUser[bidderId] = [];
        bidsByUserPlayerMap[bidderId] = new Map();
      }
      
      // Find if this user is highest or second (second = losing to someone else)
      const isHighest = top1?.bidderId === bidderId;
      const isSecond = top2?.bidderId === bidderId && top2?.bidderId !== top1?.bidderId;
      
      // Get the other bidder's abbreviation
      let otherBidderAbbr = null;
      let otherBidderName = null;
      if (isHighest && top2) {
        otherBidderAbbr = top2.bidderAbbreviation;
        otherBidderName = top2.bidderName || null;
      } else if (isSecond && top1) {
        otherBidderAbbr = top1.bidderAbbreviation;
        otherBidderName = top1.bidderName || null;
      }
      
      // Group by player - keep highest bid per player for this user (O(1) map update)
      const existingPlayerBid = bidsByUserPlayerMap[bidderId].get(playerId);
      if (!existingPlayerBid || existingPlayerBid.bidAmount < bid.bidAmount) {
        const lastExit = lastExitByPlayer.get(playerId);
        bidsByUserPlayerMap[bidderId].set(playerId, {
          playerId: bid.playerId._id,
          playerName: bid.playerId.name,
          playerType: bid.playerId.type,
          playerRole: bid.playerId.role,
          basePrice: bid.playerId.basePrice,
          profilePicture: bid.playerId.profilePicture || null,
          bidAmount: bid.bidAmount,
          timestamp: bid.timestamp,
          isWinning: isHighest,
          isLosing: isSecond,
          otherBidderAbbr: otherBidderAbbr,
          otherBidderName: otherBidderName,
          lastExitUser: lastExit?.exitedUser || null,
          lastExitAt: lastExit?.timestamp || null
        });
      }
    });

    // Materialize map values once after grouping
    Object.keys(bidsByUserPlayerMap).forEach((bidderId) => {
      bidsByUser[bidderId] = Array.from(bidsByUserPlayerMap[bidderId].values());
    });

    // Combine users with their active bids
    const result = users.map(user => ({
      userId: user._id,
      userName: user.name,
      teamName: user.teamName || user.name,
      abbreviation: user.abbreviation || user.teamName?.substring(0, 3).toUpperCase() || user.name?.substring(0, 3).toUpperCase() || 'N/A',
      purse: parseFloat(user.purse.toString()),
      activeBids: (bidsByUser[user._id.toString()] || []).slice(0, 8) // Limit to 8 bids
    }));

    res.json({ users: result });
  } catch (error) {
    console.error('Error fetching users dashboard data:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Personalized auction command center: running bids, purses, queues, notifications
router.get('/my-auction-hub/:userId', async (req, res) => {
  try {
    const decimalToNumber = (value) => {
      if (value === null || value === undefined) return 0;
      if (typeof value === 'number') return value;
      if (typeof value === 'string') return parseFloat(value) || 0;
      if (typeof value === 'object' && value.$numberDecimal !== undefined) {
        return parseFloat(value.$numberDecimal) || 0;
      }
      if (typeof value?.toString === 'function') {
        return parseFloat(value.toString()) || 0;
      }
      return 0;
    };
    const bidderAbbr = (bidder) =>
      bidder?.abbreviation ||
      bidder?.teamName?.substring(0, 3).toUpperCase() ||
      bidder?.name?.substring(0, 3).toUpperCase() ||
      'N/A';
    const upsertTopTwoByPlayer = (bucket, playerId, bidRow) => {
      const current = bucket[playerId];
      if (!current) {
        bucket[playerId] = { top1: bidRow, top2: null };
        return;
      }
      if (!current.top1 || bidRow.bidAmount > current.top1.bidAmount) {
        current.top2 = current.top1;
        current.top1 = bidRow;
        return;
      }
      if (!current.top2 || bidRow.bidAmount > current.top2.bidAmount) {
        current.top2 = bidRow;
      }
    };

    const { userId } = req.params;
    const me = await User.findById(userId)
      .select('name teamName purse _id abbreviation isAdmin')
      .lean();
    if (!me) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (me.isAdmin) {
      const ioAdm = req.app.get('io');
      let demandAdm = { globalTop: null, yourTop: null };
      if (ioAdm) {
        const topList = getTopWatchedPlayers(ioAdm, 5);
        if (topList.length > 0) {
          const t = topList[0];
          const topPlayer = await getPlayerWatchCard(t.playerId);
          demandAdm.globalTop = {
            playerId: t.playerId,
            count: t.count,
            playerName: topPlayer.playerName,
            profilePicture: topPlayer.profilePicture,
          };
        }
      }
      return res.json({
        me: {
          userId: me._id,
          name: me.name,
          teamName: me.teamName || me.name,
          abbreviation:
            me.abbreviation ||
            me.teamName?.substring(0, 3).toUpperCase() ||
            me.name?.substring(0, 3).toUpperCase() ||
            'N/A',
          purse: parseFloat(me.purse.toString()),
          isAdmin: true,
        },
        runningBids: [],
        queueMemberships: [],
        bidNotifications: [],
        demand: demandAdm,
      });
    }

    const myActiveBidRows = await Bid.find({
      bidder: me._id,
      isActive: true,
      isBidOn: true,
    })
      .select('playerId')
      .lean();
    const myActivePlayerIds = [
      ...new Set(
        myActiveBidRows
          .map((r) => r?.playerId?.toString())
          .filter(Boolean)
      ),
    ];

    const activeBids = myActivePlayerIds.length
      ? await Bid.find({
          isActive: true,
          isBidOn: true,
          playerId: { $in: myActivePlayerIds },
        })
          .select('playerId bidder bidAmount timestamp isActive isBidOn')
          .populate('playerId', 'name type role basePrice profilePicture')
          .populate('bidder', 'name teamName _id abbreviation purse')
          .sort({ bidAmount: -1 })
          .lean()
      : [];

    const bidsByPlayerTopTwo = {};
    activeBids.forEach((bid) => {
      const pid = bid.playerId._id.toString();
      upsertTopTwoByPlayer(bidsByPlayerTopTwo, pid, {
        bidderId: bid.bidder._id.toString(),
        bidderName: bid.bidder.name,
        bidderAbbreviation: bidderAbbr(bid.bidder),
        bidAmount: bid.bidAmount,
        timestamp: bid.timestamp,
        bidderPurse: decimalToNumber(bid.bidder?.purse),
      });
    });

    const myId = userId.toString();
    const myRunningMap = new Map();

    activeBids.forEach((bid) => {
      if (bid.bidder._id.toString() !== myId) return;
      const playerId = bid.playerId._id.toString();
      const topTwo = bidsByPlayerTopTwo[playerId] || {};
      const top1 = topTwo.top1 || null;
      const top2 = topTwo.top2 || null;
      const isHighest = top1?.bidderId === myId;
      const isSecond =
        top2?.bidderId === myId &&
        top2?.bidderId !== top1?.bidderId;

      let otherBidderId = null;
      let otherBidderAbbr = null;
      let otherBidderName = null;
      let otherBidderPurse = null;
      if (isHighest && top2) {
        otherBidderId = top2.bidderId;
        otherBidderAbbr = top2.bidderAbbreviation;
        otherBidderName = top2.bidderName;
        otherBidderPurse = top2.bidderPurse;
      } else if (isSecond && top1) {
        otherBidderId = top1.bidderId;
        otherBidderAbbr = top1.bidderAbbreviation;
        otherBidderName = top1.bidderName;
        otherBidderPurse = top1.bidderPurse;
      }

      const existingPlayerBid = myRunningMap.get(playerId);
      if (!existingPlayerBid || existingPlayerBid.bidAmount < bid.bidAmount) {
        myRunningMap.set(playerId, {
          playerId: bid.playerId._id,
          playerName: bid.playerId.name,
          playerType: bid.playerId.type,
          playerRole: bid.playerId.role,
          basePrice: bid.playerId.basePrice,
          profilePicture: bid.playerId.profilePicture || null,
          bidAmount: bid.bidAmount,
          isWinning: isHighest,
          isLosing: isSecond,
          otherBidderAbbr,
          otherBidderName,
          otherBidderId,
          otherBidderPurse,
          leadingBidAmount: top1?.bidAmount ?? bid.bidAmount,
          secondBidAmount: top2?.bidAmount ?? null,
        });
      }
    });
    const myRunning = Array.from(myRunningMap.values());

    const relevantNotifications = await BidNotification.find({
      active: true,
      $or: [{ currentBidder: myId }, { secondBidder: myId }],
    })
      .sort({ timestamp: -1 })
      .limit(5)
      .lean();

    const queueMemberships = await getCachedQueueMemberships(me._id);

    const io = req.app.get('io');
    let demand = { globalTop: null, yourTop: null };
    if (io) {
      const topList = getTopWatchedPlayers(io, 5);
      if (topList.length > 0) {
        const t = topList[0];
        const topPlayer = await getPlayerWatchCard(t.playerId);
        demand.globalTop = {
          playerId: t.playerId,
          count: t.count,
          playerName: topPlayer.playerName,
          profilePicture: topPlayer.profilePicture,
        };
      }
      const myPidSet = new Set();
      myRunning.forEach((b) => myPidSet.add(b.playerId.toString()));
      queueMemberships.forEach((q) => myPidSet.add(String(q.playerId)));
      let best = null;
      let bestCount = -1;
      for (const pid of myPidSet) {
        const c = getWatchCountFromAdapter(io, pid);
        if (c > bestCount) {
          bestCount = c;
          best = pid;
        }
      }
      if (best != null && bestCount > 0) {
        const topMine = await getPlayerWatchCard(best);
        demand.yourTop = {
          playerId: best,
          count: bestCount,
          playerName: topMine.playerName,
          profilePicture: topMine.profilePicture,
        };
      }
    }

    res.json({
      me: {
        userId: me._id,
        name: me.name,
        teamName: me.teamName || me.name,
        abbreviation:
          me.abbreviation ||
          me.teamName?.substring(0, 3).toUpperCase() ||
          me.name?.substring(0, 3).toUpperCase() ||
          'N/A',
        purse: parseFloat(me.purse.toString()),
        isAdmin: false,
      },
      runningBids: myRunning,
      queueMemberships,
      bidNotifications: relevantNotifications,
      demand,
    });
  } catch (error) {
    console.error('Error fetching my auction hub:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;
module.exports.runBulkExitAll = runBulkExitAll;
module.exports.getSingleBidPlayers = getSingleBidPlayers;
module.exports.getUnsoldPlayers = getUnsoldPlayers;
module.exports.getBidderCount = getBidderCount;
module.exports.sellPlayer = sellPlayer;
module.exports.exitSecondHighestForPlayerSingle = exitSecondHighestForPlayerSingle;
module.exports.lockUnderLimitAll = lockUnderLimitAll;
