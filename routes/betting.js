const express = require('express');
const router = express.Router();
const Bet = require('../models/Bet');
const User = require('../models/User');
const mongoose = require('mongoose');

// Middleware to check if user is authenticated
const isAuthenticated = async (req, res, next) => {
  try {
    const userId = req.headers['user-id'];
    if (!userId || userId === 'undefined' || userId === 'null') {
      return res.status(401).json({ error: 'User ID required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Middleware to check if user is admin
const isAdmin = async (req, res, next) => {
  try {
    const userId = req.headers['user-id'];
    if (!userId || userId === 'undefined' || userId === 'null') {
      return res.status(401).json({ error: 'User ID required' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.isAdmin) {
      return res.status(403).json({ error: 'Only admin can perform this action' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Admin check error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Helper function to calculate odds based on team rankings
const calculateOdds = (team1Rank, team2Rank, selectedTeam) => {
  // Get team rankings from point table (lower rank number = better team)
  // If team1Rank < team2Rank, team1 is better (favorite)
  // If team1Rank > team2Rank, team1 is worse (underdog)
  
  const isTeam1Favorite = team1Rank < team2Rank;
  const isTeam2Favorite = team2Rank < team1Rank;
  
  let isUnderdog = false;
  let winMultiplier = 1.5; // 50% gain (default for favorite)
  let loseMultiplier = 0.6; // 60% loss (default for favorite)
  
  if (selectedTeam === 'team1') {
    if (isTeam1Favorite) {
      // Betting on favorite (team1)
      winMultiplier = 1.5; // 50% gain
      loseMultiplier = 0.6; // 60% loss
      isUnderdog = false;
    } else {
      // Betting on underdog (team1)
      winMultiplier = 1.6; // 60% gain
      loseMultiplier = 0.4; // 40% loss
      isUnderdog = true;
    }
  } else if (selectedTeam === 'team2') {
    if (isTeam2Favorite) {
      // Betting on favorite (team2)
      winMultiplier = 1.5; // 50% gain
      loseMultiplier = 0.6; // 60% loss
      isUnderdog = false;
    } else {
      // Betting on underdog (team2)
      winMultiplier = 1.6; // 60% gain
      loseMultiplier = 0.4; // 40% loss
      isUnderdog = true;
    }
  }
  
  return { isUnderdog, winMultiplier, loseMultiplier };
};

// POST /api/betting/place - Place a bet
router.post('/place', isAuthenticated, async (req, res) => {
  try {
    const { team1, team2, selectedTeam, betAmount, team1UserId, team2UserId, fixtureId } = req.body;
    const userId = req.user._id;

    // Validation
    if (!team1 || !team2 || !selectedTeam || !betAmount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (selectedTeam !== 'team1' && selectedTeam !== 'team2') {
      return res.status(400).json({ error: 'Invalid selectedTeam. Must be team1 or team2' });
    }

    const betAmountNum = Number(betAmount);
    const MIN_BET = 1000000; // 10 Lakh minimum (1,000,000 = 0.10 Cr)
    
    if (isNaN(betAmountNum) || betAmountNum <= 0) {
      return res.status(400).json({ error: 'Invalid bet amount' });
    }

    if (betAmountNum < MIN_BET) {
      return res.status(400).json({ error: `Minimum bet amount is 10 Lakh (${MIN_BET})` });
    }

    // Check if user has enough betWallet (NOT purse - purse is never touched)
    const user = await User.findById(userId);
    // Use betWallet, default to 100 CR if not set
    const currentWallet = parseFloat((user.betWallet || 1000000000).toString());
    
    // Check if total wallet is at least minimum bet (safety check)
    if (currentWallet < MIN_BET) {
      return res.status(400).json({ error: `Insufficient bet wallet balance. You need at least 10 Lakh (1,000,000 = 0.10 Cr) in your bet wallet to place any bet.` });
    }

    // DON'T deduct bet amount from wallet immediately
    // Only reserve it - actual deduction happens when admin settles bets
    // Check if user has enough available balance (including pending bets)
    const pendingBets = await Bet.find({ 
      userId, 
      status: 'pending' 
    }).select('betAmount').lean();
    
    const totalPendingAmount = pendingBets.reduce((sum, bet) => sum + (bet.betAmount || 0), 0);
    const availableBalance = currentWallet - totalPendingAmount;
    
    if (availableBalance < betAmountNum) {
      const availableCr = (availableBalance / 10000000).toFixed(2);
      const reservedCr = (totalPendingAmount / 10000000).toFixed(2);
      return res.status(400).json({ 
        error: `Insufficient available balance. You have ${availableCr} Cr available (${reservedCr} Cr reserved in pending bets). Minimum bet is 10 Lakh (0.10 Cr).` 
      });
    }

    // Get team rankings from point table (same logic as /api/users/points-table)
    const allUsers = await User.find({ 
      teamName: { $exists: true, $ne: null, $ne: 'NA' }, 
      isActive: true,
      isAdmin: false
    })
      .select('teamName points matchesPlayed fairnessPoint')
      .lean();
    
    // Transform and sort exactly like points-table endpoint
    const pointsTable = allUsers.map((user) => {
      const matchesPlayed = user.matchesPlayed || 0;
      const points = user.points || 0;
      const fairness = user.fairnessPoint || 0;
      return {
        teamName: user.teamName,
        points,
        matchesPlayed,
        fairness
      };
    });
    
    // Sort by points (desc), then fairness (desc), then matches played (asc), then alphabetical
    const sortedPointsTable = pointsTable.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.fairness !== a.fairness) return b.fairness - a.fairness;
      if (a.matchesPlayed !== b.matchesPlayed) return a.matchesPlayed - b.matchesPlayed;
      return (a.teamName || '').localeCompare(b.teamName || '');
    });
    
    // Find ranks
    const team1Data = sortedPointsTable.find(t => t.teamName === team1);
    const team2Data = sortedPointsTable.find(t => t.teamName === team2);
    
    const team1Rank = team1Data ? sortedPointsTable.indexOf(team1Data) + 1 : sortedPointsTable.length + 1;
    const team2Rank = team2Data ? sortedPointsTable.indexOf(team2Data) + 1 : sortedPointsTable.length + 1;

    // Calculate odds
    const { isUnderdog, winMultiplier, loseMultiplier } = calculateOdds(team1Rank, team2Rank, selectedTeam);

    // Calculate potential win/loss
    const potentialWin = Math.floor(betAmountNum * winMultiplier);
    const potentialLoss = Math.floor(betAmountNum * loseMultiplier);

    // Create bet
    const bet = new Bet({
      userId,
      team1,
      team2,
      team1UserId: team1UserId || null,
      team2UserId: team2UserId || null,
      selectedTeam,
      betAmount: betAmountNum,
      isUnderdog,
      winMultiplier,
      loseMultiplier,
      potentialWin,
      potentialLoss,
      fixtureId: fixtureId || null,
      status: 'pending'
    });

    await bet.save();

    // Populate user details for response
    await bet.populate('userId', 'name teamName');

    // Calculate new available balance (not actual wallet, but available after this bet)
    const newTotalPending = totalPendingAmount + betAmountNum;
    const newAvailableBalance = currentWallet - newTotalPending;

    res.status(201).json({
      message: 'Bet placed successfully. Amount reserved until settlement.',
      bet: {
        ...bet.toObject(),
        availableBalance: newAvailableBalance,
        totalWallet: currentWallet,
        betWallet: currentWallet, // Also return as betWallet for frontend compatibility
        reservedAmount: newTotalPending
      }
    });
  } catch (error) {
    console.error('Place bet error:', error);
    res.status(500).json({ error: 'Failed to place bet' });
  }
});

// GET /api/betting/live - Get all live (pending) bets
router.get('/live', isAuthenticated, async (req, res) => {
  try {
    const bets = await Bet.find({ status: 'pending' })
      .populate('userId', 'name teamName teamImage')
      .populate('team1UserId', 'name teamName teamImage')
      .populate('team2UserId', 'name teamName teamImage')
      .sort({ createdAt: -1 })
      .lean();

    // Group bets by match (team1 vs team2)
    const betsByMatch = {};
    bets.forEach(bet => {
      const matchKey = `${bet.team1}_vs_${bet.team2}`;
      if (!betsByMatch[matchKey]) {
        betsByMatch[matchKey] = {
          team1: bet.team1,
          team2: bet.team2,
          team1UserId: bet.team1UserId,
          team2UserId: bet.team2UserId,
          bets: []
        };
      }
      betsByMatch[matchKey].bets.push(bet);
    });

    // Calculate totals for each match
    const matches = Object.values(betsByMatch).map(match => {
      const team1Bets = match.bets.filter(b => b.selectedTeam === 'team1');
      const team2Bets = match.bets.filter(b => b.selectedTeam === 'team2');
      
      const team1Total = team1Bets.reduce((sum, b) => sum + b.betAmount, 0);
      const team2Total = team2Bets.reduce((sum, b) => sum + b.betAmount, 0);
      const totalBets = match.bets.length;
      const totalAmount = team1Total + team2Total;

      return {
        ...match,
        team1Total,
        team2Total,
        totalBets,
        totalAmount,
        allBets: match.bets
      };
    });

    res.json({
      matches,
      totalPendingBets: bets.length,
      totalBetAmount: bets.reduce((sum, b) => sum + b.betAmount, 0)
    });
  } catch (error) {
    console.error('Get live bets error:', error);
    res.status(500).json({ error: 'Failed to fetch live bets' });
  }
});

// GET /api/betting/my-bets - Get user's bets
router.get('/my-bets', isAuthenticated, async (req, res) => {
  try {
    const userId = req.user._id;
    const { status } = req.query;

    const query = { userId };
    if (status) {
      query.status = status;
    }

    const bets = await Bet.find(query)
      .populate('team1UserId', 'name teamName teamImage')
      .populate('team2UserId', 'name teamName teamImage')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ bets });
  } catch (error) {
    console.error('Get my bets error:', error);
    res.status(500).json({ error: 'Failed to fetch bets' });
  }
});

// GET /api/betting/settled - Get all settled bets (admin only)
router.get('/settled', isAdmin, async (req, res) => {
  try {
    const bets = await Bet.find({
      status: { $in: ['won', 'lost'] }
    })
      .populate('userId', 'name teamName teamImage')
      .populate('team1UserId', 'name teamName teamImage')
      .populate('team2UserId', 'name teamName teamImage')
      .sort({ settledAt: -1, createdAt: -1 })
      .lean();

    // Group bets by match (team1 vs team2)
    const betsByMatch = {};
    bets.forEach(bet => {
      const matchKey = `${bet.team1}_vs_${bet.team2}`;
      if (!betsByMatch[matchKey]) {
        betsByMatch[matchKey] = {
          team1: bet.team1,
          team2: bet.team2,
          team1UserId: bet.team1UserId,
          team2UserId: bet.team2UserId,
          winner: bet.winner, // All bets in a match have the same winner
          bets: []
        };
      }
      betsByMatch[matchKey].bets.push(bet);
    });

    // Calculate totals for each match
    const matches = Object.values(betsByMatch).map(match => {
      const team1Bets = match.bets.filter(b => b.selectedTeam === 'team1');
      const team2Bets = match.bets.filter(b => b.selectedTeam === 'team2');
      const wonBets = match.bets.filter(b => b.status === 'won');
      const lostBets = match.bets.filter(b => b.status === 'lost');
      
      const team1Total = team1Bets.reduce((sum, b) => sum + b.betAmount, 0);
      const team2Total = team2Bets.reduce((sum, b) => sum + b.betAmount, 0);
      const totalBets = match.bets.length;
      const totalAmount = team1Total + team2Total;
      // Calculate totalWinnings and totalLosses for this match
      const totalWinningsForMatch = wonBets.reduce((sum, b) => sum + (b.actualPayout || 0), 0);
      const totalLossesForMatch = lostBets.reduce((sum, b) => sum + Math.abs(b.actualPayout || 0), 0);
      
      // Get the most recent settlement date
      const settlementDates = match.bets
        .filter(b => b.settledAt)
        .map(b => new Date(b.settledAt))
        .sort((a, b) => b - a);
      const settledAt = settlementDates.length > 0 ? settlementDates[0] : null;

      return {
        ...match,
        team1Total,
        team2Total,
        totalBets,
        totalAmount,
        totalWinnings: totalWinningsForMatch,
        totalLosses: totalLossesForMatch,
        wonBets: wonBets.length,
        lostBets: lostBets.length,
        settledAt,
        allBets: match.bets
      };
    });

    const totalWinningsAll = matches.reduce((sum, m) => sum + m.totalWinnings, 0);
    const totalLossesAll = matches.reduce((sum, m) => sum + m.totalLosses, 0);

    res.json({
      matches,
      totalSettledBets: bets.length,
      totalWinnings: totalWinningsAll,
      totalLosses: totalLossesAll
    });
  } catch (error) {
    console.error('Get settled bets error:', error);
    res.status(500).json({ error: 'Failed to fetch settled bets' });
  }
});

// POST /api/betting/settle/:matchKey - Settle bets for a specific match (admin only)
router.post('/settle/:matchKey', isAdmin, async (req, res) => {
  try {
    const { matchKey } = req.params;
    const { winner } = req.body; // 'team1' or 'team2'

    if (!winner || (winner !== 'team1' && winner !== 'team2')) {
      return res.status(400).json({ error: 'Invalid winner. Must be team1 or team2' });
    }

    // Parse match key (format: "team1_vs_team2")
    const [team1, , team2] = matchKey.split('_vs_');
    if (!team1 || !team2) {
      return res.status(400).json({ error: 'Invalid match key format' });
    }

    // Find all pending bets for this match
    const bets = await Bet.find({
      team1,
      team2,
      status: 'pending'
    }).populate('userId');

    if (bets.length === 0) {
      return res.status(404).json({ error: 'No pending bets found for this match' });
    }

    const settlementResults = [];
    let totalCredited = 0;
    let totalDebited = 0;
    let totalWinners = 0;
    let totalLosers = 0;
    let totalWinnings = 0;
    let totalLosses = 0;

    // Process each bet
    for (const bet of bets) {
      try {
        const user = bet.userId;
        // Use betWallet, NOT purse - purse is never touched
        const currentWallet = parseFloat((user.betWallet || 1000000000).toString());
        let actualPayout = 0;
        let newStatus = 'lost';

        if (bet.selectedTeam === winner) {
          // User won - deduct reserved bet amount and add winnings to betWallet
          actualPayout = bet.potentialWin;
          // Deduct the reserved bet amount and add winnings to betWallet
          const newWallet = currentWallet - bet.betAmount + actualPayout;
          user.betWallet = mongoose.Types.Decimal128.fromString(newWallet.toString());
          newStatus = 'won';
          totalCredited += actualPayout;
          totalWinners++;
          totalWinnings += actualPayout;
        } else {
          // User lost - deduct the reserved bet amount from betWallet
          actualPayout = -bet.betAmount; // Negative for loss
          const newWallet = currentWallet - bet.betAmount;
          user.betWallet = mongoose.Types.Decimal128.fromString(newWallet.toString());
          newStatus = 'lost';
          totalDebited += bet.betAmount;
          totalLosers++;
          totalLosses += bet.betAmount;
        }

        // Update bet
        bet.status = newStatus;
        bet.winner = winner;
        bet.actualPayout = actualPayout;
        bet.settledAt = new Date();
        await bet.save();

        // Update user betWallet (always save since we're deducting the reserved amount)
        // NOTE: purse is NEVER touched
        await user.save();

        settlementResults.push({
          betId: bet._id,
          userId: user._id,
          teamName: user.teamName || user.name,
          selectedTeam: bet.selectedTeam,
          betAmount: bet.betAmount,
          status: newStatus,
          payout: actualPayout,
          newWallet: newStatus === 'won' ? parseFloat((user.betWallet || 1000000000).toString()) : currentWallet
        });
      } catch (betError) {
        console.error(`Error settling bet ${bet._id}:`, betError);
        settlementResults.push({
          betId: bet._id,
          error: betError.message
        });
      }
    }

    res.json({
      message: `Settled ${bets.length} bets for ${team1} vs ${team2}`,
      match: { team1, team2, winner },
      summary: {
        totalBets: bets.length,
        totalWinners,
        totalLosers,
        totalCredited,
        totalDebited,
        totalWinnings,
        totalLosses,
        netAmount: totalCredited - totalDebited
      },
      results: settlementResults
    });
  } catch (error) {
    console.error('Settle bets error:', error);
    res.status(500).json({ error: 'Failed to settle bets' });
  }
});

// POST /api/betting/settle-all - Settle all pending bets (admin only)
router.post('/settle-all', isAdmin, async (req, res) => {
  try {
    const { matchResults } = req.body; // Array of { team1, team2, winner }

    if (!Array.isArray(matchResults) || matchResults.length === 0) {
      return res.status(400).json({ error: 'matchResults array is required' });
    }

    const allResults = [];
    let totalSettled = 0;
    let totalCredited = 0;
    let totalDebited = 0;

    for (const match of matchResults) {
      const { team1, team2, winner } = match;

      if (!team1 || !team2 || !winner) {
        continue;
      }

      // Find all pending bets for this match
      const bets = await Bet.find({
        team1,
        team2,
        status: 'pending'
      }).populate('userId');

      for (const bet of bets) {
        try {
          const user = bet.userId;
          // Use betWallet, NOT purse - purse is never touched
          const currentWallet = parseFloat((user.betWallet || 1000000000).toString());
          let actualPayout = 0;
          let newStatus = 'lost';

          if (bet.selectedTeam === winner) {
            // User won - refund bet amount and add winnings to betWallet
            actualPayout = bet.potentialWin;
            const newWallet = currentWallet - bet.betAmount + actualPayout;
            user.betWallet = mongoose.Types.Decimal128.fromString(newWallet.toString());
            newStatus = 'won';
            totalCredited += actualPayout;
            await user.save();
          } else {
            // User lost - deduct the reserved bet amount from betWallet
            actualPayout = -bet.betAmount;
            const newWallet = currentWallet - bet.betAmount;
            user.betWallet = mongoose.Types.Decimal128.fromString(newWallet.toString());
            newStatus = 'lost';
            totalDebited += bet.betAmount;
            await user.save();
          }

          bet.status = newStatus;
          bet.winner = winner;
          bet.actualPayout = actualPayout;
          bet.settledAt = new Date();
          await bet.save();

          totalSettled++;
        } catch (betError) {
          console.error(`Error settling bet ${bet._id}:`, betError);
        }
      }

      allResults.push({
        match: `${team1} vs ${team2}`,
        winner,
        betsSettled: bets.length
      });
    }

    res.json({
      message: `Settled ${totalSettled} bets across ${matchResults.length} matches`,
      totalSettled,
      totalCredited,
      totalDebited,
      results: allResults
    });
  } catch (error) {
    console.error('Settle all bets error:', error);
    res.status(500).json({ error: 'Failed to settle all bets' });
  }
});

// GET /api/betting/stats - Get betting statistics (admin only)
router.get('/stats', isAdmin, async (req, res) => {
  try {
    const totalBets = await Bet.countDocuments();
    const pendingBets = await Bet.countDocuments({ status: 'pending' });
    const wonBets = await Bet.countDocuments({ status: 'won' });
    const lostBets = await Bet.countDocuments({ status: 'lost' });

    const totalBetAmount = await Bet.aggregate([
      { $group: { _id: null, total: { $sum: '$betAmount' } } }
    ]);

    const totalPayout = await Bet.aggregate([
      { $match: { status: 'won' } },
      { $group: { _id: null, total: { $sum: '$actualPayout' } } }
    ]);

    res.json({
      totalBets,
      pendingBets,
      wonBets,
      lostBets,
      totalBetAmount: totalBetAmount[0]?.total || 0,
      totalPayout: totalPayout[0]?.total || 0
    });
  } catch (error) {
    console.error('Get betting stats error:', error);
    res.status(500).json({ error: 'Failed to fetch betting statistics' });
  }
});

module.exports = router;

