const test = require('node:test');
const assert = require('node:assert/strict');

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
