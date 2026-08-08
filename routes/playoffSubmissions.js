const express = require('express');
const PlayoffFixture = require('../models/PlayoffFixture');
const PlayoffSubmission = require('../models/PlayoffSubmission');
const User = require('../models/User');
const AppSettings = require('../models/AppSettings');
const Tournament = require('../models/Tournament');
const {
  isPlayoffMatchReady,
  userInPlayoffFixture,
  resolvePlayoffWinnerUserId,
  resolvePlayoffWinnerName,
  applyPlayoffFixtureResult,
  buildPlayoffUpdateFromSubmission,
} = require('../utils/playoffSaveService');
const {
  findRunningWorldCupTournament,
  mapTournamentFixturesToPlayoffShape,
  resolveTournamentFixtureByMatchId,
  resolveWinnerOnTournamentFixture,
  applyTournamentFixtureResult,
  isPlaceholderTeam,
} = require('../utils/tournamentFixtureSaveService');

const router = express.Router();

const SCORE_REGEX = /^\d+\/\d+$/;

const getUserId = (req) =>
  req.headers['user-id'] || req.body?.userId || req.body?.submittedBy;

const requireUser = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    if (!userId || userId === 'undefined' || userId === 'null') {
      return res.status(401).json({ error: 'User ID required' });
    }
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    req.authUser = user;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Authentication failed' });
  }
};

const requireAdmin = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: 'User ID required' });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    req.authUser = user;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Authentication failed' });
  }
};

const validateSubmissionBody = (body, { requireOvers = false } = {}) => {
  const errors = [];
  if (!body.matchId) errors.push('matchId is required');
  if (!body.winner) errors.push('Winner is required');
  if (!body.margin?.trim()) errors.push('Margin is required');
  if (!body.team1Score?.trim()) errors.push('Team 1 score is required');
  else if (!SCORE_REGEX.test(body.team1Score.trim())) {
    errors.push('Team 1 score must be runs/wickets (e.g. 265/10)');
  }
  if (!body.team2Score?.trim()) errors.push('Team 2 score is required');
  else if (!SCORE_REGEX.test(body.team2Score.trim())) {
    errors.push('Team 2 score must be runs/wickets (e.g. 134/10)');
  }
  if (body.team1Fairness === '' || body.team1Fairness == null) {
    errors.push('Team 1 fairness is required');
  }
  if (body.team2Fairness === '' || body.team2Fairness == null) {
    errors.push('Team 2 fairness is required');
  }
  if (requireOvers) {
    if (!body.team1Overs?.trim()) errors.push('Team 1 overs is required for World Cup fixtures');
    if (!body.team2Overs?.trim()) errors.push('Team 2 overs is required for World Cup fixtures');
  }
  return errors;
};

const isWorldCupModeEnabled = async () => {
  const settings = await AppSettings.findOne().lean();
  return settings?.worldCupMode === true || settings?.worldCupMode === 'true';
};

const loadWorldCupVirtualFixture = async (matchId, tournamentId, fixtureIndex) => {
  let tournament = null;
  if (tournamentId) {
    tournament = await Tournament.findById(tournamentId);
  }
  if (!tournament) {
    tournament = await findRunningWorldCupTournament();
  }
  if (!tournament) return null;

  if (fixtureIndex != null && fixtureIndex !== '' && !Number.isNaN(Number(fixtureIndex))) {
    const idx = Number(fixtureIndex);
    const mapped = mapTournamentFixturesToPlayoffShape(tournament);
    const virtual = mapped[idx];
    if (!virtual) return null;
    return {
      tournament,
      fixtureIndex: idx,
      fixture: tournament.tournamentFixtures[idx],
      virtual,
    };
  }

  const resolved = resolveTournamentFixtureByMatchId(tournament, matchId);
  if (!resolved) return null;
  return {
    tournament,
    fixtureIndex: resolved.fixtureIndex,
    fixture: resolved.fixture,
    virtual: resolved.virtual,
  };
};

