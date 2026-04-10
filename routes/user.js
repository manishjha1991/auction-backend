const express = require('express');
// Adjust the path based on your project structure
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const router = express.Router();
const { getClientIp } = require('../utils/network');
const { cacheConfig, invalidateCache } = require('../utils/cache');
const { emitPointsTableUpdated } = require('../utils/emitPointsTableUpdate');

// Request logging only in development (avoids logging sensitive body in prod)
router.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production') console.log(`👤 ${req.method} ${req.path}`);
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
const { clampTradesUsed } = require('../utils/tradeConstants');
const { getTradeRules } = require('../utils/tradeRules');
const MatchResult = require('../models/MatchResult');
const Tournament = require('../models/Tournament');
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
  
  if (process.env.NODE_ENV !== 'production') console.log(`🔐 Login from ${country}`);
  
  const { email, password } = req.body;
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
    // Parse purse from Decimal128 to number
    const purseValue = user.purse ? parseFloat(user.purse.toString()) : 0;
    
    res.json({
      _id: user._id,
      id: user._id,
      name: user.name,
      email: user.email,
      teamName: user.teamName,
      playStationId: user.playStationId,
      isAdmin: user.isAdmin,
      timezone: user.timezone,
      streamLink: user.streamLink,
      purse: purseValue, // Include purse value
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

  // 🚀 PERFORMANCE: Check cache first (2 minute cache for user details)
  const cacheKey = `user-details:${userId}`;
  const cached = cacheConfig.medium.get(cacheKey);
  if (cached) return res.status(200).json(cached);

  try {
    
    // 1) Fetch user data
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const user = await User.findById(userId).includeInactive().lean();
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }
    
    // 2) Fetch sold players for the user
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const soldPlayers = await UserPlayer.find({ userId, isActive: true })
      .populate("playerId", "name type role basePrice over overallScore totalRuns totalWickets")
      .lean()
      .exec();

    // 3) Fetch all bids for the user
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const userBids = await Bid.find({ bidder: userId })
      .select('playerId bidAmount isBidOn isActive timestamp bidder')
      .populate("playerId", "name type role basePrice")
      .sort({ timestamp: -1 })
      .lean()
      .exec();

    // Separate active and past bids
    const activeBids = [];
    const pastBids = [];

    // OPTIMIZATION: Get all past bid player IDs first
    const pastBidPlayerIds = userBids
      .filter(bid => !(bid.isBidOn && bid.isActive))
      .map(bid => bid.playerId._id);

    // OPTIMIZATION: Get all highest bids in ONE query instead of N queries
    const highestBids = await Bid.aggregate([
      { $match: { playerId: { $in: pastBidPlayerIds } } },
      { $sort: { playerId: 1, bidAmount: -1 } },
      { $group: {
        _id: "$playerId",
        highestBid: { $first: "$$ROOT" }
      }}
    ]);

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

    // OPTIMIZATION: Get all opponent team names first
    const opponentTeamNames = fixtures.map(fx => 
      fx.team1 === user.teamName ? fx.team2 : fx.team1
    );

    // OPTIMIZATION: Get all opponent users in ONE query instead of N queries
    // 🚀 PERFORMANCE: Use .lean() for faster queries
    const opponentUsers = await User.find({ 
      teamName: { $in: opponentTeamNames },
      isTournamentReady: true 
    }).select('teamName').lean();

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
    
    const response = {
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
    };
    
    // 🚀 PERFORMANCE: Cache the response (2 minute cache)
    cacheConfig.medium.set(cacheKey, response);
    
    res.status(200).json(response);
  } catch (error) {
    console.error("Error fetching user details:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

// Get full bids list for a user (active + past)
router.get("/:userId/bids", async (req, res) => {
  const { userId } = req.params;
  try {
    const user = await User.findById(userId).select('_id name').lean();
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const userBids = await Bid.find({ bidder: userId })
      .populate("playerId", "name type role basePrice")
      .sort({ timestamp: -1 })
      .lean()
      .exec();

    const bidPlayerIds = userBids.map((bid) => bid.playerId?._id).filter(Boolean);
    const highestBids = await Bid.aggregate([
      { $match: { playerId: { $in: bidPlayerIds } } },
      { $project: { playerId: 1, bidder: 1, bidAmount: 1, isActive: 1, isBidOn: 1 } },
      { $sort: { playerId: 1, bidAmount: -1 } },
      {
        $group: {
          _id: "$playerId",
          highestBid: { $first: "$$ROOT" }
        }
      }
    ]);
    const highestBidMap = new Map();
    highestBids.forEach((item) => {
      highestBidMap.set(item._id.toString(), item.highestBid);
    });

    const bids = userBids.map((bid) => {
      const highestBid = highestBidMap.get(bid.playerId?._id?.toString());
      const isActive = bid.isBidOn && bid.isActive;
      let status = "Out";
      if (isActive) {
        if (highestBid && highestBid.bidder?.toString() === userId.toString()) {
          status = "Winning";
        } else {
          status = "Losing";
        }
      } else if (highestBid && highestBid.bidder?.toString() === userId.toString()) {
        status = "Won";
      } else {
        status = "Lost";
      }

      return {
        playerId: bid.playerId?._id,
        playerName: bid.playerId?.name,
        playerType: bid.playerId?.type,
        playerRole: bid.playerId?.role,
        bidAmount: bid.bidAmount,
        status
      };
    });

    res.json({ bids });
  } catch (error) {
    console.error("Error fetching user bids:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});



router.get("/purses", async (req, res) => {
  const startTime = Date.now();
  
  // 🚀 PERFORMANCE: Check cache first (2 minute cache for purses)
  const cacheKey = 'user-purses';
  const cached = cacheConfig.medium.get(cacheKey);
  if (cached) return res.status(200).json(cached);
  
  try {
    
    // OPTIMIZATION: Fetch all data in parallel with single queries (excluding admin users)
    // 🚀 PERFORMANCE: All queries already use .lean() - optimized!
    const [users, allUserPlayers, allActiveBids, matchResults, worldCupTournaments] = await Promise.all([
      User.find({ isAdmin: { $ne: true } }).select("name teamName purse _id").lean(),
      UserPlayer.find({ isActive: true })
        .select('userId playerId bidValue')
        .populate("playerId", "name type role")
        .lean(),
      Bid.find({ isActive: true, isBidOn: true })
        .select('playerId bidder bidAmount timestamp isActive isBidOn')
        .populate("playerId", "name type role")
        .populate("bidder", "name _id")
        .sort({ bidAmount: -1 })
        .lean(),
      MatchResult.find({}).select('winner team1 team2').lean(),
      Tournament.find({ 
        status: 'completed',
        name: { $regex: /^World Cup/ }
      }).select('name winner endDate tournamentFixtures').lean()
    ]);
    

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

        // Calculate World Cup wins for this team
        const worldCupWins = worldCupTournaments.filter(tournament => {
          return tournament.winner && 
                 tournament.winner.teamName && 
                 tournament.winner.teamName === user.teamName;
        });
        
        const worldCupCount = worldCupWins.length;
        const worldCupWinsList = worldCupWins.map(wc => ({
          tournamentName: wc.name,
          wonAt: wc.winner?.wonAt || wc.endDate || null
        }));

        // Calculate World Cup runner-ups (teams that reached final but lost)
        // Helper function to normalize team names for comparison
        const normalizeTeamName = (name) => {
          if (!name) return '';
          return name.trim().toLowerCase();
        };
        
        const worldCupRunnerUps = worldCupTournaments.filter(tournament => {
          // Check if tournament has a winner
          if (!tournament.winner || !tournament.winner.teamName) return false;
          
          const normalizedUserTeam = normalizeTeamName(user.teamName);
          const normalizedTournamentWinner = normalizeTeamName(tournament.winner.teamName);
          
          // If this team is the winner, they're not a runner-up
          if (normalizedUserTeam === normalizedTournamentWinner) return false;
          
          // Check if this team was in the final match
          if (tournament.tournamentFixtures && tournament.tournamentFixtures.length > 0) {
            // Get the final fixture (last fixture)
            const finalFixture = tournament.tournamentFixtures[tournament.tournamentFixtures.length - 1];
            
            if (finalFixture) {
              // Normalize team names for comparison
              const normalizedTeam1 = normalizeTeamName(finalFixture.team1);
              const normalizedTeam2 = normalizeTeamName(finalFixture.team2);
              
              // Check if this team was in the final (team1 or team2)
              const wasInFinal = (normalizedTeam1 === normalizedUserTeam || normalizedTeam2 === normalizedUserTeam);
              
              // If team was in final and didn't win, they're the runner-up
              if (wasInFinal) {
                // Debug logging for Shantanu
                if (normalizedUserTeam.includes('shantanu')) {
                  console.log(`✅ World Cup Runner-up FOUND for ${user.teamName}:`, {
                    tournamentName: tournament.name,
                    finalFixtureTeam1: finalFixture.team1,
                    finalFixtureTeam2: finalFixture.team2,
                    tournamentWinner: tournament.winner.teamName,
                    userTeamName: user.teamName
                  });
                }
                return true;
              }
            }
          }
          
          return false;
        });
        
        const worldCupRunnerUpCount = worldCupRunnerUps.length;
        
        // Debug logging
        if (user.teamName?.toLowerCase().includes('shantanu')) {
          console.log(`🔍 World Cup Runner-up Check for ${user.teamName}:`, {
            totalWorldCups: worldCupTournaments.length,
            runnerUpCount: worldCupRunnerUpCount,
            worldCupWins: worldCupCount
          });
        }

        // Convert purse from Decimal128 to Number
        // Handle both Decimal128 object and lean() format ($numberDecimal)
        let purseValue = 0;
        if (user.purse) {
          if (typeof user.purse === 'object') {
            // Check if it's the lean() format with $numberDecimal
            if (user.purse.$numberDecimal !== undefined) {
              purseValue = parseFloat(user.purse.$numberDecimal);
            } else if (user.purse.toString) {
              // It's a Decimal128 object
              purseValue = parseFloat(user.purse.toString());
            } else {
              purseValue = parseFloat(user.purse) || 0;
            }
          } else {
            // It's already a number or string
            purseValue = parseFloat(user.purse) || 0;
          }
        }

        return {
          id: user._id, // Add user ID for frontend reference
          userName: user.name,
          teamName: user.teamName,
          purseValue: purseValue, // Convert Decimal128 to Number safely
          players: [...soldPlayers, ...biddingPlayers], // Combine sold and bidding players
          trophyCount: trophyCount,
          runnerUpCount: runnerUpCount,
          worldCupCount: worldCupCount,
          worldCupRunnerUpCount: worldCupRunnerUpCount,
          worldCupWins: worldCupWinsList // Array of World Cup wins with tournament name and date
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
    
    // Calculate bidding status for each player (use string keys for consistency)
    playerBiddersMap.forEach((bidders, playerName) => {
      const sortedBidders = bidders.sort((a, b) => b.bidAmount - a.bidAmount);
      sortedBidders.forEach((bidder, index) => {
        const key = `${String(bidder.userId || '')}-${playerName}`;
        biddingStatusMap.set(key, {
          isHighest: index === 0,
          isSecondHighest: index === 1,
          position: index + 1,
          totalBidders: sortedBidders.length
        });
      });
    });

    // 🚀 PERFORMANCE: Pre-calculate competitor bidder info for all players
    const playerCompetitorMap = new Map();
    allActiveBids.forEach(bid => {
      const playerId = bid.playerId._id.toString();
      const playerName = bid.playerId.name;
      
      if (!playerCompetitorMap.has(playerId)) {
        playerCompetitorMap.set(playerId, []);
      }
      
      playerCompetitorMap.get(playerId).push({
        bidderId: bid.bidder._id.toString(),
        bidderName: bid.bidder.name,
        bidAmount: bid.bidAmount
      });
    });
    
    // Sort bids for each player and extract competitor info
    const competitorInfoMap = new Map();
    playerCompetitorMap.forEach((bids, playerId) => {
      const sortedBids = bids.sort((a, b) => b.bidAmount - a.bidAmount);
      sortedBids.forEach((bid, index) => {
        const key = `${bid.bidderId}-${playerId}`;
        let competitorName = null;
        
        if (index === 0 && sortedBids.length > 1) {
          // Highest bidder - competitor is second highest
          competitorName = sortedBids[1].bidderName;
        } else if (index === 1) {
          // Second highest - competitor is highest
          competitorName = sortedBids[0].bidderName;
        } else if (index > 1) {
          // Lower position - competitor is highest
          competitorName = sortedBids[0].bidderName;
        }
        
        competitorInfoMap.set(key, {
          competitorName,
          position: index + 1
        });
      });
    });

    // OPTIMIZATION: Apply bidding status using pre-calculated map
    const enhancedUserData = userData.map((user) => {
      const enhancedPlayers = user.players.map((player) => {
        if (!player.isBidOn) {
          return player;
        }
        
        const biddingStatusKey = `${String(user.id || user._id)}-${player.name}`;
        const biddingStatus = biddingStatusMap.get(biddingStatusKey) || {
          isHighest: false,
          isSecondHighest: false,
          position: 1,
          totalBidders: 1
        };
        
        // Get competitor info (normalize IDs to string for consistent lookup)
        const competitorKey = `${String(user.id || user._id)}-${String(player.id || player._id)}`;
        const competitorInfo = competitorInfoMap.get(competitorKey) || {
          competitorName: null,
          position: biddingStatus.position
        };

        return {
          ...player,
          biddingStatus,
          competitorName: competitorInfo.competitorName,
          bidPosition: competitorInfo.position
        };
      });

      return {
        ...user,
        players: enhancedPlayers
      };
    });


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

    // 🚀 PERFORMANCE: Invalidate user details cache when profile is updated
    invalidateCache(`user-details:${userId}`);

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

    emitPointsTableUpdated(req, { reason: 'user_update_points' });
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

    emitPointsTableUpdated(req, { reason: 'admin_update_fairness' });
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




// Helper function to parse score string and extract runs
// Handles formats like "150", "150/5", "150/10", "150-5", etc.
const parseRuns = (scoreString) => {
  if (!scoreString) {
    return 0;
  }
  
  const scoreStr = String(scoreString).trim();
  
  // Check for invalid values
  if (scoreStr === 'null' || scoreStr === 'TBD' || scoreStr === 'NA' || 
      scoreStr === '' || scoreStr === 'undefined' || scoreStr.toLowerCase() === 'null') {
    return 0;
  }
  
  // Try to extract number - handle formats like "150", "150/5", "150-5", "150 (20.0 ov)"
  // Match any number at the start
  const match = scoreStr.match(/^(\d+)/);
  if (match) {
    const runs = parseInt(match[1], 10);
    return isNaN(runs) ? 0 : runs;
  }
  
  // If no match, try to parse as number directly
  const num = parseFloat(scoreStr);
  return isNaN(num) ? 0 : Math.floor(num);
};

// Helper function to parse wickets from score string (e.g., "150/10" → 10, "180/5" → 5)
const parseWickets = (scoreString) => {
  if (!scoreString) {
    return 0;
  }
  
  const scoreStr = String(scoreString).trim();
  
  // Check for invalid values
  if (scoreStr === 'null' || scoreStr === 'TBD' || scoreStr === 'NA' || 
      scoreStr === '' || scoreStr === 'undefined' || scoreStr.toLowerCase() === 'null') {
    return 0;
  }
  
  // Try to extract wickets from formats like "150/10", "180/5", "150-10"
  // Pattern: number/number or number-number
  const slashMatch = scoreStr.match(/\/(\d+)/); // Match "/10" or "/5"
  if (slashMatch) {
    const wickets = parseInt(slashMatch[1], 10);
    if (!isNaN(wickets) && wickets >= 0 && wickets <= 10) {
      return wickets;
    }
  }
  
  // Try hyphen format: "150-10"
  const hyphenMatch = scoreStr.match(/-(\d+)/);
  if (hyphenMatch) {
    const wickets = parseInt(hyphenMatch[1], 10);
    if (!isNaN(wickets) && wickets >= 0 && wickets <= 10) {
      return wickets;
    }
  }
  
  // If no wickets found in score, assume 0 wickets (not all out)
  return 0;
};

// Helper function to parse overs string and convert to decimal (e.g., "20.0" -> 20.0, "19.3" -> 19.5, "18.5" -> 18.5)
const parseOvers = (oversString) => {
  if (!oversString) {
    return null; // Return null if not provided, will use default
  }
  
  const oversStr = String(oversString).trim();
  
  // Check for invalid values
  if (oversStr === 'null' || oversStr === 'TBD' || oversStr === 'NA' || 
      oversStr === '' || oversStr === 'undefined' || oversStr.toLowerCase() === 'null') {
    return null;
  }
  
  // Handle decimal format: "20.0", "19.3", "18.5"
  // Format: overs.balls where balls is 0-5
  const decimalMatch = oversStr.match(/^(\d+)\.(\d+)$/);
  if (decimalMatch) {
    const overs = parseInt(decimalMatch[1], 10);
    const balls = parseInt(decimalMatch[2], 10);
    if (!isNaN(overs) && !isNaN(balls) && balls >= 0 && balls <= 5) {
      // Convert to decimal: overs + (balls / 6)
      return overs + (balls / 6);
    }
  }
  
  // Handle whole number format: "20" -> 20.0
  const wholeMatch = oversStr.match(/^(\d+)$/);
  if (wholeMatch) {
    const overs = parseInt(wholeMatch[1], 10);
    if (!isNaN(overs)) {
      return overs;
    }
  }
  
  // Try to parse as float directly
  const num = parseFloat(oversStr);
  if (!isNaN(num) && num >= 0) {
    return num;
  }
  
  return null; // Invalid format, will use default
};

// Calculate Net Run Rate (NRR) for a team following ICC rules
// NRR = (Total Runs Scored / Total Overs Faced) - (Total Runs Conceded / Total Overs Bowled)
// Uses overs from main fixtures (team1Overs and team2Overs) - these are the actual overs played by both teams
// ICC Rule: If a team is all out (10 wickets), use full quota (20 overs) for NRR calculation
const calculateNRR = (fixtures, teamName, userId) => {
  const DEFAULT_OVERS = 20; // Standard T20 format - used if overs not provided
  let totalRunsScored = 0;
  let totalRunsConceded = 0;
  let totalOversFaced = 0;
  let totalOversBowled = 0;
  let matchesCount = 0;

  // Convert userId to string for comparison
  const userIdStr = userId ? userId.toString() : null;

  fixtures.forEach((fixture) => {
    // Skip if match is not completed
    if (!fixture.winner) {
      return;
    }

    // Check if scores exist
    const score1 = fixture.team1Score;
    const score2 = fixture.team2Score;
    
    // Parse runs from scores
    const team1Runs = parseRuns(score1);
    const team2Runs = parseRuns(score2);

    // Skip if both scores are invalid (0 or couldn't parse)
    if (team1Runs === 0 && team2Runs === 0) {
      return;
    }

    // Parse wickets to check for all-out scenarios
    const team1Wickets = parseWickets(score1);
    const team2Wickets = parseWickets(score2);

    // ICC RULE: Use overs from fixture (team1Overs and team2Overs) - these are the actual overs played by both teams
    let team1OversActual = parseOvers(fixture.team1Overs);
    let team2OversActual = parseOvers(fixture.team2Overs);
    
    // If overs are not provided in fixture, use default (shouldn't happen for completed matches with overs)
    if (team1OversActual === null) {
      console.warn(`⚠️ Missing team1Overs in fixture for ${fixture.team1} vs ${fixture.team2}. Using default ${DEFAULT_OVERS} overs.`);
      team1OversActual = DEFAULT_OVERS;
    }
    if (team2OversActual === null) {
      console.warn(`⚠️ Missing team2Overs in fixture for ${fixture.team1} vs ${fixture.team2}. Using default ${DEFAULT_OVERS} overs.`);
      team2OversActual = DEFAULT_OVERS;
    }

    // ICC RULE 1 & 2: Overs FACED
    // If team is all out (10 wickets), use FULL quota (20.0 overs), otherwise use actual overs
    let team1OversFaced = (team1Wickets === 10) ? DEFAULT_OVERS : team1OversActual;
    let team2OversFaced = (team2Wickets === 10) ? DEFAULT_OVERS : team2OversActual;
    
    // ICC RULE 3: Overs BOWLED
    // If opposition is all out, use FULL quota (20.0 overs), otherwise use actual overs
    let team1OversBowled = (team2Wickets === 10) ? DEFAULT_OVERS : team2OversActual;
    let team2OversBowled = (team1Wickets === 10) ? DEFAULT_OVERS : team1OversActual;

    // Match by userId first (more reliable), then fall back to teamName
    // Handle both ObjectId and string formats
    const team1UserIdStr = fixture.team1UserId ? 
      (fixture.team1UserId.toString ? fixture.team1UserId.toString() : String(fixture.team1UserId)) : null;
    const team2UserIdStr = fixture.team2UserId ? 
      (fixture.team2UserId.toString ? fixture.team2UserId.toString() : String(fixture.team2UserId)) : null;

    // Try userId matching first
    let isTeam1 = false;
    let isTeam2 = false;
    
    if (userIdStr) {
      if (team1UserIdStr && team1UserIdStr === userIdStr) {
        isTeam1 = true;
      } else if (team2UserIdStr && team2UserIdStr === userIdStr) {
        isTeam2 = true;
      }
    }
    
    // Fall back to teamName matching if userId didn't match
    if (!isTeam1 && !isTeam2) {
      if (fixture.team1 && fixture.team1.trim().toLowerCase() === teamName.trim().toLowerCase()) {
        isTeam1 = true;
      } else if (fixture.team2 && fixture.team2.trim().toLowerCase() === teamName.trim().toLowerCase()) {
        isTeam2 = true;
      }
    }

    if (!isTeam1 && !isTeam2) {
      return; // Team not involved in this match
    }

    if (isTeam1) {
      totalRunsScored += team1Runs;
      totalRunsConceded += team2Runs;
      // ICC RULE: Overs FACED (if all out, use 20.0; otherwise actual)
      totalOversFaced += team1OversFaced;
      // ICC RULE: Overs BOWLED (if opposition all out, use 20.0; otherwise actual)
      totalOversBowled += team1OversBowled;
    } else {
      totalRunsScored += team2Runs;
      totalRunsConceded += team1Runs;
      // ICC RULE: Overs FACED (if all out, use 20.0; otherwise actual)
      totalOversFaced += team2OversFaced;
      // ICC RULE: Overs BOWLED (if opposition all out, use 20.0; otherwise actual)
      totalOversBowled += team2OversBowled;
    }

    matchesCount++;
  });

  if (matchesCount === 0) {
    return 0;
  }

  // Calculate NRR
  const runsScoredPerOver = totalOversFaced > 0 ? totalRunsScored / totalOversFaced : 0;
  const runsConcededPerOver = totalOversBowled > 0 ? totalRunsConceded / totalOversBowled : 0;
  const nrr = runsScoredPerOver - runsConcededPerOver;

  return parseFloat(nrr.toFixed(3)); // Round to 3 decimal places
};

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

    // Fetch all completed fixtures to calculate NRR
    // Don't filter by score here - we'll check validity in the calculation function
    const fixtures = await Fixture.find({
      isActive: true,
      winner: { $ne: null, $exists: true }
    })
    .select('team1 team2 team1UserId team2UserId team1Score team2Score team1Overs team2Overs winner')
    .lean();
    
    console.log(`📊 Found ${fixtures.length} fixtures with winners for NRR calculation`);
    if (fixtures.length > 0) {
      console.log(`📊 Sample fixture:`, {
        team1: fixtures[0].team1,
        team2: fixtures[0].team2,
        team1Score: fixtures[0].team1Score,
        team2Score: fixtures[0].team2Score,
        team1UserId: fixtures[0].team1UserId,
        team2UserId: fixtures[0].team2UserId
      });
    }

    // Transform data to calculate wins, losses, fairness, and NRR
    const pointsTable = users.map((user) => {
      const matchesPlayed = user.matchesPlayed || 0;
      const points = user.points || 0;
      const fairness = user.fairnessPoint || 0;
      const teamImage = user.teamImage || '';

      // Calculate wins and losses
      const wins = Math.floor(points / 2); // each win = 2 points
      const losses = matchesPlayed - wins;

      // Calculate NRR for this team
      const nrr = calculateNRR(fixtures, user.teamName, user._id);
      
      // Debug first team's NRR calculation
      if (users.indexOf(user) === 0) {
        console.log(`📊 NRR calculation for ${user.teamName} (${user._id}):`, nrr);
        console.log(`📊 Total fixtures checked: ${fixtures.length}`);
        console.log(`📊 Team name for matching: "${user.teamName}"`);
        // Log sample fixtures to see what we're matching against
        const sampleFixtures = fixtures.slice(0, 5);
        sampleFixtures.forEach((fx, idx) => {
          console.log(`📊 Sample fixture ${idx + 1}:`, {
            team1: fx.team1,
            team2: fx.team2,
            team1UserId: fx.team1UserId ? fx.team1UserId.toString() : null,
            team2UserId: fx.team2UserId ? fx.team2UserId.toString() : null,
            team1Score: fx.team1Score,
            team2Score: fx.team2Score,
            winner: fx.winner,
            parsedTeam1Runs: parseRuns(fx.team1Score),
            parsedTeam2Runs: parseRuns(fx.team2Score)
          });
        });
      }

      return {
        _id: user._id,
        teamName: user.abbreviation || user.teamName || 'Unknown', // Display name (abbreviation)
        originalTeamName: user.teamName || 'Unknown', // Original team name for fixture matching
        matchesPlayed,
        points,
        wins,
        losses,
        fairness,
        nrr,
        teamImage
      };
    });

    // Sort the points table: Points → NRR → Fairness
    const sortedPointsTable = pointsTable.sort((a, b) => {
      // Priority 1: Points (descending)
      if (b.points !== a.points) {
        return b.points - a.points;
      }
      // Priority 2: Net Run Rate (descending)
      const nrrA = a.nrr || 0;
      const nrrB = b.nrr || 0;
      if (nrrB !== nrrA) {
        return nrrB - nrrA;
      }
      // Priority 3: Fairness (descending)
      if (b.fairness !== a.fairness) {
        return b.fairness - a.fairness;
      }
      // Priority 4: Matches played (ascending)
      if (a.matchesPlayed !== b.matchesPlayed) {
        return a.matchesPlayed - b.matchesPlayed;
      }
      // Priority 5: Alphabetical by team name (ascending)
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

    // Fetch all completed fixtures to calculate NRR
    // Don't filter by score here - we'll check validity in the calculation function
    const fixtures = await Fixture.find({
      isActive: true,
      winner: { $ne: null, $exists: true }
    })
    .select('team1 team2 team1UserId team2UserId team1Score team2Score winner')
      .lean();

    const toRow = (u) => {
      const matchesPlayed = u.matchesPlayed || 0;
      const points = u.points || 0;
      const fairness = u.fairnessPoint || 0;
      const wins = Math.floor(points / 2);
      const losses = matchesPlayed - wins;
      // Calculate NRR for this team
      const nrr = calculateNRR(fixtures, u.teamName, u._id);
      return {
        _id: u._id,
        teamName: u.abbreviation || u.teamName || 'Unknown', // Display name (abbreviation)
        originalTeamName: u.teamName || 'Unknown', // Original team name for fixture matching
        matchesPlayed,
        points,
        wins,
        losses,
        fairness,
        nrr,
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
      if (b.nrr !== a.nrr) return b.nrr - a.nrr;
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



// GET: trade usage for a user (completed trades + releases → tradesUsed vs season cap)
router.get('/:userId/trades-usage', async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).select('tradesUsed');
    if (!user) return res.status(404).json({ message: 'User not found' });
    const used = clampTradesUsed(user.tradesUsed);
    const rules = await getTradeRules();
    const cap = rules.tradeSeasonCap;
    const remaining = Math.max(0, cap - used);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({
      tradesUsed: used,
      cap,
      remaining,
      maxActiveOutgoing: rules.maxActiveOutgoingTrades,
      maxTradesPerOpponentPair: rules.maxTradesPerOpponentPair,
    });
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

// GET: Calculate what's needed to reach a target position
router.get('/position-calculator/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { targetPosition } = req.query;
    
    if (!targetPosition || isNaN(targetPosition)) {
      return res.status(400).json({ message: 'Target position is required and must be a number' });
    }

    const targetPos = parseInt(targetPosition);

    // Get current point table (reuse the logic from /points-table)
    const users = await User.find({ 
      teamName: { $exists: true, $ne: null, $ne: "NA" }, 
      isActive: true,
      isAdmin: false
    })
    .select('_id teamName abbreviation points matchesPlayed fairnessPoint teamImage')
    .lean();

    if (!users.length) {
      return res.status(404).json({ message: 'No teams found' });
    }

    // Fetch all completed fixtures to calculate NRR
    const fixtures = await Fixture.find({
      isActive: true,
      winner: { $ne: null, $exists: true }
    })
    .select('team1 team2 team1UserId team2UserId team1Score team2Score team1Overs team2Overs winner')
    .lean();

    // Calculate point table with NRR
    const pointsTable = users.map((user) => {
      const matchesPlayed = user.matchesPlayed || 0;
      const points = user.points || 0;
      const fairness = user.fairnessPoint || 0;
      const wins = Math.floor(points / 2);
      const losses = matchesPlayed - wins;
      const nrr = calculateNRR(fixtures, user.teamName, user._id);

      return {
        _id: user._id,
        teamName: user.abbreviation || user.teamName || 'Unknown',
        originalTeamName: user.teamName || 'Unknown',
        matchesPlayed,
        points,
        wins,
        losses,
        fairness,
        nrr,
        teamImage: user.teamImage || ''
      };
    });

    // Sort the points table: Points → NRR → Fairness
    const sortedPointsTable = pointsTable.sort((a, b) => {
      if (b.points !== a.points) {
        return b.points - a.points;
      }
      const nrrA = a.nrr || 0;
      const nrrB = b.nrr || 0;
      if (nrrB !== nrrA) {
        return nrrB - nrrA;
      }
      if (b.fairness !== a.fairness) {
        return b.fairness - a.fairness;
      }
      if (a.matchesPlayed !== b.matchesPlayed) {
        return a.matchesPlayed - b.matchesPlayed;
      }
      const teamNameA = a.teamName || '';
      const teamNameB = b.teamName || '';
      return teamNameA.localeCompare(teamNameB);
    });

    // Add rank to each team
    const rankedPointsTable = sortedPointsTable.map((team, index) => ({
      rank: index + 1,
      ...team,
    }));

    // Find current user's position
    const currentUser = rankedPointsTable.find(t => t._id.toString() === userId.toString());
    if (!currentUser) {
      return res.status(404).json({ message: 'User not found in point table' });
    }

    const currentPosition = currentUser.rank;

    // Check if target position is valid
    if (targetPos < 1 || targetPos > rankedPointsTable.length) {
      return res.status(400).json({ 
        message: `Target position must be between 1 and ${rankedPointsTable.length}` 
      });
    }

    if (targetPos === currentPosition) {
      return res.json({
        currentPosition,
        targetPosition: targetPos,
        message: 'You are already at the target position!',
        requirements: null
      });
    }

    if (targetPos > currentPosition) {
      return res.status(400).json({ 
        message: 'Target position must be better (lower number) than current position' 
      });
    }

    // Find target position team
    const targetTeam = rankedPointsTable.find(t => t.rank === targetPos);
    if (!targetTeam) {
      return res.status(404).json({ message: 'Target position not found' });
    }

    // Calculate remaining matches
    // Assuming each team plays 13 matches (round-robin for 8 teams)
    const TOTAL_MATCHES = 13;
    const remainingMatches = Math.max(0, TOTAL_MATCHES - currentUser.matchesPlayed);

    if (remainingMatches === 0) {
      return res.json({
        currentPosition,
        targetPosition: targetPos,
        message: 'No remaining matches. Cannot improve position.',
        requirements: null
      });
    }

    // Calculate what's needed to surpass target position
    // To surpass, we need to be strictly better in at least one criterion:
    // 1. More points, OR
    // 2. Same points but better NRR, OR
    // 3. Same points and NRR but better fairness

    const targetPoints = targetTeam.points;
    const targetNRR = targetTeam.nrr || 0;
    const targetFairness = targetTeam.fairness || 0;

    const currentPoints = currentUser.points;
    const currentNRR = currentUser.nrr || 0;
    const currentFairness = currentUser.fairness || 0;

    // Calculate required improvements
    const pointsNeeded = targetPoints - currentPoints + 1; // Need at least 1 more point
    const pointsFromWins = Math.ceil(pointsNeeded / 2); // Each win = 2 points
    const minWinsNeeded = Math.max(0, pointsFromWins);

    // Calculate NRR improvement needed (if points will be equal)
    let nrrImprovementNeeded = 0;
    if (pointsNeeded <= remainingMatches * 2) {
      // If we can match points, calculate NRR needed
      if (currentNRR <= targetNRR) {
        nrrImprovementNeeded = targetNRR - currentNRR + 0.001; // Need to be slightly better
      }
    }

    // Calculate fairness improvement needed (if points and NRR will be equal)
    let fairnessImprovementNeeded = 0;
    if (pointsNeeded <= remainingMatches * 2 && nrrImprovementNeeded === 0) {
      if (currentFairness <= targetFairness) {
        fairnessImprovementNeeded = targetFairness - currentFairness + 1; // Need at least 1 more
      }
    }

    // Calculate current NRR totals from fixtures for the user
    let currentTotalRunsScored = 0;
    let currentTotalRunsConceded = 0;
    let currentTotalOversFaced = 0;
    let currentTotalOversBowled = 0;
    let currentMatchesCount = 0;

    fixtures.forEach((fixture) => {
      if (!fixture.winner) return;

      const score1 = fixture.team1Score;
      const score2 = fixture.team2Score;
      const team1Runs = parseRuns(score1);
      const team2Runs = parseRuns(score2);

      if (team1Runs === 0 && team2Runs === 0) return;

      const team1OversActual = parseOvers(fixture.team1Overs) || 20;
      const team2OversActual = parseOvers(fixture.team2Overs) || 20;

      const userIdStr = currentUser._id.toString();
      const team1UserIdStr = fixture.team1UserId ? fixture.team1UserId.toString() : null;
      const team2UserIdStr = fixture.team2UserId ? fixture.team2UserId.toString() : null;

      let isTeam1 = false;
      let isTeam2 = false;

      if (userIdStr) {
        if (team1UserIdStr === userIdStr) isTeam1 = true;
        else if (team2UserIdStr === userIdStr) isTeam2 = true;
      }

      if (!isTeam1 && !isTeam2) {
        if (fixture.team1 && fixture.team1.trim().toLowerCase() === currentUser.originalTeamName.trim().toLowerCase()) {
          isTeam1 = true;
        } else if (fixture.team2 && fixture.team2.trim().toLowerCase() === currentUser.originalTeamName.trim().toLowerCase()) {
          isTeam2 = true;
        }
      }

      if (!isTeam1 && !isTeam2) return;

      if (isTeam1) {
        currentTotalRunsScored += team1Runs;
        currentTotalRunsConceded += team2Runs;
        currentTotalOversFaced += team1OversActual;
        currentTotalOversBowled += team2OversActual;
      } else {
        currentTotalRunsScored += team2Runs;
        currentTotalRunsConceded += team1Runs;
        currentTotalOversFaced += team2OversActual;
        currentTotalOversBowled += team1OversActual;
      }

      currentMatchesCount++;
    });

    // Helper function to calculate new NRR after a match
    const calculateNewNRR = (yourRuns, yourOvers, opponentRuns, opponentOvers) => {
      const newTotalRunsScored = currentTotalRunsScored + yourRuns;
      const newTotalRunsConceded = currentTotalRunsConceded + opponentRuns;
      const newTotalOversFaced = currentTotalOversFaced + yourOvers;
      const newTotalOversBowled = currentTotalOversBowled + opponentOvers;

      const runsScoredPerOver = newTotalOversFaced > 0 ? newTotalRunsScored / newTotalOversFaced : 0;
      const runsConcededPerOver = newTotalOversBowled > 0 ? newTotalRunsConceded / newTotalOversBowled : 0;
      return parseFloat((runsScoredPerOver - runsConcededPerOver).toFixed(3));
    };

    // Calculate match scenarios for next match
    const matchScenarios = [];

    // Scenario 1: Batting First - Different scores
    const battingFirstScores = [150, 160, 170, 180, 190, 200];
    for (const yourScore of battingFirstScores) {
      // Assume opponent chases and loses by different margins
      for (const margin of [1, 3, 5, 7, 10]) {
        const opponentScore = yourScore - margin;
        const yourOvers = 20.0;
        const opponentOvers = 20.0; // Assume they use all 20 overs

        const newNRR = calculateNewNRR(yourScore, yourOvers, opponentScore, opponentOvers);
        const newPoints = currentPoints + 2; // Win = 2 points

        const willSurpass = newPoints > targetPoints ||
          (newPoints === targetPoints && newNRR > targetNRR) ||
          (newPoints === targetPoints && newNRR === targetNRR && currentFairness > targetFairness);

        if (willSurpass || matchScenarios.length < 5) {
          matchScenarios.push({
            type: 'bat_first',
            description: `Score ${yourScore} runs in 20 overs, restrict opponent to ${opponentScore} runs (win by ${margin} runs)`,
            yourScore,
            opponentScore,
            yourOvers: 20.0,
            opponentOvers: 20.0,
            margin: `${margin} runs`,
            newPoints,
            newNRR,
            willSurpass
          });
        }
      }
    }

    // Scenario 2: Batting Second - Different chase scenarios
    const opponentScores = [150, 160, 170, 180, 190, 200];
    for (const opponentScore of opponentScores) {
      // Chase with different wickets remaining (more wickets = better NRR)
      for (const wicketsRemaining of [1, 3, 5, 7, 9]) {
        const yourScore = opponentScore + 1; // Win by 1 run
        const opponentOvers = 20.0;
        // Calculate overs used based on wickets remaining
        // More wickets = fewer overs needed (better NRR)
        // Formula: overs = 20 - (wicketsRemaining * 1.5) gives realistic scenarios
        const yourOvers = Math.max(10.0, 20.0 - (wicketsRemaining * 1.2)); // At least 10 overs

        const newNRR = calculateNewNRR(yourScore, yourOvers, opponentScore, opponentOvers);
        const newPoints = currentPoints + 2;

        const willSurpass = newPoints > targetPoints ||
          (newPoints === targetPoints && newNRR > targetNRR) ||
          (newPoints === targetPoints && newNRR === targetNRR && currentFairness > targetFairness);

        if (willSurpass || matchScenarios.length < 10) {
          matchScenarios.push({
            type: 'bat_second',
            description: `Chase ${opponentScore} runs in ${yourOvers.toFixed(1)} overs (win by ${10 - wicketsRemaining} wickets)`,
            yourScore,
            opponentScore,
            yourOvers,
            opponentOvers: 20.0,
            margin: `${10 - wicketsRemaining} wickets`,
            newPoints,
            newNRR,
            willSurpass
          });
        }
      }
    }

    // Sort scenarios: willSurpass first, then by NRR improvement
    matchScenarios.sort((a, b) => {
      if (a.willSurpass !== b.willSurpass) {
        return b.willSurpass - a.willSurpass; // True first
      }
      return b.newNRR - a.newNRR; // Higher NRR first
    });

    // Take top 10 scenarios
    const topMatchScenarios = matchScenarios.slice(0, 10);

    // Calculate scenarios
    const scenarios = [];

    // Scenario 1: Win all remaining matches
    const winsAllPoints = currentPoints + (remainingMatches * 2);
    const winsAllBetter = winsAllPoints > targetPoints || 
                         (winsAllPoints === targetPoints && currentNRR > targetNRR) ||
                         (winsAllPoints === targetPoints && currentNRR === targetNRR && currentFairness > targetFairness);
    
    scenarios.push({
      type: 'win_all',
      description: `Win all ${remainingMatches} remaining matches`,
      points: winsAllPoints,
      nrr: currentNRR, // NRR will change based on actual match results
      fairness: currentFairness, // Fairness will change based on actual match results
      willReach: winsAllBetter,
      note: winsAllBetter ? 'This will help you reach the target position' : 'May need additional NRR/fairness improvements'
    });

    // Scenario 2: Minimum wins needed
    if (minWinsNeeded > 0 && minWinsNeeded <= remainingMatches) {
      const minPoints = currentPoints + (minWinsNeeded * 2);
      const minBetter = minPoints > targetPoints || 
                       (minPoints === targetPoints && currentNRR > targetNRR) ||
                       (minPoints === targetPoints && currentNRR === targetNRR && currentFairness > targetFairness);
      
      scenarios.push({
        type: 'minimum',
        description: `Win at least ${minWinsNeeded} out of ${remainingMatches} matches`,
        points: minPoints,
        nrr: currentNRR,
        fairness: currentFairness,
        willReach: minBetter,
        note: minBetter ? 'This is the minimum, but you may need better NRR/fairness' : 'Need to improve NRR or fairness as well'
      });
    }

    res.json({
      currentPosition,
      targetPosition: targetPos,
      currentStats: {
        points: currentPoints,
        nrr: currentNRR,
        fairness: currentFairness,
        matchesPlayed: currentUser.matchesPlayed,
        wins: currentUser.wins,
        losses: currentUser.losses
      },
      targetStats: {
        teamName: targetTeam.teamName,
        points: targetPoints,
        nrr: targetNRR,
        fairness: targetFairness,
        matchesPlayed: targetTeam.matchesPlayed,
        wins: targetTeam.wins,
        losses: targetTeam.losses
      },
      remainingMatches,
      requirements: {
        pointsNeeded,
        minWinsNeeded,
        nrrImprovementNeeded: nrrImprovementNeeded > 0 ? parseFloat(nrrImprovementNeeded.toFixed(3)) : 0,
        fairnessImprovementNeeded
      },
      scenarios,
      matchScenarios: topMatchScenarios,
      currentNRRTotals: {
        runsScored: currentTotalRunsScored,
        runsConceded: currentTotalRunsConceded,
        oversFaced: currentTotalOversFaced,
        oversBowled: currentTotalOversBowled,
        matchesCount: currentMatchesCount
      }
    });
  } catch (error) {
    console.error('Error calculating position requirements:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Advanced Position Calculator with Permutations
// GET /api/users/position-calculator-advanced/:userId?targetPosition=1&qualifyFor=top1
router.get('/position-calculator-advanced/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const targetPos = parseInt(req.query.targetPosition) || 1;
    const qualifyFor = req.query.qualifyFor || 'top1'; // top1, top2, top3, or any position number

    const TOTAL_MATCHES = 13;

    // Fetch all fixtures to get remaining matches
    const Fixture = require('../models/Fixture');
    const allFixtures = await Fixture.find({ isActive: true }).lean();

    // Calculate point table for all teams
    const users = await User.find({
      teamName: { $exists: true, $ne: null, $ne: 'NA' },
      isActive: true,
      isTournamentReady: true,
      isAdmin: { $ne: true }
    }).lean();

    // Helper functions (same as before)
    const parseRuns = (scoreString) => {
      if (!scoreString) return 0;
      const scoreStr = String(scoreString).trim();
      if (scoreStr === 'null' || scoreStr === 'TBD' || scoreStr === 'NA' || scoreStr === '' || scoreStr === 'undefined' || scoreStr.toLowerCase() === 'null') {
        return 0;
      }
      const match = scoreStr.match(/^(\d+)/);
      if (match) {
        const runs = parseInt(match[1], 10);
        return isNaN(runs) ? 0 : runs;
      }
      const num = parseFloat(scoreStr);
      return isNaN(num) ? 0 : Math.floor(num);
    };

    const parseOvers = (oversString) => {
      if (!oversString) return null;
      const oversStr = String(oversString).trim();
      if (oversStr === 'null' || oversStr === 'TBD' || oversStr === 'NA' || oversStr === '') {
        return null;
      }
      const match = oversStr.match(/(\d+)\.?(\d*)/);
      if (match) {
        const whole = parseInt(match[1], 10);
        const fraction = match[2] ? parseInt(match[2], 10) : 0;
        return whole + (fraction / 6);
      }
      return null;
    };

    const calculateNRR = (fixtures, teamName, userId) => {
      const DEFAULT_OVERS = 20;
      let totalRunsScored = 0;
      let totalRunsConceded = 0;
      let totalOversFaced = 0;
      let totalOversBowled = 0;
      let matchesCount = 0;

      const userIdStr = userId ? userId.toString() : null;

      fixtures.forEach((fixture) => {
        if (!fixture.winner) return;

        const score1 = fixture.team1Score;
        const score2 = fixture.team2Score;
        const team1Runs = parseRuns(score1);
        const team2Runs = parseRuns(score2);

        if (team1Runs === 0 && team2Runs === 0) return;

        let team1OversActual = parseOvers(fixture.team1Overs);
        let team2OversActual = parseOvers(fixture.team2Overs);

        if (team1OversActual === null) team1OversActual = DEFAULT_OVERS;
        if (team2OversActual === null) team2OversActual = DEFAULT_OVERS;

        let team1OversFaced = team1OversActual;
        let team2OversFaced = team2OversActual;

        let isTeam1 = false;
        let isTeam2 = false;
        
        if (userIdStr) {
          if (fixture.team1UserId && fixture.team1UserId.toString() === userIdStr) {
            isTeam1 = true;
          } else if (fixture.team2UserId && fixture.team2UserId.toString() === userIdStr) {
            isTeam2 = true;
          }
        }
        
        if (!isTeam1 && !isTeam2) {
          if (fixture.team1 && fixture.team1.trim().toLowerCase() === teamName.trim().toLowerCase()) {
            isTeam1 = true;
          } else if (fixture.team2 && fixture.team2.trim().toLowerCase() === teamName.trim().toLowerCase()) {
            isTeam2 = true;
          }
        }

        if (!isTeam1 && !isTeam2) return;

        if (isTeam1) {
          totalRunsScored += team1Runs;
          totalRunsConceded += team2Runs;
          totalOversFaced += team1OversFaced;
          totalOversBowled += team2OversActual;
        } else {
          totalRunsScored += team2Runs;
          totalRunsConceded += team1Runs;
          totalOversFaced += team2OversFaced;
          totalOversBowled += team1OversActual;
        }

        matchesCount++;
      });

      if (matchesCount === 0) return 0;

      const runsScoredPerOver = totalOversFaced > 0 ? totalRunsScored / totalOversFaced : 0;
      const runsConcededPerOver = totalOversBowled > 0 ? totalRunsConceded / totalOversBowled : 0;
      return parseFloat((runsScoredPerOver - runsConcededPerOver).toFixed(3));
    };

    // Calculate current point table
    const pointsTable = users.map(user => {
      const userFixtures = allFixtures.filter(f => 
        (f.team1 === user.teamName || f.team2 === user.teamName) && f.winner
      );
      
      const wins = userFixtures.filter(f => f.winner === user.teamName).length;
      const matchesPlayed = userFixtures.length;
      const points = wins * 2;
      const nrr = calculateNRR(allFixtures, user.teamName, user._id);
      const fairness = userFixtures.reduce((sum, f) => {
        const isTeam1 = f.team1 === user.teamName;
        return sum + (isTeam1 ? (f.team1Fairness || 0) : (f.team2Fairness || 0));
      }, 0);

      return {
        _id: user._id,
        teamName: user.abbreviation || user.teamName || 'Unknown',
        originalTeamName: user.teamName || 'Unknown',
        matchesPlayed,
        points,
        wins,
        losses: matchesPlayed - wins,
        fairness,
        nrr,
        teamImage: user.teamImage || ''
      };
    });

    // Sort point table
    const sortedPointsTable = pointsTable.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      const nrrA = a.nrr || 0;
      const nrrB = b.nrr || 0;
      if (nrrB !== nrrA) return nrrB - nrrA;
      if (b.fairness !== a.fairness) return b.fairness - a.fairness;
      return (a.matchesPlayed || 0) - (b.matchesPlayed || 0);
    });

    const rankedPointsTable = sortedPointsTable.map((team, index) => ({
      rank: index + 1,
      ...team,
    }));

    // Find current user
    const currentUser = rankedPointsTable.find(t => t._id.toString() === userId.toString());
    if (!currentUser) {
      return res.status(404).json({ message: 'User not found in point table' });
    }

    // Get remaining fixtures for all teams
    const getRemainingFixtures = (teamName, teamId) => {
      return allFixtures.filter(f => {
        const isInvolved = (f.team1 === teamName || f.team2 === teamName) ||
                          (f.team1UserId && f.team1UserId.toString() === teamId.toString()) ||
                          (f.team2UserId && f.team2UserId.toString() === teamId.toString());
        return isInvolved && !f.winner;
      });
    };

    const userRemainingFixtures = getRemainingFixtures(currentUser.originalTeamName, currentUser._id);
    
    // Get all teams' remaining fixtures
    const allTeamsRemainingFixtures = {};
    rankedPointsTable.forEach(team => {
      allTeamsRemainingFixtures[team._id.toString()] = getRemainingFixtures(team.originalTeamName, team._id);
    });

    // Calculate qualification scenarios
    const qualificationScenarios = [];
    const maxScenarios = 30; // Increased for more comprehensive scenarios

    // Generate key match outcome scenarios
    // Focus on matches involving teams above/below the user
    const teamsAbove = rankedPointsTable.filter(t => t.rank < currentUser.rank);
    const teamsBelow = rankedPointsTable.filter(t => t.rank > currentUser.rank);
    
    // Calculate current NRR totals for user (for accurate projections)
    let currentUserTotalRunsScored = 0;
    let currentUserTotalRunsConceded = 0;
    let currentUserTotalOversFaced = 0;
    let currentUserTotalOversBowled = 0;
    
    allFixtures.forEach((fixture) => {
      if (!fixture.winner) return;
      
      const score1 = fixture.team1Score;
      const score2 = fixture.team2Score;
      const team1Runs = parseRuns(score1);
      const team2Runs = parseRuns(score2);
      
      if (team1Runs === 0 && team2Runs === 0) return;
      
      let team1OversActual = parseOvers(fixture.team1Overs) || 20;
      let team2OversActual = parseOvers(fixture.team2Overs) || 20;
      
      const userIdStr = currentUser._id.toString();
      const team1UserIdStr = fixture.team1UserId ? fixture.team1UserId.toString() : null;
      const team2UserIdStr = fixture.team2UserId ? fixture.team2UserId.toString() : null;
      
      let isTeam1 = false;
      let isTeam2 = false;
      
      if (team1UserIdStr === userIdStr) isTeam1 = true;
      else if (team2UserIdStr === userIdStr) isTeam2 = true;
      
      if (!isTeam1 && !isTeam2) {
        if (fixture.team1 && fixture.team1.trim().toLowerCase() === currentUser.originalTeamName.trim().toLowerCase()) {
          isTeam1 = true;
        } else if (fixture.team2 && fixture.team2.trim().toLowerCase() === currentUser.originalTeamName.trim().toLowerCase()) {
          isTeam2 = true;
        }
      }
      
      if (!isTeam1 && !isTeam2) return;
      
      if (isTeam1) {
        currentUserTotalRunsScored += team1Runs;
        currentUserTotalRunsConceded += team2Runs;
        currentUserTotalOversFaced += team1OversActual;
        currentUserTotalOversBowled += team2OversActual;
      } else {
        currentUserTotalRunsScored += team2Runs;
        currentUserTotalRunsConceded += team1Runs;
        currentUserTotalOversFaced += team2OversActual;
        currentUserTotalOversBowled += team1OversActual;
      }
    });

      // Get all remaining fixtures across all teams (for permutation calculation)
      const allRemainingFixtures = allFixtures.filter(f => !f.winner);
      
      // Create a map of fixtures by teams involved
      const fixturesByTeam = {};
      rankedPointsTable.forEach(team => {
        const teamFixtures = allTeamsRemainingFixtures[team._id.toString()] || [];
        teamFixtures.forEach(fixture => {
          const key = fixture._id.toString();
          if (!fixturesByTeam[key]) {
            fixturesByTeam[key] = {
              fixture,
              teams: []
            };
          }
          fixturesByTeam[key].teams.push({
            teamId: team._id.toString(),
            teamName: team.teamName,
            originalTeamName: team.originalTeamName
          });
        });
      });

    // Scenario generation logic - Comprehensive analysis
    // Generate scenarios: Win All, Win Some, Lose All, and combinations
    const scenarioTypes = [
      { name: 'Win All Matches', wins: userRemainingFixtures.length, losses: 0 },
      { name: 'Win Most Matches', wins: Math.max(1, Math.floor(userRemainingFixtures.length * 0.75)), losses: userRemainingFixtures.length - Math.max(1, Math.floor(userRemainingFixtures.length * 0.75)) },
      { name: 'Win Half Matches', wins: Math.max(1, Math.floor(userRemainingFixtures.length / 2)), losses: Math.max(0, userRemainingFixtures.length - Math.floor(userRemainingFixtures.length / 2)) },
      { name: 'Win Few Matches', wins: Math.max(1, Math.floor(userRemainingFixtures.length * 0.25)), losses: Math.max(0, userRemainingFixtures.length - Math.floor(userRemainingFixtures.length * 0.25)) },
      { name: 'Lose All Matches', wins: 0, losses: userRemainingFixtures.length }
    ];
    
    // Generate multiple scenarios for each type with different NRR outcomes
    for (let scenarioTypeIdx = 0; scenarioTypeIdx < scenarioTypes.length; scenarioTypeIdx++) {
      const scenarioType = scenarioTypes[scenarioTypeIdx];
      if (scenarioType.wins > userRemainingFixtures.length || scenarioType.wins < 0) continue;
      
      // Generate 3-4 variations of each scenario type with different NRR outcomes
      for (let variation = 0; variation < 4 && qualificationScenarios.length < maxScenarios; variation++) {
        const simulatedResults = {};
        let userWins = 0;
        let userTotalRunsScored = currentUserTotalRunsScored;
        let userTotalRunsConceded = currentUserTotalRunsConceded;
        let userTotalOversFaced = currentUserTotalOversFaced;
        let userTotalOversBowled = currentUserTotalOversBowled;

        // Simulate user's matches based on scenario type
        let winsSoFar = 0;
        userRemainingFixtures.forEach((fixture, idx) => {
          const opponent = fixture.team1 === currentUser.originalTeamName ? fixture.team2 : fixture.team1;
          const opponentTeam = rankedPointsTable.find(t => 
            t.originalTeamName === opponent || t.teamName === opponent
          );

          // Determine if this match should be a win based on scenario type
          const shouldWin = winsSoFar < scenarioType.wins;
          
          if (shouldWin) {
            userWins++;
            winsSoFar++;
            // Simulate win scenarios with varying margins for NRR
            // Variation 0: Big win (good NRR), Variation 1: Medium win, Variation 2: Small win, Variation 3: Very big win
            const winMargins = [50, 30, 10, 80]; // Runs margin
            const margin = winMargins[variation % 4];
            const yourScore = 180 + (variation * 10);
            const opponentScore = yourScore - margin;
            
            // Vary overs for NRR calculation (chase quickly = better NRR)
            const yourOvers = variation === 0 ? 16.0 : (variation === 1 ? 18.0 : 20.0); // Quick chase = better NRR
            const opponentOvers = 20.0;
            
            simulatedResults[fixture._id.toString()] = {
              winner: currentUser.originalTeamName,
              yourScore,
              opponentScore,
              yourOvers,
              opponentOvers
            };
            userTotalRunsScored += yourScore;
            userTotalRunsConceded += opponentScore;
            userTotalOversFaced += yourOvers;
            userTotalOversBowled += opponentOvers;
          } else {
            // Loss scenario
            const yourScore = 150 - (variation * 5);
            const opponentScore = yourScore + (10 + variation * 5);
            simulatedResults[fixture._id.toString()] = {
              winner: opponent,
              yourScore,
              opponentScore,
              yourOvers: 20.0,
              opponentOvers: 20.0
            };
            userTotalRunsScored += yourScore;
            userTotalRunsConceded += opponentScore;
            userTotalOversFaced += 20;
            userTotalOversBowled += 20;
          }
        });

        // Simulate other teams' matches - critical for qualification
        // First, handle teams ABOVE user - they need to lose some matches
        teamsAbove.forEach((team, teamIdx) => {
          const teamFixtures = allTeamsRemainingFixtures[team._id.toString()] || [];
          
          // If team has no remaining matches, they've finished - skip simulation
          if (teamFixtures.length === 0) {
            return; // Team finished - their points are final (e.g., MSD Lions at 20 points)
          }
          
          // Calculate how many matches this team should lose to help user
          // More important teams (closer to user) need to lose more
          const matchesToLose = Math.min(
            Math.ceil(teamFixtures.length * (0.3 + (teamIdx * 0.1))), // 30-50% of matches
            teamFixtures.length
          );
          
          let lossesSoFar = 0;
          teamFixtures.forEach((fixture, fixIdx) => {
            if (simulatedResults[fixture._id.toString()]) return; // Already simulated
            
            const opponent = fixture.team1 === team.originalTeamName ? fixture.team2 : fixture.team1;
            const opponentTeam = rankedPointsTable.find(t => 
              t.originalTeamName === opponent || t.teamName === opponent
            );
            
            // Make team lose if we haven't reached the target losses
            const shouldLose = lossesSoFar < matchesToLose && (variation % 2 === 0 || fixIdx % 2 === 0);
            
            if (shouldLose) {
              lossesSoFar++;
              simulatedResults[fixture._id.toString()] = {
                winner: opponent,
                team1Score: fixture.team1 === team.originalTeamName ? 140 : 160,
                team2Score: fixture.team2 === team.originalTeamName ? 140 : 160,
                teamAbove: team.teamName,
                opponent: opponentTeam?.teamName || opponent
              };
            } else {
              // Team wins
              simulatedResults[fixture._id.toString()] = {
                winner: team.originalTeamName,
                team1Score: fixture.team1 === team.originalTeamName ? 180 : 150,
                team2Score: fixture.team2 === team.originalTeamName ? 180 : 150,
                teamAbove: team.teamName,
                opponent: opponentTeam?.teamName || opponent
              };
            }
          });
        });
        
        // Now simulate teams BELOW user - they can win matches which helps if they beat teams above
        // This is important: if BL wins all matches, they might beat teams above RR, helping RR move up
        teamsBelow.forEach((team, teamIdx) => {
          const teamFixtures = allTeamsRemainingFixtures[team._id.toString()] || [];
          
          if (teamFixtures.length === 0) return; // Team finished
          
          // Generate scenarios where teams below win matches
          // Variation 0-1: Teams below win most/all matches (helps if they beat teams above)
          // Variation 2-3: Teams below win some/lose some (more balanced)
          const shouldWinMost = variation < 2;
          
          teamFixtures.forEach((fixture, fixIdx) => {
            if (simulatedResults[fixture._id.toString()]) return; // Already simulated
            
            const opponent = fixture.team1 === team.originalTeamName ? fixture.team2 : fixture.team1;
            const opponentTeam = rankedPointsTable.find(t => 
              t.originalTeamName === opponent || t.teamName === opponent
            );
            
            // If opponent is above user, team below should WIN (helps user by beating teams above)
            // If opponent is also below user, either outcome is okay
            const opponentIsAbove = opponentTeam && opponentTeam.rank < currentUser.rank;
            const shouldWin = shouldWinMost || opponentIsAbove || (fixIdx % 2 === 0);
            
            if (shouldWin) {
              simulatedResults[fixture._id.toString()] = {
                winner: team.originalTeamName,
                team1Score: fixture.team1 === team.originalTeamName ? 180 : 150,
                team2Score: fixture.team2 === team.originalTeamName ? 180 : 150,
                teamBelow: team.teamName,
                opponent: opponentTeam?.teamName || opponent,
                helpsUser: opponentIsAbove
              };
            } else {
              // Team below loses
              simulatedResults[fixture._id.toString()] = {
                winner: opponent,
                team1Score: fixture.team1 === team.originalTeamName ? 140 : 160,
                team2Score: fixture.team2 === team.originalTeamName ? 140 : 160,
                teamBelow: team.teamName,
                opponent: opponentTeam?.teamName || opponent
              };
            }
          });
        });
        
        // Also simulate matches between teams at same level or other combinations
        // This ensures all remaining fixtures are covered
        rankedPointsTable.forEach(team => {
          const teamFixtures = allTeamsRemainingFixtures[team._id.toString()] || [];
          teamFixtures.forEach(fixture => {
            if (simulatedResults[fixture._id.toString()]) return; // Already simulated
            
            // This is a match not involving user, teams above, or teams below
            // Default: random outcome based on variation
            const team1Name = fixture.team1;
            const team2Name = fixture.team2;
            const team1 = rankedPointsTable.find(t => 
              t.originalTeamName === team1Name || t.teamName === team1Name
            );
            const team2 = rankedPointsTable.find(t => 
              t.originalTeamName === team2Name || t.teamName === team2Name
            );
            
            // Default outcome: team1 wins (can be varied)
            const winner = (variation % 2 === 0) ? team1Name : team2Name;
            simulatedResults[fixture._id.toString()] = {
              winner,
              team1Score: 180,
              team2Score: 150,
              team1: team1?.teamName || team1Name,
              team2: team2?.teamName || team2Name
            };
          });
        });

        // Calculate new NRR after simulation
        const newUserNRR = userTotalOversFaced > 0 && userTotalOversBowled > 0
          ? parseFloat(((userTotalRunsScored / userTotalOversFaced) - (userTotalRunsConceded / userTotalOversBowled)).toFixed(3))
          : currentUser.nrr;
        
        // Calculate new points
        const newUserPoints = currentUser.points + (userWins * 2);
        
        // Calculate what rank user would be after this scenario
        // Need to recalculate all teams' final positions including simulated results
        let newRank = currentUser.rank;
        let qualifies = false;
        
        // Build final point table with simulated results
        const finalTeamStats = rankedPointsTable.map(team => {
          if (team._id.toString() === currentUser._id.toString()) {
            return {
              ...team,
              points: newUserPoints,
              nrr: newUserNRR,
              matchesPlayed: currentUser.matchesPlayed + userWins + (userRemainingFixtures.length - userWins)
            };
          }
          
          // Calculate other teams' final stats
          const teamRemaining = allTeamsRemainingFixtures[team._id.toString()] || [];
          let teamWins = 0;
          let teamTotalRunsScored = 0;
          let teamTotalRunsConceded = 0;
          let teamTotalOversFaced = 0;
          let teamTotalOversBowled = 0;
          
          // Get team's current stats from played matches
          allFixtures.forEach(f => {
            if (!f.winner) return;
            const isTeam1 = f.team1 === team.originalTeamName || 
                           (f.team1UserId && f.team1UserId.toString() === team._id.toString());
            const isTeam2 = f.team2 === team.originalTeamName || 
                           (f.team2UserId && f.team2UserId.toString() === team._id.toString());
            
            if (!isTeam1 && !isTeam2) return;
            
            const runs1 = parseRuns(f.team1Score);
            const runs2 = parseRuns(f.team2Score);
            const overs1 = parseOvers(f.team1Overs) || 20;
            const overs2 = parseOvers(f.team2Overs) || 20;
            
            if (isTeam1 && f.winner === team.originalTeamName) {
              teamWins++;
              teamTotalRunsScored += runs1;
              teamTotalRunsConceded += runs2;
              teamTotalOversFaced += overs1;
              teamTotalOversBowled += overs2;
            } else if (isTeam2 && f.winner === team.originalTeamName) {
              teamWins++;
              teamTotalRunsScored += runs2;
              teamTotalRunsConceded += runs1;
              teamTotalOversFaced += overs2;
              teamTotalOversBowled += overs1;
            } else {
              // Loss
              if (isTeam1) {
                teamTotalRunsScored += runs1;
                teamTotalRunsConceded += runs2;
                teamTotalOversFaced += overs1;
                teamTotalOversBowled += overs2;
              } else {
                teamTotalRunsScored += runs2;
                teamTotalRunsConceded += runs1;
                teamTotalOversFaced += overs2;
                teamTotalOversBowled += overs1;
              }
            }
          });
          
          // Add simulated results for remaining matches
          teamRemaining.forEach(fixture => {
            const result = simulatedResults[fixture._id.toString()];
            if (result) {
              const isTeam1 = fixture.team1 === team.originalTeamName || 
                             (fixture.team1UserId && fixture.team1UserId.toString() === team._id.toString());
              const isTeam2 = fixture.team2 === team.originalTeamName || 
                             (fixture.team2UserId && fixture.team2UserId.toString() === team._id.toString());
              
              if (isTeam1 && result.winner === team.originalTeamName) {
                teamWins++;
                teamTotalRunsScored += (result.team1Score || 180);
                teamTotalRunsConceded += (result.team2Score || 150);
                teamTotalOversFaced += 20;
                teamTotalOversBowled += 20;
              } else if (isTeam2 && result.winner === team.originalTeamName) {
                teamWins++;
                teamTotalRunsScored += (result.team2Score || 180);
                teamTotalRunsConceded += (result.team1Score || 150);
                teamTotalOversFaced += 20;
                teamTotalOversBowled += 20;
              } else {
                // Loss
                if (isTeam1) {
                  teamTotalRunsScored += (result.team1Score || 150);
                  teamTotalRunsConceded += (result.team2Score || 180);
                } else {
                  teamTotalRunsScored += (result.team2Score || 150);
                  teamTotalRunsConceded += (result.team1Score || 180);
                }
                teamTotalOversFaced += 20;
                teamTotalOversBowled += 20;
              }
            }
          });
          
          const finalPoints = teamWins * 2;
          const finalNRR = teamTotalOversFaced > 0 && teamTotalOversBowled > 0
            ? parseFloat(((teamTotalRunsScored / teamTotalOversFaced) - (teamTotalRunsConceded / teamTotalOversBowled)).toFixed(3))
            : team.nrr;
          
          return {
            ...team,
            points: finalPoints,
            nrr: finalNRR,
            matchesPlayed: team.matchesPlayed + teamRemaining.length
          };
        });
        
        // Sort final teams by points, NRR, fairness
        const sortedFinalTeams = finalTeamStats.sort((a, b) => {
          if (b.points !== a.points) return b.points - a.points;
          if (b.nrr !== a.nrr) return b.nrr - a.nrr;
          return b.fairness - a.fairness;
        });
        
        // Find user's new rank
        const userFinalRank = sortedFinalTeams.findIndex(t => t._id.toString() === currentUser._id.toString()) + 1;
        newRank = userFinalRank;
        
        // Check if qualifies for target position
        if (qualifyFor === 'top1') {
          qualifies = userFinalRank === 1;
        } else if (qualifyFor === 'top2') {
          qualifies = userFinalRank <= 2;
        } else if (qualifyFor === 'top3') {
          qualifies = userFinalRank <= 3;
        } else {
          const targetRank = parseInt(qualifyFor) || targetPos;
          if (targetRank <= 6) {
            qualifies = userFinalRank <= targetRank;
          }
        }

        // Build detailed match scenarios showing who needs to lose to whom
        const matchScenarios = [];
        const criticalMatches = []; // Matches to watch
        
        // User's matches
        userRemainingFixtures.forEach((fixture, idx) => {
          const opponent = fixture.team1 === currentUser.originalTeamName ? fixture.team2 : fixture.team1;
          const opponentTeam = rankedPointsTable.find(t => 
            t.originalTeamName === opponent || t.teamName === opponent
          );
          const result = simulatedResults[fixture._id.toString()];
          
          if (result) {
            matchScenarios.push({
              matchType: 'your_match',
              fixtureId: fixture._id.toString(),
              yourTeam: currentUser.teamName,
              opponent: opponentTeam?.teamName || opponent,
              outcome: result.winner === currentUser.originalTeamName ? 'win' : 'loss',
              yourScore: result.yourScore,
              opponentScore: result.opponentScore,
              yourOvers: result.yourOvers,
              opponentOvers: result.opponentOvers,
              description: result.winner === currentUser.originalTeamName
                ? `You WIN vs ${opponentTeam?.teamName || opponent}: Score ${result.yourScore} runs, restrict them to ${result.opponentScore} runs`
                : `You LOSE vs ${opponentTeam?.teamName || opponent}: You score ${result.yourScore}, they score ${result.opponentScore}`,
              battingFirst: result.yourScore > result.opponentScore ? 'yes' : 'no'
            });
          }
        });

        // Identify ALL remaining matches across ALL teams and determine required outcomes
        // This is critical for showing what needs to happen in each match
        
        // Get all unique remaining fixtures (not just teams above)
        const allRemainingFixturesMap = new Map();
        rankedPointsTable.forEach(team => {
          const teamFixtures = allTeamsRemainingFixtures[team._id.toString()] || [];
          teamFixtures.forEach(fixture => {
            const fixtureKey = fixture._id.toString();
            if (!allRemainingFixturesMap.has(fixtureKey)) {
              allRemainingFixturesMap.set(fixtureKey, fixture);
            }
          });
        });
        
        // Analyze each remaining match to determine required outcome
        allRemainingFixturesMap.forEach((fixture, fixtureKey) => {
          const result = simulatedResults[fixtureKey];
          if (!result) return; // Skip if not simulated
          
          const team1Name = fixture.team1;
          const team2Name = fixture.team2;
          const team1 = rankedPointsTable.find(t => 
            t.originalTeamName === team1Name || t.teamName === team1Name
          );
          const team2 = rankedPointsTable.find(t => 
            t.originalTeamName === team2Name || t.teamName === team2Name
          );
          
          // Skip user's own matches (already handled)
          if (team1?._id.toString() === currentUser._id.toString() || 
              team2?._id.toString() === currentUser._id.toString()) {
            return;
          }
          
          const winner = result.winner;
          const isTeam1Win = winner === team1Name || winner === team1?.originalTeamName;
          const isTeam2Win = winner === team2Name || winner === team2?.originalTeamName;
          
          // Determine if this match is critical for qualification
          let isCritical = false;
          let requiredOutcome = '';
          let reason = '';
          let importance = 'medium';
          
          // Check if team1 is above user and needs to lose
          if (team1 && team1.rank < currentUser.rank) {
            if (!isTeam1Win) {
              isCritical = true;
              requiredOutcome = `${team1.teamName} must LOSE to ${team2?.teamName || team2Name}`;
              reason = `${team1.teamName} is above you (Rank ${team1.rank}). If they lose, it helps you move up.`;
              importance = 'critical';
            }
          }
          
          // Check if team2 is above user and needs to lose
          if (team2 && team2.rank < currentUser.rank) {
            if (!isTeam2Win) {
              isCritical = true;
              requiredOutcome = `${team2.teamName} must LOSE to ${team1?.teamName || team1Name}`;
              reason = `${team2.teamName} is above you (Rank ${team2.rank}). If they lose, it helps you move up.`;
              importance = 'critical';
            }
          }
          
          // Check if teams below user need to win (to prevent them from catching up)
          if (team1 && team1.rank > currentUser.rank) {
            if (isTeam1Win) {
              // Team below wins - this is good, prevents them from catching up
              if (!isCritical) {
                requiredOutcome = `${team1.teamName} should WIN (they're below you)`;
                reason = `${team1.teamName} is below you (Rank ${team1.rank}). If they win, they might catch up, but in this scenario they lose.`;
                importance = 'low';
              }
            }
          }
          
          if (team2 && team2.rank > currentUser.rank) {
            if (isTeam2Win) {
              if (!isCritical) {
                requiredOutcome = `${team2.teamName} should WIN (they're below you)`;
                reason = `${team2.teamName} is below you (Rank ${team2.rank}). If they win, they might catch up, but in this scenario they lose.`;
                importance = 'low';
              }
            }
          }
          
          // Always add ALL remaining matches (not just critical ones)
          // This ensures user sees what needs to happen in every match
          const teamAbove = team1 && team1.rank < currentUser.rank ? team1 : 
                           (team2 && team2.rank < currentUser.rank ? team2 : null);
          const opponent = teamAbove === team1 ? team2 : team1;
          
          // Set default required outcome if not set
          if (!requiredOutcome) {
            if (team1 && team1.rank < currentUser.rank) {
              requiredOutcome = `${team1.teamName} must LOSE to ${team2?.teamName || team2Name}`;
              reason = `${team1.teamName} is above you (Rank ${team1.rank}). They need to lose for you to move up.`;
              importance = 'critical';
              isCritical = true;
            } else if (team2 && team2.rank < currentUser.rank) {
              requiredOutcome = `${team2.teamName} must LOSE to ${team1?.teamName || team1Name}`;
              reason = `${team2.teamName} is above you (Rank ${team2.rank}). They need to lose for you to move up.`;
              importance = 'critical';
              isCritical = true;
            } else {
              // Both teams are below or equal - show the match anyway
              requiredOutcome = `${team1Name} vs ${team2Name}`;
              reason = `Both teams are at or below your rank. This match has less impact on your qualification.`;
              importance = 'low';
            }
          }
          
          criticalMatches.push({
            matchType: 'critical_watch',
            fixtureId: fixtureKey,
            team1: team1?.teamName || team1Name,
            team2: team2?.teamName || team2Name,
            team1Rank: team1?.rank || 0,
            team2Rank: team2?.rank || 0,
            team1Points: team1?.points || 0,
            team2Points: team2?.points || 0,
            team1NRR: team1?.nrr || 0,
            team2NRR: team2?.nrr || 0,
            teamAbove: teamAbove?.teamName || null,
            opponent: opponent?.teamName || (teamAbove === team1 ? team2Name : team1Name),
            teamAbovePoints: teamAbove?.points || 0,
            teamAboveNRR: teamAbove?.nrr || 0,
            opponentPoints: opponent?.points || 0,
            opponentNRR: opponent?.nrr || 0,
            requiredOutcome: requiredOutcome,
            actualOutcome: isTeam1Win ? `${team1?.teamName || team1Name} WINS` : 
                          (isTeam2Win ? `${team2?.teamName || team2Name} WINS` : 'TBD'),
            importance: importance,
            reason: reason || 'This match affects your qualification chances',
            matchDate: fixture.matchTime || fixture.createdAt,
            helpsYou: isCritical
          });
          
          matchScenarios.push({
            matchType: 'other_team_match',
            fixtureId: fixtureKey,
            team1: team1?.teamName || team1Name,
            team2: team2?.teamName || team2Name,
            teamAbove: teamAbove?.teamName || null,
            opponent: opponent?.teamName || (teamAbove === team1 ? team2Name : team1Name),
            outcome: isTeam1Win ? (teamAbove === team1 ? 'loss' : 'win') : 
                    (isTeam2Win ? (teamAbove === team2 ? 'loss' : 'win') : 'unknown'),
            description: requiredOutcome,
            importance: importance,
            helpsYou: isCritical
          });
        });
        
        // Only add scenario if it's interesting (qualifies, or shows different outcomes)
        if (qualifies || qualificationScenarios.length < 10 || (scenarioTypeIdx < 2 && variation < 2)) {
          qualificationScenarios.push({
            scenarioNumber: qualificationScenarios.length + 1,
            scenarioType: scenarioType.name,
            userWins,
            userLosses: userRemainingFixtures.length - userWins,
            newUserPoints,
            newUserNRR,
            newRank,
            qualifies,
            matchScenarios: matchScenarios,
            criticalMatches: criticalMatches,
            requirements: {
              minWinsNeeded: Math.ceil((targetPos === 1 ? teamsAbove[0]?.points - currentUser.points + 1 : 0) / 2),
              nrrNeeded: teamsAbove[0] ? Math.max(0, teamsAbove[0].nrr - currentUser.nrr + 0.001) : 0
            },
            summary: {
              yourMatches: matchScenarios.filter(m => m.matchType === 'your_match').length,
              criticalMatches: criticalMatches.length,
              teamsThatMustLose: [...new Set(criticalMatches.map(m => m.teamAbove))].filter(Boolean),
              matchesToWatch: criticalMatches.map(m => `${m.teamAbove} vs ${m.opponent}`)
            }
          });
        }
      }
    }

    const response = {
      currentPosition: currentUser.rank,
      targetPosition: targetPos,
      qualifyFor,
      currentStats: {
        points: currentUser.points,
        nrr: currentUser.nrr,
        fairness: currentUser.fairness,
        matchesPlayed: currentUser.matchesPlayed,
        remainingMatches: userRemainingFixtures.length
      },
      remainingFixtures: userRemainingFixtures.map(f => ({
        matchId: f._id,
        opponent: f.team1 === currentUser.originalTeamName ? f.team2 : f.team1,
        date: f.matchTime || f.createdAt,
        venue: f.venue || 'TBD'
      })),
      allTeamsRemainingFixtures: Object.keys(allTeamsRemainingFixtures).reduce((acc, teamId) => {
        const team = rankedPointsTable.find(t => t._id.toString() === teamId);
        if (team) {
          acc[team.teamName] = allTeamsRemainingFixtures[teamId].map(f => ({
            opponent: f.team1 === team.originalTeamName ? f.team2 : f.team1,
            date: f.matchTime || f.createdAt
          }));
        }
        return acc;
      }, {}),
      qualificationScenarios: qualificationScenarios.slice(0, 10),
      teamsAbove: teamsAbove.map(t => ({
        teamName: t.teamName,
        points: t.points,
        nrr: t.nrr,
        remainingMatches: allTeamsRemainingFixtures[t._id.toString()]?.length || 0
      })),
      teamsBelow: teamsBelow.slice(0, 3).map(t => ({
        teamName: t.teamName,
        points: t.points,
        nrr: t.nrr,
        remainingMatches: allTeamsRemainingFixtures[t._id.toString()]?.length || 0
      })),
      // Comprehensive list of ALL remaining matches with required outcomes
      allRemainingMatchesAnalysis: (() => {
        const allMatches = [];
        const processedMatches = new Set();
        
        rankedPointsTable.forEach(team => {
          const teamFixtures = allTeamsRemainingFixtures[team._id.toString()] || [];
          teamFixtures.forEach(fixture => {
            const fixtureKey = fixture._id.toString();
            if (processedMatches.has(fixtureKey)) return;
            processedMatches.add(fixtureKey);
            
            const team1Name = fixture.team1;
            const team2Name = fixture.team2;
            const team1 = rankedPointsTable.find(t => 
              t.originalTeamName === team1Name || t.teamName === team1Name
            );
            const team2 = rankedPointsTable.find(t => 
              t.originalTeamName === team2Name || t.teamName === team2Name
            );
            
            if (!team1 || !team2) return;
            
            // Skip user's own matches
            if (team1._id.toString() === currentUser._id.toString() || 
                team2._id.toString() === currentUser._id.toString()) {
              return;
            }
            
            // Determine what needs to happen
            let requiredOutcome = '';
            let importance = 'medium';
            let reason = '';
            
            if (team1.rank < currentUser.rank) {
              requiredOutcome = `${team1.teamName} must LOSE to ${team2.teamName}`;
              importance = 'critical';
              reason = `${team1.teamName} is at Rank ${team1.rank} (above you). If they lose, it helps you move up.`;
            } else if (team2.rank < currentUser.rank) {
              requiredOutcome = `${team2.teamName} must LOSE to ${team1.teamName}`;
              importance = 'critical';
              reason = `${team2.teamName} is at Rank ${team2.rank} (above you). If they lose, it helps you move up.`;
            } else if (team1.rank > currentUser.rank && team2.rank > currentUser.rank) {
              requiredOutcome = 'Either outcome is okay (both teams below you)';
              importance = 'low';
              reason = `Both ${team1.teamName} (Rank ${team1.rank}) and ${team2.teamName} (Rank ${team2.rank}) are below you.`;
            } else {
              requiredOutcome = 'Monitor this match';
              importance = 'medium';
              reason = 'This match may affect your position depending on outcomes.';
            }
            
            allMatches.push({
              matchId: fixtureKey,
              team1: team1.teamName,
              team2: team2.teamName,
              team1Rank: team1.rank,
              team2Rank: team2.rank,
              team1Points: team1.points,
              team2Points: team2.points,
              team1NRR: team1.nrr,
              team2NRR: team2.nrr,
              requiredOutcome,
              importance,
              reason,
              matchDate: fixture.matchTime || fixture.createdAt
            });
          });
        });
        
        return allMatches.sort((a, b) => {
          // Sort by importance: critical first, then by rank
          if (a.importance === 'critical' && b.importance !== 'critical') return -1;
          if (b.importance === 'critical' && a.importance !== 'critical') return 1;
          return Math.min(a.team1Rank, a.team2Rank) - Math.min(b.team1Rank, b.team2Rank);
        });
      })()
    };
    
    res.json(response);
  } catch (error) {
    console.error('Error in advanced position calculator:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// NRR Calculator Endpoint
router.get('/nrr-calculator', async (req, res) => {
  try {
    const { yourTeamId, opponentTeamId, targetTeamId } = req.query;

    if (!yourTeamId || !opponentTeamId || !targetTeamId) {
      return res.status(400).json({ 
        message: 'Missing required parameters: yourTeamId, opponentTeamId, targetTeamId' 
      });
    }

    // Fetch all teams
    const allTeams = await User.find({ 
      teamName: { $exists: true, $ne: null, $ne: "NA" }, 
      isActive: true 
    })
    .select('_id teamName abbreviation')
    .lean();

    // Find the three teams
    const yourTeam = allTeams.find(t => 
      t._id.toString() === yourTeamId || t.teamName === yourTeamId
    );
    const opponentTeam = allTeams.find(t => 
      t._id.toString() === opponentTeamId || t.teamName === opponentTeamId
    );
    const targetTeam = allTeams.find(t => 
      t._id.toString() === targetTeamId || t.teamName === targetTeamId
    );

    if (!yourTeam || !opponentTeam || !targetTeam) {
      return res.status(404).json({ 
        message: 'One or more teams not found',
        yourTeam: !!yourTeam,
        opponentTeam: !!opponentTeam,
        targetTeam: !!targetTeam
      });
    }

    // Fetch all completed fixtures
    const fixtures = await Fixture.find({
      isActive: true,
      winner: { $ne: null, $exists: true }
    })
    .select('team1 team2 team1UserId team2UserId team1Score team2Score team1Overs team2Overs winner')
    .lean();

    // Calculate current NRR for your team and target team
    const yourTeamNRR = calculateNRR(fixtures, yourTeam.teamName, yourTeam._id);
    const targetTeamNRR = calculateNRR(fixtures, targetTeam.teamName, targetTeam._id);

    // Calculate your team's current stats (for NRR calculation)
    const yourTeamStats = getTeamStats(fixtures, yourTeam.teamName, yourTeam._id);
    const targetTeamStats = getTeamStats(fixtures, targetTeam.teamName, targetTeam._id);

    // Target NRR needed (slightly above target team's NRR)
    const targetNRR = targetTeamNRR + 0.001; // Need to surpass by at least 0.001

    // Calculate required match result scenarios
    const scenarios = calculateNRRScenarios(
      yourTeamStats,
      targetNRR,
      yourTeamNRR
    );

    res.json({
      yourTeam: {
        _id: yourTeam._id,
        teamName: yourTeam.teamName,
        abbreviation: yourTeam.abbreviation,
        currentNRR: yourTeamNRR
      },
      opponentTeam: {
        _id: opponentTeam._id,
        teamName: opponentTeam.teamName,
        abbreviation: opponentTeam.abbreviation
      },
      targetTeam: {
        _id: targetTeam._id,
        teamName: targetTeam.teamName,
        abbreviation: targetTeam.abbreviation,
        currentNRR: targetTeamNRR
      },
      targetNRR: parseFloat(targetNRR.toFixed(3)),
      scenarios
    });
  } catch (error) {
    console.error('Error in NRR calculator:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

// Helper function to get team stats for NRR calculation
function getTeamStats(fixtures, teamName, userId) {
  const DEFAULT_OVERS = 20;
  let totalRunsScored = 0;
  let totalRunsConceded = 0;
  let totalOversFaced = 0;
  let totalOversBowled = 0;
  let matchesCount = 0;

  const userIdStr = userId ? userId.toString() : null;

  fixtures.forEach((fixture) => {
    if (!fixture.winner) return;

    const score1 = fixture.team1Score;
    const score2 = fixture.team2Score;
    const team1Runs = parseRuns(score1);
    const team2Runs = parseRuns(score2);

    if (team1Runs === 0 && team2Runs === 0) return;

    const team1Wickets = parseWickets(score1);
    const team2Wickets = parseWickets(score2);

    let team1OversActual = parseOvers(fixture.team1Overs);
    let team2OversActual = parseOvers(fixture.team2Overs);
    
    if (team1OversActual === null) team1OversActual = DEFAULT_OVERS;
    if (team2OversActual === null) team2OversActual = DEFAULT_OVERS;

    let team1OversFaced = (team1Wickets === 10) ? DEFAULT_OVERS : team1OversActual;
    let team2OversFaced = (team2Wickets === 10) ? DEFAULT_OVERS : team2OversActual;
    
    let team1OversBowled = (team2Wickets === 10) ? DEFAULT_OVERS : team2OversActual;
    let team2OversBowled = (team1Wickets === 10) ? DEFAULT_OVERS : team1OversActual;

    const team1UserIdStr = fixture.team1UserId ? 
      (fixture.team1UserId.toString ? fixture.team1UserId.toString() : String(fixture.team1UserId)) : null;
    const team2UserIdStr = fixture.team2UserId ? 
      (fixture.team2UserId.toString ? fixture.team2UserId.toString() : String(fixture.team2UserId)) : null;

    let isTeam1 = false;
    let isTeam2 = false;
    
    if (userIdStr) {
      if (team1UserIdStr && team1UserIdStr === userIdStr) {
        isTeam1 = true;
      } else if (team2UserIdStr && team2UserIdStr === userIdStr) {
        isTeam2 = true;
      }
    }
    
    if (!isTeam1 && !isTeam2) {
      if (fixture.team1 && fixture.team1.trim().toLowerCase() === teamName.trim().toLowerCase()) {
        isTeam1 = true;
      } else if (fixture.team2 && fixture.team2.trim().toLowerCase() === teamName.trim().toLowerCase()) {
        isTeam2 = true;
      }
    }

    if (!isTeam1 && !isTeam2) return;

    if (isTeam1) {
      totalRunsScored += team1Runs;
      totalRunsConceded += team2Runs;
      totalOversFaced += team1OversFaced;
      totalOversBowled += team1OversBowled;
    } else {
      totalRunsScored += team2Runs;
      totalRunsConceded += team1Runs;
      totalOversFaced += team2OversFaced;
      totalOversBowled += team2OversBowled;
    }
    matchesCount++;
  });

  return {
    totalRunsScored,
    totalRunsConceded,
    totalOversFaced,
    totalOversBowled,
    matchesCount
  };
}

// Calculate NRR scenarios for batting first and second
function calculateNRRScenarios(currentStats, targetNRR, currentNRR) {
  const DEFAULT_OVERS = 20;
  const scenarios = {
    battingFirst: [],
    battingSecond: []
  };

  // Current totals
  const currentRunsScored = currentStats.totalRunsScored;
  const currentRunsConceded = currentStats.totalRunsConceded;
  const currentOversFaced = currentStats.totalOversFaced;
  const currentOversBowled = currentStats.totalOversBowled;

  // For batting first: We set a score, opponent chases
  // We need: (currentRunsScored + yourScore) / (currentOversFaced + yourOversFaced) - 
  //          (currentRunsConceded + opponentScore) / (currentOversBowled + opponentOversBowled) >= targetNRR
  
  // Try different realistic scores and overs
  const scoreRanges = [
    { min: 120, max: 200, step: 5 },
    { min: 200, max: 250, step: 10 }
  ];

  for (const range of scoreRanges) {
    for (let yourScore = range.min; yourScore <= range.max; yourScore += range.step) {
      // Try different overs (15.0 to 20.0, not all out)
      for (let yourOvers = 15.0; yourOvers <= 20.0; yourOvers += 0.5) {
        // Realistic wickets: more overs = fewer wickets lost
        const yourWickets = yourOvers >= 19.5 ? 9 : Math.max(0, Math.floor((20.0 - yourOvers) * 1.2));
        const yourOversFaced = (yourWickets === 10) ? DEFAULT_OVERS : yourOvers;

        // Calculate what opponent score/overs would give us target NRR
        // targetNRR = (newRunsScored / newOversFaced) - (newRunsConceded / newOversBowled)
        // Rearranging: newRunsConceded / newOversBowled = (newRunsScored / newOversFaced) - targetNRR
        
        const newRunsScored = currentRunsScored + yourScore;
        const newOversFaced = currentOversFaced + yourOversFaced;
        const runsScoredPerOver = newRunsScored / newOversFaced;
        const targetRunsConcededPerOver = runsScoredPerOver - targetNRR;

        if (targetRunsConcededPerOver <= 0) continue; // Invalid scenario

        // Try different opponent overs (they chase, so >= your overs)
        for (let opponentOvers = yourOvers; opponentOvers <= 20.0; opponentOvers += 0.5) {
          // Opponent loses all wickets if they're all out (for win scenario)
          const opponentWickets = 10; // Assume all out when losing
          const opponentOversBowled = DEFAULT_OVERS; // All out = 20.0 overs
          
          const newOversBowled = currentOversBowled + opponentOversBowled;
          const requiredOpponentScore = Math.floor(targetRunsConcededPerOver * newOversBowled - currentRunsConceded);
          
          if (requiredOpponentScore < 0 || requiredOpponentScore >= yourScore) continue; // Must win

          // Verify the NRR
          const newRunsConceded = currentRunsConceded + requiredOpponentScore;
          const newNRR = (newRunsScored / newOversFaced) - (newRunsConceded / newOversBowled);

          if (newNRR >= targetNRR && newNRR <= targetNRR + 0.3) {
            scenarios.battingFirst.push({
              yourScore,
              yourOvers: parseFloat(yourOvers.toFixed(1)),
              yourWickets,
              opponentScore: requiredOpponentScore,
              opponentOvers: parseFloat(opponentOvers.toFixed(1)),
              opponentWickets,
              newNRR: parseFloat(newNRR.toFixed(3)),
              winMargin: `${yourScore - requiredOpponentScore} runs`,
              requiredRunRate: parseFloat((requiredOpponentScore / opponentOvers).toFixed(2))
            });

            if (scenarios.battingFirst.length >= 5) break;
          }
        }
        if (scenarios.battingFirst.length >= 5) break;
      }
      if (scenarios.battingFirst.length >= 5) break;
    }
    if (scenarios.battingFirst.length >= 5) break;
  }

  // For batting second: Opponent sets score, we chase
  // We need to chase in fewer overs for better NRR
  for (let opponentScore = 100; opponentScore <= 250; opponentScore += 10) {
    for (let opponentOvers = 15.0; opponentOvers <= 20.0; opponentOvers += 0.5) {
      const opponentWickets = 0; // Opponent batting first, assume not all out
      const opponentOversBowled = opponentOvers; // Not all out

      // Calculate what we need to score and in how many overs
      const newRunsConceded = currentRunsConceded + opponentScore;
      const newOversBowled = currentOversBowled + opponentOversBowled;
      
      // targetNRR = (newRunsScored / newOversFaced) - (newRunsConceded / newOversBowled)
      // Rearranging: newRunsScored / newOversFaced = targetNRR + (newRunsConceded / newOversBowled)
      
      const runsConcededPerOver = newRunsConceded / newOversBowled;
      const targetRunsScoredPerOver = targetNRR + runsConcededPerOver;

      if (targetRunsScoredPerOver <= 0) continue;

      // Try different overs to chase (less than opponent overs for better NRR)
      for (let yourOvers = 10.0; yourOvers < opponentOvers; yourOvers += 0.5) {
        // Realistic wickets: more overs = fewer wickets lost
        const yourWickets = yourOvers >= 19.5 ? 9 : Math.max(0, Math.floor((20.0 - yourOvers) * 1.2));
        const yourOversFaced = (yourWickets === 10) ? DEFAULT_OVERS : yourOvers;
        
        const newOversFaced = currentOversFaced + yourOversFaced;
        const requiredYourScore = Math.ceil(targetRunsScoredPerOver * newOversFaced - currentRunsScored);
        
        if (requiredYourScore <= opponentScore) continue; // Must win

        // Verify the NRR
        const newRunsScored = currentRunsScored + requiredYourScore;
        const newNRR = (newRunsScored / newOversFaced) - (newRunsConceded / newOversBowled);

        if (newNRR >= targetNRR && newNRR <= targetNRR + 0.3) {
          const ballsRemaining = Math.floor((opponentOvers - yourOvers) * 6);
          const requiredRunRate = parseFloat((requiredYourScore / yourOvers).toFixed(2));
          const wicketsRemaining = 10 - yourWickets;

          scenarios.battingSecond.push({
            opponentScore,
            opponentOvers: parseFloat(opponentOvers.toFixed(1)),
            opponentWickets,
            yourScore: requiredYourScore,
            yourOvers: parseFloat(yourOvers.toFixed(1)),
            yourWickets,
            newNRR: parseFloat(newNRR.toFixed(3)),
            winMargin: `${wicketsRemaining} wicket${wicketsRemaining !== 1 ? 's' : ''}`,
            ballsRemaining,
            wicketsRemaining,
            requiredRunRate
          });

          if (scenarios.battingSecond.length >= 5) break;
        }
      }
      if (scenarios.battingSecond.length >= 5) break;
    }
    if (scenarios.battingSecond.length >= 5) break;
  }

  // Sort scenarios by newNRR (closest to target first)
  scenarios.battingFirst.sort((a, b) => Math.abs(a.newNRR - targetNRR) - Math.abs(b.newNRR - targetNRR));
  scenarios.battingSecond.sort((a, b) => Math.abs(a.newNRR - targetNRR) - Math.abs(b.newNRR - targetNRR));

  // Limit to top 5 scenarios each
  scenarios.battingFirst = scenarios.battingFirst.slice(0, 5);
  scenarios.battingSecond = scenarios.battingSecond.slice(0, 5);

  return scenarios;
}

// NRR Impact Calculator - Calculate how a match affects your NRR
router.post('/nrr-impact', async (req, res) => {
  try {
    const { teamId, runsScored, oversFaced, runsConceded, oversBowled, wicketsLost, opponentWickets } = req.body;

    if (!teamId || runsScored === undefined || oversFaced === undefined || 
        runsConceded === undefined || oversBowled === undefined) {
      return res.status(400).json({ 
        message: 'Missing required parameters: teamId, runsScored, oversFaced, runsConceded, oversBowled' 
      });
    }

    // Find the team
    const team = await User.findOne({ 
      _id: teamId,
      teamName: { $exists: true, $ne: null, $ne: "NA" }, 
      isActive: true 
    })
    .select('_id teamName abbreviation')
    .lean();

    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }

    // Fetch all completed fixtures
    const fixtures = await Fixture.find({
      isActive: true,
      winner: { $ne: null, $exists: true }
    })
    .select('team1 team2 team1UserId team2UserId team1Score team2Score team1Overs team2Overs winner')
    .lean();

    // Calculate current NRR
    const currentNRR = calculateNRR(fixtures, team.teamName, team._id);
    const currentStats = getTeamStats(fixtures, team.teamName, team._id);

    // Parse inputs
    const DEFAULT_OVERS = 20;
    const runsScoredNum = parseFloat(runsScored) || 0;
    const runsConcededNum = parseFloat(runsConceded) || 0;
    const wicketsLostNum = parseInt(wicketsLost) || 0;
    const opponentWicketsNum = parseInt(opponentWickets) || 0;

    // Parse overs (handle format like 7.3 = 7 overs 3 balls = 7.5 overs)
    const parseOversInput = (oversInput) => {
      if (typeof oversInput === 'number') return oversInput;
      const str = String(oversInput);
      const parts = str.split('.');
      if (parts.length === 2) {
        const overs = parseInt(parts[0]) || 0;
        const balls = parseInt(parts[1]) || 0;
        return overs + (balls / 6);
      }
      return parseFloat(oversInput) || 0;
    };

    const oversFacedNum = parseOversInput(oversFaced);
    const oversBowledNum = parseOversInput(oversBowled);

    // Apply ICC rules for overs
    const oversFacedFinal = (wicketsLostNum === 10) ? DEFAULT_OVERS : oversFacedNum;
    const oversBowledFinal = (opponentWicketsNum === 10) ? DEFAULT_OVERS : oversBowledNum;

    // Calculate new totals
    const newRunsScored = currentStats.totalRunsScored + runsScoredNum;
    const newRunsConceded = currentStats.totalRunsConceded + runsConcededNum;
    const newOversFaced = currentStats.totalOversFaced + oversFacedFinal;
    const newOversBowled = currentStats.totalOversBowled + oversBowledFinal;

    // Calculate new NRR
    const runsScoredPerOver = newOversFaced > 0 ? newRunsScored / newOversFaced : 0;
    const runsConcededPerOver = newOversBowled > 0 ? newRunsConceded / newOversBowled : 0;
    const newNRR = runsScoredPerOver - runsConcededPerOver;

    const nrrChange = newNRR - currentNRR;
    const nrrChangePercent = currentNRR !== 0 ? ((nrrChange / Math.abs(currentNRR)) * 100) : 0;

    // Get current point table to calculate new position
    const allUsers = await User.find({ 
      teamName: { $exists: true, $ne: null, $ne: "NA" }, 
      isActive: true,
      isAdmin: false
    })
    .select('_id teamName abbreviation points matchesPlayed fairnessPoint teamImage')
    .lean();

    // Calculate current point table with NRR
    const currentPointTable = allUsers.map((user) => {
      const userNRR = calculateNRR(fixtures, user.teamName, user._id);
      return {
        ...user,
        nrr: userNRR,
        points: user.points || 0,
        matchesPlayed: user.matchesPlayed || 0,
        fairness: user.fairnessPoint || 0
      };
    });

    // Calculate new point table with updated NRR for selected team
    const newPointTable = currentPointTable.map((user) => {
      if (user._id.toString() === team._id.toString()) {
        return {
          ...user,
          nrr: parseFloat(newNRR.toFixed(3))
        };
      }
      return user;
    });

    // Sort both tables
    const sortTable = (table) => {
      return [...table].sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.nrr !== a.nrr) return b.nrr - a.nrr;
        return b.fairness - a.fairness;
      });
    };

    const sortedCurrent = sortTable(currentPointTable);
    const sortedNew = sortTable(newPointTable);

    const currentPosition = sortedCurrent.findIndex(t => t._id.toString() === team._id.toString()) + 1;
    const newPosition = sortedNew.findIndex(t => t._id.toString() === team._id.toString()) + 1;
    const positionChange = currentPosition - newPosition; // Positive = moved up, Negative = moved down

    res.json({
      team: {
        _id: team._id,
        teamName: team.teamName,
        abbreviation: team.abbreviation
      },
      currentNRR: parseFloat(currentNRR.toFixed(3)),
      newNRR: parseFloat(newNRR.toFixed(3)),
      nrrChange: parseFloat(nrrChange.toFixed(3)),
      nrrChangePercent: parseFloat(nrrChangePercent.toFixed(2)),
      currentPosition,
      newPosition,
      positionChange,
      matchStats: {
        runsScored: runsScoredNum,
        oversFaced: parseFloat(oversFacedFinal.toFixed(1)),
        wicketsLost: wicketsLostNum,
        runsConceded: runsConcededNum,
        oversBowled: parseFloat(oversBowledFinal.toFixed(1)),
        opponentWickets: opponentWicketsNum
      }
    });
  } catch (error) {
    console.error('Error in NRR impact calculator:', error);
    res.status(500).json({ message: 'Internal server error', error: error.message });
  }
});

module.exports = router;


