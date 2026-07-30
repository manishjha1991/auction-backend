const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const requireAdmin = require('../middleware/requireAdmin');
const authenticateJWT = require('../middleware/authJWT');
const adminRosterOpsRoutes = require('../routes/adminRosterOps');

function getRouteStack(router, method, path) {
  const layer = router.stack.find(
    (item) => item.route?.path === path && item.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} must exist`);
  return layer.route.stack;
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

test('admin roster router requires JWT admin for all routes', async () => {
  const authLayers = adminRosterOpsRoutes.stack.filter(
    (layer) => !layer.route && typeof layer.handle === 'function'
  );
  assert.ok(authLayers.length >= 2, 'router-level authenticateJWT + requireAdmin required');

  // Express mounts authenticateJWT then requireAdmin as separate router.use layers.
  const unauthenticated = await invoke(authLayers[0].handle, {
    method: 'POST',
    path: '/trade/execute',
    headers: {},
    body: { adminUserId: 'spoofed-admin', player1Id: 'p1', player2Id: 'p2' },
    query: {},
  });
  assert.equal(unauthenticated.calledNext, false);
  assert.equal(unauthenticated.statusCode, 401);

  const mutationPaths = [
    ['post', '/trade/preview'],
    ['post', '/trade/execute'],
    ['post', '/pick/preview'],
    ['post', '/pick/execute'],
    ['post', '/release/preview'],
    ['post', '/release/execute'],
    ['get', '/teams'],
    ['get', '/unsold'],
  ];

  for (const [method, path] of mutationPaths) {
    // Handlers themselves must not re-check spoofable body adminUserId.
    const stack = getRouteStack(adminRosterOpsRoutes, method, path);
    const source = stack.map((layer) => layer.handle.toString()).join('\n');
    assert.equal(
      /await requireAdmin\(/.test(source),
      false,
      `${method.toUpperCase()} ${path} must not trust body/query adminUserId`
    );
  }
});

test('spoofed body adminUserId alone cannot authorize trade execute', async () => {
  const authLayers = adminRosterOpsRoutes.stack.filter(
    (layer) => !layer.route && typeof layer.handle === 'function'
  );
  assert.ok(authLayers[0], 'authenticateJWT router middleware missing');

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
    const result = await invoke(authLayers[0].handle, {
      method: 'POST',
      path: '/trade/execute',
      headers: { authorization: `Bearer ${forged}` },
      body: {
        adminUserId: '507f1f77bcf86cd799439011',
        player1Id: 'p1',
        player2Id: 'p2',
      },
      query: {},
    });
    assert.equal(result.calledNext, false);
    assert.equal(result.statusCode, 403);
  } finally {
    require('../models/User').findById = originalFindById;
  }
});
