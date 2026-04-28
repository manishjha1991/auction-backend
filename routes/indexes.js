const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

// Import all models
const User = require('../models/User');
const Player = require('../models/Player');
const Bid = require('../models/Bid');
const BidHistory = require('../models/BidHistory');
const Fixture = require('../models/Fixture');
const PlayerStats = require('../models/PlayerStats');
const TradeRequest = require('../models/TradeRequest');
const ReleaseRequest = require('../models/ReleaseRequest');
const PickRequest = require('../models/PickRequest');
const Comment = require('../models/Comment');
const PostLike = require('../models/PostLike');
const Notification = require('../models/Notification');
const BidNotification = require('../models/BidNotification');
const Schedule = require('../models/Schedule');
const UserPlayer = require('../models/UserPlayer');
const PlayoffFixture = require('../models/PlayoffFixture');
const AppSettings = require('../models/AppSettings');
const RetainedPlayer = require('../models/RetainedPlayer');
const MatchResult = require('../models/MatchResult');
const Tournament = require('../models/Tournament');
const PlayerCareerSummary = require('../models/PlayerCareerSummary');
const TeamHeadToHead = require('../models/TeamHeadToHead');
const VenueMatchEntry = require('../models/VenueMatchEntry');

/**
 * Venue ledger index plan — returned in POST /create-all as `venueMatchEntryIndexGuide`
 * so operators see which fields power /venue-aggregate and /venue-explorer.
 */
const VENUE_MATCH_ENTRY_INDEX_GUIDE = {
  collection: 'venuematchentries',
  model: 'VenueMatchEntry',
  description:
    'Persistent venue ledger (survives PlayerStats wipes). Used by venue aggregate, explorer, profile Venues tab.',
  singleFieldIndexes: [
    { fields: { playerId: 1 }, purpose: 'Filter/group ledger rows by player' },
    { fields: { userId: 1 }, purpose: 'Owner-scoped venue stats and team splits' },
    { fields: { opponentUserId: 1 }, purpose: 'Opponent-side lookups when needed' },
    { fields: { venue: 1 }, purpose: 'Primary venue filter and $group by venue name' },
    { fields: { tournamentId: 1 }, purpose: 'Tournament-scoped venue analytics' },
    { fields: { matchId: 1 }, purpose: 'Distinct match counts ($addToSet matchId) per venue' },
    { fields: { sourcePlayerStatsId: 1 }, purpose: 'Upsert key mirroring PlayerStats row' },
  ],
  compoundIndexes: [
    {
      fields: { venue: 1, createdAt: -1 },
      purpose: 'Recent activity per ground; time-ordered venue lists',
    },
    {
      fields: { userId: 1, venue: 1 },
      purpose: 'Profile + explorer team splits: match userId then venue',
    },
    {
      fields: { tournamentId: 1, venue: 1 },
      purpose: 'Tournament venue leaderboards',
    },
    {
      fields: { isWcScore: 1, isPlayoffScore: 1, venue: 1 },
      purpose: 'League-only scope=league (excludes WC/playoff flags) with venue grouping',
    },
    {
      fields: { userId: 1, venue: 1, playerId: 1 },
      purpose: 'Per-user squad breakdown at each venue (profile Venues tab)',
    },
  ],
};

