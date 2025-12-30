const mongoose = require('mongoose');
const Tournament = require('../models/Tournament');
require('dotenv').config();

// Match data from user
const matchData = `
*MATCH1* 
 MSD vs SXI - *SXI WIN BY 3 Wkts*
MSD - 556
SXI - 540
MSD 160/10 14.3 
SXI 161/7 19
POTM - Zahir khan 3-29

*MATCH 2*
MSD vs BL - *WG WIN BY 7 wkts*
MSD - 381
BL - 418
MSD 91/10 8.4
WG 96/3 6.5
POTM - Josua James 3-16

**MATCH 3 **
SXI vs BL - *BL WIN BY 2 wkts*
SXI - 421
BL - 489
SXI - 111/10 16.5
BL - 116/8 9.5
POTM - Joel paris 5-19

*MATCH 4*
MSD vs SHER - *MSD WIN BY 3 wkts*
MSD - 436
SHER - 338
SHER - 68/10 11.5
MSD 72/7 9 
POTM - Kyle Jamieson 4-19

**MATCH 5*
SXI vs SHER - *SXI WIN BY 115 runs*
SXI - 448
SHER - 490
SXI - 184/8 20 
SHER - 69/10 10.3
POTM - Rashid 31(19) / 3-1 

*MATCH 6*
DC vs BL - *DC win by 16 runs*
DC - 532
BL - 617
DC - 155/10 18.5
BL - 139/10 16.5
POTM - Rostan Chase 66(50) / 2-23

*MATCH 7*
SHER vs PUN - *SHER win by 182 runs*
SHER - 441
PUN - 506
SHER 224/7 20
PUNJ - 42/10 6.5
POTM - Luke wood 7-20

*MATCH 8*
MSD vs DC - *MSD WIN BY 3 wkts*
MSD - 648
DC - 595
DC - 162/7 20
MSD - 168/7 17.5
POTM - Hassaranga 50(21) / 1-22

*MATCH 9*
DC vs SXI - *DC WIN BY 21 runs*
DC- 602
SXI- 621
DC 143/10 19.1
SXI 122/10 17.4
POTM - Finch 40(23) / 1-6

*MATCH 10*
DC vs SHER - *DC win by 2 wkts*
DC - 541
SHER - 494
SHER 118/10 19.2
DC 120/8 17
POTM - Gerath Delany 42(26) / 2- 31

*MATCH 11*
MSD vs STG - ** MSD win by 21 Runs**
MSD - 424
STG - 417
MSD 106/10 - 16.1
STG 85/10 - 12.2
POTM - Neil wagnae 48(36) / 2 - 7

**MATCH 12 **
BL vs SHER - *BL win by 60 Runs*
BL - 597
SHER -  521
BL - 171/10 - 18.1
SHER - 111/10 - 17.1
POTM - Pollard 53(30) / 3-16

**MATCH 13 **
STG vs SXI - *SXI win by 36 Runs*
STG - 627
SXI -  602
SXI - 193/8 - 20
STG - 157/10 - 17.4
POTM - Agar 69(37) 

**MATCH 14 **
STG vs DC - *DC win by 6 wickets*
STG - 410
DC - 490
STG - 87/10 - 12.4
DC - 89/4 - 8.3
POTM - 35(16) / 1-11

**MATCH 15 **
MSD vs RR - **MSD win by 2 wickets **
MSD - 584
RR - 502
RR - 103/10 -18.4
MSD - 104/8 - 10.1 
POTM - wagner 23(11)/4-27

*MATCH 16*
SXI vs ATL - *SXI WIN By 51 Runs*
SXI - 
ATL -
SXI - 176/10 -19.4
ATL - 125/10 - 16.4
POTM - Jack Prestwidge 29(30)/ 6-40

**MATCH 17 **
RR vs SHER - *SHER win by 14 Runs*
RR - 565
SHER - 406
SHER - 189/10 -19.2
RR - 175/10 -19.2
POTM- mcandrew 4-16

*MATCH 18*
MSD vs ATL - *MSD win by 4 wickets*
MSD - 573
ATL - 493
ATL - 192/10-19.1
MSD - 195/6-16.5
POTM - Guptil 82(37)/3-41
`;

