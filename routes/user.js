const express = require('express');
// Adjust the path based on your project structure
const bcrypt = require('bcrypt');
const router = express.Router();
const User = require('../models/User'); // Adjust the path based on your project structure
const Player = require('../models/Player');
const Bid = require('../models/Bid');
const UserPlayer = require('../models/UserPlayer');
const multer = require('multer');
const path = require('path');
// Configure Multer for file uploads
const upload = multer({ dest: 'uploads/' });
// Signup Route
router.post('/signup', async (req, res) => {
  const { name, email, password, teamName, playStationId } = req.body;

  try {
    // Check if email already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'Email is already registered' });
    }

    // Hash the password
    //const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user
    const newUser = new User({
      name,
      email,
      password,
      teamName,
      playStationId,
    });

    const savedUser = await newUser.save();
    res.status(201).json({ message: 'User registered successfully', user: savedUser });
  } catch (error) {
    console.error('Error during user signup:', error);
    res.status(500).json({ message: 'Server error' });
  }
});
// POST: User Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found!' });
    }

    // console.log('Password input:', password);
    // console.log('Hashed password in DB:', user.password);

    //const isPasswordValid = await bcrypt.compare(password, user.password);
    if (password != user.password) {
      return res.status(401).json({ message: 'Invalid credentials!' });
    }

    // Return user data (excluding sensitive fields like password)
    res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      teamName: user.teamName,
      playStationId: user.playStationId,
      isAdmin: user.isAdmin,
    });
  } catch (err) {
    console.error('Error logging in:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.get("/:userId/details", async (req, res) => {
  const { userId } = req.params;

  try {
    // Fetch user data
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    // Fetch sold players for the user
    const soldPlayers = await UserPlayer.find({ userId, isActive: true })
      .populate("playerId", "name type role basePrice")
      .exec();

    // Fetch all bids for the user

    const userBids = await Bid.find({ bidder: userId })
      .populate("playerId", "name type role basePrice")
      .sort({ timestamp: -1 })
      .exec();

    // Separate active and past bids
    const activeBids = [];
    const pastBids = [];

    for (const bid of userBids) {
      if (bid.isBidOn && bid.isActive) {
        // Active bids
        activeBids.push({
          player: bid.playerId,
          bidAmount: bid.bidAmount,
          status: "Active",
        });
      } else {
        // Past bids: Check if the user is the highest bidder
        const highestBid = await Bid.findOne({ playerId: bid.playerId._id })
          .sort({ bidAmount: -1 })
          .exec();

        const status = highestBid && highestBid.bidder.toString() === userId.toString() ? "Won" : "Lost";

        pastBids.push({
          player: bid.playerId,
          bidAmount: bid.bidAmount,
          status: status,
        });
      }
    }


    // Limit past bids to the last 5
    const lastFivePastBids = pastBids.slice(0, 5);

    res.status(200).json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        image:user.teamImage,
        teamName: user.teamName,
        purse: user.purse,
      },
      soldPlayers: soldPlayers.map((sp) => ({
        player: sp.playerId,
        bidValue: sp.bidValue,
      })),
      activeBids,
      pastBids: lastFivePastBids,
    });
  } catch (error) {
    console.error("Error fetching user details:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

router.get("/purses", async (req, res) => {
  try {
    // Fetch all users
    const users = await User.find().select("name purse");

    const userData = await Promise.all(
      users.map(async (user) => {
        // Fetch players owned by the user (from UserPlayer)
        const userPlayers = await UserPlayer.find({ userId: user._id, isActive: true }).populate(
          "playerId",
          "name type"
        );

        // Fetch all active bids placed by the user (from Bid)
        const activeBids = await Bid.find({ bidder: user._id, isActive: true })
          .populate("playerId", "name type")
          .sort({ bidAmount: -1 }) // Sort by highest bid amount
          .exec();

        // Map sold players (from UserPlayer)
        const soldPlayers = userPlayers.map((entry) => ({
          name: entry.playerId.name,
          boughtValue: entry.bidValue,
          type: entry.playerId.type,
          isBidOn: false, // Sold players are not actively being bid on
          biddingPrice: null,
          biddingBy: null,
        }));

        // Map all actively bid players
        const biddingPlayers = activeBids.map((bid) => ({
          name: bid.playerId.name,
          boughtValue: null, // Not yet sold, so no bought value
          type: bid.playerId.type,
          isBidOn: true, // Actively being bid on
          biddingPrice: bid.bidAmount,
          biddingBy: user.name, // User placing the bid
        }));

        return {
          userName: user.name,
          purseValue: parseFloat(user.purse.toString()), // Convert Decimal128 to Number
          players: [...soldPlayers, ...biddingPlayers], // Combine sold and bidding players
        };
      })
    );

    res.status(200).json(userData);
  } catch (error) {
    console.error("Error fetching user purse data:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});



//Edit Profile Api 

router.put('/:id', upload.single('teamImage'), async (req, res) => {
  try {
    const userId = req.params.id;
    const { name, teamName } = req.body;

    // Validate inputs
    if (!name || !teamName) {
      return res.status(400).json({ message: 'Name and team name are required.' });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Update user fields
    user.name = name;
    user.teamName = teamName;

    // Update teamImage if provided
    if (req.file) {
      const teamImagePath = `/uploads/${req.file.filename}`; // Update with proper file storage path
      user.teamImage = teamImagePath;
    }

    await user.save();

    res.status(200).json({
      message: 'Profile updated successfully.',
      user: {
        name: user.name,
        teamName: user.teamName,
        teamImage: user.teamImage,
      },
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ message: 'An error occurred while updating the profile.' });
  }
});

module.exports = router;


