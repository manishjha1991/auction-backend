const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const requireAdmin = require('../middleware/requireAdmin');
const authenticateJWT = require('../middleware/authJWT');
const userRoutes = require('../routes/user');
const fixtureRoutes = require('../routes/fixture');
const playoffFixtureRoutes = require('../routes/playoffFixtures');

function getRouteStack(router, method, path) {
  const layer = router.stack.find(
    (item) => item.route?.path === path && item.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} must exist`);
  return layer.route.stack;
}

function assertAdminGuarded(router, method, path) {
  const stack = getRouteStack(router, method, path);
  assert.equal(stack[0].handle.name, 'authenticateJWT');
  assert.equal(stack[1].handle.name, 'requireAdmin');
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

const guardedMutations = [
  [userRoutes, 'put', '/update-points/:userId'],
  [userRoutes, 'put', '/update-fairness/:userId'],
  [userRoutes, 'post', '/:userId/group'],
  [fixtureRoutes, 'post', '/save'],
  [playoffFixtureRoutes, 'post', '/initialize'],
  [playoffFixtureRoutes, 'post', '/update/:matchId'],
  [playoffFixtureRoutes, 'post', '/test-update/:matchId'],
];

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

test('standings, fixture save, and playoff mutations require JWT admin middleware', () => {
  for (const [router, method, path] of guardedMutations) {
    assertAdminGuarded(router, method, path);
  }
});

test('unauthenticated callers cannot reach standings or fixture mutations', async () => {
  for (const [router, method, path] of [
    [userRoutes, 'put', '/update-points/:userId'],
    [userRoutes, 'put', '/update-fairness/:userId'],
    [userRoutes, 'post', '/:userId/group'],
    [fixtureRoutes, 'post', '/save'],
    [playoffFixtureRoutes, 'post', '/initialize'],
  ]) {
    const stack = getRouteStack(router, method, path);
    const authHandler = stack[0].handle;
    const result = await invoke(authHandler, {
      headers: { 'user-id': '507f1f77bcf86cd799439011' },
      body: {
        points: 100,
        adminUserId: '507f1f77bcf86cd799439011',
        userId: '507f1f77bcf86cd799439011',
        group: 'A',
      },
      query: {},
      params: { userId: '507f1f77bcf86cd799439012' },
    });
    assert.equal(result.calledNext, false);
    assert.equal(result.statusCode, 401);
  }
});

test('forged JWT without matching server session cannot authorize update-points', async () => {
  const stack = getRouteStack(userRoutes, 'put', '/update-points/:userId');
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
      body: { points: 100 },
      query: {},
      params: { userId: '507f1f77bcf86cd799439012' },
    });
    assert.equal(result.calledNext, false);
    assert.equal(result.statusCode, 403);
    assert.match(result.responseBody.message, /session/i);
  } finally {
    require('../models/User').findById = originalFindById;
  }
});

test('authenticateJWT rejects forged tokens without a matching server session', async () => {
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
    assert.match(result.responseBody.message, /session/i);
  } finally {
    require('../models/User').findById = originalFindById;
  }
});

test('spoofed body adminUserId alone cannot pass group route auth', async () => {
  const stack = getRouteStack(userRoutes, 'post', '/:userId/group');
  const authHandler = stack[0].handle;
  const result = await invoke(authHandler, {
    headers: {},
    body: { group: 'A', adminUserId: '507f1f77bcf86cd799439011' },
    query: {},
    params: { userId: '507f1f77bcf86cd799439012' },
  });
  assert.equal(result.calledNext, false);
  assert.equal(result.statusCode, 401);
});