// Team name mappings (handle variations)
const teamNameMap = {
  'MSD': 'MSD',
  'SXI': 'SXI',
  'BL': 'BL',
  'WG': 'WG', // Note: Match 2 says BL but winner is WG
  'SHER': 'SHER',
  'DC': 'DC',
  'PUN': 'PUN',
  'PUNJ': 'PUN',
  'STG': 'STG',
  'RR': 'RR',
  'ATL': 'ATL'
};

// Parse match data
function parseMatchData(data) {
  const matches = [];
  const lines = data.split('\n').map(l => l.trim()).filter(l => l);
  
  let currentMatch = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Match header (e.g., "*MATCH1*" or "**MATCH 3 **")
    const matchHeader = line.match(/^\*+\s*MATCH\s*(\d+)\s*\*+/i);
    if (matchHeader) {
      if (currentMatch) {
        matches.push(currentMatch);
      }
      currentMatch = {
        matchNumber: parseInt(matchHeader[1]),
        team1: null,
        team2: null,
        winner: null,
        margin: null,
        team1Score: null,
        team1Overs: null,
        team2Score: null,
        team2Overs: null,
        potm: null
      };
      continue;
    }
    
    if (!currentMatch) continue;
    
    // Match teams and winner (e.g., "MSD vs SXI - *SXI WIN BY 3 Wkts*")
    const vsMatch = line.match(/(\w+)\s+vs\s+(\w+)\s*-\s*\*?(\w+)\s+WIN\s+BY\s+([^*]+)\*?/i);
    if (vsMatch) {
      currentMatch.team1 = teamNameMap[vsMatch[1].toUpperCase()] || vsMatch[1];
      currentMatch.team2 = teamNameMap[vsMatch[2].toUpperCase()] || vsMatch[2];
      currentMatch.winner = teamNameMap[vsMatch[3].toUpperCase()] || vsMatch[3];
      currentMatch.margin = vsMatch[4].trim();
      continue;
    }
    
    // Score lines (e.g., "MSD 160/10 14.3" or "MSD 106/10 - 16.1")
    const scoreMatch = line.match(/^(\w+)\s+(\d+)\/(\d+)\s+[-\s]*(\d+)\.(\d+)$/);
    if (scoreMatch) {
      const team = teamNameMap[scoreMatch[1].toUpperCase()] || scoreMatch[1];
      const runs = scoreMatch[2];
      const wickets = scoreMatch[3];
      const overs = scoreMatch[4];
      const balls = scoreMatch[5];
      const oversStr = `${overs}.${balls}`;
      
      if (team === currentMatch.team1 || team === currentMatch.team2) {
        if (team === currentMatch.team1) {
          currentMatch.team1Score = `${runs}/${wickets}`;
          currentMatch.team1Overs = oversStr;
        } else if (team === currentMatch.team2) {
          currentMatch.team2Score = `${runs}/${wickets}`;
          currentMatch.team2Overs = oversStr;
        }
      }
      continue;
    }
    
    // POTM line
    if (line.match(/POTM\s*-/i)) {
      currentMatch.potm = line.replace(/POTM\s*-/i, '').trim();
    }
  }
  
  if (currentMatch) {
    matches.push(currentMatch);
  }
  
  return matches;
}

