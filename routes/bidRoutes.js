const express = require("express");
const Bid = require("../models/Bid");
const Player = require("../models/Player");
const UserPlayer = require("../models/UserPlayer");
const router = express.Router();
const BidHistory = require("../models/BidHistory.js");
const validateUser = require("../config/validation.js")
const User = require("../models/User.js");
const mongoose = require("mongoose");

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
          message: `Insufficient funds in purse. You need at least ₹${
            incrementalDifference
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
  const { playerID } = req.body;

  try {
    // Find the player
    const player = await Player.findById(playerID);

    if (!player) {
      return res.status(404).json({ message: "Player not found" });
    }

    // Check if the player is already sold
    if (player.isSold) {
      return res.status(400).json({ message: "Player is already sold." });
    }

    // Fetch all bids for the player
    const bids = await Bid.find({ playerId: playerID }).sort({ bidAmount: -1 });

    if (!bids || bids.length === 0) {
      return res.status(404).json({ message: "No bids found for this player." });
    }

    // Find the highest bid
    const highestBid = bids[0];

    // Mark all bids as inactive
    await Bid.updateMany({ playerId: playerID }, { $set: { isActive: false } });

    // Create an entry in the UserPlayer schema for the sold player
    const existingUserPlayer = await UserPlayer.findOne({
      playerId: playerID,
      userId: highestBid.bidder,
      isActive: true,
    });
    
    if (existingUserPlayer) {
      return res.status(400).json({
        message: "User already has this player active sold on last click.  stop cliking sold its slready sold so.",
      });
    }
    
    // Otherwise, create a new one
    const newUserPlayer = new UserPlayer({
      playerId: playerID,
      userId: highestBid.bidder,
      bidValue: highestBid.bidAmount,
      isActive: true,
    });
    
    await newUserPlayer.save();

    // Log the sold bid in the BidHistory schema
    const bidHistory = await BidHistory.findOne({ playerId: playerID });
    if (!bidHistory) {
      await new BidHistory({
        playerId: playerID,
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

    // Fetch the winning user
    const winningUser = await User.findById(highestBid.bidder);

    if (!winningUser) {
      return res.status(404).json({ message: "Winning bidder not found." });
    }

    // Ensure the user has enough balance to cover the bid amount
    const winningBid = winningUser.currentBids.find(
      (bid) => bid.playerId.toString() === playerID
    );
    const lockedAmount = winningBid ? winningBid.amount : 0;
    const totalPurse = parseFloat(winningUser.purse.toString());

    if (totalPurse + lockedAmount < highestBid.bidAmount) {
      return res.status(400).json({
        message: "Insufficient purse balance for the winning bidder.",
      });
    }

    // Deduct the bid amount and update the user's current bids
    winningUser.purse = mongoose.Types.Decimal128.fromString(
      (totalPurse + lockedAmount - highestBid.bidAmount).toString()
    );
    winningUser.currentBids = winningUser.currentBids.filter(
      (bid) => bid.playerId.toString() !== playerID
    );
    winningUser.boughtPlayers.push(playerID);
    await winningUser.save();

    // Revert locked amounts for other bidders
    for (const bid of bids.slice(1)) {
      const otherBidder = await User.findById(bid.bidder);
      if (otherBidder) {
        const lockedBid = otherBidder.currentBids.find(
          (userBid) => userBid.playerId.toString() === playerID
        );
        const otherLockedAmount = lockedBid ? lockedBid.amount : 0;
        const otherPurse = parseFloat(otherBidder.purse.toString());

        // Refund locked amount and update current bids
        otherBidder.purse = mongoose.Types.Decimal128.fromString(
          (otherPurse + otherLockedAmount).toString()
        );
        otherBidder.currentBids = otherBidder.currentBids.filter(
          (bid) => bid.playerId.toString() !== playerID
        );
        await otherBidder.save();
      }
    }

    // Mark the player as sold
    player.isSold = true;
    player.currentBid = highestBid.bidAmount;
    player.currentBidder = highestBid.bidder;
    await player.save();

    res.status(200).json({
      message: "Player sold successfully.",
      player: player.name,
      highestBid,
      soldTo: highestBid.bidder,
    });
  } catch (error) {
    console.error("Error marking player as sold:", error);
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
// router.post("/exit-second-highest/all", async (req, res) => {
//   try {
//     const unsoldPlayers = await Player.find({ isSold: false });
//     let totalExits = 0;

//     for (const player of unsoldPlayers) {
//       // Find active bids sorted descending
//       const activeBids = await Bid.find({ 
//         playerId: player._id,
//         isActive: true
//       }).sort({ bidAmount: -1 });

//       if (activeBids.length > 1) {
//         // Identify second highest
//         const secondHighestBid = activeBids[1];
//         const secondHighestBidderId = secondHighestBid.bidder;

//         // Grab that user
//         const secondHighestBidder = await User.findById(secondHighestBidderId);
//         if (!secondHighestBidder) continue;

//         // Refund exactly the secondHighestBid's locked amount
//         const lockedBid = secondHighestBidder.currentBids.find(
//           (cb) =>
//             cb.playerId.toString() === player._id.toString() &&
//             cb.amount === secondHighestBid.bidAmount
//         );
//         if (lockedBid) {
//           const purse = parseFloat(secondHighestBidder.purse.toString());
//           secondHighestBidder.purse = mongoose.Types.Decimal128.fromString(
//             (purse + lockedBid.amount).toString()
//           );

//           // Remove that one doc from user.currentBids
//           secondHighestBidder.currentBids = secondHighestBidder.currentBids.filter(
//             (cb) =>
//               !(
//                 cb.playerId.toString() === player._id.toString() &&
//                 cb.amount === secondHighestBid.bidAmount
//               )
//           );
//           await secondHighestBidder.save();
//         }

//         // Now mark only that single secondHighestBid doc as inactive
//         await Bid.updateOne(
//           { _id: secondHighestBid._id },
//           { $set: { isActive: false, isBidOn: false } }
//         );

//         // Re-check remaining active bids
//         const remaining = await Bid.find({
//           playerId: player._id,
//           isActive: true,
//         }).sort({ bidAmount: -1 });

//         // If there's still at least 1, set that as highest
//         if (remaining.length > 0) {
//           player.currentBid = remaining[0].bidAmount;
//           player.currentBidder = remaining[0].bidder;
//         } else {
//           // Reset if no bidders
//           player.currentBid = null;
//           player.currentBidder = null;
//         }
//         await player.save();

//         totalExits++;
//       }
//     }

//     return res.json({
//       message: `Removed second-highest bidder for ${totalExits} player(s).`,
//     });
//   } catch (error) {
//     console.error("Error bulk-exiting second-highest bidders:", error);
//     return res.status(500).json({ message: "Internal server error" });
//   }
// });


/**
 * POST /bid/sold/single-bid
 * This endpoint finds all unsold players who have EXACTLY one active bid
 * and sells them to that single bidder immediately.
 */
router.post("/sold/single-bid", async (req, res) => {
  try {
    // 1. Find all players that are NOT sold
    const unsoldPlayers = await Player.find({ isSold: false });

    const results = [];

    // 2. For each unsold player, check how many active bids it has
    for (const player of unsoldPlayers) {
      const activeBids = await Bid.find({
        playerId: player._id,
        isActive: true,
      }).sort({ bidAmount: -1 });

      // If exactly ONE active bid, we finalize the sale
      if (activeBids.length === 1) {
        const singleBid = activeBids[0];

        // --- FINALIZE THE SALE (similar logic as your single-player “sold” route) ---
        try {
          // (a) Mark all player’s bids as inactive (though we only have one active)
          await Bid.updateMany({ playerId: player._id }, { $set: { isActive: false } });

          // (b) Create UserPlayer record
          const newUserPlayer = new UserPlayer({
            playerId: player._id,
            userId: singleBid.bidder,
            bidValue: singleBid.bidAmount,
            isActive: true,
          });
          await newUserPlayer.save();

          // (c) Create/update BidHistory
          const allBids = await Bid.find({ playerId: player._id }).sort({ bidAmount: -1 });
          const bidHistory = await BidHistory.findOne({ playerId: player._id });
          if (!bidHistory) {
            // If no existing BidHistory, create a new one
            await new BidHistory({
              playerId: player._id,
              bidID: singleBid._id,
              bids: allBids.map((bid) => ({
                userID: bid.bidder,
                bidAmount: bid.bidAmount,
                status: bid._id.toString() === singleBid._id.toString(),
                createdAt: bid.createdAt,
                updatedAt: bid.updatedAt,
              })),
            }).save();
          } else {
            // If it exists, mark the winning bid’s status as true
            bidHistory.bids.forEach((history) => {
              if (history._id.toString() === singleBid._id.toString()) {
                history.status = true;
              }
            });
            await bidHistory.save();
          }

          // (d) Fetch winning user
          const winningUser = await User.findById(singleBid.bidder);
          if (!winningUser) {
            results.push({
              playerId: player._id,
              status: "error",
              message: "Winning bidder not found.",
            });
            // Move on to the next player
            continue;
          }

          // (e) Ensure user still has enough purse
          const lockedBid = winningUser.currentBids.find(
            (bid) => bid.playerId.toString() === player._id.toString()
          );
          const lockedAmount = lockedBid ? lockedBid.amount : 0;
          const totalPurse = parseFloat(winningUser.purse.toString());

          if (totalPurse + lockedAmount < singleBid.bidAmount) {
            results.push({
              playerId: player._id,
              status: "error",
              message: "Insufficient purse balance for the winning bidder.",
            });
            continue;
          }

          // (f) Deduct the bid amount
          winningUser.purse = mongoose.Types.Decimal128.fromString(
            (totalPurse + lockedAmount - singleBid.bidAmount).toString()
          );
          // Remove from currentBids
          winningUser.currentBids = winningUser.currentBids.filter(
            (bid) => bid.playerId.toString() !== player._id.toString()
          );
          // Add to boughtPlayers
          winningUser.boughtPlayers.push(player._id);
          await winningUser.save();

          // (g) Mark the player as sold
          player.isSold = true;
          player.currentBid = singleBid.bidAmount;
          player.currentBidder = singleBid.bidder;
          await player.save();

          // (h) No other bidders to refund, because we only had one active bidder
          // If you consider "inactive" bids not physically removed from DB,
          // you could still do a refund for them, but presumably they've been
          // made inactive earlier.

          // (i) Record success
          results.push({
            playerId: player._id,
            status: "success",
            soldTo: singleBid.bidder.toString(),
            bidAmount: singleBid.bidAmount,
          });
        } catch (err) {
          console.error("Error selling single-bid player:", err);
          results.push({
            playerId: player._id,
            status: "error",
            message: err.message,
          });
        }
      } else {
        // Either no bids or more than one. We skip these.
        results.push({
          playerId: player._id,
          status: "skipped",
          reason: `This player has ${activeBids.length} active bids (need exactly 1 to auto-sell).`,
        });
      }
    }

    // Return summary for all players
    return res.status(200).json({ results });
  } catch (error) {
    console.error("Bulk single-bid sale error:", error);
    return res.status(500).json({ message: "Internal server error." });
  }
});

module.exports = router;
