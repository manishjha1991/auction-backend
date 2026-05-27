/**
 * Single source of truth for fixture result persistence.
 * Used by POST /api/fixtures/save and fixture submission approval.
 */
const Fixture = require('../models/Fixture');
const User = require('../models/User');
const headToHeadModule = require('../routes/headToHead');
const { invalidateCache } = require('./cache');
const { emitPointsTableUpdated } = require('./emitPointsTableUpdate');
const { applyCareerLeagueResult } = require('./careerUserCounters');

const SCORE_FORMAT_REGEX = /^\d+\/\d+$/;

function validateFixturePayload(body) {
  const {
    team1Score,
    team2Score,
    team1Overs,
    team2Overs,
    team1,
    team2,
  } = body;

  if (team1Score && !SCORE_FORMAT_REGEX.test(String(team1Score).trim())) {
    throw new Error(
      `Team 1 score format is invalid. Expected runs/wickets (e.g. "107/10"). Received: "${team1Score}"`
    );
  }
  if (team2Score && !SCORE_FORMAT_REGEX.test(String(team2Score).trim())) {
    throw new Error(
      `Team 2 score format is invalid. Expected runs/wickets (e.g. "107/10"). Received: "${team2Score}"`
    );
  }

  const team1OversStr = String(team1Overs || '').trim();
  const team2OversStr = String(team2Overs || '').trim();
  if (!team1OversStr) throw new Error('Team 1 overs is required');
  if (!team2OversStr) throw new Error('Team 2 overs is required');

  return { team1OversStr, team2OversStr };
}

async function assertTeamsParticipating(team1, team2) {
  if (!team1 || !team2) return;

  const team1User = await User.findOne({ teamName: team1, isActive: true })
    .select('isParticipating teamName')
    .lean();
  const team2User = await User.findOne({ teamName: team2, isActive: true })
    .select('isParticipating teamName')
    .lean();

  if (team1User && team1User.isParticipating === false) {
    throw new Error(`${team1} is not participating in the current season. Cannot create or update fixture.`);
  }
  if (team2User && team2User.isParticipating === false) {
    throw new Error(`${team2} is not participating in the current season. Cannot create or update fixture.`);
  }
}

async function findFixtureDocument(body) {
  const {
    _id,
    team1,
    team2,
    team1UserId,
    team2UserId,
  } = body;

  let fixture = null;

  if (_id) {
    try {
      fixture = await Fixture.findById(_id);
    } catch (idError) {
      console.error(`Error finding fixture by _id ${_id}:`, idError.message);
    }
  }

  if (!fixture && team1 && team2) {
    let userId1 = team1UserId || null;
    let userId2 = team2UserId || null;

    if (!userId1 || !userId2) {
      const team1UserLookup = await User.findOne({ teamName: team1, isActive: true }).lean();
      const team2UserLookup = await User.findOne({ teamName: team2, isActive: true }).lean();
      userId1 = userId1 || (team1UserLookup ? team1UserLookup._id : null);
      userId2 = userId2 || (team2UserLookup ? team2UserLookup._id : null);
    }

    if (userId1 && userId2) {
      fixture = await Fixture.findOne({
        $or: [
          { team1UserId: userId1, team2UserId: userId2 },
          { team1UserId: userId2, team2UserId: userId1 },
        ],
        isActive: true,
      });
    }

    if (!fixture) {
      fixture = await Fixture.findOne({ team1, team2, isActive: true });
    }
  }

  return fixture;
}

/**
 * @param {object} body Same shape as POST /api/fixtures/save body
 * @param {object} [options]
 * @param {import('express').Request} [options.req] For socket emit on points table update
 */