// Main function
async function updateTournamentOvers() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/cpl_16';
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Find tournament by name (Super 8)
    const tournament = await Tournament.findOne({ 
      name: { $regex: /super\s*8/i } 
    });
    
    if (!tournament) {
      console.error('❌ Tournament "Super 8" not found');
      console.log('Available tournaments:');
      const allTournaments = await Tournament.find({}).select('name _id').lean();
      allTournaments.forEach(t => console.log(`  - ${t.name} (${t._id})`));
      process.exit(1);
    }

    console.log(`\n📋 Found Tournament: ${tournament.name} (${tournament._id})`);
    console.log(`📊 Total fixtures: ${tournament.tournamentFixtures.length}\n`);

    // Parse match data
    const parsedMatches = parseMatchData(matchData);
    console.log(`📝 Parsed ${parsedMatches.length} matches from data\n`);

    // Create preview of updates
    const updates = [];
    
    for (const match of parsedMatches) {
      // Find matching fixture in tournament
      const fixture = tournament.tournamentFixtures.find(f => {
        const team1Match = (f.team1 && f.team1.trim().toUpperCase() === match.team1.toUpperCase()) ||
                          (f.team1 && f.team1.trim().toUpperCase().includes(match.team1.toUpperCase())) ||
                          (f.team1 && match.team1.toUpperCase().includes(f.team1.trim().toUpperCase()));
        const team2Match = (f.team2 && f.team2.trim().toUpperCase() === match.team2.toUpperCase()) ||
                          (f.team2 && f.team2.trim().toUpperCase().includes(match.team2.toUpperCase())) ||
                          (f.team2 && match.team2.toUpperCase().includes(f.team2.trim().toUpperCase()));
        return team1Match && team2Match;
      });

      if (!fixture) {
        console.log(`⚠️  Match ${match.matchNumber}: ${match.team1} vs ${match.team2} - Fixture not found in tournament`);
        continue;
      }

      const fixtureIndex = tournament.tournamentFixtures.indexOf(fixture);
      
      // Check if update is needed
      const needsUpdate = 
        (match.team1Overs && fixture.team1Overs !== match.team1Overs) ||
        (match.team2Overs && fixture.team2Overs !== match.team2Overs) ||
        (match.team1Score && fixture.team1Score !== match.team1Score) ||
        (match.team2Score && fixture.team2Score !== match.team2Score);

      if (needsUpdate) {
        updates.push({
          matchNumber: match.matchNumber,
          fixtureIndex,
          team1: fixture.team1,
          team2: fixture.team2,
          current: {
            team1Score: fixture.team1Score || 'N/A',
            team1Overs: fixture.team1Overs || 'N/A',
            team2Score: fixture.team2Score || 'N/A',
            team2Overs: fixture.team2Overs || 'N/A'
          },
          new: {
            team1Score: match.team1Score,
            team1Overs: match.team1Overs,
            team2Score: match.team2Score,
            team2Overs: match.team2Overs
          }
        });
      }
    }

    // Display preview
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📋 PREVIEW: Updates to be applied');
    console.log('═══════════════════════════════════════════════════════════\n');

    if (updates.length === 0) {
      console.log('✅ No updates needed. All fixtures already have correct data.\n');
      await mongoose.disconnect();
      process.exit(0);
    }

    updates.forEach((update, index) => {
      console.log(`Match ${update.matchNumber}: ${update.team1} vs ${update.team2}`);
      console.log(`  Fixture Index: ${update.fixtureIndex}`);
      console.log(`  Current:`);
      console.log(`    ${update.team1}: ${update.current.team1Score} (${update.current.team1Overs} overs)`);
      console.log(`    ${update.team2}: ${update.current.team2Score} (${update.current.team2Overs} overs)`);
      console.log(`  New:`);
      console.log(`    ${update.team1}: ${update.new.team1Score} (${update.new.team1Overs} overs)`);
      console.log(`    ${update.team2}: ${update.new.team2Score} (${update.new.team2Overs} overs)`);
      console.log('');
    });

    console.log(`\n📊 Total fixtures to update: ${updates.length}`);
    console.log('═══════════════════════════════════════════════════════════\n');

    // Ask for confirmation
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('❓ Do you want to proceed with these updates? (yes/no): ', async (answer) => {
      if (answer.toLowerCase() !== 'yes' && answer.toLowerCase() !== 'y') {
        console.log('❌ Update cancelled by user');
        rl.close();
        await mongoose.disconnect();
        process.exit(0);
      }

      // Apply updates
      console.log('\n🔄 Applying updates...\n');
      
      for (const update of updates) {
        const fixture = tournament.tournamentFixtures[update.fixtureIndex];
        
        if (update.new.team1Score) fixture.team1Score = update.new.team1Score;
        if (update.new.team1Overs) fixture.team1Overs = update.new.team1Overs;
        if (update.new.team2Score) fixture.team2Score = update.new.team2Score;
        if (update.new.team2Overs) fixture.team2Overs = update.new.team2Overs;
        
        console.log(`✅ Updated Match ${update.matchNumber}: ${update.team1} vs ${update.team2}`);
      }

      // Save tournament
      await tournament.save();
      console.log(`\n✅ Tournament "${tournament.name}" updated successfully!`);
      console.log(`📊 ${updates.length} fixtures updated\n`);

      rl.close();
      await mongoose.disconnect();
      process.exit(0);
    });

  } catch (error) {
    console.error('❌ Error:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

// Run the script
updateTournamentOvers();

