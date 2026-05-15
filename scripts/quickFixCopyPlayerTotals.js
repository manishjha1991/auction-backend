/**
 * Quick fix: Copy Player totals (totalRuns, totalWickets, etc.) from cpl_20 to cpl_21
 * This ensures Top Rankings data matches exactly.
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function copyPlayerTotalsFromCpl20ToCpl21() {
  const targetDb = process.env.MONGO_DB_NAME || 'cpl_21';
  await mongoose.connect(process.env.MONGO_URI, { dbName: targetDb });
  
  console.log('🎯 Quick Fix: Copy Player Totals from cpl_20 to cpl_21');
  console.log('Target DB:', mongoose.connection.name);
  
  // Connect to source (cpl_20)
  const sourceConn = mongoose.connection.useDb('cpl_20', { useCache: true });
  
  // Get all players from cpl_20 with their totals
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
  
  console.log(`Found ${sourcePlayers.length} players in cpl_20`);
  
  const targetConn = mongoose.connection.useDb(targetDb, { useCache: true });
  
  let matched = 0;
  let updated = 0;
  let notFound = [];
  
  for (const sourcePlayer of sourcePlayers) {
    // Find matching player in cpl_21 by name (case-insensitive)
    const escapedName = sourcePlayer.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const targetPlayer = await targetConn.db.collection('players').findOne({
      name: { $regex: `^${escapedName}$`, $options: 'i' }
    });
    
    if (targetPlayer) {
      matched++;
      
      // Update the player totals
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
      
      updated++;
      
      // Show example for Finch
      if (sourcePlayer.name.toLowerCase().includes('finch')) {
        console.log(`\n✅ Finch Example:`);
        console.log(`   Source (cpl_20): ${sourcePlayer.totalRuns} runs, ${sourcePlayer.totalWickets} wickets, ${sourcePlayer.matchesPlayed} matches`);
        console.log(`   Copied to ${targetDb}`);
      }
    } else {
      notFound.push(sourcePlayer.name);
    }
  }
  
  console.log('\n📊 Results:');
  console.log(`   Source players: ${sourcePlayers.length}`);
  console.log(`   Matched in target: ${matched}`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Not found in target: ${notFound.length}`);
  
  if (notFound.length > 0 && notFound.length <= 10) {
    console.log(`\n⚠️  Players not found in ${targetDb}:`);
    notFound.forEach(name => console.log(`   - ${name}`));
  }
  
  await mongoose.disconnect();
  console.log('\n✅ Done! Top Rankings data should now match exactly.');
}

copyPlayerTotalsFromCpl20ToCpl21().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
