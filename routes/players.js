const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Player = require('../models/Player');
const upload = require('../config/multerConfig'); // Import Multer configuration
const Bid = require("../models/Bid");
const User = require("../models/User");
const UserPlayer = require("../models/UserPlayer");
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
    const updates = req.body;

    // If a new profile picture is uploaded, update its path
    if (req.file) {
      updates.profilePicture = req.file.path;
    }

    const updatedPlayer = await Player.findOneAndUpdate(
      { playerID },
      { $set: updates, updatedAt: new Date() },
      { new: true }
    );

    if (!updatedPlayer) {
      return res.status(404).json({ message: 'Player not found' });
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
  try {
    // Check if the player exists
    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ message: "Player not found." });
    }
    // Fetch all bids for the player
    const allBids = await Bid.find({ playerId })
      .populate("bidder", "name email") // Populate bidder's name and email
      .sort({ bidAmount: -1 }) // Sort by bid value (descending)
      .exec();
    // Add the last two bids to the top of the response
    const lastTwoBids = allBids ? allBids.slice(0, 2) : [];
    res.status(200).json({
      player: {
        id: player._id,
        name: player.name,
        type: player.type,
        role: player.role,
        battingStyle: player.style || null,
        score: player.overallScore || null,
        status: player.isSold,
        basePrice: player.basePrice, // Format base price
      },
      topTwoBids: lastTwoBids.map((bid) => ({
        id: bid._id,
        bidder: bid.bidder,
        bidAmount: bid.bidAmount, // Format bid amount
        createdAt: bid.timestamp,
        isBidOn: bid.isBidOn
      })),
      allBids: allBids.map((bid) => ({
        id: bid._id,
        bidder: bid.bidder,
        bidAmount: bid.bidAmount, // Format bid amount
        createdAt: bid.timestamp,
        isBidOn: bid.isBidOn
      })),
    });
  } catch (error) {
    console.error("Error fetching bids for player:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

router.get("/players/data", async (req, res) => {
  try {
    // Fetch all players
    const players = await Player.find();

    // Map players to the desired format
    const formattedPlayers = await Promise.all(
      players.map(async (player) => {
        let currentBidderName = "N/A";
        let teamName = "N/A";
        let status = "Unsold";
        let basePrice = parseFloat(player.basePrice); // Default to player's base price

        if (player.isSold) {
          // Fetch UserPlayer details if the player is sold
          const userPlayer = await UserPlayer.findOne({ playerId: player._id }).populate("userId", "name teamName");

          if (userPlayer) {
            currentBidderName = userPlayer.userId.name;
            teamName = userPlayer.userId.teamName || "N/A";
            status = "Sold";

            // Use bidValue as base price if available
            if (userPlayer.bidValue) {
              basePrice = parseFloat(userPlayer.bidValue);
            }
          }
        } else {
          // Check for active bids if the player is not sold
          const highestBid = await Bid.findOne({ playerId: player._id })
            .populate("bidder", "name teamName")
            .sort({ bidAmount: -1 }); // Fetch the highest bid

          if (highestBid) {
            currentBidderName = highestBid.bidder.name || "N/A";
            teamName = highestBid.bidder.teamName || "N/A";
            basePrice = parseFloat(highestBid.bidAmount); // Use highest bid amount as base price
          }
        }

        return {
          id: player._id,
          name: player.name,
          type: player.type,
          role: player.role,
          basePrice: `${basePrice}`, // Use highest bid value if available, otherwise base price
          currentBidder: currentBidderName,
          teamName: teamName,
          status: status,
        };
      })
    );

    res.status(200).json(formattedPlayers);
  } catch (error) {
    console.error("Error fetching player data:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});



module.exports = router;