async function saveFixtureResult(body, options = {}) {
  const {
    _id,
    team1,
    team2,
    team1UserId,
    team2UserId,
    winner,
    margin,
    mom,
    team1Score,
    team2Score,
    team1Overs,
    team2Overs,
    team1Fairness,
    team2Fairness,
    group,
    matchType,
  } = body;

  await assertTeamsParticipating(team1, team2);
  const { team1OversStr, team2OversStr } = validateFixturePayload(body);

  let fixture = await findFixtureDocument(body);
  let oldWinnerBeforeSave = null;

  if (!fixture) {
    let finalUserId1 = team1UserId || null;
    let finalUserId2 = team2UserId || null;

    if (!finalUserId1 && team1) {
      const team1User = await User.findOne({ teamName: team1, isActive: true });
      finalUserId1 = team1User?._id || null;
    }
    if (!finalUserId2 && team2) {
      const team2User = await User.findOne({ teamName: team2, isActive: true });
      finalUserId2 = team2User?._id || null;
    }

    fixture = new Fixture({
      team1,
      team2,
      team1UserId: finalUserId1,
      team2UserId: finalUserId2,
      winner,
      margin,
      mom: mom
        ? {
            name: mom.name || null,
            score: mom.score !== undefined ? mom.score : null,
            wickets: mom.wickets !== undefined ? mom.wickets : null,
          }
        : null,
      team1Score,
      team2Score,
      team1Overs: team1OversStr,
      team2Overs: team2OversStr,
      team1Fairness,
      team2Fairness,
      group: group || null,
      matchType: matchType || 'normal',
    });
  } else {
    oldWinnerBeforeSave = fixture.winner;
    if (winner !== undefined) fixture.winner = winner;
    if (margin !== undefined) fixture.margin = margin;
    if (mom !== undefined) {
      fixture.mom = {
        name: mom.name || null,
        score: mom.score !== undefined ? mom.score : null,
        wickets: mom.wickets !== undefined ? mom.wickets : null,
      };
    }
    if (team1Score !== undefined) fixture.team1Score = team1Score;
    if (team2Score !== undefined) fixture.team2Score = team2Score;
    fixture.team1Overs = team1OversStr;
    fixture.team2Overs = team2OversStr;
    if (team1Fairness !== undefined) fixture.team1Fairness = team1Fairness;
    if (team2Fairness !== undefined) fixture.team2Fairness = team2Fairness;
    if (group !== undefined) fixture.group = group;
    if (matchType !== undefined) fixture.matchType = matchType;

    if (team1UserId && team1UserId !== fixture.team1UserId) {
      fixture.team1UserId = team1UserId;
    }
    if (team2UserId && team2UserId !== fixture.team2UserId) {
      fixture.team2UserId = team2UserId;
    }

    if (!fixture.team1UserId || !fixture.team2UserId) {
      const team1User = await User.findOne({ teamName: fixture.team1, isActive: true });
      const team2User = await User.findOne({ teamName: fixture.team2, isActive: true });
      if (team1User && !fixture.team1UserId) fixture.team1UserId = team1User._id;
      if (team2User && !fixture.team2UserId) fixture.team2UserId = team2User._id;
    }

    if (fixture.winner && !fixture.winnerUserId) {
      const winnerUser = await User.findOne({ teamName: fixture.winner, isActive: true });
      if (winnerUser) fixture.winnerUserId = winnerUser._id;
    }
  }

  if (!fixture.team1 || !fixture.team2) {
    throw new Error('Missing required fields: team1 and team2 are required');
  }

  await fixture.save();
  invalidateCache('fixtures:');

  if (fixture.winner) {
    try {
      const team1User = await User.findOne({ teamName: fixture.team1 });
      const team2User = await User.findOne({ teamName: fixture.team2 });

      if (team1User && team2User) {
        if (fixture.winner === fixture.team1) {
          team1User.points = (team1User.points || 0) + 2;
          team2User.points = (team2User.points || 0) + 0;
        } else {
          team1User.points = (team1User.points || 0) + 0;
          team2User.points = (team2User.points || 0) + 2;
        }

        team1User.fairnessPoint = (team1User.fairnessPoint || 0) + (fixture.team1Fairness || 0);
        team2User.fairnessPoint = (team2User.fairnessPoint || 0) + (fixture.team2Fairness || 0);
        team1User.matchesPlayed = (team1User.matchesPlayed || 0) + 1;
        team2User.matchesPlayed = (team2User.matchesPlayed || 0) + 1;

        await Promise.all([team1User.save(), team2User.save()]);
      }

      if (oldWinnerBeforeSave && oldWinnerBeforeSave !== fixture.winner && headToHeadModule.revertAndResyncForRecord) {
        Fixture.updateOne({ _id: fixture._id }, { $set: { headToHeadSynced: false } })
          .then(() =>
            headToHeadModule.revertAndResyncForRecord(fixture.team1, fixture.team2, oldWinnerBeforeSave)
          )
          .catch((err) => console.error('Head-to-head sync:', err));
      } else if (headToHeadModule.syncHeadToHead) {
        headToHeadModule.syncHeadToHead().catch((err) => console.error('Head-to-head sync:', err));
      }

      const shouldBumpCareer = !oldWinnerBeforeSave || oldWinnerBeforeSave !== fixture.winner;
      if (shouldBumpCareer) {
        applyCareerLeagueResult({
          team1: fixture.team1,
          team2: fixture.team2,
          newWinnerName: fixture.winner,
          oldWinnerName: oldWinnerBeforeSave || null,
        }).catch((err) => console.error('Career counters:', err));
      }
    } catch (pointsError) {
      console.error('Error updating points:', pointsError);
    }
  }

  if (options.req) {
    emitPointsTableUpdated(options.req, { reason: 'fixture_saved' });
  }

  const fixtureResponse = fixture.toObject ? fixture.toObject() : fixture;
  return {
    message: 'Fixture result saved successfully! Points updated automatically.',
    fixture: fixtureResponse,
  };
}

module.exports = {
  saveFixtureResult,
  buildFixtureSaveBodyFromSubmission(submission, fixture) {
    return {
      _id: fixture._id,
      team1: fixture.team1,
      team2: fixture.team2,
      team1UserId: fixture.team1UserId,
      team2UserId: fixture.team2UserId,
      winner: submission.winner,
      margin: submission.margin,
      team1Score: submission.team1Score,
      team2Score: submission.team2Score,
      team1Overs: submission.team1Overs,
      team2Overs: submission.team2Overs,
      mom: submission.mom,
      team1Fairness: submission.team1Fairness,
      team2Fairness: submission.team2Fairness,
      group: fixture.group,
      matchType: fixture.matchType,
    };
  },
};