const buildSubmissionPayload = (body, fixture, user, wcMeta = null) => {
  const winnerUserId = resolvePlayoffWinnerUserId(body.winner, fixture);
  const winner = winnerUserId
    ? String(winnerUserId) === String(fixture.team1UserId)
      ? fixture.team1
      : fixture.team2
    : resolvePlayoffWinnerName(body.winner, fixture) || body.winner;

  return {
    matchId: fixture.matchId,
    stage: fixture.stage || '',
    isWorldCupTournament: !!wcMeta?.isWorldCupTournament,
    tournamentId: wcMeta?.tournamentId || null,
    fixtureIndex: wcMeta?.fixtureIndex != null ? wcMeta.fixtureIndex : null,
    tournamentName: wcMeta?.tournamentName || '',
    submittedBy: user._id,
    submitterName: user.name || user.username || '',
    submitterTeamName: user.teamName || '',
    team1: fixture.team1,
    team2: fixture.team2,
    winner,
    winnerUserId: winnerUserId || null,
    margin: String(body.margin || '').trim(),
    team1Score: String(body.team1Score || '').trim(),
    team2Score: String(body.team2Score || '').trim(),
    team1Overs: String(body.team1Overs || '').trim() || null,
    team2Overs: String(body.team2Overs || '').trim() || null,
    mom: {
      name: body.mom?.name?.trim() || null,
      score: body.mom?.score != null && body.mom.score !== '' ? Number(body.mom.score) : null,
      wickets:
        body.mom?.wickets != null && body.mom.wickets !== '' ? Number(body.mom.wickets) : null,
    },
    team1Fairness: Number(body.team1Fairness),
    team2Fairness: Number(body.team2Fairness),
  };
};

function isOpponent(user, submission, fixture) {
  if (!user || !submission || !fixture) return false;
  if (String(submission.submittedBy) === String(user._id)) return false;
  return userInPlayoffFixture(user, fixture);
}

async function resolveFixtureForSubmission(submission) {
  if (submission.isWorldCupTournament && submission.tournamentId != null) {
    const loaded = await loadWorldCupVirtualFixture(
      submission.matchId,
      submission.tournamentId,
      submission.fixtureIndex
    );
    if (!loaded) return null;
    return {
      kind: 'wc',
      fixture: loaded.virtual,
      tournament: loaded.tournament,
      fixtureIndex: loaded.fixtureIndex,
    };
  }

  const fixture = await PlayoffFixture.findOne({ matchId: submission.matchId });
  if (!fixture) return null;
  return { kind: 'playoff', fixture };
}

async function getDecisionAccess(user, submission) {
  if (!user || !submission) return { allowed: false };
  if (user.isAdmin) return { allowed: true, role: 'admin' };
  const resolved = await resolveFixtureForSubmission(submission);
  if (!resolved?.fixture) return { allowed: false };
  if (isOpponent(user, submission, resolved.fixture)) return { allowed: true, role: 'opponent' };
  return { allowed: false };
}

async function processApproval(submission, req, overrides = {}, allowOverrides = false) {
  const access = await getDecisionAccess(req.authUser, submission);
  if (!access.allowed) {
    const err = new Error('Only an admin or the opposing team can confirm this result.');
    err.status = 403;
    throw err;
  }

  const merged = allowOverrides
    ? {
        winner: overrides.winner ?? submission.winner,
        margin: overrides.margin ?? submission.margin,
        team1Score: overrides.team1Score ?? submission.team1Score,
        team2Score: overrides.team2Score ?? submission.team2Score,
        team1Overs: overrides.team1Overs ?? submission.team1Overs,
        team2Overs: overrides.team2Overs ?? submission.team2Overs,
        mom: overrides.mom ?? submission.mom,
        team1Fairness: overrides.team1Fairness ?? submission.team1Fairness,
        team2Fairness: overrides.team2Fairness ?? submission.team2Fairness,
      }
    : {
        winner: submission.winner,
        margin: submission.margin,
        team1Score: submission.team1Score,
        team2Score: submission.team2Score,
        team1Overs: submission.team1Overs,
        team2Overs: submission.team2Overs,
        mom: submission.mom,
        team1Fairness: submission.team1Fairness,
        team2Fairness: submission.team2Fairness,
      };

  const requireOvers = !!submission.isWorldCupTournament;
  const errors = validateSubmissionBody(
    { matchId: submission.matchId, ...merged },
    { requireOvers }
  );
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.status = 400;
    throw err;
  }

  Object.assign(submission, merged);

  const resolved = await resolveFixtureForSubmission(submission);
  if (!resolved?.fixture) {
    const err = new Error(
      submission.isWorldCupTournament
        ? 'World Cup tournament fixture not found'
        : 'Playoff fixture not found'
    );
    err.status = 404;
    throw err;
  }

  const fixture = resolved.fixture;

  if (resolved.kind === 'wc') {
    const { winnerName, winnerUserId } = resolveWinnerOnTournamentFixture(
      submission.winner,
      fixture
    );
    if (!winnerName) {
      const err = new Error('Winner must be one of the two teams in this World Cup match.');
      err.status = 400;
      throw err;
    }
    submission.winner = winnerName;
    submission.winnerUserId = winnerUserId || null;

    await applyTournamentFixtureResult(submission.tournamentId, submission.fixtureIndex, {
      winner: winnerName,
      margin: submission.margin,
      team1Score: submission.team1Score,
      team2Score: submission.team2Score,
      team1Overs: submission.team1Overs,
      team2Overs: submission.team2Overs,
      team1Fairness: submission.team1Fairness,
      team2Fairness: submission.team2Fairness,
      mom: submission.mom,
    });
  } else {
    const winnerUserId = resolvePlayoffWinnerUserId(submission.winner, fixture);
    if (!winnerUserId) {
      const err = new Error('Winner must be one of the two teams in this playoff match.');
      err.status = 400;
      throw err;
    }

    submission.winnerUserId = winnerUserId;
    submission.winner =
      String(winnerUserId) === String(fixture.team1UserId) ? fixture.team1 : fixture.team2;

    await applyPlayoffFixtureResult(
      submission.matchId,
      buildPlayoffUpdateFromSubmission(submission)
    );
  }

  submission.status = 'approved';
  submission.adminDecision = {
    status: 'approved',
    decidedBy: req.authUser._id,
    decidedAt: new Date(),
    decidedByRole: access.role,
    note: allowOverrides ? overrides.note || '' : '',
  };
  await submission.save();

  return submission;
}

