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
    // Fetch the player
    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ message: "Player not found" });
    }

    // Check if the player is already sold
    if (player.isSold) {
      return res.status(400).json({ message: "Cannot place bids on a sold player." });
    }

    // Fetch the user
    const user = await User.findById(bidder);
    if (!user) {
      return res.status(404).json({ message: "Bidder not found." });
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
    // Ensure the user has not bid on more than 4 players
    if (user.currentBids.length >= 6 && !user.currentBids.some((bid) => bid.playerId.toString() === playerId)) {
      return res.status(400).json({
        message: "You can bid on a maximum of 6 players at a time. Exit an existing auction to bid on this player.",
      });
    }

    // Fetch the highest active bid for the player
    const highestBid = await Bid.findOne({ playerId, isActive: true })
      .sort({ bidAmount: -1 })
      .exec();

    // Determine the new bid amount
    let bidAmount;
    if (!highestBid) {
      bidAmount = player.basePrice;
    } else {
      const determineBidIncrement = (playerType, lastBidAmount) => {
        if (["Sapphire", "Gold", "Emerald"].includes(playerType)) {
          return 5000000;
        } else if (playerType === "Silver" && lastBidAmount >= 10000000) {
          return 5000000;
        } else if (playerType === "Silver") {
          return 1000000;
        }
        return 1000000;
      };

      const bidIncrement = determineBidIncrement(player.type, highestBid.bidAmount);
      bidAmount = highestBid.bidAmount + bidIncrement;
    }

    // Calculate the total locked amount for all current bids
    const totalLockedAmount = user.currentBids.reduce((sum, bid) => sum + bid.amount, 0);

    // Check if the user has sufficient purse balance for the new bid
    const currentBidOnPlayer = user.currentBids.find((bid) => bid.playerId.toString() === playerId);
    const lockedAmount = currentBidOnPlayer ? currentBidOnPlayer.amount : 0;
    const incrementalDeduction = bidAmount - lockedAmount;

    if (totalLockedAmount + incrementalDeduction > user.purse) {
      return res.status(400).json({
        message: `Insufficient funds in purse. You need at least ₹${incrementalDeduction} to place this bid.`,
      });
    }
    // if (user.purse <= 0) {
    //   return res.status(400).json({
    //     message: "Insufficient funds in purse. Your purse value cannot be zero or negative.",
    //   });
    // }
    // Ensure the same user cannot place consecutive bids
    if (highestBid && highestBid.bidder.toString() === bidder.toString()) {
      return res.status(400).json({
        message: "You cannot place consecutive bids. Wait for another bidder to bid.",
      });
    }

    // Save the new bid to the Bid collection
    const newBid = new Bid({
      playerId,
      bidder,
      bidAmount,
      isActive: true,
    });
    await newBid.save();

    // Update the user's current bids
    if (currentBidOnPlayer) {
      currentBidOnPlayer.amount = bidAmount;
    } else {
      user.currentBids.push({ playerId, amount: bidAmount });
    }
    user.purse -= incrementalDeduction;
    await user.save();

    // Update the player's currentBid and currentBidder
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
// router.post("/:playerId/exit", async (req, res) => {
//   const { playerId } = req.params;
//   const { userId } = req.body;

//   try {
//     // Find the player
//     const player = await Player.findById(playerId);
//     if (!player) {
//       return res.status(404).json({ message: "Player not found" });
//     }

//     // Check if the player is already sold
//     if (player.isSold) {
//       return res.status(400).json({ message: "Cannot exit bid for a sold player." });
//     }

//     // Fetch the user
//     const user = await User.findById(userId);
//     if (!user) {
//       return res.status(404).json({ message: "User not found." });
//     }

//     // Check if the user has placed a bid on this player
//     const userBid = user.currentBids.find((bid) => bid.playerId.toString() === playerId);
//     if (!userBid) {
//       return res.status(400).json({ message: "You cannot exit as you have not placed a bid on this player." });
//     }

//     // Fetch all active bids for the player
//     const activeBids = await Bid.find({ playerId, isActive: true }).sort({ bidAmount: -1 });

//     if (!activeBids || activeBids.length === 0) {
//       return res.status(400).json({ message: "No active bids found for this player." });
//     }

//     // Ensure the user is not the highest bidder
//     const highestBid = activeBids[0];
//     if (highestBid.bidder.toString() === userId) {
//       return res.status(400).json({ message: "The highest bidder cannot exit the bid." });
//     }

//     // Unlock the amount locked for this player
//     const lockedAmount = userBid.amount;
//     const purse = parseFloat(user.purse.toString()); // Convert Decimal128 to Number
//     user.purse = mongoose.Types.Decimal128.fromString((purse + lockedAmount).toString());

//     // Remove the bid from user's current bids
//     user.currentBids = user.currentBids.filter((bid) => bid.playerId.toString() !== playerId);
//     await user.save();

//     // Mark the user's bid for this player as inactive
//     await Bid.updateMany({ playerId, bidder: userId }, { $set: { isActive: false, isBidOn: false } });

//     // Update the player's current bid and bidder
//     const otherBidders = activeBids.filter((bid) => bid.bidder.toString() !== userId);
//     if (otherBidders.length > 0) {
//       const newHighestBid = otherBidders[0];
//       player.currentBid = newHighestBid.bidAmount;
//       player.currentBidder = newHighestBid.bidder;
//     } else {
//       // If no other bidders, reset the player's current bid
//       player.currentBid = null;
//       player.currentBidder = null;
//     }
//     await player.save();

//     res.json({
//       message: "You have exited the bid successfully. Locked amount refunded.",
//       currentBid: player.currentBid,
//       currentBidder: player.currentBidder,
//     });
//   } catch (error) {
//     console.error("Error exiting bid:", error);
//     res.status(500).json({ message: "Internal server error" });
//   }
// });


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

module.exports = router;
