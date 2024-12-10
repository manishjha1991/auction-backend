const express = require("express");
const Bid = require("../models/Bid");
const Player = require("../models/Player");
const UserPlayer = require("../models/UserPlayer");
const router = express.Router();
const BidHistory = require("../models/BidHistory.js");
const validateUser = require("../config/validation.js")
const User = require("../models/User.js");
// Place a bid
router.put("/:playerId/bid", validateUser, async (req, res) => {
  const { playerId } = req.params;
  const { bidAmount, bidder } = req.body;

  try {
    // Find the player
    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ message: "Player not found" });
    }

    // Check if the player is already sold
    if (player.isSold) {
      return res.status(400).json({ message: "Cannot place bids on a sold player." });
    }
    // Check if the user has any active bids on other players
    const activeBidsOnOtherPlayers = await Bid.find({
      bidder,
      isActive: true,
      playerId: { $ne: playerId }, // Exclude the current player
    });
    if (activeBidsOnOtherPlayers.length > 0) {
      return res.status(400).json({
        message: "You already have an active bid on another player. Exit the current auction to bid on this player.",
      });
    }
    // Check if bid is valid
    if (bidAmount < player.basePrice || (player.currentBid && bidAmount <= player.currentBid)) {
      return res.status(400).json({
        message: "Bid amount must be higher than the current bid or base price.",
      });
    }

    // Fetch all active bids for the player
    const activeBids = await Bid.find({ playerId, isActive: true }).sort({ bidAmount: -1 }); // Sort by bidAmount or timestamp as required

    // Ensure there is only one active bid
    if (activeBids.length > 1) {
      return res.status(400).json({
        message: "Invalid state: Multiple active bids found. Please contact support.",
      });
    }

    // Ensure the same user cannot place consecutive bids
    if (activeBids.length > 0 && activeBids[0].bidder.toString() === bidder.toString()) {
      return res.status(400).json({
        message: "You cannot place consecutive bids. Wait for another bidder to bid.",
      });
    }

    // Fetch all bids for the player and exclude the last two bids
    const bidsToUpdate = await Bid.find({ playerId })
      .sort({ bidAmount: -1 }) // Sort by bidAmount or timestamp
      .skip(2); // Skip the top two bids

    // Mark all bids except the last two as inactive
    await Bid.updateMany(
      { _id: { $in: bidsToUpdate.map((bid) => bid._id) } },
      { $set: { isActive: false } }
    );

    // Save the new bid to the bids collection
    const newBid = new Bid({
      playerId,
      bidder,
      bidAmount,
      isActive: true, // Mark the new bid as active
    });
    await newBid.save();

    // Update the player's currentBid and currentBidder
    player.currentBid = bidAmount;
    player.currentBidder = bidder;
    await player.save();

    res.json({
      message: "Bid placed successfully",
      currentBid: player.currentBid,
      currentBidder: player.currentBidder,
    });
  } catch (error) {
    console.error("Error placing bid:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});


// Out from bid
router.post("/:playerId/exit", validateUser, async (req, res) => {
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

    // Fetch all active bids for the player
    const activeBids = await Bid.find({ playerId, isBidOn: 1 }).sort({ bidAmount: -1 });

    if (!activeBids || activeBids.length === 0) {
      return res.status(400).json({ message: "No active bids found for this player." });
    }

    // Check if the user has placed a bid
    const userBid = activeBids.find((bid) => bid.bidder.toString() === userId);
    if (!userBid) {
      return res.status(400).json({ message: "You cannot exit as you have not placed a bid." });
    }

    // Check if the user is the highest bidder
    const highestBid = activeBids[0];
    if (highestBid.bidder.toString() === userId) {
      return res.status(400).json({ message: "The highest bidder cannot exit the bid." });
    }

    // Ensure there is at least one other bidder
    const otherBidders = activeBids.filter((bid) => bid.bidder.toString() !== userId);
    if (otherBidders.length === 0) {
      return res.status(400).json({
        message: "You cannot exit the bid as there are no other bidders.",
      });
    }

    // Update the user's bid to inactive
    await Bid.updateMany({ playerId, bidder: userId }, { $set: { isBidOn: false, isActive: false } });

    // Update the player's currentBid and currentBidder
    if (otherBidders.length > 0) {
      const newHighestBid = otherBidders[0];
      player.currentBid = newHighestBid.bidAmount;
      player.currentBidder = newHighestBid.bidder;
    } else {
      player.currentBid = null;
      player.currentBidder = null;
    }
    await player.save();

    res.json({
      message: "You have exited the bid successfully.",
      currentBid: player.currentBid,
      currentBidder: player.currentBidder,
    });
  } catch (error) {
    console.error("Error exiting bid:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});


// Get all bids for a player
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
    await Bid.updateMany(
      { playerId: playerID },
      { $set: { isActive: false, isBidOn: false } }
    );

    // Create an entry in the UserPlayer schema for the sold player
    const newUserPlayer = new UserPlayer({
      playerId: playerID,
      userId: highestBid.bidder,
      bidValue: highestBid.bidAmount,
    });
    await newUserPlayer.save();

    // Mark the player as sold
    player.isSold = true;
    await player.save();

    // Log the sold bid in the BidHistory schema
    const bidHistory = await BidHistory.findOne({ playerId: playerID });
    if (!bidHistory) {
      // Create a new history entry if it doesn't exist
      await new BidHistory({
        playerId: playerID,
        bidID: highestBid._id, // Add bidID
        bids: bids.map((bid) => ({
          userID: bid.bidder, // Add userID for each bid
          bidAmount: bid.bidAmount,
          status: bid._id.toString() === highestBid._id.toString(),
          createdAt: bid.createdAt,
          updatedAt: bid.updatedAt,
        })),
      }).save();
    } else {
      // Update existing history
      bidHistory.bids.forEach((history) => {
        if (history._id.toString() === highestBid._id.toString()) {
          history.status = true;
        }
      });
      await bidHistory.save();
    }
// Fetch the winning user
const user = await User.findById(highestBid.bidder);

// Check if the user exists
if (!user) {
  return res.status(404).json({ message: "Winning bidder not found." });
}

// Ensure the user has enough balance to cover the bid amount
if (user.purse < highestBid.bidAmount) {
  return res.status(400).json({ message: "Insufficient purse balance for the winning bidder." });
}

// Deduct the bid amount from the user's purse
user.purse -= highestBid.bidAmount;

// Save the updated user details
await user.save();
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





module.exports = router;