async function processRejection(submission, req, note = '') {
  const access = await getDecisionAccess(req.authUser, submission);
  if (!access.allowed) {
    const err = new Error('Only an admin or the opposing team can reject this result.');
    err.status = 403;
    throw err;
  }

  submission.status = 'rejected';
  submission.adminDecision = {
    status: 'rejected',
    decidedBy: req.authUser._id,
    decidedAt: new Date(),
    decidedByRole: access.role,
    note: note || '',
  };
  await submission.save();

  return submission;
}

// POST /api/playoff-submissions/submit
router.post('/submit', requireUser, async (req, res) => {
  try {
    const wcMode = await isWorldCupModeEnabled();
    const lookingForWc =
      wcMode ||
      req.body?.isWorldCupTournament === true ||
      !!req.body?.tournamentId ||
      String(req.body?.matchId || '').startsWith('WC');

    const errors = validateSubmissionBody(req.body, { requireOvers: lookingForWc });
    if (errors.length) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    let fixture = null;
    let wcMeta = null;

    if (lookingForWc) {
      const loaded = await loadWorldCupVirtualFixture(
        req.body.matchId,
        req.body.tournamentId,
        req.body.fixtureIndex
      );
      if (!loaded) {
        return res.status(404).json({
          error:
            'World Cup fixture not found. Ensure World Cup mode is on and a running World Cup tournament exists.',
        });
      }
      fixture = loaded.virtual;
      wcMeta = {
        isWorldCupTournament: true,
        tournamentId: loaded.tournament._id,
        fixtureIndex: loaded.fixtureIndex,
        tournamentName: loaded.tournament.name || '',
      };
    } else {
      fixture = await PlayoffFixture.findOne({ matchId: req.body.matchId });
      if (!fixture) {
        return res.status(404).json({ error: 'Playoff fixture not found' });
      }
    }

    const notReady =
      fixture.winner ||
      isPlaceholderTeam(fixture.team1) ||
      isPlaceholderTeam(fixture.team2) ||
      (!lookingForWc && !isPlayoffMatchReady(fixture));
    if (notReady) {
      return res.status(400).json({
        error: 'This match is not ready yet (teams not set or already completed).',
      });
    }

    const winnerOk = lookingForWc
      ? !!resolveWinnerOnTournamentFixture(req.body.winner, fixture).winnerName
      : !!resolvePlayoffWinnerUserId(req.body.winner, fixture);
    if (!winnerOk) {
      return res.status(400).json({
        error: 'Winner must be one of the two teams in this match.',
      });
    }

    const user = req.authUser;
    if (!user.isAdmin && !userInPlayoffFixture(user, fixture)) {
      return res.status(403).json({
        error: 'You can only submit results for matches involving your team.',
      });
    }

    const pendingQuery = {
      matchId: fixture.matchId,
      status: 'pending',
    };
    if (wcMeta?.tournamentId != null) {
      pendingQuery.tournamentId = wcMeta.tournamentId;
      pendingQuery.fixtureIndex = wcMeta.fixtureIndex;
    }
    const existingPending = await PlayoffSubmission.findOne(pendingQuery);
    if (existingPending) {
      return res.status(409).json({
        error: 'A pending submission already exists for this match.',
        submissionId: existingPending._id,
      });
    }

    const doc = await PlayoffSubmission.create(
      buildSubmissionPayload(req.body, fixture, user, wcMeta)
    );

    res.status(201).json({
      message: lookingForWc
        ? 'Submitted — waiting for opponent or admin to confirm. On approval this updates the World Cup tournament fixture.'
        : 'Submitted — waiting for opponent or admin to confirm.',
      submission: doc,
    });
  } catch (err) {
    console.error('Playoff submission error:', err);
    res.status(500).json({ error: err.message || 'Failed to submit' });
  }
});

