/**
 * Database migration routes - copy data between CPL databases with de-duplication.
 */
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const PlayerStats = require('../models/PlayerStats');
const Tournament = require('../models/Tournament');
const { rebuildAllPlayerTotalsFromCurrentStats } = require('../utils/runCareerHistorySeed');

/**
 * List all available CPL databases on the cluster.
 */
router.get('/list-databases', async (req, res) => {
  try {
    const adminDb = mongoose.connection.db.admin();
    const { databases } = await adminDb.listDatabases();
    
    // Filter for CPL databases only
    const cplDbs = databases
      .filter(db => db.name.startsWith('cpl_'))
      .map(db => ({
        name: db.name,
        sizeOnDisk: db.sizeOnDisk,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    
    res.json({
      success: true,
      currentDatabase: mongoose.connection.name,
      databases: cplDbs,
    });
  } catch (error) {
    console.error('Error listing databases:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to list databases',
      error: error.message,
    });
  }
});

/**
 * Get tournaments from a specific database.
 */
router.get('/list-tournaments/:dbName', async (req, res) => {
  try {
    const { dbName } = req.params;
    const sourceConn = mongoose.connection.useDb(dbName, { useCache: true });
    
    const tournaments = await sourceConn.db
      .collection('tournaments')
      .find({})
      .project({ _id: 1, name: 1, startDate: 1, endDate: 1, isActive: 1 })
      .toArray();
    
    res.json({
      success: true,
      database: dbName,
      tournaments: tournaments.map(t => ({
        id: t._id.toString(),
        name: t.name,
        startDate: t.startDate,
        endDate: t.endDate,
        isActive: t.isActive,
      })),
    });
  } catch (error) {
    console.error('Error listing tournaments:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to list tournaments',
      error: error.message,
    });
  }
});

/**
 * Preview migration - show what will be migrated.
 */
router.post('/preview', async (req, res) => {
  try {
    const { sourceDb, targetDb, migrationType, tournamentId } = req.body;
    
    if (!sourceDb || !targetDb) {
      return res.status(400).json({
        success: false,
        message: 'Source and target databases are required',
      });
    }
    
    if (sourceDb === targetDb) {
      return res.status(400).json({
        success: false,
        message: 'Source and target databases must be different',
      });
    }
    
    const sourceConn = mongoose.connection.useDb(sourceDb, { useCache: true });
    const targetConn = mongoose.connection.useDb(targetDb, { useCache: true });
    
    const preview = {
      sourceDb,
      targetDb,
      migrationType,
    };
    
    if (migrationType === 'player_stats' || migrationType === 'player_stats_and_tournaments') {
      let query = {};
      if (migrationType === 'player_stats_and_tournaments' && tournamentId) {
        query.tournamentId = new mongoose.Types.ObjectId(tournamentId);
      }
      
      const sourceCount = await sourceConn.db.collection('playerstats').countDocuments(query);
      const targetCount = await targetConn.db.collection('playerstats').countDocuments(query);
      
      preview.playerStats = {
        sourceCount,
        targetCount,
        query: tournamentId ? { tournamentId } : 'all',
      };
    }
    
    if (migrationType === 'tournaments' || migrationType === 'player_stats_and_tournaments') {
      let query = {};
      if (tournamentId) {
        query._id = new mongoose.Types.ObjectId(tournamentId);
      }
      
      const sourceTournaments = await sourceConn.db
        .collection('tournaments')
        .find(query)
        .project({ _id: 1, name: 1 })
        .toArray();
      
      preview.tournaments = {
        count: sourceTournaments.length,
        tournaments: sourceTournaments.map(t => ({
          id: t._id.toString(),
          name: t.name,
        })),
      };
    }
    
    res.json({
      success: true,
      preview,
    });
  } catch (error) {
    console.error('Error previewing migration:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to preview migration',
      error: error.message,
    });
  }
});

/**
 * Execute migration with de-duplication.
 */
