// routes/bidRoutes.js
const express = require("express");
const Bid = require("../models/Bid");
const Player = require("../models/Player");

const router = express.Router();

// Place a bid
router.put("/:playerId/bid", async (req, res) => {
  const { playerId } = req.params;
  const { bidAmount, bidder } = req.body;

  try {
    // Find the player
    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ message: "Player not found" });
    }

    // Check if bid is valid
    if (bidAmount < player.basePrice || (player.currentBid && bidAmount <= player.currentBid)) {
      return res.status(400).json({
        message: "Bid amount must be higher than the current bid or base price.",
      });
    }

    // Save the bid to the bids collection
    const newBid = new Bid({
      playerId,
      bidder,
      bidAmount,
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
// routes/bidRoutes.js
router.get("/:playerId/bids", async (req, res) => {
    const { playerId } = req.params;
  
    try {
      // Fetch all bids for the given player
      const bids = await Bid.find({ playerId }).sort({ timestamp: -1 });
  
      res.json(bids);
    } catch (error) {
      console.error("Error fetching bids:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });
  
module.exports = router;