// Create all indexes for maximum performance
router.post('/create-all', async (req, res) => {
  try {
    console.log('🚀 Starting comprehensive index creation...');
    const results = {};

    // 1. USER COLLECTION INDEXES
    console.log('📊 Creating User indexes...');
    results.users = await createUserIndexes();

    // 2. PLAYER COLLECTION INDEXES
    console.log('👥 Creating Player indexes...');
    results.players = await createPlayerIndexes();

    // 2b. PLAYER CAREER SUMMARY (CPL career page + upserts)
    console.log('📊 Creating PlayerCareerSummary indexes...');
    results.playerCareerSummaries = await createPlayerCareerSummaryIndexes();

    // 3. BID COLLECTION INDEXES
    console.log('💰 Creating Bid indexes...');
    results.bids = await createBidIndexes();

    // 4. BID HISTORY COLLECTION INDEXES
    console.log('📈 Creating BidHistory indexes...');
    results.bidHistory = await createBidHistoryIndexes();

    // 5. MATCH RESULT COLLECTION INDEXES
    console.log('🥇 Creating MatchResult indexes...');
    results.matchResults = await createMatchResultIndexes();

    // 7. FIXTURE COLLECTION INDEXES
    console.log('🏆 Creating Fixture indexes...');
    results.fixtures = await createFixtureIndexes();

    // 8. PLAYER STATS COLLECTION INDEXES
    console.log('📊 Creating PlayerStats indexes...');
    results.playerStats = await createPlayerStatsIndexes();

    // 9. TRADE REQUEST COLLECTION INDEXES
    console.log('🔄 Creating TradeRequest indexes...');
    results.tradeRequests = await createTradeRequestIndexes();

    // 10. RELEASE REQUEST COLLECTION INDEXES
    console.log('🔓 Creating ReleaseRequest indexes...');
    results.releaseRequests = await createReleaseRequestIndexes();

    // 11. PICK REQUEST COLLECTION INDEXES
    console.log('✋ Creating PickRequest indexes...');
    results.pickRequests = await createPickRequestIndexes();

    // 12. COMMENT COLLECTION INDEXES
    console.log('💬 Creating Comment indexes...');
    results.comments = await createCommentIndexes();

    // 13. POST LIKE COLLECTION INDEXES
    console.log('👍 Creating PostLike indexes...');
    results.postLikes = await createPostLikeIndexes();

    // 14. NOTIFICATION COLLECTION INDEXES
    console.log('🔔 Creating Notification indexes...');
    results.notifications = await createNotificationIndexes();

    // 15. BID NOTIFICATION COLLECTION INDEXES
    console.log('📢 Creating BidNotification indexes...');
    results.bidNotifications = await createBidNotificationIndexes();

    // 16. SCHEDULE COLLECTION INDEXES
    console.log('📅 Creating Schedule indexes...');
    results.schedules = await createScheduleIndexes();

    // 17. USER PLAYER COLLECTION INDEXES
    console.log('👤 Creating UserPlayer indexes...');
    results.userPlayers = await createUserPlayerIndexes();

    // 18. PLAYOFF FIXTURE COLLECTION INDEXES
    console.log('🏆 Creating PlayoffFixture indexes...');
    results.playoffFixtures = await createPlayoffFixtureIndexes();

    // 19. APP SETTINGS COLLECTION INDEXES
    console.log('⚙️ Creating AppSettings indexes...');
    results.appSettings = await createAppSettingsIndexes();

    // 20. TOURNAMENT COLLECTION INDEXES
    console.log('🏟️ Creating Tournament indexes...');
    results.tournaments = await createTournamentIndexes();

    // 21. RETAINED PLAYER COLLECTION INDEXES
    console.log('🔒 Creating RetainedPlayer indexes...');
    results.retainedPlayers = await createRetainedPlayerIndexes();

    // 22. VENUE MATCH ENTRY (grounds / venue analytics ledger)
    console.log('🏟️ Creating VenueMatchEntry indexes...');
    results.venueMatchEntries = await createVenueMatchEntryIndexes();

    console.log('✅ All indexes created successfully!');
    res.status(200).json({
      success: true,
      message: 'All indexes created successfully!',
      results,
      venueMatchEntryIndexGuide: VENUE_MATCH_ENTRY_INDEX_GUIDE,
    });

  } catch (error) {
    console.error('❌ Error creating indexes:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating indexes',
      error: error.message
    });
  }
});

