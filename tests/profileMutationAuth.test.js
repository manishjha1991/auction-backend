const test = require('node:test');
const assert = require('node:assert/strict');

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const authenticateJWT = require('../middleware/authJWT');
const userRoutes = require('../routes/user');

function getRouteHandler(router, method, path, index = 0) {
  const layer = router.stack.find(
    (item) => item.route?.path === path && item.route.methods[method]
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} must exist`);
  return layer.route.stack[index].handle;
}

async function assertRejectsSpoofedIdentity(handler, body) {
  const req = {
    headers: {},
    body,
    query: {},
  };
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

  assert.equal(calledNext, false);
  assert.equal(statusCode, 401);
  assert.match(responseBody.message, /authentication required/i);
}

for (const path of ['/:userId/captain', '/:userId/squad-theme']) {
  test(`${path} rejects a spoofed requester without a JWT`, async () => {
    const authenticate = getRouteHandler(userRoutes, 'put', path);

    assert.equal(authenticate.name, 'authenticateJWT');
    await assertRejectsSpoofedIdentity(authenticate, {
      requesterUserId: 'spoofed-owner-id',
    });
  });
}

async function invokeAuthentication(decodedToken, activeSessionId) {
  const originalVerify = jwt.verify;
  const originalFindById = User.findById;
  jwt.verify = () => decodedToken;
  User.findById = () => ({
    includeInactive: async () => ({
      _id: decodedToken.id,
      activeSessionId,
    }),
  });

  const req = {
    headers: { authorization: 'Bearer forged-token' },
    body: {},
    query: {},
  };
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

  try {
    await authenticateJWT(req, res, () => {
      calledNext = true;
    });
  } finally {
    jwt.verify = originalVerify;
    User.findById = originalFindById;
  }

  return { req, statusCode, responseBody, calledNext };
}

test('a signed token without a server-bound session cannot authenticate', async () => {
  const result = await invokeAuthentication(
    { id: 'victim-user-id' },
    'victim-active-session'
  );

  assert.equal(result.calledNext, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.responseBody.requiresReauth, true);
});

test('authentication accepts only the matching active session', async () => {
  const result = await invokeAuthentication(
    { id: 'owner-user-id', sessionId: 'owner-active-session' },
    'owner-active-session'
  );

  assert.equal(result.calledNext, true);
  assert.equal(String(result.req.userId), 'owner-user-id');
});
