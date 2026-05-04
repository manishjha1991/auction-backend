/* eslint-disable no-console */
/**
 * Replace ALL tournament fixtures with a fresh round-robin set (each subscribed team plays every other team once).
 * Removes any existing results and knockout rows — re-add knockout from the app (Manage) after round-robin is complete.
 *
 * Usage:
 *   node scripts/recreateTournamentFixtures.js <tournamentId>           # dry-run
 *   node scripts/recreateTournamentFixtures.js <tournamentId> --apply
 *
 * Requires .env MONGO_URI. Optional MONGO_DB_NAME to target a specific DB.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Tournament = require('../models/Tournament');
const { updateTournamentPointTable } = require('../routes/tournaments');

const MONGO_DB_NAME = process.env.MONGO_DB_NAME || null;

function buildRoundRobinFixtures(teams) {
  const fixtures = [];
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      fixtures.push({
        team1: teams[i].teamName,
        team2: teams[j].teamName,
        team1UserId: teams[i].userId,
        team2UserId: teams[j].userId,
        winner: null,
        margin: null,
        team1Score: null,
        team2Score: null,
        team1Overs: null,
        team2Overs: null,
        team1Fairness: 0,
        team2Fairness: 0,
        mom: { name: null, score: null, wickets: null },
        createdAt: new Date(),
      });
    }
  }
  return fixtures;
}

(async () => {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const idArg = argv.find((a) => a !== '--apply' && mongoose.isValidObjectId(a));

  if (!process.env.MONGO_URI) {
    console.error('Missing MONGO_URI');
    process.exit(1);
  }
  if (!idArg) {
    console.error('Usage: node scripts/recreateTournamentFixtures.js <tournamentId> [--apply]');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, MONGO_DB_NAME ? { dbName: MONGO_DB_NAME } : undefined);
  console.log(`Connected (database: ${mongoose.connection.name})\n`);

  const tournament = await Tournament.findById(idArg).populate('subscribedTeams.userId', 'teamName');
  if (!tournament) {
    console.error('Tournament not found');
    await mongoose.disconnect();
    process.exit(1);
  }

  const teams = tournament.subscribedTeams.map((team) => ({
    userId: team.userId?._id || team.userId,
    teamName: team.userId?.teamName || team.teamName,
  }));

  if (teams.length < 2) {
    console.error('Need at least 2 subscribed teams.');
    await mongoose.disconnect();
    process.exit(1);
  }

  const fixtures = buildRoundRobinFixtures(teams);
  const expected = (teams.length * (teams.length - 1)) / 2;
  const oldLen = tournament.tournamentFixtures?.length || 0;

  console.log(`Tournament: ${tournament.name}`);
  console.log(`Teams: ${teams.length}`);
  console.log(`Current fixtures: ${oldLen} → will become ${expected} (round-robin only)`);
  console.log(`Sample: ${fixtures[0]?.team1} vs ${fixtures[0]?.team2} … ${fixtures[fixtures.length - 1]?.team1} vs ${fixtures[fixtures.length - 1]?.team2}`);

  if (!apply) {
    console.log('\nDry-run. Add --apply to replace fixtures, reset winner, and refresh point table.');
    await mongoose.disconnect();
    process.exit(0);
  }

  tournament.tournamentFixtures = fixtures;
  tournament.markModified('tournamentFixtures');
  tournament.winner = { teamName: null, teamImage: null, wonAt: null };
  if (tournament.status === 'completed') {
    tournament.status = 'running';
  }

  await tournament.save();
  await updateTournamentPointTable(tournament._id);

  console.log('\nDone. Point table recalculated. Use Manage → Initialize knockout after all round-robin results are in.');
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
