const express = require('express');
// Adjust the path based on your project structure
const bcrypt = require('bcrypt');
const router = express.Router();
const User = require('../models/User'); // Adjust the path based on your project structure
const Player = require('../models/Player');
const Bid = require('../models/Bid');
const Fixture = require('../models/Fixture');
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

// routes/user.js (example)
router.get("/:userId/details", async (req, res) => {
  const { userId } = req.params;

  try {
    // 1) Fetch user data
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    // 2) Fetch sold players for the user
    const soldPlayers = await UserPlayer.find({ userId, isActive: true })
      .populate("playerId", "name type role basePrice")
      .exec();

    // 3) Fetch all bids for the user
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

        const status =
          highestBid && highestBid.bidder.toString() === userId.toString()
            ? "Won"
            : "Lost";

        pastBids.push({
          player: bid.playerId,
          bidAmount: bid.bidAmount,
          status: status,
        });
      }
    }

    // Limit past bids to the last 5
    const lastFivePastBids = pastBids.slice(0, 5);

    // 4) Fetch last 5 fixtures (matches) for this user's team
    //    We assume user.teamName matches fixture.team1 or fixture.team2
    // In your route or controller:
    let fixtures = await Fixture.find({
      $or: [
        { team1: user.teamName },
        { team2: user.teamName },
      ],
      isActive: true,
    })
      .sort({ createdAt: 1 })
      .limit(5)
      .exec();


    // Transform fixture data into a simpler "score/fairness/result/opponentTeam" format
    const lastFiveMatches = fixtures.map((fx) => {
      // Determine if user is team1 or team2 in this fixture
      const isTeam1 = (fx.team1 === user.teamName);

      // The user's score/fairness
      const userScore = isTeam1 ? fx.team1Score : fx.team2Score;
      const userFairness = isTeam1 ? fx.team1Fairness : fx.team2Fairness;

      // Opponent is whichever team isn't the user's
      const opponentTeam = isTeam1 ? fx.team2 : fx.team1;

      // Determine result from fixture's winner field
      let userResult = "TBD";
      if (fx.winner) {
        userResult = (fx.winner === user.teamName) ? "Won" : "Lost";
      }

      return {
        score: userScore || "NA",
        fairness: userFairness || 0,
        result: userResult,
        opponentTeam: opponentTeam || "NA",
      };
    });

    // 5) Return everything, including the new lastFiveMatches
    res.status(200).json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        image: user.teamImage,
        teamName: user.teamName,
        purse: user.purse,
      },
      soldPlayers: soldPlayers.map((sp) => ({
        player: sp.playerId,
        bidValue: sp.bidValue,
      })),
      activeBids,
      pastBids: lastFivePastBids,
      lastFiveMatches, // <-- includes opponentTeam now
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
        const activeBids = await Bid.find({ bidder: user._id, isActive: true, isBidOn: true })
          .populate("playerId", "name type")
          .sort({ bidAmount: -1 }) // Sort by highest bid amount
          .exec();


        // Group bids by playerId and select the highest bid for each player
        const highestBidsByPlayer = activeBids.reduce((acc, bid) => {
          if (!acc[bid.playerId._id] || acc[bid.playerId._id].bidAmount < bid.bidAmount) {
            acc[bid.playerId._id] = bid; // Keep the highest bid for this player
          }
          return acc;
        }, {});

        // Map sold players (from UserPlayer)
        const soldPlayers = userPlayers.map((entry) => ({
          name: entry.playerId.name,
          boughtValue: entry.bidValue,
          type: entry.playerId.type,
          isBidOn: false, // Sold players are not actively being bid on
          biddingPrice: null,
          biddingBy: null,
        }));

        // Map all actively bid players (using highest bid per player)
        const biddingPlayers = Object.values(highestBidsByPlayer).map((bid) => ({
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


router.put('/update-points/:userId', async (req, res) => {
  const { userId } = req.params;
  const { points, fairness } = req.body;

  try {
    // Validate input
    if (points === undefined || points === null) {
      return res.status(400).json({ message: 'Invalid points value' });
    }

    // Fetch the user
    const user = await User.findById(userId);
    if (!user || !user.teamName) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Update points, matches played, and fairness points
    user.points = (user.points || 0) + points; // Add points to the existing total
    user.matchesPlayed = (user.matchesPlayed || 0) + 1; // Increment matches played by 1
    if (fairness !== undefined) {
      user.fairnessPoint = (user.fairnessPoint || 0) + fairness; // Add fairness points
    }

    await user.save();

    res.json({ message: 'Points, matches, and fairness updated successfully', user });
  } catch (error) {
    console.error('Error updating points:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});




router.get('/points-table', async (req, res) => {
  try {
    // Fetch all users with a team
    const users = await User.find({ teamName: { $exists: true, $ne: null }, isActive: true })
      .select('_id teamName abbreviation points matchesPlayed fairnessPoint teamImage')
      .lean();

    if (!users.length) {
      return res.status(404).json({ message: 'No teams found' });
    }

    // Transform data to calculate wins, losses, and fairness
    const pointsTable = users.map((user) => {
      const matchesPlayed = user.matchesPlayed || 0; // Default to 0 if undefined
      const points = user.points || 0; // Default to 0 if undefined
      const fairness = user.fairnessPoint || 0; // Default to 0 if undefined
      const teamImage = user.teamImage || ''; // Default to empty string if undefined

      // Calculate wins and losses
      const wins = Math.floor(points / 2); // Each win gives 2 points
      const losses = matchesPlayed - wins;

      return {
        _id: user._id,
        teamName: user.abbreviation,
        matchesPlayed,
        points,
        wins,
        losses,
        fairness,
        teamImage, // Add the image field
      };
    });

    // Sort the points table
    const sortedPointsTable = pointsTable.sort((a, b) => {
      // Priority 1: Points (descending)
      if (b.points !== a.points) {
        return b.points - a.points;
      }

      // Priority 2: Fairness points (descending)
      if (b.fairness !== a.fairness) {
        return b.fairness - a.fairness;
      }

      // Priority 3: Matches played (ascending, fewer matches higher rank)
      if (a.matchesPlayed !== b.matchesPlayed) {
        return a.matchesPlayed - b.matchesPlayed;
      }

      // Priority 4: Alphabetical order by team name (ascending)
      return a.teamName.localeCompare(b.teamName);
    });

    // Add rank to each team
    const rankedPointsTable = sortedPointsTable.map((team, index) => ({
      rank: index + 1, // Assign rank based on sorted order
      ...team,
    }));

    res.json(rankedPointsTable);
  } catch (error) {
    console.error('Error fetching points table:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});


// GET: All Teams Information
router.get('/teams', async (req, res) => {
  try {
    // Fetch all users that have a team name.
    const teams = await User.find({ teamName: { $exists: true, $ne: null } })
      .select('_id name email teamName teamImage purse isAdmin points matchesPlayed fairnessPoint')
      .lean();

    res.status(200).json({ teams });
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});



module.exports = router;


