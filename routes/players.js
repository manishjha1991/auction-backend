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
    // 1. Check if the player exists
    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ message: "Player not found." });
    }

    // 2. Fetch all bids for the player
    const allBids = await Bid.find({ playerId })
      .populate("bidder", "name email") // Populate bidder's name and email
      .sort({ bidAmount: -1 }) // Sort by bid value (descending)
      .exec();

    // 3. Get the top two bids
    const lastTwoBids = allBids ? allBids.slice(0, 2) : [];

    // 4. Respond with player's info + top bids + all bids
    res.status(200).json({
      player: {
        id: player._id,
        name: player.name,
        type: player.type,
        role: player.role,
        battingStyle: player.style || null,
        score: player.overallScore || null,
        status: player.isSold,
        basePrice: player.basePrice,
        // NEW FIELDS (assuming they exist in your Player schema)
        totalRuns: player.totalRuns || 0,
        totalWickets: player.totalWickets || 0
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


router.get("/players/data", async (req, res) => {
  try {
    // Fetch all players
    const players = await Player.find({ isActive: true });
    // Map players to the desired format
    const formattedPlayers = await Promise.all(
      players.map(async (player) => {
        let currentBidderName = "N/A";
        let teamName = "N/A";
        let status = "Unsold";
        let basePrice = parseFloat(player.basePrice); // Default to player's base price

        if (player.isSold) {
          // Fetch UserPlayer details if the player is sold
          const userPlayer = await UserPlayer.findOne({ playerId: player._id, isActive: true }).populate("userId", "name teamName");
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

    // Sort players to prioritize those with currentBidder
    const sortedPlayers = formattedPlayers.sort((a, b) => {
      if (a.currentBidder !== "N/A" && b.currentBidder === "N/A") return -1; // a has currentBidder, b does not
      if (a.currentBidder === "N/A" && b.currentBidder !== "N/A") return 1; // b has currentBidder, a does not
      return 0; // Keep the original order if both have or don't have currentBidder
    });

    res.status(200).json(sortedPlayers);
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
    if (Number(team2.purse) < player1.bidValue || Number(team1.purse) < player2.bidValue) {
      return res.status(400).json({ message: 'Insufficient purse for the trade.' });
    }

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




module.exports = router;