// GET /api/playoff-submissions/my
router.get('/my', requireUser, async (req, res) => {
  try {
    const list = await PlayoffSubmission.find({ submittedBy: req.authUser._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load submissions' });
  }
});

// GET /api/playoff-submissions/opponent/pending
router.get('/opponent/pending', requireUser, async (req, res) => {
  try {
    const user = req.authUser;
    const pending = await PlayoffSubmission.find({ status: 'pending' })
      .populate('submittedBy', 'name teamName teamImage')
      .sort({ createdAt: -1 })
      .lean();

    const list = [];
    for (const item of pending) {
      const resolved = await resolveFixtureForSubmission(item);
      if (!resolved?.fixture) continue;
      if (isOpponent(user, item, resolved.fixture)) list.push(item);
    }

    res.json(list);
  } catch (err) {
    console.error('Playoff opponent pending error:', err);
    res.status(500).json({ error: 'Failed to load confirmations' });
  }
});

// GET /api/playoff-submissions/admin/pending
router.get('/admin/pending', requireAdmin, async (req, res) => {
  try {
    const list = await PlayoffSubmission.find({ status: 'pending' })
      .populate('submittedBy', 'name teamName teamImage')
      .sort({ createdAt: -1 })
      .lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load pending submissions' });
  }
});

// GET /api/playoff-submissions/admin/history
router.get('/admin/history', requireAdmin, async (req, res) => {
  try {
    const list = await PlayoffSubmission.find({ status: { $in: ['approved', 'rejected'] } })
      .populate('submittedBy', 'name teamName teamImage')
      .populate('adminDecision.decidedBy', 'name teamName')
      .sort({ 'adminDecision.decidedAt': -1 })
      .limit(100)
      .lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load history' });
  }
});

// POST /api/playoff-submissions/:id/approve
router.post('/:id/approve', requireUser, async (req, res) => {
  try {
    const submission = await PlayoffSubmission.findById(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.status !== 'pending') {
      return res.status(400).json({ error: 'Submission is no longer pending' });
    }

    const allowOverrides = !!req.authUser.isAdmin;
    const overrides = allowOverrides ? req.body || {} : {};
    const updated = await processApproval(submission, req, overrides, allowOverrides);

    res.json({
      message: updated.isWorldCupTournament
        ? 'World Cup result confirmed and tournament fixture updated.'
        : 'Playoff result confirmed and bracket updated.',
      submission: updated,
    });
  } catch (err) {
    console.error('Approve playoff submission error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Approval failed' });
  }
});

// POST /api/playoff-submissions/:id/reject
router.post('/:id/reject', requireUser, async (req, res) => {
  try {
    const submission = await PlayoffSubmission.findById(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.status !== 'pending') {
      return res.status(400).json({ error: 'Submission is no longer pending' });
    }

    const updated = await processRejection(submission, req, req.body?.note || '');

    res.json({ message: 'Submission rejected.', submission: updated });
  } catch (err) {
    console.error('Reject playoff submission error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Rejection failed' });
  }
});

