const assert = require('node:assert/strict');
const test = require('node:test');

const User = require('../models/User');
const { applyCareerLeagueResult } = require('../utils/careerUserCounters');

test('career counters apply every valid result transition exactly once', async (t) => {
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  let calls = [];

  User.findOneAndUpdate = async (...args) => {
    calls.push(args);
  };
  t.after(() => {
    User.findOneAndUpdate = originalFindOneAndUpdate;
  });

  const transition = async (oldWinnerName, newWinnerName) => {
    calls = [];
    await applyCareerLeagueResult({
      team1: 'Team A',
      team2: 'Team B',
      oldWinnerName,
      newWinnerName,
    });
    return calls.map(([filter, update]) => ({ filter, update }));
  };

  assert.deepEqual(await transition(null, 'Team A'), [
    {
      filter: { teamName: 'Team A' },
      update: { $inc: { careerMatchesPlayed: 1 } },
    },
    {
      filter: { teamName: 'Team B' },
      update: { $inc: { careerMatchesPlayed: 1 } },
    },
    {
      filter: { teamName: 'Team A' },
      update: { $inc: { careerWins: 1 } },
    },
  ]);

  assert.deepEqual(await transition('Team A', 'Team B'), [
    {
      filter: { teamName: 'Team A' },
      update: { $inc: { careerWins: -1 } },
    },
    {
      filter: { teamName: 'Team B' },
      update: { $inc: { careerWins: 1 } },
    },
  ]);

  assert.deepEqual(await transition('Team A', null), [
    {
      filter: { teamName: 'Team A' },
      update: { $inc: { careerWins: -1 } },
    },
    {
      filter: { teamName: 'Team A' },
      update: { $inc: { careerMatchesPlayed: -1 } },
    },
    {
      filter: { teamName: 'Team B' },
      update: { $inc: { careerMatchesPlayed: -1 } },
    },
  ]);

  assert.deepEqual(await transition('tie', 'Team B'), [
    {
      filter: { teamName: 'Team A' },
      update: { $inc: { careerMatchesPlayed: 1 } },
    },
    {
      filter: { teamName: 'Team B' },
      update: { $inc: { careerMatchesPlayed: 1 } },
    },
    {
      filter: { teamName: 'Team B' },
      update: { $inc: { careerWins: 1 } },
    },
  ]);

  assert.deepEqual(await transition('Team A', 'team a'), []);
  assert.deepEqual(await transition('tie', 'no_result'), []);
});
