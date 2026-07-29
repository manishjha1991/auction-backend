const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const requireAdmin = require('../middleware/requireAdmin');
const authenticateJWT = require('../middleware/authJWT');
const matchResultsRoutes = require('../routes/matchResults');
const tournamentRoutes = require('../routes/tournaments');
const settingsRoutes = require('../routes/settings');
const adminToolsRoutes = require('../routes/adminTools');

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

test('authenticateJWT rejects forged tokens without a matching server session', async () => {
  const forged = jwt.sign(
    { id: '507f1f77bcf86cd799439011' },
    process.env.JWT_SECRET || 'your-secret-key',
    { expiresIn: '1d' }
  );

  const originalFindById = require('../models/User').findById;
  // Avoid DB: if verify fails first we're fine; if it reaches User lookup, stub it.
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

test('match-results admin mutations require JWT admin middleware', () => {
  assertAdminGuarded(matchResultsRoutes, 'get', '/');
  assertAdminGuarded(matchResultsRoutes, 'post', '/');
  assertAdminGuarded(matchResultsRoutes, 'put', '/:id');
  assertAdminGuarded(matchResultsRoutes, 'delete', '/:id');
  assertAdminGuarded(matchResultsRoutes, 'get', '/stats/summary');
});

test('tournament admin mutations require JWT admin middleware', () => {
  assertAdminGuarded(tournamentRoutes, 'post', '/');
  assertAdminGuarded(tournamentRoutes, 'put', '/:id');
  assertAdminGuarded(tournamentRoutes, 'delete', '/:id');
  assertAdminGuarded(tournamentRoutes, 'post', '/:id/generate-fixtures');
  assertAdminGuarded(tournamentRoutes, 'post', '/:id/reset-winner');
  assertAdminGuarded(tournamentRoutes, 'post', '/world-cup/initialize');
});

test('settings updates require JWT admin middleware', () => {
  assertAdminGuarded(settingsRoutes, 'post', '/');
});

test('admin-tools router requires JWT admin except public DLS calculator', async () => {
  const authLayer = adminToolsRoutes.stack.find(
    (layer) => !layer.route && typeof layer.handle === 'function'
  );
  assert.ok(authLayer, 'router-level admin auth middleware must exist');

  const unauthenticated = await invoke(authLayer.handle, {
    method: 'POST',
    path: '/auction/reset',
    headers: {},
    body: { adminUserId: 'spoofed-admin' },
    query: {},
  });
  assert.equal(unauthenticated.calledNext, false);
  assert.equal(unauthenticated.statusCode, 401);

  const publicCalc = await invoke(authLayer.handle, {
    method: 'POST',
    path: '/target/calculate',
    headers: {},
    body: {},
    query: {},
  });
  assert.equal(publicCalc.calledNext, true);
});
