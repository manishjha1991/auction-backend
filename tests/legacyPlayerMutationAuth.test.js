const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const requireAdmin = require('../middleware/requireAdmin');
const authenticateJWT = require('../middleware/authJWT');
const playerRoutes = require('../routes/players');

function getRouteStack(router, method, path) {
  const layer = router.stack.find(
    (item) => item.route?.path === path && item.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} must exist`);
  return layer.route.stack;
}

function handlerNames(method, path) {
  return getRouteStack(playerRoutes, method, path).map((layer) => layer.handle.name);
}

async function invoke(handler, req) {
  let statusCode = 200;
  let responseBody;
  let calledNext = false;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      responseBody = payload;
      return this;
    },
  };

  await handler(req, res, () => {
    calledNext = true;
  });

  return { statusCode, responseBody, calledNext };
}

test('requireAdmin blocks missing and non-admin users', async () => {
  const missing = await invoke(requireAdmin, {});
  assert.equal(missing.calledNext, false);
  assert.equal(missing.statusCode, 401);

  const nonAdmin = await invoke(requireAdmin, {
    authenticatedUser: { isAdmin: false },
  });
  assert.equal(nonAdmin.calledNext, false);
  assert.equal(nonAdmin.statusCode, 403);

  const admin = await invoke(requireAdmin, {
    authenticatedUser: { isAdmin: true },
  });
  assert.equal(admin.calledNext, true);
  assert.equal(admin.statusCode, 200);
});

test('legacy trade-player and release-player require JWT admin middleware', () => {
  const tradeHandlers = handlerNames('post', '/trade-player');
  assert.ok(tradeHandlers.includes('authenticateJWT'));
  assert.ok(tradeHandlers.includes('requireAdmin'));

  const releaseHandlers = handlerNames('post', '/release-player');
  assert.ok(releaseHandlers.includes('authenticateJWT'));
  assert.ok(releaseHandlers.includes('requireAdmin'));
});

test('unauthenticated callers cannot reach trade-player or release-player handlers', async () => {
  for (const path of ['/trade-player', '/release-player']) {
    const stack = getRouteStack(playerRoutes, 'post', path);
    const authHandler = stack[0].handle;
    const result = await invoke(authHandler, {
      headers: {},
      body: { player1Id: 'p1', player2Id: 'p2', adminUserId: 'spoofed', userId: 'u1', playerId: 'p1' },
      query: {},
    });
    assert.equal(result.calledNext, false);
    assert.equal(result.statusCode, 401);
  }
});

test('forged JWT without matching server session cannot authorize release-player', async () => {
  const stack = getRouteStack(playerRoutes, 'post', '/release-player');
  const authHandler = stack[0].handle;

  const forged = jwt.sign(
    { id: '507f1f77bcf86cd799439011' },
    process.env.JWT_SECRET || 'your-secret-key',
    { expiresIn: '1d' }
  );

  const originalFindById = require('../models/User').findById;
  require('../models/User').findById = () => ({
    includeInactive() {
      return Promise.resolve({
        _id: '507f1f77bcf86cd799439011',
        isAdmin: true,
        activeSessionId: 'real-session',
      });
    },
  });

  try {
    const result = await invoke(authHandler, {
      headers: { authorization: `Bearer ${forged}` },
      body: {
        adminUserId: '507f1f77bcf86cd799439011',
        userId: '507f1f77bcf86cd799439012',
        playerId: '507f1f77bcf86cd799439013',
      },
      query: {},
    });
    assert.equal(result.calledNext, false);
    assert.equal(result.statusCode, 403);
    assert.match(result.responseBody.message, /session/i);
  } finally {
    require('../models/User').findById = originalFindById;
  }
});

test('release-player handler returns player to unsold pool and ignores body adminUserId', () => {
  const stack = getRouteStack(playerRoutes, 'post', '/release-player');
  const handler = stack[stack.length - 1].handle;
  const source = handler.toString();

  assert.match(source, /isSold:\s*false/);
  assert.match(source, /releasedAt:\s*new Date\(\)/);
  assert.match(source, /req\.authenticatedUser\._id/);
  assert.equal(/User\.findById\(adminUserId\)/.test(source), false);
  assert.equal(/const\s*\{\s*adminUserId/.test(source), false);
});

test('authenticateJWT rejects tokens that omit sessionId', async () => {
  const forged = jwt.sign(
    { id: '507f1f77bcf86cd799439011' },
    process.env.JWT_SECRET || 'your-secret-key',
    { expiresIn: '1d' }
  );

  const originalFindById = require('../models/User').findById;
  require('../models/User').findById = () => ({
    includeInactive() {
      return Promise.resolve({
        _id: '507f1f77bcf86cd799439011',
        isAdmin: true,
        activeSessionId: 'real-session',
      });
    },
  });

  try {
    const result = await invoke(authenticateJWT, {
      headers: { authorization: `Bearer ${forged}` },
      body: {},
      query: {},
    });
    assert.equal(result.calledNext, false);
    assert.equal(result.statusCode, 403);
  } finally {
    require('../models/User').findById = originalFindById;
  }
});