router.post('/execute', async (req, res) => {
  try {
    const { sourceDb, targetDb, migrationType, tournamentId, clearTarget, copyPlayerTotals } = req.body;
    
    if (!sourceDb || !targetDb) {
      return res.status(400).json({
        success: false,
        message: 'Source and target databases are required',
      });
    }
    
    if (sourceDb === targetDb) {
      return res.status(400).json({
        success: false,
        message: 'Source and target databases must be different',
      });
    }
    
    const sourceConn = mongoose.connection.useDb(sourceDb, { useCache: true });
    const targetConn = mongoose.connection.useDb(targetDb, { useCache: true });
    
    const result = {
      sourceDb,
      targetDb,
      migrationType,
      operations: [],
    };
    
    // Helper to create dedup key for player stats
    const createDedupKey = (doc) => {
      const playerId = doc?.playerId ? doc.playerId.toString() : '';
      const opponentUserId = doc?.opponentUserId ? doc.opponentUserId.toString() : '';
      const battingRuns = Number(doc?.battingStats?.runs) || 0;
      const battingBalls = Number(doc?.battingStats?.balls) || 0;
      const runsGiven = Number(doc?.bowlingStats?.runsGiven) || 0;
      const ballsBowled = Number(doc?.bowlingStats?.ballsBowled) || 0;
      const wickets = Number(doc?.bowlingStats?.wickets) || 0;
      
      return [
        playerId,
        opponentUserId,
        battingRuns,
        battingBalls,
        runsGiven,
        ballsBowled,
        wickets,
      ].join('|');
    };
    
    // Migrate Player Stats
    if (migrationType === 'player_stats' || migrationType === 'player_stats_and_tournaments') {
      let query = {};
      if (migrationType === 'player_stats_and_tournaments' && tournamentId) {
        query.tournamentId = new mongoose.Types.ObjectId(tournamentId);
      }
      
      const sourceStats = await sourceConn.db.collection('playerstats').find(query).toArray();
      
      // Clear target if requested
      if (clearTarget) {
        const deleteResult = await targetConn.db.collection('playerstats').deleteMany(query);
        result.operations.push({
          type: 'delete',
          collection: 'playerstats',
          count: deleteResult.deletedCount,
        });
      }
      
      // De-duplicate source data
      const dedupMap = new Map();
      let duplicatesSkipped = 0;
      
      for (const doc of sourceStats) {
        const key = createDedupKey(doc);
        if (!dedupMap.has(key)) {
          dedupMap.set(key, doc);
        } else {
          duplicatesSkipped++;
        }
      }
      
      // Insert deduplicated data
      if (dedupMap.size > 0) {
        const docsToInsert = Array.from(dedupMap.values()).map(doc => {
          const { _id, ...rest } = doc;
          return rest;
        });
        
        await targetConn.db.collection('playerstats').insertMany(docsToInsert, { ordered: false });
        
        result.operations.push({
          type: 'insert',
          collection: 'playerstats',
          totalFromSource: sourceStats.length,
          duplicatesSkipped,
          inserted: docsToInsert.length,
        });
      }
    }
    
    // Migrate Tournaments
    if (migrationType === 'tournaments' || migrationType === 'player_stats_and_tournaments') {
      let query = {};
      if (tournamentId) {
        query._id = new mongoose.Types.ObjectId(tournamentId);
      }
      
      const sourceTournaments = await sourceConn.db.collection('tournaments').find(query).toArray();
      
      if (clearTarget) {
        const deleteResult = await targetConn.db.collection('tournaments').deleteMany(query);
        result.operations.push({
          type: 'delete',
          collection: 'tournaments',
          count: deleteResult.deletedCount,
        });
      }
      
      // De-duplicate by tournament name
      const tournamentByName = new Map();
      let duplicateTournamentsSkipped = 0;
      
      for (const doc of sourceTournaments) {
        const name = (doc.name || '').trim().toLowerCase();
        if (name && !tournamentByName.has(name)) {
          tournamentByName.set(name, doc);
        } else {
          duplicateTournamentsSkipped++;
        }
      }
      
      if (tournamentByName.size > 0) {
        const docsToInsert = Array.from(tournamentByName.values()).map(doc => {
          const { _id, ...rest } = doc;
          return rest;
        });
        
        await targetConn.db.collection('tournaments').insertMany(docsToInsert, { ordered: false });
        
        result.operations.push({
          type: 'insert',
          collection: 'tournaments',
          totalFromSource: sourceTournaments.length,
          duplicatesSkipped: duplicateTournamentsSkipped,
          inserted: docsToInsert.length,
        });
      }
    }
    
    // Handle player rankings/totals
    if (migrationType === 'player_stats' || migrationType === 'player_stats_and_tournaments') {
      // Switch back to target DB
      await mongoose.connection.useDb(targetDb);
      
      if (copyPlayerTotals) {
        // Copy Player document totals directly from source to match exactly
        const sourcePlayers = await sourceConn.db
          .collection('players')
          .find({})
          .project({
            _id: 1,
            name: 1,
            totalRuns: 1,
            totalWickets: 1,
            matchesPlayed: 1,
            momCount: 1,
          })
          .toArray();
        
        let playersMatched = 0;
        let playersUpdated = 0;
        
        for (const sourcePlayer of sourcePlayers) {
          // Find matching player in target by name (case-insensitive)
          const targetPlayer = await targetConn.db.collection('players').findOne({
            name: { $regex: `^${sourcePlayer.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
          });
          
          if (targetPlayer) {
            playersMatched++;
            await targetConn.db.collection('players').updateOne(
              { _id: targetPlayer._id },
              {
                $set: {
                  totalRuns: sourcePlayer.totalRuns || 0,
                  totalWickets: sourcePlayer.totalWickets || 0,
                  matchesPlayed: sourcePlayer.matchesPlayed || 0,
                  momCount: sourcePlayer.momCount || 0,
                }
              }
            );
            playersUpdated++;
          }
        }
        
        result.playerTotalsCopied = {
          sourcePlayers: sourcePlayers.length,
          playersMatched,
          playersUpdated,
        };
      } else {
        // Rebuild from current stats
        const rankingsSync = await rebuildAllPlayerTotalsFromCurrentStats();
        result.rankingsSync = rankingsSync;
      }
    }
    
    res.json({
      success: true,
      message: 'Migration completed successfully',
      result,
    });
  } catch (error) {
    console.error('Error executing migration:', error);
    res.status(500).json({
      success: false,
      message: 'Migration failed',
      error: error.message,
    });
  }
});

module.exports = router;
