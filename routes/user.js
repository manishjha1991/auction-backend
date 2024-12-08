const express = require('express');
// Adjust the path based on your project structure
const bcrypt = require('bcrypt');
const router = express.Router();
const User = require('../models/User'); // Adjust the path based on your project structure
const Player = require('../models/Player');
const Bid = require('../models/Bid');



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

    // Fetch sold players (players the user has won)
    const soldPlayers = await Player.find({ userId })
      .populate("playerId", "name type role basePrice")
      .exec();

    // Fetch current bids
    const currentBids = await Bid.find({ bidder: userId })
      .populate("playerId", "name type role basePrice currentBid")
      .sort({ createdAt: -1 })
      .exec();

    // Separate active and past bids
    const pastBids = [];
    const activeBids = [];

    currentBids.forEach((bid) => {
      if (bid.playerId.isSold) {
        pastBids.push({
          player: bid.playerId,
          bidAmount: bid.bidAmount,
          status: "Lost",
        });
      } else {
        activeBids.push({
          player: bid.playerId,
          bidAmount: bid.bidAmount,
          status: "Active",
        });
      }
    });

    res.status(200).json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        teamName: user.teamName,
        purse: user.purse,
      },
      soldPlayers: soldPlayers.map((sp) => ({
        player: sp.playerId,
        bidValue: sp.bidValue,
      })),
      activeBids,
      pastBids,
    });
  } catch (error) {
    console.error("Error fetching user details:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});






module.exports = router;
