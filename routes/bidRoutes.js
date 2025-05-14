const express = require("express");
const Bid = require("../models/Bid");
const Player = require("../models/Player");
const UserPlayer = require("../models/UserPlayer");
const router = express.Router();
const BidHistory = require("../models/BidHistory.js");
const validateUser = require("../config/validation.js")
const User = require("../models/User.js");
const mongoose = require("mongoose");
const Notification = require('../models/Notification'); // import the model
// Place a bid
router.put("/:playerId/bid", validateUser, async (req, res) => {
  const { playerId } = req.params;
  const { bidder } = req.body;

  try {
    // 1. Fetch the player
    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ message: "Player not found" });
    }

    // 2. Check if the player is already sold
    if (player.isSold) {
      return res
        .status(400)
        .json({ message: "Cannot place bids on a sold player." });
    }

    // 3. Fetch the user
    const user = await User.findById(bidder);
    if (!user) {
      return res.status(404).json({ message: "Bidder not found." });
    }

    // ============================
    // 4. Per-Type Limits
    // ============================
    const typeLimit = {
      Sapphire: 2,
      Gold: 8,
      Emerald: 4,
      Silver: 6,
    };

    const boughtPlayersOfThisType = await Player.countDocuments({
      _id: { $in: user.boughtPlayers },
      type: player.type,
    });
    const currentBidPlayersOfThisType = await Player.countDocuments({
      _id: { $in: user.currentBids.map((bid) => bid.playerId) },
      type: player.type,
    });
    const totalTypeCount = boughtPlayersOfThisType + currentBidPlayersOfThisType;

    const alreadyBiddingThisPlayer = user.currentBids.some(
      (bid) => bid.playerId.toString() === playerId
    );

    if (totalTypeCount >= typeLimit[player.type] && !alreadyBiddingThisPlayer) {
      return res.status(400).json({
        message: `You have already reached the maximum limit for ${player.type} players (limit: ${typeLimit[player.type]}).`,
      });
    }

    // ============================
    // 5. Combined Emerald + Sapphire Limit
    // ============================
    const combinedESLimit = 5;
    const combinedESCount = await Player.countDocuments({
      _id: [...user.boughtPlayers, ...user.currentBids.map((bid) => bid.playerId)],
      type: { $in: ["Emerald", "Sapphire"] },
    });

    if (
      ["Emerald", "Sapphire"].includes(player.type) &&
      combinedESCount >= combinedESLimit &&
      !alreadyBiddingThisPlayer
    ) {
      return res.status(400).json({
        message: `You have reached the maximum combined limit (${combinedESLimit}) for Emerald + Sapphire players.`,
      });
    }
    // Fetch active bids on this player
    const activeBids = await Bid.find({ playerId, isActive: true, isBidOn: true });

    // Ensure only two bidders can actively bid on the player
    const activeBidders = [...new Set(activeBids.map((bid) => bid.bidder.toString()))];

    if (activeBidders.length >= 2 && !activeBidders.includes(bidder.toString())) {
      return res.status(400).json({
        message: 'Only two bidders can actively bid on a player. Wait for one of the current bidders to exit.',
      });
    }
    // ============================
    // 6. Max 5 Current Bids
    // ============================
    if (
      user.currentBids.length >= 8 &&
      !user.currentBids.some((bid) => bid.playerId.toString() === playerId)
    ) {
      return res.status(400).json({
        message:
          "You can bid on a maximum of 5 players at a time. Exit an existing auction to bid on this player.",
      });
    }

    // ============================
    // 7. Fetch the highest active bid for the player
    // ============================
    const highestBid = await Bid.findOne({ playerId, isActive: true })
      .sort({ bidAmount: -1 })
      .exec();

    // 8. Determine the new bid amount
    let bidAmount;
    if (!highestBid) {
      // No active bids => start at basePrice
      bidAmount = player.basePrice;
    } else {
      // There's an existing bid, figure out increment
      const determineBidIncrement = (playerType, lastBidAmount) => {
        if (["Sapphire", "Gold", "Emerald"].includes(playerType)) {
          return 5000000; // 50 Lakh increment
        } else if (playerType === "Silver" && lastBidAmount >= 10000000) {
          return 5000000; // 50 Lakh for Silver if last >= 1 Cr
        } else if (playerType === "Silver") {
          return 1000000; // 10 Lakh for Silver otherwise
        }
        return 1000000; // default 10 Lakh
      };

      const bidIncrement = determineBidIncrement(player.type, highestBid.bidAmount);
      bidAmount = highestBid.bidAmount + bidIncrement;
    }

    // 9. Check if user has enough purse
    // First, figure out the incremental difference
    const currentBidOnPlayer = user.currentBids.find(
      (bid) => bid.playerId.toString() === playerId
    );
    const lockedAmount = currentBidOnPlayer ? currentBidOnPlayer.amount : 0;
    const incrementalDifference = bidAmount - lockedAmount;

    // If incrementalDifference <= 0 => user is not actually raising
    // but typically we only handle raising bids. So if <= 0, no additional purse needed.
    if (incrementalDifference > 0) {
      const purseValue = parseFloat(user.purse.toString());
      if (purseValue < incrementalDifference) {
        return res.status(400).json({
          message: `Insufficient funds in purse. You need at least ₹${incrementalDifference
            } extra to place this bid. Your current purse is ₹${purseValue}.`,
        });
      }
      // Deduct only the incremental difference
      const updatedPurse = purseValue - incrementalDifference;
      user.purse = mongoose.Types.Decimal128.fromString(updatedPurse.toString());
    }

    // 10. Ensure same user can't place consecutive bids
    if (highestBid && highestBid.bidder.toString() === bidder.toString()) {
      return res.status(400).json({
        message: "You cannot place consecutive bids. Wait for another bidder to bid.",
      });
    }

    // 11. Save the new bid to the Bid collection
    const newBid = new Bid({
      playerId,
      bidder,
      bidAmount,
      isActive: true,
      // isBidOn default = true, etc., if that's in your schema
    });
    await newBid.save();

    // 12. Update the user's currentBids
    if (currentBidOnPlayer) {
      // They previously had locked X for this same player
      currentBidOnPlayer.amount = bidAmount; // new total
    } else {
      // They didn't have a bid for this player, add a new currentBids entry
      user.currentBids.push({ playerId, amount: bidAmount });
    }
    await user.save();

    // 13. Update the player's currentBid & currentBidder
    player.currentBid = bidAmount;
    player.currentBidder = bidder;
    await player.save();

    // Determine secondBidder: the bidder in activeBidders that is not the current bidder.
    let secondBidder = null;
    if (activeBidders.length >= 1) {
      secondBidder = activeBidders.find(id => id !== bidder.toString());
    }

    // ** Emit a real-time notification **
    // Store notification in DB
    const newNotification = new Notification({
      message: "A new bid has been placed",
      playername: player.name,
      currentBid: player.currentBid,
      currentBidder: user.name, // sending bidder's name
      secondBidder,
      newBid,
      active: true
    });
    await newNotification.save();

    // Emit real-time notification
    const io = req.app.get('io');
    io.emit('bid_notification', newNotification);
    res.json({
      message: "Bid placed successfully",
      currentBid: player.currentBid,
      currentBidder: player.currentBidder,
      newBid,
    });
  } catch (error) {
    console.error("Error placing bid:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});



router.post("/:playerId/exit", async (req, res) => {
  const { playerId } = req.params;
  const { userId } = req.body;

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
    const activeBids = await Bid.find({ playerId, isActive: true }).sort({ bidAmount: -1 });

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
      currentBid: player.currentBid,
      currentBidder: player.currentBidder,
      exitedUser: user.name
    };
    // Save notification in DB
    const newNotification = new Notification(notificationData);
    await newNotification.save();
    io.emit('bid_exit_notification', newNotification);
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


// Out from bid



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

        // 3. Fetch all bids
        const bids = await Bid.find({ playerId: pid }).sort({ bidAmount: -1 });
        if (!bids || bids.length === 0) {
          results.push({
            playerID: pid,
            status: "error",
            message: "No bids found for this player.",
          });
          continue;
        }

        // 4. Highest bid
        const highestBid = bids[0];

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
            bids: bids.map((bid) => ({
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

        // 12. Revert locked amounts for other bidders
        for (const bid of bids.slice(1)) {
          const otherBidder = await User.findById(bid.bidder);
          if (otherBidder) {
            const lockedBid = otherBidder.currentBids.find(
              (userBid) => userBid.playerId.toString() === pid
            );
            const otherLockedAmount = lockedBid ? lockedBid.amount : 0;
            const otherPurse = parseFloat(otherBidder.purse.toString());

            // Refund locked amount
            otherBidder.purse = mongoose.Types.Decimal128.fromString(
              (otherPurse + otherLockedAmount).toString()
            );
            // Remove the bid from user's current bids
            otherBidder.currentBids = otherBidder.currentBids.filter(
              (b) => b.playerId.toString() !== pid
            );
            await otherBidder.save();
          }
        }

        // 13. Mark the player as sold
        player.isSold = true;
        player.currentBid = highestBid.bidAmount;
        player.currentBidder = highestBid.bidder;
        await player.save();

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

    // Return the array of results for each player
    res.status(200).json({ results });
  } catch (error) {
    console.error("Error marking player(s) as sold:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});
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
// Add this NEW route alongside your existing routes:
router.post("/:playerId/exit-second-highest", async (req, res) => {
  try {
    const { playerId } = req.params;

     // Find the player
     const player = await Player.findById(playerId);
     if (!player) {
       return res.status(404).json({ message: "Player not found" });
     }
 
     // Check if the player is already sold
     if (player.isSold) {
       return res.status(400).json({ message: "Cannot exit bid for a sold player." });
     }
 
     // Fetch all active bids for the player
     const activeBids = await Bid.find({ playerId, isActive: true }).sort({ bidAmount: -1 });
     
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

          return res.json({
            message: "The second-highest bidder has exited successfully. Locked amount refunded.",
            currentBid: player.currentBid,
            currentBidder: player.currentBidder,
          });
        }
      } 
    }catch (error) {
    console.error("Error bulk-exiting second-highest bidders:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});





/**
 * GET /api/players?filter=unsold
 * 
 * Query:
 *  - filter=unsold   → return only players where isSold === false
 *  - (no filter)     → return all players
 */
router.get('/players', async (req, res) => {
  try {
    let players;
    if (req.query.filter === 'unsold') {
      players = await Player.find({ isSold: false,isActive:true });
    } else {
      players = await Player.find();
    }

    return res.json({
      count: players.length,
      players
    });
  } catch (error) {
    console.error("Error fetching players:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});


router.get('/players/:playerId/bidders', async (req, res) => {
  try {
    const { playerId } = req.params;
    
    const activeBids = await Bid.find({ playerId, isActive: true }).sort({ bidAmount: -1 });
    if (activeBids.length === 0) {
      // no bids → skip
      return;
    }
    return res.json({
      count: activeBids.length,
      activeBids
    });
  } catch (error) {
    console.error("Error fetching players:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});



router.post("/players/:playerId/soldcrone", async (req, res) => {
  try {
    console.log(req.params)
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

        // 3. Fetch all bids
        const bids = await Bid.find({ playerId: pid }).sort({ bidAmount: -1 });
        if (!bids || bids.length === 0) {
          results.push({
            playerID: pid,
            status: "error",
            message: "No bids found for this player.",
          });
          continue;
        }

        // 4. Highest bid
        const highestBid = bids[0];

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
            bids: bids.map((bid) => ({
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

        // 12. Revert locked amounts for other bidders
        for (const bid of bids.slice(1)) {
          const otherBidder = await User.findById(bid.bidder);
          if (otherBidder) {
            const lockedBid = otherBidder.currentBids.find(
              (userBid) => userBid.playerId.toString() === pid
            );
            const otherLockedAmount = lockedBid ? lockedBid.amount : 0;
            const otherPurse = parseFloat(otherBidder.purse.toString());

            // Refund locked amount
            otherBidder.purse = mongoose.Types.Decimal128.fromString(
              (otherPurse + otherLockedAmount).toString()
            );
            // Remove the bid from user's current bids
            otherBidder.currentBids = otherBidder.currentBids.filter(
              (b) => b.playerId.toString() !== pid
            );
            await otherBidder.save();
          }
        }

        // 13. Mark the player as sold
        player.isSold = true;
        player.currentBid = highestBid.bidAmount;
        player.currentBidder = highestBid.bidder;
        await player.save();

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

    // Return the array of results for each player
    res.status(200).json({ results });
  } catch (error) {
    console.error("Error marking player(s) as sold:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});


router.post("/players/:playerId/singlebid", async (req, res) => {
  try{
    const { playerId } = req.params;
    console.log(playerId)
    const result = await Bid.aggregate([
      // 1) only consider active bids (or drop this match if you want *all* bids)
      { $match: { isActive: true } },
  
      // 2) group by playerId and collect unique bidder IDs
      {
        $group: {
          _id: '$playerId',
          uniqueBidders: { $addToSet: '$bidder' }
        }
      },
  
      // 3) only keep those with exactly one unique bidder
      {
        $match: {
          'uniqueBidders.1': { $exists: false }   // no second element in the array
        }
      },
  
      // 4) project just the playerId
      {
        $project: {
          _id: 0,
          playerId: '$_id'
        }
      }
    ]);
  console.log(result)
    // result = [ { playerId: ObjectId("…") }, … ]
    const resultMain =  result.map(r => r.playerId);
    console.log(resultMain)
    res.status(200).json({ resultMain });
  }catch(err){
    console.log(err)
  }
 
});


 

module.exports = router;