// USER COLLECTION INDEXES
async function createUserIndexes() {
  const indexes = [
    // Basic indexes (skip email - unique index from schema)
    { teamName: 1 },
    { isActive: 1 },
    { isTournamentReady: 1 },
    { isAdmin: 1 },
    { group: 1 },
    
    // Compound indexes for common queries
    { isActive: 1, isTournamentReady: 1 },
    { isActive: 1, group: 1 },
    { isTournamentReady: 1, group: 1 },
    { isActive: 1, isTournamentReady: 1, group: 1 },
    { isAdmin: 1, isActive: 1, isTournamentReady: 1 },
    { isAdmin: 1, isActive: 1, isTournamentReady: 1, teamName: 1 },
    
    // Points table queries
    { points: -1, fairnessPoint: -1 },
    { points: -1, matchesPlayed: 1 },
    { group: 1, points: -1 },
    { group: 1, points: -1, fairnessPoint: -1 },
    // CPL report / history: active teams with teamName, sort by points (multi-DB point tables)
    { isActive: 1, isAdmin: 1, teamName: 1, points: -1 },
    
    // Search and filtering
    { teamName: 1, isActive: 1 },
    { name: 1, isActive: 1 },
    { streamLink: 1, isActive: 1, isAdmin: 1 },
    
    // Admin queries
    { isAdmin: 1, isActive: 1 },
    { isLocked: 1, isActive: 1 },
    
    // NEW: Retention-related indexes
    { isRetentionLocked: 1 },
    { allPlayersReleased: 1 },
    { isRetentionLocked: 1, isActive: 1 },
    { allPlayersReleased: 1, isActive: 1 },
    { isRetentionLocked: 1, allPlayersReleased: 1 },
    { isActive: 1, isAdmin: 1, allPlayersReleased: 1 },
    
    // NEW: Array membership queries
    { boughtPlayers: 1 },
    { 'currentBids.playerId': 1 },
    
    // NEW: Anti-proxy bidding indexes
    { lastLoginIP: 1 },
    { lastBidIP: 1 },
    { activeSessionId: 1 },
    { suspiciousActivityCount: 1 },
    { lastLoginIP: 1, lastLoginTime: -1 },
    { lastBidIP: 1, lastBidTime: -1 },
    { suspiciousActivityCount: -1, isActive: 1 },
    // Device fingerprint for anti-proxy bidding (bid placement)
    { lastDeviceFingerprint: 1, lastLoginTime: -1 },
    { isAdmin: 1, lastDeviceFingerprint: 1, lastLoginTime: -1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await User.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// PLAYER COLLECTION INDEXES
async function createPlayerIndexes() {
  const indexes = [
    // Basic indexes (skip playerID - unique index from schema)
    { isActive: 1 },
    { isSold: 1 },
    { type: 1 },
    { role: 1 },
    { tradeLocked: 1 },
    
    // Compound indexes for common queries
    { isActive: 1, isSold: 1 },
    { isActive: 1, type: 1 },
    { isSold: 1, type: 1 },
    { type: 1, isSold: 1 }, // Hot path: scheduler/settings Player.updateMany({ type, isSold: false })
    { isActive: 1, isSold: 1, type: 1 },
    
    // Search queries
    { name: 1, isActive: 1 },
    { name: 1, isSold: 1 },
    { isActive: 1, name: 1 },
    
    // Sorting queries
    { basePrice: 1 },
    { overallScore: -1 },
    { totalRuns: -1 },
    { totalWickets: -1 },
    
    // Complex filtering
    { isActive: 1, isSold: 1, type: 1, role: 1 },
    { isActive: 1, tradeLocked: 1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await Player.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// PLAYER CAREER SUMMARY — aligns with models/PlayerCareerSummary.js + career API queries
async function createPlayerCareerSummaryIndexes() {
  const indexes = [
    // playerKey unique index comes from schema; use POST /sync-schema-indexes to align
    { playerId: 1 },
    { playerName: 1 },
    { 'total.totalRuns': -1, 'total.totalWickets': -1, playerName: 1 },
    { updatedAt: -1 },
    { 'total.totalRuns': -1 },
    { 'total.totalWickets': -1 },
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await PlayerCareerSummary.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// BID COLLECTION INDEXES
async function createBidIndexes() {
  const indexes = [
    // Basic indexes (some already exist)
    { playerId: 1 },
    { bidder: 1 },
    { bidAmount: -1 },
    { isActive: 1 },
    { isBidOn: 1 },
    { timestamp: -1 },
    
    // Compound indexes for common queries
    { playerId: 1, isActive: 1 },
    { playerId: 1, isBidOn: 1 },
    { bidder: 1, isActive: 1 },
    { bidder: 1, isBidOn: 1 },
    { playerId: 1, bidAmount: -1 },
    { bidder: 1, timestamp: -1 },
    { playerId: 1, timestamp: -1 },
    
    // Complex queries
    { playerId: 1, isActive: 1, isBidOn: 1 },
    { playerId: 1, isActive: 1, isBidOn: 1, bidAmount: -1 }, // Hot path: sell flow + sort by bidAmount
    { bidder: 1, isActive: 1, isBidOn: 1 },
    { playerId: 1, bidAmount: -1, isActive: 1 },
    { playerId: 1, isActive: 1, timestamp: -1 },
    { isActive: 1, isBidOn: 1, bidAmount: -1 },
    
    // Sorting and filtering
    { timestamp: -1, isActive: 1 },
    { bidAmount: -1, timestamp: -1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await Bid.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// BID HISTORY COLLECTION INDEXES
async function createBidHistoryIndexes() {
  const indexes = [
    { playerId: 1 },
    { bidID: 1 },
    { 'bids.userID': 1 },
    { 'bids.createdAt': -1 },
    { 'bids.status': 1 },
    { playerId: 1, 'bids.createdAt': -1 },
    { playerId: 1, 'bids.userID': 1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await BidHistory.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// MATCH RESULT COLLECTION INDEXES
async function createMatchResultIndexes() {
  const indexes = [
    // Skip matchNumber - unique index from schema
    { matchDate: -1 },
    { matchType: 1 },
    { trophyType: 1 },
    { winner: 1 },
    { team1: 1 },
    { team2: 1 },
    { createdBy: 1 },
    { matchType: 1, matchDate: -1 },
    { trophyType: 1, matchDate: -1 },
    { winner: 1, matchType: 1 },
    { team1: 1, matchDate: -1 },
    { team2: 1, matchDate: -1 },
    { matchStatus: 1, matchDate: -1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await MatchResult.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// FIXTURE COLLECTION INDEXES
async function createFixtureIndexes() {
  const indexes = [
    // Basic indexes
    { isActive: 1 },
    { team1: 1 },
    { team2: 1 },
    { winner: 1 },
    { group: 1 },
    { matchType: 1 },
    { createdAt: -1 },
    
    // Compound indexes for common queries
    { isActive: 1, group: 1 },
    { isActive: 1, matchType: 1 },
    { group: 1, matchType: 1 },
    { isActive: 1, group: 1, matchType: 1 },
    
    // Team-based queries
    { team1: 1, isActive: 1 },
    { team2: 1, isActive: 1 },
    { team1: 1, team2: 1 },
    { team1: 1, team2: 1, isActive: 1 },
    
    // Winner queries
    { winner: 1, isActive: 1 },
    { isActive: 1, winner: 1 },
    { winner: 1, group: 1 },
    
    // Sorting queries
    { createdAt: 1, isActive: 1 },
    { createdAt: -1, isActive: 1 },
    
    // Complex filtering
    { isActive: 1, group: 1, matchType: 1, createdAt: -1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await Fixture.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// PLAYER STATS COLLECTION INDEXES
async function createPlayerStatsIndexes() {
  const indexes = [
    { playerId: 1 },
    { userId: 1 },
    { opponentUserId: 1 },
    { createdAt: -1 },
    { isMom: 1 },
    
    // Compound indexes
    { playerId: 1, userId: 1 },
    { playerId: 1, opponentUserId: 1 },
    { userId: 1, opponentUserId: 1 },
    { playerId: 1, createdAt: -1 },
    { userId: 1, createdAt: -1 },
    { isMom: 1, createdAt: -1 },
    
    // Complex queries
    { playerId: 1, userId: 1, createdAt: -1 },
    { userId: 1, isMom: 1, createdAt: -1 },
    { playerId: 1, isMom: 1, createdAt: -1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await PlayerStats.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// TRADE REQUEST COLLECTION INDEXES
async function createTradeRequestIndexes() {
  const indexes = [
    { fromUser: 1 },
    { toUser: 1 },
    { status: 1 },
    { offeredPlayer: 1 },
    { requestedPlayer: 1 },
    { createdAt: -1 },
    { updatedAt: -1 },
    
    // Compound indexes
    { fromUser: 1, status: 1 },
    { toUser: 1, status: 1 },
    { fromUser: 1, toUser: 1 },
    { status: 1, createdAt: -1 },
    { fromUser: 1, createdAt: -1 },
    { toUser: 1, createdAt: -1 },
    
    // Complex queries
    { fromUser: 1, status: 1, createdAt: -1 },
    { toUser: 1, status: 1, createdAt: -1 },
    { status: 1, updatedAt: -1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await TradeRequest.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// RELEASE REQUEST COLLECTION INDEXES
async function createReleaseRequestIndexes() {
  const indexes = [
    { user: 1 },
    { player: 1 },
    { status: 1 },
    { createdAt: -1 },
    { updatedAt: -1 },
    
    // Compound indexes
    { user: 1, status: 1 },
    { player: 1, status: 1 },
    { user: 1, player: 1 },
    { user: 1, player: 1, status: 1 }, // Hot path: release request check
    { status: 1, createdAt: -1 },
    { user: 1, createdAt: -1 },
    { player: 1, createdAt: -1 },
    { 'adminDecision.status': 1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await ReleaseRequest.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// PICK REQUEST COLLECTION INDEXES
async function createPickRequestIndexes() {
  const indexes = [
    { user: 1 },
    { player: 1 },
    { status: 1 },
    { createdAt: -1 },
    { updatedAt: -1 },
    
    // Compound indexes
    { user: 1, status: 1 },
    { player: 1, status: 1 },
    { user: 1, player: 1 },
    { status: 1, createdAt: -1 },
    { user: 1, createdAt: -1 },
    { player: 1, createdAt: -1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await PickRequest.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// COMMENT COLLECTION INDEXES
async function createCommentIndexes() {
  const indexes = [
    // Basic indexes (some already exist)
    { newsId: 1, createdAt: -1 },
    { userId: 1 },
    
    // Additional indexes
    { newsId: 1 },
    { createdAt: -1 },
    { isEdited: 1 },
    { 'replies.createdAt': -1 },
    { 'replies.userId': 1 },
    
    // Compound indexes
    { newsId: 1, userId: 1 },
    { newsId: 1, isEdited: 1 },
    { userId: 1, createdAt: -1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await Comment.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// POST LIKE COLLECTION INDEXES
async function createPostLikeIndexes() {
  const indexes = [
    // Skip newsId+userId - unique compound index from schema
    
    // Additional indexes
    { newsId: 1 },
    { userId: 1 },
    { likeType: 1 },
    { createdAt: -1 },
    
    // Compound indexes
    { newsId: 1, likeType: 1 },
    { userId: 1, likeType: 1 },
    { newsId: 1, createdAt: -1 },
    { userId: 1, createdAt: -1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await PostLike.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// NOTIFICATION COLLECTION INDEXES
async function createNotificationIndexes() {
  const indexes = [
    { recipient: 1 },
    { sender: 1 },
    { type: 1 },
    { isRead: 1 },
    { isActive: 1 },
    { createdAt: -1 },
    { scheduleId: 1 },
    
    // Compound indexes
    { recipient: 1, isRead: 1 },
    { recipient: 1, isActive: 1 },
    { recipient: 1, type: 1 },
    { recipient: 1, createdAt: -1 },
    { isRead: 1, createdAt: -1 },
    { isActive: 1, createdAt: -1 },
    
    // Complex queries
    { recipient: 1, isRead: 1, createdAt: -1 },
    { recipient: 1, isActive: 1, createdAt: -1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await Notification.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// BID NOTIFICATION COLLECTION INDEXES
async function createBidNotificationIndexes() {
  const indexes = [
    { active: 1 },
    { timestamp: -1 },
    { currentBidder: 1 },
    { secondBidder: 1 },
    { playername: 1 },
    { playerId: 1 },
    { active: 1, timestamp: -1 },
    { currentBidder: 1, active: 1 },
    { playername: 1, active: 1 },
    { playerId: 1, timestamp: -1 },
    { playername: 1, timestamp: -1 },
    { playerId: 1, exitedUser: 1, timestamp: -1 }, // Hot path: dashboard last exit
    { playerId: 1, playername: 1, timestamp: -1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await BidNotification.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// SCHEDULE COLLECTION INDEXES
async function createScheduleIndexes() {
  const indexes = [
    { requester: 1 },
    { opponent: 1 },
    { status: 1 },
    { date: 1 },
    { createdAt: -1 },
    { updatedAt: -1 },
    
    // Compound indexes
    { requester: 1, status: 1 },
    { opponent: 1, status: 1 },
    { requester: 1, opponent: 1 },
    { status: 1, date: 1 },
    { requester: 1, date: 1 },
    { opponent: 1, date: 1 },
    
    // Complex queries
    { requester: 1, status: 1, date: 1 },
    { opponent: 1, status: 1, date: 1 },
    { status: 1, createdAt: -1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await Schedule.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// USER PLAYER COLLECTION INDEXES
async function createUserPlayerIndexes() {
  const indexes = [
    // Basic indexes (some already exist)
    { playerId: 1, isActive: 1 },
    { userId: 1, isActive: 1 },
    { isActive: 1 },
    
    // Additional indexes
    { playerId: 1 },
    { userId: 1 },
    { bidValue: -1 },
    { createdAt: -1 },
    { updatedAt: -1 },
    
    // Compound indexes
    { playerId: 1, userId: 1 },
    { userId: 1, bidValue: -1 },
    { playerId: 1, bidValue: -1 },
    { userId: 1, createdAt: -1 },
    { playerId: 1, createdAt: -1 },
    
    // Complex queries
    { userId: 1, isActive: 1, bidValue: -1 },
    { playerId: 1, isActive: 1, bidValue: -1 },
    { userId: 1, playerId: 1, isActive: 1 } // Hot path: release/trade ownership check
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await UserPlayer.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }

  // Create unique partial index to prevent duplicate active sales
  // This prevents the same player from being sold twice to the same user when isActive is true
  try {
    await UserPlayer.collection.createIndex(
      { playerId: 1, userId: 1 },
      { 
        unique: true, 
        partialFilterExpression: { isActive: true },
        name: 'unique_active_player_user'
      }
    );
    results.push({ 
      index: { playerId: 1, userId: 1, unique: true, partialFilter: { isActive: true } }, 
      status: 'created',
      note: 'Unique partial index to prevent duplicate active sales'
    });
  } catch (error) {
    results.push({ 
      index: { playerId: 1, userId: 1, unique: true }, 
      status: 'error', 
      error: error.message 
    });
  }

  return results;
}

// PLAYOFF FIXTURE COLLECTION INDEXES
async function createPlayoffFixtureIndexes() {
  const indexes = [
    { matchId: 1 },
    { stage: 1 },
    { team1: 1 },
    { team2: 1 },
    { isCompleted: 1 },
    { date: -1 },
    { createdAt: -1 },
    
    // Compound indexes
    { stage: 1, isCompleted: 1 },
    { team1: 1, team2: 1 },
    { isCompleted: 1, date: -1 },
    { stage: 1, date: -1 },
    { matchId: 1, stage: 1 },
    
    // Complex queries
    { stage: 1, isCompleted: 1, date: -1 },
    { team1: 1, isCompleted: 1 },
    { team2: 1, isCompleted: 1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await PlayoffFixture.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// APP SETTINGS COLLECTION INDEXES
async function createAppSettingsIndexes() {
  const indexes = [
    { pointsMode: 1 },
    { enableTradeCenter: 1 },
    { enableUnsoldPlayers: 1 },
    { enablePickButton: 1 },
    { enablePlayerRetention: 1 },
    { requiredGames: 1 },
    { adminReleasedPlayers: 1 },
    { allPlayersReleased: 1 },
    { createdAt: -1 },
    { updatedAt: -1 },
    
    // NEW: Retention-related compound indexes
    { enablePlayerRetention: 1, adminReleasedPlayers: 1 },
    { adminReleasedPlayers: 1, allPlayersReleased: 1 },
    { auctionStartAt: 1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await AppSettings.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// TOURNAMENT COLLECTION INDEXES
async function createTournamentIndexes() {
  const indexes = [
    { status: 1 },
    { isActive: 1 },
    { isLocked: 1 },
    { startDate: 1 },
    { endDate: 1 },
    { createdBy: 1 },
    { name: 1 },
    { status: 1, startDate: 1 },
    { status: 1, isActive: 1 },
    { 'subscribedTeams.userId': 1 },
    { 'tournamentFixtures.team1': 1 },
    { 'tournamentFixtures.team2': 1 },
    { 'tournamentFixtures.winner': 1 },
    { status: 1, endDate: 1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await Tournament.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// RETAINED PLAYER COLLECTION INDEXES
async function createRetainedPlayerIndexes() {
  const indexes = [
    // Basic indexes (some already exist in model)
    { playerId: 1 },
    { userId: 1 },
    { isActive: 1 },
    { status: 1 },
    { playerType: 1 },
    { playerRole: 1 },
    { retainedAt: -1 },
    { withdrawnAt: -1 },
    
    // Compound indexes for common queries
    { userId: 1, isActive: 1 },
    { playerId: 1, isActive: 1 },
    { userId: 1, status: 1 },
    { playerId: 1, status: 1 },
    { userId: 1, playerType: 1 },
    { isActive: 1, status: 1 },
    { userId: 1, playerType: 1, isActive: 1 },
    
    // Complex queries for retention logic
    { userId: 1, isActive: 1, status: 1 },
    { playerId: 1, isActive: 1, status: 1 },
    { userId: 1, withdrawnAt: -1 },
    { status: 1, withdrawnAt: -1 },
    { isActive: 1, withdrawnAt: -1 },
    
    // Sorting and filtering
    { retainedAt: -1, isActive: 1 },
    { userId: 1, retainedAt: -1 },
    { playerType: 1, isActive: 1 },
    { playerRole: 1, isActive: 1 }
  ];

  const results = [];
  for (const index of indexes) {
    try {
      await RetainedPlayer.collection.createIndex(index);
      results.push({ index, status: 'created' });
    } catch (error) {
      results.push({ index, status: 'error', error: error.message });
    }
  }
  return results;
}

// VENUE MATCH ENTRY — ledger for /venue-aggregate, /venue-explorer, profile Venues
async function createVenueMatchEntryIndexes() {
  const specs = [
    ...VENUE_MATCH_ENTRY_INDEX_GUIDE.singleFieldIndexes.map((e) => ({
      index: e.fields,
      purpose: e.purpose,
    })),
    ...VENUE_MATCH_ENTRY_INDEX_GUIDE.compoundIndexes.map((e) => ({
      index: e.fields,
      purpose: e.purpose,
    })),
  ];

  const results = [];
  for (const { index, purpose } of specs) {
    try {
      await VenueMatchEntry.collection.createIndex(index);
      results.push({ index, purpose, status: 'created' });
    } catch (error) {
      results.push({ index, purpose, status: 'error', error: error.message });
    }
  }
  return results;
}

/**
 * Sync indexes declared on Mongoose schemas (PlayerCareerSummary compound indexes, uniques, etc.).
 * Safer than raw createIndex when schema already defines indexes.
 */
router.post('/sync-schema-indexes', async (req, res) => {
  try {
    const models = [
      ['PlayerCareerSummary', PlayerCareerSummary],
      ['Player', Player],
      ['User', User],
      ['PlayerStats', PlayerStats],
      ['Fixture', Fixture],
      ['TeamHeadToHead', TeamHeadToHead],
      ['VenueMatchEntry', VenueMatchEntry],
    ];
    const results = {};
    for (const [name, Model] of models) {
      try {
        const syncResult = await Model.syncIndexes();
        results[name] = { ok: true, syncIndexesResult: syncResult };
      } catch (error) {
        results[name] = { ok: false, error: error.message };
      }
    }
    res.status(200).json({
      success: true,
      message: 'Schema indexes synced (drops extras not in schema)',
      results,
      venueMatchEntryIndexGuide: VENUE_MATCH_ENTRY_INDEX_GUIDE,
    });
  } catch (error) {
    console.error('sync-schema-indexes error', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get index statistics
router.get('/stats', async (req, res) => {
  try {
    const collections = [
      'users', 'players', 'bids', 'bidhistories', 'matchresults', 'fixtures',
      'playerstats', 'playercareersummaries', 'traderequests', 'releaserequests', 'pickrequests',
      'comments', 'postlikes', 'notifications', 'bidnotifications', 'schedules',
      'userplayers', 'playofffixtures', 'appsettings', 'tournaments', 'retainedplayers',
      'venuematchentries',
      'useractivities'
    ];

    const stats = {};
    
    for (const collectionName of collections) {
      try {
        const collection = mongoose.connection.db.collection(collectionName);
        const indexes = await collection.indexes();
        stats[collectionName] = {
          count: indexes.length,
          indexes: indexes.map(idx => ({
            name: idx.name,
            key: idx.key,
            unique: idx.unique || false,
            sparse: idx.sparse || false
          }))
        };
      } catch (error) {
        stats[collectionName] = { error: error.message };
      }
    }

    res.status(200).json({
      success: true,
      stats
    });

  } catch (error) {
    console.error('Error getting index stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting index statistics',
      error: error.message
    });
  }
});

// Drop all indexes (use with caution!)
router.post('/drop-all', async (req, res) => {
  try {
    const collections = [
      'users', 'players', 'bids', 'bidhistories', 'matchresults', 'fixtures',
      'playerstats', 'playercareersummaries', 'traderequests', 'releaserequests', 'pickrequests',
      'comments', 'postlikes', 'notifications', 'bidnotifications', 'schedules',
      'userplayers', 'playofffixtures', 'appsettings', 'tournaments', 'retainedplayers',
      'venuematchentries',
      'useractivities'
    ];

    const results = {};
    
    for (const collectionName of collections) {
      try {
        const collection = mongoose.connection.db.collection(collectionName);
        const result = await collection.dropIndexes();
        results[collectionName] = { status: 'dropped', result };
      } catch (error) {
        results[collectionName] = { status: 'error', error: error.message };
      }
    }

    res.status(200).json({
      success: true,
      message: 'All indexes dropped successfully!',
      results
    });

  } catch (error) {
    console.error('Error dropping indexes:', error);
    res.status(500).json({
      success: false,
      message: 'Error dropping indexes',
      error: error.message
    });
  }
});

module.exports = router;
