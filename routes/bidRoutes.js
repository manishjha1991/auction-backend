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
// If the user is locked, reject their bid with a friendly explanation
    if (user.isLocked) {
      return res.status(403).json({
        message: "You’ve been locked out for not meeting the minimum/maximum player count by the deadline. " +
                "Please wait until everyone has secured their favorite players. After that window, " +
                "you’ll have the chance to join with the remaining players. Hang in there!"
      });
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


// Exit From Bid
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
        // Defensive: remove accidental currentBids field if present
        if (player.currentBids !== undefined) delete player.currentBids;
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

    // pull the two newest bids regardless of their active status
    const recentBids = await Bid
      .find({ playerId })       // Mongoose will cast playerId → ObjectId
      .sort({ timestamp: -1 })
      .limit(2)
      .lean();

    console.log("→ recentBids:", JSON.stringify(recentBids, null, 2));

    // no bids at all → count as “keep polling”
    if (recentBids.length === 0) {
      return res.json({ count: 1 });
    }

    const [latest, second] = recentBids;

    console.log(
      "latest:", {
        isActive: latest.isActive,
        isBidOn:  latest.isBidOn,
        timestamp: latest.timestamp
      }
    );
    if (second) {
      console.log(
        "second:", {
          isActive: second.isActive,
          isBidOn:  second.isBidOn,
          timestamp: second.timestamp
        }
      );
    }

    const hasLatestActive  = (latest.isActive === true && latest.isBidOn === true);
    const hasSecondInactive = Boolean(
      second &&
      second.isActive === false &&
      second.isBidOn === false
    );

    // exactly one new active bid over a previously closed bid?
    const zeroCounterCondition = hasLatestActive && hasSecondInactive;
    const count = zeroCounterCondition ? 0 : 1;

    console.log(`→ computed count=${count} for playerId=${playerId}`);
    return res.json({ count });

  } catch (error) {
    console.error("Error fetching bidder count:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});



router.post('/players/:playerId?/soldcrone', async (req, res) => {
  try {
    const { playerId: paramId } = req.params;
    const { resultMain, playerIDs, playerID } = req.body;

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

    // 3) Run the “sell” logic for each unsold player
    for (const pid of unsoldIds) {
      try {
        // a) Load player
        const player = await Player.findById(pid);
        const existingUPCheckForSold = await UserPlayer.findOne({
          playerId: pid,
          isActive: true
        });
        if (existingUPCheckForSold) {
          results.push({
            playerID: pid,
            status: 'error',
            message: 'Already sold to this user.'
          });
          continue;
        }

        if (!player) {
          results.push({ playerID: pid, status: 'error', message: 'Player not found.' });
          continue;
        }

        // b) Fetch bids
        const bids = await Bid.find({ playerId: pid }).sort({ bidAmount: -1 });
        if (!bids.length) {
          results.push({ playerID: pid, status: 'error', message: 'No bids found.' });
          continue;
        }

        const highestBid = bids[0];

        // c) Deactivate all bids
        await Bid.updateMany({ playerId: pid }, { $set: { isActive: false } });

        // d) Prevent duplicate sale record
        const existingUP = await UserPlayer.findOne({
          playerId: pid,
          userId: highestBid.bidder,
          isActive: true
        });
        if (existingUP) {
          results.push({
            playerID: pid,
            status: 'error',
            message: 'Already sold to this user.'
          });
          continue;
        }

        // e) Create UserPlayer
        await new UserPlayer({
          playerId: pid,
          userId: highestBid.bidder,
          bidValue: highestBid.bidAmount,
          isActive: true
        }).save();

        // f) Log BidHistory
        let bidHist = await BidHistory.findOne({ playerId: pid });
        if (!bidHist) {
          await new BidHistory({
            playerId: pid,
            bidID: highestBid._id,
            bids: bids.map(b => ({
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

        // g) Adjust winner’s purse & currentBids
        const winner = await User.findById(highestBid.bidder);
        const locked = winner.currentBids.find(cb => cb.playerId.equals(pid))?.amount || 0;
        const purse = parseFloat(winner.purse.toString());
        winner.purse = mongoose.Types.Decimal128.fromString(
          (purse + locked - highestBid.bidAmount).toString()
        );
        winner.currentBids = winner.currentBids.filter(cb => !cb.playerId.equals(pid));
        winner.boughtPlayers.push(pid);
        await winner.save();

        // h) Refund other bidders
        for (const b of bids.slice(1)) {
          const u = await User.findById(b.bidder);
          if (u) {
            const amt = u.currentBids.find(cb => cb.playerId.equals(pid))?.amount || 0;
            const pu = parseFloat(u.purse.toString());
            u.purse = mongoose.Types.Decimal128.fromString((pu + amt).toString());
            u.currentBids = u.currentBids.filter(cb => !cb.playerId.equals(pid));
            await u.save();
          }
        }

        // i) Mark player as sold
        player.isSold = true;
        player.currentBid = highestBid.bidAmount;
        player.currentBidder = highestBid.bidder;
        // Defensive: remove accidental currentBids field if present
        if (player.currentBids !== undefined) delete player.currentBids;
        await player.save();

        results.push({
          playerID: pid,
          status: 'success',
          message: 'Player sold successfully.',
          soldTo: highestBid.bidder.toString(),
          bidAmount: highestBid.bidAmount
        });
      } catch (err) {
        console.error(`Error selling player ${pid}:`, err);
        results.push({
          playerID: pid,
          status: 'error',
          message: err.message || 'Internal error for this player.'
        });
      }
    }

    // 4) Send back detailed results
    return res.status(200).json({ results });
  } catch (error) {
    console.error('Error in soldcrone handler:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
});


router.post("/players/singlebid", async (req, res) => {
  try{
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
    const resultMain =  result.map(r => r.playerID);
    res.status(200).json({ resultMain });
  }catch(err){
    console.log(err)
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
async function exitBidForUserOnPlayer(userId, playerId, io) {
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
  // Defensive: remove accidental currentBids field if present
  if (player.currentBids !== undefined) delete player.currentBids;
  await player.save();

  // Emit notification
  const note = new Notification({
    message:      `Bid exit: ${user.name} exited on ${player.name}.`,
    playername:   player.name,
    currentBid:   player.currentBid,
    currentBidder:player.currentBidder,
    exitedUser:   user.name
  });
  await note.save();
  io.emit('bid_exit_notification', note);

  return {
    playerId,
    userId,
    message:    "User bid exited",
    currentBid: player.currentBid,
    currentBidder: player.currentBidder
  };
}

// New batch endpoint
router.post('/exit-second-highest/all', async (req, res) => {
  try {
    const io    = req.app.get('io');
    const users = await User.find().select('_id');
    const players = await Player.find({ isSold: false }).select('_id');

    const report = [];
    for (const { _id: userId ,isAdmin} of users) {
      if (isAdmin) {
        // skip any admin user entirely
        continue;
      }
      for (const { _id: playerId } of players) {
        const result = await exitBidForUserOnPlayer(userId.toString(), playerId.toString(), io);
        report.push(result);
      }
    }

    return res.json({
      message: 'Batch exit-all complete',
      details: report
    });
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
router.post('/lock-under-limit/all', async (_req, res) => {
  try {
    // ── 1. RULES ─────────────────────────────────────────────────────────────
    // per-type minimums (your original numbers)
    // const MIN_REQUIRED = { Sapphire: 1, Gold: 8, Emerald: 3, Silver: 6 };
    const MIN_REQUIRED = { Sapphire: 1, Emerald: 3 };
    // const MIN_REQUIRED = { Silver: 6 };
    // const MIN_REQUIRED = { Gold: 8 };
    // NEW: max Emerald+Sapphire combined
    const MAX_ES_COMBINED = 5;

    // ── 2. SCAN EVERY USER ───────────────────────────────────────────────────
    const users = await User.find({}, { boughtPlayers: 1, currentBids: 1 }).lean();

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

      // ── 2-a. Check per-type minimums ───────────────────────────────────────
      let failsMinimum = false;
      const missing = {};
      for (const [type, min] of Object.entries(MIN_REQUIRED)) {
        const have = counts[type] || 0;
        if (have < min) {
          failsMinimum = true;
          missing[type] = min - have;
        }
      }

      // ── 2-b. NEW: Check Emerald+Sapphire maximum ──────────────────────────
      const esCombined =
        (counts['Emerald'] || 0) + (counts['Sapphire'] || 0);
      const exceedsES = esCombined > MAX_ES_COMBINED;

      // ── 2-c. Decide whether to lock this user ─────────────────────────────
      if (failsMinimum || exceedsES) {
        toLock.push(user._id);
        details.push({
          userId : user._id,
          reason : failsMinimum ? 'belowMinimum' : 'exceedsES',
          data   : failsMinimum ? missing : { combined: esCombined }
        });
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
    return res.json({
      message     : `Locked ${toLock.length} user(s) (minimums or Emerald+Sapphire > ${MAX_ES_COMBINED}).`,
      totalLocked : toLock.length,
      details,
    });
  } catch (err) {
    console.error('[lock-under-limit] fatal:', err);
    return res.status(500).json({ message: 'Internal server error' });
  }
});






module.exports = router;
