const express = require('express');
// Adjust the path based on your project structure
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const router = express.Router();
const { getClientIp } = require('../utils/network');

// Add middleware to log ALL requests to user routes
router.use((req, res, next) => {
  console.log(`👤 USER ROUTE: ${req.method} ${req.path}`);
  console.log(`📝 Body:`, req.body);
  next();
});
const User = require('../models/User'); // Adjust the path based on your project structure
const AppSettings = require('../models/AppSettings');
const Player = require('../models/Player');
const Bid = require('../models/Bid');
const Fixture = require('../models/Fixture');
const UserPlayer = require('../models/UserPlayer');
const TradeRequest = require('../models/TradeRequest');
const ReleaseRequest = require('../models/ReleaseRequest');
const MatchResult = require('../models/MatchResult');
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
  const clientIP = getClientIp(req);
  const country = req.get('CF-IPCountry') || req.get('X-Country-Code') || 'Unknown';
  
  console.log(`🔐 LOGIN ATTEMPT from ${country} (IP: ${clientIP})`);
  console.log(`📧 Email: ${req.body.email}`);
  console.log(`🔑 Password length: ${req.body.password ? req.body.password.length : 0}`);
  
  const { email, password } = req.body;
  console.log(email, password,"@@@@@@@@@@@@@@");
  try {
    const user = await User.findOne({ email }).includeInactive();
    if (!user) {
      return res.status(404).json({ message: 'User not found!' });
    }
    if (user.isActive === false && !user.isAdmin) {
      return res.status(403).json({ message: 'Account has been deactivated. Please contact admin.' });
    }

    // console.log('Password input:', password);
    // console.log('Hashed password in DB:', user.password);

    //const isPasswordValid = await bcrypt.compare(password, user.password);
    if (password != user.password) {
      return res.status(401).json({ message: 'Invalid credentials!' });
    }

    // Generate session ID and device fingerprint
    const sessionId = require('crypto').randomBytes(16).toString('hex');
    const userAgent = req.get('User-Agent') || 'Unknown';
    const extraDeviceInfo = {
      acceptLanguage: req.get('accept-language') || '',
      secChUA: req.get('sec-ch-ua') || '',
      secChPlatform: req.get('sec-ch-ua-platform') || '',
      secChMobile: req.get('sec-ch-ua-mobile') || '',
    };
    const { generateDeviceFingerprint } = require('../utils/deviceFingerprint');
    const deviceFingerprint = generateDeviceFingerprint(userAgent, clientIP, extraDeviceInfo);
    
    // Check for multi-account usage (same IP/device logging into multiple accounts)
    // Skip this check for admin accounts - they can login from multiple devices
    let isSuspiciousMultiAccount = false;
    let isNewDeviceLogin = false;
    let isDeviceSwitch = false;
    const suspiciousReasons = [];
    const previousDeviceFingerprint = user.lastDeviceFingerprint || null;

    if (!user.isAdmin && previousDeviceFingerprint && previousDeviceFingerprint !== deviceFingerprint) {
      isDeviceSwitch = true;
      suspiciousReasons.push('Account accessed from a different device than last session');
    }

    if (!user.isAdmin) {
      // Find other users who logged in from the same device recently (within last 24 hours)
      const recentLoginTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const otherUsersSameDevice = await User.find({
        _id: { $ne: user._id },
        isAdmin: false,
        lastDeviceFingerprint: deviceFingerprint,
        lastLoginTime: { $gte: recentLoginTime }
      }).select('name email teamName lastLoginTime').limit(5);
      
      if (otherUsersSameDevice.length > 0) {
        isSuspiciousMultiAccount = true;
        const sharedList = [...new Set(otherUsersSameDevice.map(u => u.teamName || u.name))].join(', ');
        suspiciousReasons.push(`Shared device with: ${sharedList}`);
      }
    }
    
    // Update user's known IPs and devices (keep last 10)
    if (!user.knownIPs) user.knownIPs = [];
    if (!user.knownIPs.includes(clientIP)) {
      user.knownIPs.push(clientIP);
      if (user.knownIPs.length > 10) user.knownIPs.shift();
    }
    
    if (!user.knownDevices) user.knownDevices = [];
    if (!user.knownDevices.includes(deviceFingerprint)) {
      user.knownDevices.push(deviceFingerprint);
      if (user.knownDevices.length > 10) user.knownDevices.shift();
    if (!user.isAdmin && user.knownDevices.length > 1) {
        isNewDeviceLogin = true;
        suspiciousReasons.push('Login from a new device');
      }
    }
    
    // Update user with login information
    user.lastLoginIP = clientIP;
    user.lastLoginTime = new Date();
    user.activeSessionId = sessionId;
    user.lastDeviceFingerprint = deviceFingerprint;
    
    // Increment suspicious count if multi-account detected
    if (isSuspiciousMultiAccount || isNewDeviceLogin || isDeviceSwitch) {
      user.suspiciousActivityCount = (user.suspiciousActivityCount || 0) + 1;
    }
    
    await user.save();

    // Generate JWT token
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { id: user._id, sessionId: sessionId },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '1d' }
    );

    // Return user data with token (excluding sensitive fields like password)
    res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      teamName: user.teamName,
      playStationId: user.playStationId,
      isAdmin: user.isAdmin,
      timezone: user.timezone,
      streamLink: user.streamLink,
      token: token, // Include JWT token in response
    });
  } catch (err) {
    console.error('Error logging in:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// routes/user.js (example)
router.get("/:userId/details", async (req, res) => {
  const { userId } = req.params;
  const startTime = Date.now();

  try {
    console.log(`🚀 Starting user details API for user: ${userId}`);
    
    // 1) Fetch user data
    const userStart = Date.now();
    const user = await User.findById(userId).includeInactive();
    console.log(`⏱️ User fetch took: ${Date.now() - userStart}ms`);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }
    
    console.log('Fetched user timezone from database:', user.timezone);

    // 2) Fetch sold players for the user
    const soldPlayersStart = Date.now();
    const soldPlayers = await UserPlayer.find({ userId, isActive: true })
      .populate("playerId", "name type role basePrice over overallScore totalRuns totalWickets")
      .exec();
    console.log(`⏱️ Sold players fetch took: ${Date.now() - soldPlayersStart}ms`);

    // 3) Fetch all bids for the user
    const bidsStart = Date.now();
    const userBids = await Bid.find({ bidder: userId })
      .populate("playerId", "name type role basePrice")
      .sort({ timestamp: -1 })
      .exec();
    console.log(`⏱️ User bids fetch took: ${Date.now() - bidsStart}ms`);

    // Separate active and past bids
    const activeBids = [];
    const pastBids = [];

    // OPTIMIZATION: Get all past bid player IDs first
    const pastBidPlayerIds = userBids
      .filter(bid => !(bid.isBidOn && bid.isActive))
      .map(bid => bid.playerId._id);

    // OPTIMIZATION: Get all highest bids in ONE query instead of N queries
    const highestBidsStart = Date.now();
    const highestBids = await Bid.aggregate([
      { $match: { playerId: { $in: pastBidPlayerIds } } },
      { $sort: { playerId: 1, bidAmount: -1 } },
      { $group: {
        _id: "$playerId",
        highestBid: { $first: "$$ROOT" }
      }}
    ]);
    console.log(`⏱️ Highest bids aggregation took: ${Date.now() - highestBidsStart}ms`);

    // Create a map for O(1) lookup
    const highestBidMap = new Map();
    highestBids.forEach(item => {
      highestBidMap.set(item._id.toString(), item.highestBid);
    });

    for (const bid of userBids) {
      if (bid.isBidOn && bid.isActive) {
        // Active bids
        activeBids.push({
          player: bid.playerId,
          bidAmount: bid.bidAmount,
          status: "Active",
        });
      } else {
        // Past bids: Use the pre-fetched highest bid data
        const highestBid = highestBidMap.get(bid.playerId._id.toString());
        const status = highestBid && highestBid.bidder.toString() === userId.toString()
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
    const fixturesStart = Date.now();
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
    console.log(`⏱️ Fixtures fetch took: ${Date.now() - fixturesStart}ms`);

    // OPTIMIZATION: Get all opponent team names first
    const opponentTeamNames = fixtures.map(fx => 
      fx.team1 === user.teamName ? fx.team2 : fx.team1
    );

    // OPTIMIZATION: Get all opponent users in ONE query instead of N queries
    const opponentUsersStart = Date.now();
    const opponentUsers = await User.find({ 
      teamName: { $in: opponentTeamNames },
      isTournamentReady: true 
    }).select('teamName');
    console.log(`⏱️ Opponent users fetch took: ${Date.now() - opponentUsersStart}ms`);

    // Create a set for O(1) lookup
    const tournamentReadyTeams = new Set(opponentUsers.map(u => u.teamName));

    // Filter out fixtures where the opponent is not tournament ready
    const filteredFixtures = fixtures.filter(fx => {
      const opponentTeamName = fx.team1 === user.teamName ? fx.team2 : fx.team1;
      return tournamentReadyTeams.has(opponentTeamName);
    });

    // Transform fixture data into a simpler "score/fairness/result/opponentTeam" format
    const lastFiveMatches = filteredFixtures.map((fx) => {
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

    // 5) Return everything, including the new lastFiveMatches and allPlayersReleased from user document
    const totalTime = Date.now() - startTime;
    console.log(`✅ User details API completed in ${totalTime}ms for user: ${userId}`);
    
    res.status(200).json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        image: user.teamImage,
        teamName: user.teamName,
        purse: user.purse,
        timezone: user.timezone,
        streamLink: user.streamLink,
        abbreviation: user.abbreviation,
        isRetentionLocked: user.isRetentionLocked,
        allPlayersReleased: user.allPlayersReleased || false,
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
  const startTime = Date.now();
  try {
    console.log('🚀 Starting purses API optimization...');
    
    // OPTIMIZATION: Fetch all data in parallel with single queries (excluding admin users)
    const [users, allUserPlayers, allActiveBids, matchResults] = await Promise.all([
      User.find({ isAdmin: { $ne: true } }).select("name teamName purse _id").lean(),
      UserPlayer.find({ isActive: true }).populate("playerId", "name type role").lean(),
      Bid.find({ isActive: true, isBidOn: true })
        .populate("playerId", "name type role")
        .populate("bidder", "name _id")
        .sort({ bidAmount: -1 })
        .lean(),
      MatchResult.find({}).lean()
    ]);
    
    console.log(`⏱️ Data fetch took: ${Date.now() - startTime}ms`);
    console.log(`📊 Fetched ${users.length} users, ${allUserPlayers.length} user players, ${allActiveBids.length} active bids`);

    // OPTIMIZATION: Create lookup maps for O(1) access
    const userPlayersMap = new Map();
    const activeBidsMap = new Map();
    
    // Group user players by userId
    allUserPlayers.forEach(up => {
      if (!userPlayersMap.has(up.userId.toString())) {
        userPlayersMap.set(up.userId.toString(), []);
      }
      userPlayersMap.get(up.userId.toString()).push(up);
    });
    
    // Group active bids by bidder
    allActiveBids.forEach(bid => {
      if (!activeBidsMap.has(bid.bidder._id.toString())) {
        activeBidsMap.set(bid.bidder._id.toString(), []);
      }
      activeBidsMap.get(bid.bidder._id.toString()).push(bid);
    });

    const userData = users.map((user) => {
      // Get user's players and bids from maps
      const userPlayers = userPlayersMap.get(user._id.toString()) || [];
      const activeBids = activeBidsMap.get(user._id.toString()) || [];

        // Group bids by playerId and select the highest bid for each player
        const highestBidsByPlayer = activeBids.reduce((acc, bid) => {
          if (!acc[bid.playerId._id] || acc[bid.playerId._id].bidAmount < bid.bidAmount) {
            acc[bid.playerId._id] = bid; // Keep the highest bid for this player
          }
          return acc;
        }, {});

        // Map sold players (from UserPlayer)
        const soldPlayers = userPlayers.map((entry) => ({
          id: entry.playerId._id,
          name: entry.playerId.name,
          boughtValue: entry.bidValue,
          type: entry.playerId.type,
          role: entry.playerId.role,
          isBidOn: false, // Sold players are not actively being bid on
          biddingPrice: null,
          biddingBy: null,
        }));

        // Map all actively bid players (using highest bid per player)
        const biddingPlayers = Object.values(highestBidsByPlayer).map((bid) => ({
          id: bid.playerId._id,
          name: bid.playerId.name,
          boughtValue: null, // Not yet sold, so no bought value
          type: bid.playerId.type,
          role: bid.playerId.role,
          isBidOn: true, // Actively being bid on
          biddingPrice: bid.bidAmount,
          biddingBy: user.name, // User placing the bid
        }));

        // Calculate trophy and runner-up counts from match results
        const teamWins = matchResults.filter(match => {
          if (!match.winner || match.winner === 'tie' || match.winner === 'no_result') return false;
          const winningTeam = match.winner === 'team1' ? match.team1 : match.team2;
          return winningTeam === user.teamName;
        });

        const teamLosses = matchResults.filter(match => {
          if (!match.winner || match.winner === 'tie' || match.winner === 'no_result') return false;
          const winningTeam = match.winner === 'team1' ? match.team1 : match.team2;
          return (match.team1 === user.teamName || match.team2 === user.teamName) && winningTeam !== user.teamName;
        });

        const trophyCount = teamWins.length;
        const runnerUpCount = teamLosses.length;

        return {
          id: user._id, // Add user ID for frontend reference
          userName: user.name,
          teamName: user.teamName,
          purseValue: parseFloat(user.purse.toString()), // Convert Decimal128 to Number
          players: [...soldPlayers, ...biddingPlayers], // Combine sold and bidding players
          trophyCount: trophyCount,
          runnerUpCount: runnerUpCount
        };
      });

    // OPTIMIZATION: Pre-calculate bidding status for all players
    const biddingStatusMap = new Map();
    
    // Group all bidding players by player name
    const playerBiddersMap = new Map();
    userData.forEach(user => {
      user.players.forEach(player => {
        if (player.isBidOn) {
          if (!playerBiddersMap.has(player.name)) {
            playerBiddersMap.set(player.name, []);
          }
          playerBiddersMap.get(player.name).push({
            userId: user.id,
            userName: user.userName,
            bidAmount: player.biddingPrice
          });
        }
      });
    });
    
    // Calculate bidding status for each player
    playerBiddersMap.forEach((bidders, playerName) => {
      const sortedBidders = bidders.sort((a, b) => b.bidAmount - a.bidAmount);
      sortedBidders.forEach((bidder, index) => {
        biddingStatusMap.set(`${bidder.userId}-${playerName}`, {
          isHighest: index === 0,
          isSecondHighest: index === 1,
          position: index + 1,
          totalBidders: sortedBidders.length
        });
      });
    });

    // OPTIMIZATION: Apply bidding status using pre-calculated map
    const enhancedUserData = userData.map((user) => {
      const enhancedPlayers = user.players.map((player) => {
        if (!player.isBidOn) {
          return player;
        }
        
        const biddingStatus = biddingStatusMap.get(`${user.id}-${player.name}`) || {
          isHighest: false,
          isSecondHighest: false,
          position: 1,
          totalBidders: 1
        };

        return {
          ...player,
          biddingStatus
        };
      });

      return {
        ...user,
        players: enhancedPlayers
      };
    });

    const totalTime = Date.now() - startTime;
    console.log(`✅ Purses API completed in ${totalTime}ms - Processed ${enhancedUserData.length} users`);

    res.status(200).json(enhancedUserData);
  } catch (error) {
    console.error("Error fetching user purse data:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});




//Edit Profile Api 

router.put('/:id', upload.single('teamImage'), async (req, res) => {
  try {
    const userId = req.params.id;
    const { name, teamName, timezone, streamLink, abbreviation } = req.body;
    
    console.log('Profile update request:', { userId, name, teamName, timezone, streamLink });

    // Validate inputs
    if (!name || !teamName) {
      return res.status(400).json({ message: 'Name and team name are required.' });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Store the old team name before updating
    const oldTeamName = user.teamName;

    // Update user fields
    user.name = name;
    user.teamName = teamName;
    
    // Always update timezone if provided, even if it's an empty string
    if (timezone !== undefined) {
      user.timezone = timezone;
      console.log('Updated timezone to:', timezone);
    } else {
      console.log('No timezone provided in request');
    }

    // Update streamLink if provided
    if (streamLink !== undefined) {
      user.streamLink = streamLink;
      console.log('Updated streamLink to:', streamLink);
    }

    // Update abbreviation if provided
    if (abbreviation !== undefined) {
      user.abbreviation = abbreviation;
      console.log('Updated abbreviation to:', abbreviation);
    }

    // Update teamImage if provided
    if (req.file) {
      const teamImagePath = `/uploads/${req.file.filename}`; // Update with proper file storage path
      user.teamImage = teamImagePath;
    }

    await user.save();
    
    console.log('User saved with timezone:', user.timezone);
    
    // If team name changed, update ALL references across the entire system
    if (oldTeamName && oldTeamName !== teamName) {
      console.log(`🔄 Team name changed from "${oldTeamName}" to "${teamName}". Starting comprehensive update...`);
      
      try {
        // Use the comprehensive team name updater
        const { updateTeamNameEverywhere } = require('../utils/teamNameUpdater');
        const updateSummary = await updateTeamNameEverywhere(oldTeamName, teamName, userId);
        
        // Log the comprehensive update results
        const totalUpdates = Object.values(updateSummary.updates).reduce((sum, count) => sum + count, 0);
        console.log(`✅ Comprehensive team name update completed: ${totalUpdates} total updates made`);
        console.log(`📊 Details: Fixtures(${updateSummary.updates.fixtures}), MatchResults(${updateSummary.updates.matchResults}), MOM(${updateSummary.updates.momReferences}), Playoffs(${updateSummary.updates.playoffFixtures}), Tournaments(${updateSummary.updates.tournaments})`);
        
      } catch (updateError) {
        console.error('❌ Error during comprehensive team name update:', updateError);
        // Don't fail the profile update if this fails, but log the error
      }
    }
    
    // Verify the timezone was actually saved by fetching from database
    const savedUser = await User.findById(userId);
    console.log('Verified timezone in database:', savedUser.timezone);

    res.status(200).json({
      message: 'Profile updated successfully.',
      user: {
        name: user.name,
        teamName: user.teamName,
        teamImage: user.teamImage,
        timezone: user.timezone,
        streamLink: user.streamLink,
        abbreviation: user.abbreviation,
      },
    });
  } catch (error) {
    console.error('Error updating profile:', error);
    res.status(500).json({ message: 'An error occurred while updating the profile.' });
  }
});

// Admin route to update user timezone and streamLink
router.put('/:userId/admin-update', async (req, res) => {
  try {
    const { timezone, streamLink, abbreviation } = req.body;
    const userId = req.params.userId;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Update fields
    if (timezone !== undefined) {
      user.timezone = timezone;
    }
    if (streamLink !== undefined) {
      user.streamLink = streamLink;
    }
    if (abbreviation !== undefined) {
      user.abbreviation = abbreviation;
    }

    await user.save();

    res.status(200).json({
      message: 'User updated successfully.',
      user: {
        _id: user._id,
        name: user.name,
        teamName: user.teamName,
        timezone: user.timezone,
        streamLink: user.streamLink,
        abbreviation: user.abbreviation
      }
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ message: 'An error occurred while updating the user.' });
  }
});

// Get all users for admin
router.get('/all', async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    let query = User.find(
      {},
      'name email teamName timezone streamLink abbreviation isAdmin isRetentionLocked isActive'
    );
    if (includeInactive) {
      query = query.includeInactive();
    }
    const users = await query.lean();
    res.status(200).json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ message: 'An error occurred while fetching users.' });
  }
});

// Get teams for team directory
router.get('/teams', async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const baseFilter = {
      teamName: { $exists: true, $ne: null, $ne: 'NA' },
      isAdmin: false,
      isTournamentReady: true,
    };
    if (!includeInactive) {
      baseFilter.isActive = true;
    }

    let query = User.find(baseFilter, 'name teamName timezone streamLink abbreviation teamImage isActive');
    if (includeInactive) {
      query = query.includeInactive();
    }
    const teams = await query.lean();
    res.status(200).json({ teams });
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ message: 'An error occurred while fetching teams.' });
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

// PUT: Update fairness points, matches played, and points directly (Admin only)
router.put('/update-fairness/:userId', async (req, res) => {
  const { userId } = req.params;
  const { points, matchesPlayed, fairnessPoint } = req.body;

  try {
    // Validate input
    if (points === undefined || matchesPlayed === undefined || fairnessPoint === undefined) {
      return res.status(400).json({ message: 'All fields (points, matchesPlayed, fairnessPoint) are required' });
    }

    // Fetch the user
    const user = await User.findById(userId);
    if (!user || !user.teamName) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Update points, matches played, and fairness points directly
    user.points = parseInt(points) || 0;
    user.matchesPlayed = parseInt(matchesPlayed) || 0;
    user.fairnessPoint = parseInt(fairnessPoint) || 0;

    await user.save();

    console.log(`Updated team ${user.teamName}: Points=${user.points}, Matches=${user.matchesPlayed}, Fairness=${user.fairnessPoint}`);

    res.json({ 
      message: 'Team stats updated successfully', 
      user: {
        _id: user._id,
        teamName: user.teamName,
        abbreviation: user.abbreviation,
        points: user.points,
        matchesPlayed: user.matchesPlayed,
        fairnessPoint: user.fairnessPoint
      }
    });
  } catch (error) {
    console.error('Error updating team stats:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET: Debug endpoint to check all users and their fairness points
router.get('/debug-fairness', async (req, res) => {
  try {
    const users = await User.find({ 
      teamName: { $exists: true, $ne: null, $ne: "NA" }, 
      isActive: true,
      isAdmin: false
    })
    .select('_id teamName abbreviation points matchesPlayed fairnessPoint isTournamentReady')
    .lean();

    console.log('Debug - All users with fairness data:', users);
    res.json({ users, count: users.length });
  } catch (error) {
    console.error('Error fetching debug data:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});




router.get('/points-table', async (req, res) => {
  try {
    // Fetch all users who have a valid team name, are active, and are NOT admins
    const users = await User.find({ 
      teamName: { $exists: true, $ne: null, $ne: "NA" }, 
      isActive: true,
      isAdmin: false // Exclude admin accounts
      // Removed isTournamentReady filter to include all teams for fairness management
    })
    .select('_id teamName abbreviation points matchesPlayed fairnessPoint teamImage')
    .lean();

    console.log(users);

    if (!users.length) {
      return res.status(404).json({ message: 'No teams found' });
    }

    // Transform data to calculate wins, losses, and fairness
    const pointsTable = users.map((user) => {
      const matchesPlayed = user.matchesPlayed || 0;
      const points = user.points || 0;
      const fairness = user.fairnessPoint || 0;
      const teamImage = user.teamImage || '';

      // Calculate wins and losses
      const wins = Math.floor(points / 2); // each win = 2 points
      const losses = matchesPlayed - wins;

      return {
        _id: user._id,
        teamName: user.abbreviation || user.teamName || 'Unknown', // Display name (abbreviation)
        originalTeamName: user.teamName || 'Unknown', // Original team name for fixture matching
        matchesPlayed,
        points,
        wins,
        losses,
        fairness,
        teamImage
      };
    });

    // Sort the points table
    const sortedPointsTable = pointsTable.sort((a, b) => {
      // Priority 1: Points (descending)
      if (b.points !== a.points) {
        return b.points - a.points;
      }
      // Priority 2: Fairness (descending)
      if (b.fairness !== a.fairness) {
        return b.fairness - a.fairness;
      }
      // Priority 3: Matches played (ascending)
      if (a.matchesPlayed !== b.matchesPlayed) {
        return a.matchesPlayed - b.matchesPlayed;
      }
      // Priority 4: Alphabetical by team name (ascending)
      const teamNameA = a.teamName || '';
      const teamNameB = b.teamName || '';
      return teamNameA.localeCompare(teamNameB);
    });

    // Add rank to each team
    const rankedPointsTable = sortedPointsTable.map((team, index) => ({
      rank: index + 1,
      ...team,
    }));

    res.json(rankedPointsTable);
  } catch (error) {
    console.error('Error fetching points table:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET: Points table grouped by user.group when AppSettings.pointsMode = 'groups'
router.get('/points-table-grouped', async (_req, res) => {
  try {
    const settings = await AppSettings.findOne().lean();
    const mode = settings?.pointsMode || 'overall';

    // Always return grouped data shape, but if mode is overall, still compute groups by existing assignments
    const users = await User.find({
      teamName: { $exists: true, $ne: null, $ne: 'NA' },
      isActive: true,
      isAdmin: false,
      isTournamentReady: true
    })
      .select('_id teamName abbreviation points matchesPlayed fairnessPoint teamImage group')
      .lean();

    const toRow = (u) => {
      const matchesPlayed = u.matchesPlayed || 0;
      const points = u.points || 0;
      const fairness = u.fairnessPoint || 0;
      const wins = Math.floor(points / 2);
      const losses = matchesPlayed - wins;
      return {
        _id: u._id,
        teamName: u.abbreviation || u.teamName || 'Unknown', // Display name (abbreviation)
        originalTeamName: u.teamName || 'Unknown', // Original team name for fixture matching
        matchesPlayed,
        points,
        wins,
        losses,
        fairness,
        teamImage: u.teamImage || ''
      };
    };

    const byGroup = { A: [], B: [] };
    users.forEach((u) => {
      if (u.group === 'A') byGroup.A.push(toRow(u));
      else if (u.group === 'B') byGroup.B.push(toRow(u));
      else {
        // If unassigned, place into smaller group for balance
        const target = byGroup.A.length <= byGroup.B.length ? 'A' : 'B';
        byGroup[target].push(toRow(u));
      }
    });

    const sortFn = (a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.fairness !== a.fairness) return b.fairness - a.fairness;
      if (a.matchesPlayed !== b.matchesPlayed) return a.matchesPlayed - b.matchesPlayed;
      // Add null checks for teamName comparison
      const teamNameA = a.teamName || '';
      const teamNameB = b.teamName || '';
      return teamNameA.localeCompare(teamNameB);
    };

    const rankify = (arr) => arr.sort(sortFn).map((t, i) => ({ rank: i + 1, ...t }));

    const response = { mode, groups: { A: rankify(byGroup.A), B: rankify(byGroup.B) } };
    res.json(response);
  } catch (e) {
    console.error('Error fetching grouped points table:', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});



// GET: All Teams Information (Enhanced version with more data)
router.get('/teams-detailed', async (req, res) => {
  try {
    // Fetch all users that have a team name.
    const teams = await User.find({ teamName: { $exists: true, $ne: null } })
      .select('_id name email teamName teamImage purse isAdmin points matchesPlayed fairnessPoint group abbreviation')
      .lean();

    res.status(200).json({ teams });
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET: list teams with group assignments (admin helper)
router.get('/groups', async (_req, res) => {
  try {
    const teams = await User.find({ teamName: { $exists: true, $ne: null }, isAdmin: false })
      .select('_id teamName abbreviation group teamImage')
      .lean();
    res.json({ teams });
  } catch (e) {
    console.error('Error fetching groups list:', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// POST: set a team's group (A or B) - admin only via adminUserId
router.post('/:userId/group', async (req, res) => {
  try {
    const { userId } = req.params;
    const { group, adminUserId } = req.body;
    if (!['A', 'B', null].includes(group)) return res.status(400).json({ message: 'Invalid group' });
    const admin = await User.findById(adminUserId);
    if (!admin || !admin.isAdmin) return res.status(403).json({ message: 'Only admin can update group' });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    user.group = group;
    await user.save();
    res.json({ message: 'Group updated', userId, group });
  } catch (e) {
    console.error('Error updating group:', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});



// GET: trade usage for a user (how many trades used out of 4)
router.get('/:userId/trades-usage', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).select('tradesUsed');
    if (!user) return res.status(404).json({ message: 'User not found' });
    const used = Number(user.tradesUsed || 0);
    const cap = 4;
    const remaining = Math.max(0, cap - used);
    res.json({ tradesUsed: used, cap, remaining });
  } catch (e) {
    console.error('Trade usage error', e);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// GET: roster for a team (players owned by a user)
router.get('/:userId/roster', async (req, res) => {
  try {
    const { userId } = req.params;
    const roster = await UserPlayer.find({ userId, isActive: true })
      .populate('playerId', 'name type role')
      .lean();
    const players = roster.map(r => ({ id: r.playerId._id, name: r.playerId.name, type: r.playerId.type, role: r.playerId.role }));
    res.json({ userId, players });
  } catch (error) {
    console.error('Error fetching roster:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Cleanup boughtPlayers arrays endpoint
router.post('/cleanup-bought-players', async (req, res) => {
  try {
    console.log('🔍 Starting boughtPlayers cleanup via API...\n');

    // Get all users with boughtPlayers
    const users = await User.find({ 
      boughtPlayers: { $exists: true, $not: { $size: 0 } } 
    }).select('_id teamName boughtPlayers');

    console.log(`📊 Found ${users.length} users with boughtPlayers arrays`);

    const cleanupResults = [];
    let totalRemoved = 0;
    let totalAdded = 0;
    let totalFixed = 0;

    for (const user of users) {
      console.log(`\n👤 Processing ${user.teamName || 'Unknown'} (${user._id})`);
      console.log(`   Current boughtPlayers: ${user.boughtPlayers.length} players`);

      // Get all active players for this user from UserPlayer collection
      const activeUserPlayers = await UserPlayer.find({ 
        userId: user._id, 
        isActive: true 
      }).select('playerId').populate('playerId', 'name type role');

      const activePlayerIds = activeUserPlayers.map(up => up.playerId._id.toString());
      console.log(`   Active players from UserPlayer: ${activePlayerIds.length} players`);

      // Find players that are in boughtPlayers but not in active UserPlayer entries
      const invalidPlayerIds = user.boughtPlayers.filter(playerId => 
        !activePlayerIds.includes(playerId.toString())
      );

      // Get details of invalid players for logging
      const invalidPlayers = await Player.find({ 
        _id: { $in: invalidPlayerIds } 
      }).select('name type role');

      // Find players that should be in boughtPlayers but aren't
      const missingPlayerIds = activePlayerIds.filter(playerId => 
        !user.boughtPlayers.some(bp => bp.toString() === playerId)
      );

      // Get details of missing players for logging
      const missingPlayers = await Player.find({ 
        _id: { $in: missingPlayerIds } 
      }).select('name type role');

      const userResult = {
        userId: user._id,
        teamName: user.teamName || 'Unknown',
        beforeCleanup: {
          boughtPlayersCount: user.boughtPlayers.length,
          activePlayersCount: activePlayerIds.length,
          invalidPlayers: invalidPlayers.map(p => ({
            id: p._id,
            name: p.name,
            type: p.type,
            role: p.role
          })),
          missingPlayers: missingPlayers.map(p => ({
            id: p._id,
            name: p.name,
            type: p.type,
            role: p.role
          }))
        },
        afterCleanup: null,
        changes: {
          removed: 0,
          added: 0,
          needsCleanup: false
        }
      };

      if (invalidPlayerIds.length > 0 || missingPlayerIds.length > 0) {
        console.log(`   ❌ Found ${invalidPlayerIds.length} invalid players in boughtPlayers:`);
        invalidPlayers.forEach(player => {
          console.log(`      - ${player.name} (${player.type})`);
        });

        if (missingPlayerIds.length > 0) {
          console.log(`   ⚠️  Found ${missingPlayerIds.length} active players missing from boughtPlayers:`);
          missingPlayers.forEach(player => {
            console.log(`      + ${player.name} (${player.type})`);
          });
        }

        // Remove invalid players from boughtPlayers array
        user.boughtPlayers = user.boughtPlayers.filter(playerId => 
          activePlayerIds.includes(playerId.toString())
        );

        // Add missing players to boughtPlayers array
        if (missingPlayerIds.length > 0) {
          user.boughtPlayers.push(...missingPlayerIds.map(id => new mongoose.Types.ObjectId(id)));
        }

        await user.save();
        
        totalRemoved += invalidPlayerIds.length;
        totalAdded += missingPlayerIds.length;
        totalFixed++;
        
        console.log(`   ✅ Cleaned up ${invalidPlayerIds.length} invalid players`);
        console.log(`   ✅ Added ${missingPlayerIds.length} missing players`);
        console.log(`   📊 Updated boughtPlayers: ${user.boughtPlayers.length} players`);

        userResult.afterCleanup = {
          boughtPlayersCount: user.boughtPlayers.length,
          activePlayersCount: activePlayerIds.length
        };
        userResult.changes.removed = invalidPlayerIds.length;
        userResult.changes.added = missingPlayerIds.length;
        userResult.changes.needsCleanup = true;
      } else {
        console.log(`   ✅ No cleanup needed - all players are valid`);
        userResult.afterCleanup = {
          boughtPlayersCount: user.boughtPlayers.length,
          activePlayersCount: activePlayerIds.length
        };
        userResult.changes.needsCleanup = false;
      }

      cleanupResults.push(userResult);
    }

    // Final verification
    console.log('\n🔍 Final verification...');
    const finalUsers = await User.find({ 
      boughtPlayers: { $exists: true, $not: { $size: 0 } } 
    }).select('_id teamName boughtPlayers');

    let allValid = true;
    const verificationResults = [];

    for (const user of finalUsers) {
      const activeUserPlayers = await UserPlayer.find({ 
        userId: user._id, 
        isActive: true 
      }).select('playerId');
      
      const activePlayerIds = activeUserPlayers.map(up => up.playerId.toString());
      const boughtPlayerIds = user.boughtPlayers.map(bp => bp.toString());
      
      const invalidCount = boughtPlayerIds.filter(id => !activePlayerIds.includes(id)).length;
      const missingCount = activePlayerIds.filter(id => !boughtPlayerIds.includes(id)).length;
      
      verificationResults.push({
        teamName: user.teamName || 'Unknown',
        invalidPlayers: invalidCount,
        missingPlayers: missingCount,
        isConsistent: invalidCount === 0 && missingCount === 0
      });

      if (invalidCount > 0 || missingCount > 0) {
        console.log(`❌ ${user.teamName} still has ${invalidCount} invalid players and ${missingCount} missing players`);
        allValid = false;
      }
    }

    console.log('\n🎉 Cleanup completed!');
    console.log(`📊 Summary:`);
    console.log(`   - Users processed: ${users.length}`);
    console.log(`   - Users fixed: ${totalFixed}`);
    console.log(`   - Invalid players removed: ${totalRemoved}`);
    console.log(`   - Missing players added: ${totalAdded}`);

    if (allValid) {
      console.log('✅ All boughtPlayers arrays are now consistent with UserPlayer data!');
    } else {
      console.log('⚠️  Some inconsistencies remain - manual review may be needed');
    }

    res.json({
      success: true,
      message: 'Cleanup completed successfully',
      summary: {
        usersProcessed: users.length,
        usersFixed: totalFixed,
        invalidPlayersRemoved: totalRemoved,
        missingPlayersAdded: totalAdded,
        allConsistent: allValid
      },
      results: cleanupResults,
      verification: verificationResults
    });

  } catch (error) {
    console.error('❌ Cleanup error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error during cleanup',
      error: error.message 
    });
  }
});

// Check boughtPlayers status endpoint (read-only)
router.get('/check-bought-players-status', async (req, res) => {
  try {
    console.log('🔍 Checking boughtPlayers status...\n');

    const users = await User.find({ 
      boughtPlayers: { $exists: true, $not: { $size: 0 } } 
    }).select('_id teamName boughtPlayers');

    const statusResults = [];
    let totalUsers = 0;
    let inconsistentUsers = 0;
    let totalInvalidPlayers = 0;
    let totalMissingPlayers = 0;

    for (const user of users) {
      totalUsers++;
      
      // Get active players for this user
      const activeUserPlayers = await UserPlayer.find({ 
        userId: user._id, 
        isActive: true 
      }).select('playerId').populate('playerId', 'name type role');
      
      const activePlayerIds = activeUserPlayers.map(up => up.playerId._id.toString());
      
      // Check for inconsistencies
      const invalidPlayerIds = user.boughtPlayers.filter(playerId => 
        !activePlayerIds.includes(playerId.toString())
      );
      
      const missingPlayerIds = activePlayerIds.filter(playerId => 
        !user.boughtPlayers.some(bp => bp.toString() === playerId)
      );

      // Get player details for invalid players
      const invalidPlayers = await Player.find({ 
        _id: { $in: invalidPlayerIds } 
      }).select('name type role');

      // Get player details for missing players
      const missingPlayers = await Player.find({ 
        _id: { $in: missingPlayerIds } 
      }).select('name type role');

      const userStatus = {
        userId: user._id,
        teamName: user.teamName || 'Unknown',
        boughtPlayersCount: user.boughtPlayers.length,
        activePlayersCount: activePlayerIds.length,
        invalidPlayers: invalidPlayers.map(p => ({
          id: p._id,
          name: p.name,
          type: p.type,
          role: p.role
        })),
        missingPlayers: missingPlayers.map(p => ({
          id: p._id,
          name: p.name,
          type: p.type,
          role: p.role
        })),
        isConsistent: invalidPlayerIds.length === 0 && missingPlayerIds.length === 0
      };

      if (invalidPlayerIds.length > 0 || missingPlayerIds.length > 0) {
        inconsistentUsers++;
        totalInvalidPlayers += invalidPlayerIds.length;
        totalMissingPlayers += missingPlayerIds.length;
        
        console.log(`❌ ${user.teamName || 'Unknown'}:`);
        console.log(`   - Invalid players in boughtPlayers: ${invalidPlayerIds.length}`);
        console.log(`   - Missing players from boughtPlayers: ${missingPlayerIds.length}`);
        console.log(`   - Total boughtPlayers: ${user.boughtPlayers.length}`);
        console.log(`   - Active UserPlayers: ${activePlayerIds.length}`);
      }

      statusResults.push(userStatus);
    }

    console.log(`\n📊 Summary:`);
    console.log(`   - Total users with boughtPlayers: ${totalUsers}`);
    console.log(`   - Users with inconsistencies: ${inconsistentUsers}`);
    console.log(`   - Total invalid players: ${totalInvalidPlayers}`);
    console.log(`   - Total missing players: ${totalMissingPlayers}`);

    if (inconsistentUsers === 0) {
      console.log(`\n✅ All boughtPlayers arrays are consistent!`);
    } else {
      console.log(`\n⚠️  ${inconsistentUsers} users need cleanup. Use /cleanup-bought-players endpoint to fix.`);
    }

    res.json({
      success: true,
      message: 'Status check completed',
      summary: {
        totalUsers,
        inconsistentUsers,
        totalInvalidPlayers,
        totalMissingPlayers,
        allConsistent: inconsistentUsers === 0
      },
      results: statusResults
    });

  } catch (error) {
    console.error('❌ Status check error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error during status check',
      error: error.message 
    });
  }
});

module.exports = router;


