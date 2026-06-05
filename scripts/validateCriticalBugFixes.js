const assert = require('assert');
const fs = require('fs');
const path = require('path');

const playersRouter = require('../routes/players');

const restoredPortraits = [
  'Adam_Rossington.jpg',
  'Alzari_Joseph.jpg',
  'Ben_Cutting.jpg',
  'Chris_Woakes.jpg',
  'Chris_Wood.jpg',
  'David_Willey.jpg',
  'Jack_Wood.jpg',
  'Jofra_Archer.jpg',
  'Kane_Williamson.jpg',
  'Liam_Livingstone.jpg',
  'Mohd_Hasnain.jpg',
  'Nathan_Mcandrew.jpg',
  'Oliver_Davies.jpg',
  'Tom_Andrews.jpg',
  'Will_Prestwidge.jpg',
  'Yasir_Shah.png',
];

function findRoute(method, routePath) {
  return playersRouter.stack.find(
    (layer) =>
      layer.route &&
      layer.route.path === routePath &&
      layer.route.methods[method.toLowerCase()]
  )?.route;
}

function handlerNames(method, routePath) {
  const route = findRoute(method, routePath);
  assert(route, `Expected ${method} ${routePath} to be registered`);
  return route.stack.map((layer) => layer.handle.name);
}

async function assertRejectsSpoofedProfileUpload() {
  const route = findRoute('POST', '/:playerId/admin/profile-picture');
  const authenticateJWT = route.stack[0].handle;
  let statusCode;
  let responseBody;

  await authenticateJWT(
    {
      headers: {},
      body: { adminUserId: '000000000000000000000000' },
      query: {},
    },
    {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    },
    () => {
      throw new Error('Unauthenticated spoofed upload should not reach the next handler');
    }
  );

  assert.strictEqual(statusCode, 401);
  assert.match(responseBody.message, /Authentication required/);
}

async function main() {
  for (const fileName of restoredPortraits) {
    const absolutePath = path.join(__dirname, '..', 'cricket-player-portraits', fileName);
    const stats = fs.statSync(absolutePath);
    assert(stats.size > 0, `${fileName} should be restored as a non-empty file`);
  }

  assert(handlerNames('POST', '/player').includes('authenticateJWT'));
  assert(handlerNames('POST', '/player').includes('requireAdmin'));
  assert(handlerNames('PUT', '/player/:playerID').includes('authenticateJWT'));
  assert(handlerNames('PUT', '/player/:playerID').includes('requireAdmin'));
  assert(handlerNames('DELETE', '/player/:playerID').includes('authenticateJWT'));
  assert(handlerNames('DELETE', '/player/:playerID').includes('requireAdmin'));
  assert(handlerNames('POST', '/:playerId/deactivate').includes('authenticateJWT'));
  assert(handlerNames('POST', '/:playerId/deactivate').includes('requireAdmin'));

  const profileUploadHandlers = handlerNames('POST', '/:playerId/admin/profile-picture');
  assert.strictEqual(profileUploadHandlers[0], 'authenticateJWT');
  assert(!profileUploadHandlers.includes('requireAdmin'));
  await assertRejectsSpoofedProfileUpload();

  console.log('Critical bug fix validations passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