function applyPendingSubmissionFields(submission, body, fixture) {
  if (body.winner !== undefined) {
    submission.winner = body.winner;
    if (fixture) {
      if (submission.isWorldCupTournament) {
        const resolved = resolveWinnerOnTournamentFixture(body.winner, fixture);
        submission.winner = resolved.winnerName || body.winner;
        submission.winnerUserId = resolved.winnerUserId || null;
      } else {
        submission.winnerUserId = resolvePlayoffWinnerUserId(body.winner, fixture);
        const winnerUserId = submission.winnerUserId;
        if (winnerUserId) {
          submission.winner =
            String(winnerUserId) === String(fixture.team1UserId)
              ? fixture.team1
              : fixture.team2;
        } else {
          submission.winner = resolvePlayoffWinnerName(body.winner, fixture) || body.winner;
        }
      }
    }
  }
  if (body.margin !== undefined) submission.margin = String(body.margin || '').trim();
  if (body.team1Score !== undefined) submission.team1Score = String(body.team1Score || '').trim();
  if (body.team2Score !== undefined) submission.team2Score = String(body.team2Score || '').trim();
  if (body.team1Overs !== undefined) {
    submission.team1Overs = String(body.team1Overs || '').trim() || null;
  }
  if (body.team2Overs !== undefined) {
    submission.team2Overs = String(body.team2Overs || '').trim() || null;
  }
  if (body.team1Fairness !== undefined) submission.team1Fairness = Number(body.team1Fairness);
  if (body.team2Fairness !== undefined) submission.team2Fairness = Number(body.team2Fairness);
  if (body.mom !== undefined) {
    submission.mom = {
      name: body.mom?.name?.trim() || null,
      score: body.mom?.score != null && body.mom.score !== '' ? Number(body.mom.score) : null,
      wickets:
        body.mom?.wickets != null && body.mom.wickets !== '' ? Number(body.mom.wickets) : null,
    };
  }
}

// POST /api/playoff-submissions/admin/:id/update
router.post('/admin/:id/update', requireAdmin, async (req, res) => {
  try {
    const submission = await PlayoffSubmission.findById(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.status !== 'pending') {
      return res.status(400).json({ error: 'Submission is no longer pending' });
    }

    const body = req.body || {};
    const merged = {
      matchId: submission.matchId,
      winner: body.winner ?? submission.winner,
      margin: body.margin ?? submission.margin,
      team1Score: body.team1Score ?? submission.team1Score,
      team2Score: body.team2Score ?? submission.team2Score,
      team1Overs: body.team1Overs ?? submission.team1Overs,
      team2Overs: body.team2Overs ?? submission.team2Overs,
      mom: body.mom ?? submission.mom,
      team1Fairness: body.team1Fairness ?? submission.team1Fairness,
      team2Fairness: body.team2Fairness ?? submission.team2Fairness,
    };

    const errors = validateSubmissionBody(merged, {
      requireOvers: !!submission.isWorldCupTournament,
    });
    if (errors.length) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    const resolved = await resolveFixtureForSubmission(submission);
    applyPendingSubmissionFields(submission, merged, resolved?.fixture || null);
    await submission.save();

    res.json({
      message: 'Submission updated. Still pending until you approve.',
      submission,
    });
  } catch (err) {
    console.error('Update playoff submission error:', err);
    res.status(500).json({ error: err.message || 'Update failed' });
  }
});

// POST /api/playoff-submissions/admin/:id/approve
router.post('/admin/:id/approve', requireAdmin, async (req, res) => {
  try {
    const submission = await PlayoffSubmission.findById(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.status !== 'pending') {
      return res.status(400).json({ error: 'Submission is no longer pending' });
    }

    const updated = await processApproval(submission, req, req.body || {}, true);

    res.json({
      message: updated.isWorldCupTournament
        ? 'World Cup result confirmed and tournament fixture updated.'
        : 'Playoff result approved and bracket updated.',
      submission: updated,
    });
  } catch (err) {
    console.error('Admin approve playoff submission error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Approval failed' });
  }
});

// POST /api/playoff-submissions/admin/:id/reject
router.post('/admin/:id/reject', requireAdmin, async (req, res) => {
  try {
    const submission = await PlayoffSubmission.findById(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.status !== 'pending') {
      return res.status(400).json({ error: 'Submission is no longer pending' });
    }

    const updated = await processRejection(submission, req, req.body?.note || '');

    res.json({ message: 'Submission rejected.', submission: updated });
  } catch (err) {
    console.error('Admin reject playoff submission error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Rejection failed' });
  }
});

module.exports = router;
