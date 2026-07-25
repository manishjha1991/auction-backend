const assert = require('node:assert/strict');
const test = require('node:test');

const User = require('../models/User');
const { applyFixtureStandingsTransition } = require('../utils/fixtureStandings');

test('fixture standings apply each result transition exactly once', async (t) => {
  const originalFindOneAndUpdate = User.findOneAndUpdate;
  let calls = [];

  User.findOneAndUpdate = async (...args) => {
    calls.push(args);
  };
  t.after(() => {
    User.findOneAndUpdate = originalFindOneAndUpdate;
  });

  const transition = async (oldWinnerName, newWinnerName, fairness = {}) => {
    calls = [];
    const result = await applyFixtureStandingsTransition({
      team1: 'Team A',
      team2: 'Team B',
      oldWinnerName,
      newWinnerName,
      team1Fairness: fairness.team1Fairness || 0,
      team2Fairness: fairness.team2Fairness || 0,
    });
    return {
      result,
      calls: calls.map(([filter, update]) => ({ filter, update })),
    };
  };

  {
    const { result, calls: c } = await transition(null, 'Team A', {
      team1Fairness: 1,
      team2Fairness: 2,
    });
    assert.equal(result.reason, 'first_result');
    assert.deepEqual(c, [
      { filter: { teamName: 'Team A' }, update: { $inc: { points: 2 } } },
      {
        filter: { teamName: 'Team A' },
        update: { $inc: { matchesPlayed: 1, fairnessPoint: 1 } },
      },
      {
        filter: { teamName: 'Team B' },
        update: { $inc: { matchesPlayed: 1, fairnessPoint: 2 } },
      },
    ]);
  }

  {
    const { result, calls: c } = await transition('Team A', 'Team A', {
      team1Fairness: 9,
      team2Fairness: 9,
    });
    assert.equal(result.reason, 'same_winner');
    assert.deepEqual(c, []);
  }

  {
    const { result, calls: c } = await transition('Team A', 'Team B');
    assert.equal(result.reason, 'winner_changed');
    assert.deepEqual(c, [
      { filter: { teamName: 'Team A' }, update: { $inc: { points: -2 } } },
      { filter: { teamName: 'Team B' }, update: { $inc: { points: 2 } } },
    ]);
  }

  {
    const { result, calls: c } = await transition('Team B', null);
    assert.equal(result.reason, 'result_cleared');
    assert.deepEqual(c, [
      { filter: { teamName: 'Team B' }, update: { $inc: { points: -2 } } },
      { filter: { teamName: 'Team A' }, update: { $inc: { matchesPlayed: -1 } } },
      { filter: { teamName: 'Team B' }, update: { $inc: { matchesPlayed: -1 } } },
    ]);
  }
});
