const express = require('express');
const Fixture = require('../models/Fixture');
const FixtureSubmission = require('../models/FixtureSubmission');
const User = require('../models/User');
const {
  saveFixtureResult,
  buildFixtureSaveBodyFromSubmission,
} = require('../utils/fixtureSaveService');

const router = express.Router();

const SCORE_REGEX = /^\d+\/\d+$/;

const normalizeTeamKey = (value = '') =>
  String(value || '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();

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

const validateSubmissionBody = (body) => {
  const errors = [];
  if (!body.fixtureId) errors.push('fixtureId is required');
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
  if (!String(body.team1Overs || '').trim()) errors.push('Team 1 overs is required');
  if (!String(body.team2Overs || '').trim()) errors.push('Team 2 overs is required');
  if (!body.mom?.name?.trim()) errors.push('Man of the Match is required');
  if (body.team1Fairness === '' || body.team1Fairness == null) {
    errors.push('Team 1 fairness is required');
  }
  if (body.team2Fairness === '' || body.team2Fairness == null) {
    errors.push('Team 2 fairness is required');
  }
  return errors;
};

const buildSubmissionPayload = (body, fixture, user) => ({
  fixtureId: fixture._id,
  submittedBy: user._id,
  submitterName: user.name || user.username || '',
  submitterTeamName: user.teamName || '',
  team1: fixture.team1,
  team2: fixture.team2,
  winner: body.winner,
  margin: String(body.margin || '').trim(),
  team1Score: String(body.team1Score || '').trim(),
  team2Score: String(body.team2Score || '').trim(),
  team1Overs: String(body.team1Overs || '').trim(),
  team2Overs: String(body.team2Overs || '').trim(),
  mom: {
    name: body.mom?.name?.trim() || null,
    score: body.mom?.score != null && body.mom.score !== '' ? Number(body.mom.score) : null,
    wickets:
      body.mom?.wickets != null && body.mom.wickets !== '' ? Number(body.mom.wickets) : null,
  },
  team1Fairness: Number(body.team1Fairness),
  team2Fairness: Number(body.team2Fairness),
});

async function applyFixtureSave(submission, req) {
  const fixture = await Fixture.findById(submission.fixtureId);
  if (!fixture) throw new Error('Fixture not found');

  const payload = buildFixtureSaveBodyFromSubmission(submission, fixture);
  return saveFixtureResult(payload, { req });
}

function userInFixture(user, fixture) {
  if (!user || !fixture) return false;
  const uid = String(user._id);
  if (fixture.team1UserId && String(fixture.team1UserId) === uid) return true;
  if (fixture.team2UserId && String(fixture.team2UserId) === uid) return true;
  const team = user.teamName || '';
  if (!team) return false;
  const mine = normalizeTeamKey(team);
  return (
    mine === normalizeTeamKey(fixture.team1 || '') ||
    mine === normalizeTeamKey(fixture.team2 || '')
  );
}

function isOpponent(user, submission, fixture) {
  if (!user || !submission || !fixture) return false;
  if (String(submission.submittedBy) === String(user._id)) return false;
  return userInFixture(user, fixture);
}

async function getDecisionAccess(user, submission) {
  if (!user || !submission) return { allowed: false };
  if (user.isAdmin) return { allowed: true, role: 'admin' };
  const fixture = await Fixture.findById(submission.fixtureId).lean();
  if (!fixture) return { allowed: false };
  if (isOpponent(user, submission, fixture)) return { allowed: true, role: 'opponent' };
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

  const errors = validateSubmissionBody({
    fixtureId: submission.fixtureId,
    ...merged,
  });
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.status = 400;
    throw err;
  }

  Object.assign(submission, merged);
  await applyFixtureSave(submission, req);

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

// POST /api/fixture-submissions/submit
router.post('/submit', requireUser, async (req, res) => {
  try {
    const errors = validateSubmissionBody(req.body);
    if (errors.length) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    const fixture = await Fixture.findById(req.body.fixtureId);
    if (!fixture || !fixture.isActive) {
      return res.status(404).json({ error: 'Fixture not found' });
    }

    const user = req.authUser;
    const isAdmin = !!user.isAdmin;
    const isInFixture =
      fixture.team1 === user.teamName ||
      fixture.team2 === user.teamName ||
      isAdmin;

    if (!isInFixture) {
      return res.status(403).json({
        error: 'You can only submit results for fixtures involving your team.',
      });
    }

    const existingPending = await FixtureSubmission.findOne({
      fixtureId: fixture._id,
      status: 'pending',
    });
    if (existingPending) {
      return res.status(409).json({
        error: 'A pending submission already exists for this fixture. Wait for opponent or admin confirmation.',
        submissionId: existingPending._id,
      });
    }

    const doc = await FixtureSubmission.create(
      buildSubmissionPayload(req.body, fixture, user)
    );

    const populated = await FixtureSubmission.findById(doc._id)
      .populate('submittedBy', 'name teamName')
      .populate('fixtureId', 'team1 team2');

    res.status(201).json({
      message: 'Submitted — waiting for opponent or admin to confirm.',
      submission: populated,
    });
  } catch (err) {
    console.error('Fixture submission error:', err);
    res.status(500).json({ error: err.message || 'Failed to submit' });
  }
});

// GET /api/fixture-submissions/my
router.get('/my', requireUser, async (req, res) => {
  try {
    const list = await FixtureSubmission.find({ submittedBy: req.authUser._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load submissions' });
  }
});

// GET /api/fixture-submissions/pending-by-team?teamName= — for points table match list
router.get('/pending-by-team', async (req, res) => {
  try {
    const teamName = String(req.query.teamName || '').trim();
    if (!teamName) {
      return res.status(400).json({ error: 'teamName query parameter is required' });
    }
    const mine = normalizeTeamKey(teamName);
    const list = await FixtureSubmission.find({ status: 'pending' })
      .select(
        'fixtureId team1 team2 submitterName submitterTeamName winner margin team1Score team2Score createdAt'
      )
      .sort({ createdAt: -1 })
      .lean();

    const filtered = list.filter(
      (s) =>
        mine === normalizeTeamKey(s.team1 || '') || mine === normalizeTeamKey(s.team2 || '')
    );
    res.json(filtered);
  } catch (err) {
    console.error('Pending-by-team error:', err);
    res.status(500).json({ error: 'Failed to load pending submissions' });
  }
});

// GET /api/fixture-submissions/opponent/pending — awaiting confirmation from opposing team
router.get('/opponent/pending', requireUser, async (req, res) => {
  try {
    const user = req.authUser;
    const pending = await FixtureSubmission.find({ status: 'pending' })
      .populate('submittedBy', 'name teamName teamImage')
      .populate('fixtureId', 'team1 team2 team1UserId team2UserId team1Score team2Score winner')
      .sort({ createdAt: -1 })
      .lean();

    const list = pending.filter((item) => {
      const fixture = item.fixtureId;
      if (!fixture || typeof fixture !== 'object') return false;
      return isOpponent(user, item, fixture);
    });

    res.json(list);
  } catch (err) {
    console.error('Opponent pending submissions error:', err);
    res.status(500).json({ error: 'Failed to load confirmations' });
  }
});

// GET /api/fixture-submissions/admin/pending
router.get('/admin/pending', requireAdmin, async (req, res) => {
  try {
    const list = await FixtureSubmission.find({ status: 'pending' })
      .populate('submittedBy', 'name teamName teamImage')
      .populate('fixtureId', 'team1 team2 team1Score team2Score winner')
      .sort({ createdAt: -1 })
      .lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load pending submissions' });
  }
});

// GET /api/fixture-submissions/admin/history
router.get('/admin/history', requireAdmin, async (req, res) => {
  try {
    const list = await FixtureSubmission.find({ status: { $in: ['approved', 'rejected'] } })
      .populate('submittedBy', 'name teamName')
      .populate('adminDecision.decidedBy', 'name teamName')
      .sort({ updatedAt: -1 })
      .limit(100)
      .lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load history' });
  }
});

// POST /api/fixture-submissions/:id/approve — admin or opposing team
router.post('/:id/approve', requireUser, async (req, res) => {
  try {
    const submission = await FixtureSubmission.findById(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.status !== 'pending') {
      return res.status(400).json({ error: 'Submission is no longer pending' });
    }

    const allowOverrides = !!req.authUser.isAdmin;
    const overrides = allowOverrides ? req.body || {} : {};
    const updated = await processApproval(submission, req, overrides, allowOverrides);

    res.json({
      message: 'Fixture confirmed and points table updated.',
      submission: updated,
    });
  } catch (err) {
    console.error('Approve fixture submission error:', err);
    const status = err.status || 500;
    const msg =
      err.response?.data?.error ||
      err.response?.data?.message ||
      err.message ||
      'Approval failed';
    res.status(status).json({ error: msg });
  }
});

// POST /api/fixture-submissions/:id/reject — admin or opposing team
router.post('/:id/reject', requireUser, async (req, res) => {
  try {
    const submission = await FixtureSubmission.findById(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.status !== 'pending') {
      return res.status(400).json({ error: 'Submission is no longer pending' });
    }

    const updated = await processRejection(submission, req, req.body?.note || '');

    res.json({ message: 'Submission rejected.', submission: updated });
  } catch (err) {
    console.error('Reject fixture submission error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Rejection failed' });
  }
});

  return submission;
}

function applyPendingSubmissionFields(submission, body) {
  if (body.winner !== undefined) submission.winner = body.winner;
  if (body.margin !== undefined) submission.margin = String(body.margin || '').trim();
  if (body.team1Score !== undefined) submission.team1Score = String(body.team1Score || '').trim();
  if (body.team2Score !== undefined) submission.team2Score = String(body.team2Score || '').trim();
  if (body.team1Overs !== undefined) submission.team1Overs = String(body.team1Overs || '').trim();
  if (body.team2Overs !== undefined) submission.team2Overs = String(body.team2Overs || '').trim();
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

// POST /api/fixture-submissions/admin/:id/update — save edits only, stays pending
router.post('/admin/:id/update', requireAdmin, async (req, res) => {
  try {
    const submission = await FixtureSubmission.findById(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.status !== 'pending') {
      return res.status(400).json({ error: 'Submission is no longer pending' });
    }

    const body = req.body || {};
    const merged = {
      fixtureId: submission.fixtureId,
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

    const errors = validateSubmissionBody(merged);
    if (errors.length) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    applyPendingSubmissionFields(submission, merged);
    await submission.save();

    res.json({
      message: 'Submission updated. Still pending until you approve.',
      submission,
    });
  } catch (err) {
    console.error('Update fixture submission error:', err);
    res.status(500).json({ error: err.message || 'Update failed' });
  }
});

// POST /api/fixture-submissions/admin/:id/approve
router.post('/admin/:id/approve', requireAdmin, async (req, res) => {
  try {
    const submission = await FixtureSubmission.findById(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.status !== 'pending') {
      return res.status(400).json({ error: 'Submission is no longer pending' });
    }

    const updated = await processApproval(submission, req, req.body || {}, true);

    res.json({
      message: 'Fixture approved and points table updated.',
      submission: updated,
    });
  } catch (err) {
    console.error('Approve fixture submission error:', err);
    const status = err.status || 500;
    const msg =
      err.response?.data?.error ||
      err.response?.data?.message ||
      err.message ||
      'Approval failed';
    res.status(status).json({ error: msg });
  }
});

// POST /api/fixture-submissions/admin/:id/reject
router.post('/admin/:id/reject', requireAdmin, async (req, res) => {
  try {
    const submission = await FixtureSubmission.findById(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Submission not found' });
    if (submission.status !== 'pending') {
      return res.status(400).json({ error: 'Submission is no longer pending' });
    }

    const updated = await processRejection(submission, req, req.body?.note || '');

    res.json({ message: 'Submission rejected.', submission: updated });
  } catch (err) {
    console.error('Reject fixture submission error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Rejection failed' });
  }
});

module.exports = router;
