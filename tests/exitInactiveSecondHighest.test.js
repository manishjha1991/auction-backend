const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bidRoutesSrc = fs.readFileSync(
  path.join(__dirname, '..', 'routes', 'bidRoutes.js'),
  'utf8'
);

test('exitSecondHighestForPlayerSingle loads second bidder with includeInactive', () => {
  const fnStart = bidRoutesSrc.indexOf('async function exitSecondHighestForPlayerSingle');
  const fnEnd = bidRoutesSrc.indexOf('router.post("/:playerId/exit-second-highest"');
  assert.ok(fnStart >= 0 && fnEnd > fnStart);
  const fn = bidRoutesSrc.slice(fnStart, fnEnd);

  assert.match(
    fn,
    /User\.findById\(secondHighestBid\.bidder\)\.includeInactive\(\)/,
    'deactivated second-highest must be loadable for refund'
  );
  assert.match(
    fn,
    /if \(secondHighestBidder\) \{[\s\S]*?\}\s*\/\/ Always deactivate the Bid/
  );
  assert.match(fn, /player\.lastExitAt\s*=\s*new Date\(\)/);
});

test('admin HTTP exit second-highest uses includeInactive and always clears Bid', () => {
  const exitHandlerStart = bidRoutesSrc.indexOf('router.post("/:playerId/exit"');
  const exitHandlerEnd = bidRoutesSrc.indexOf('router.post("/bid/sold"');
  assert.ok(exitHandlerStart >= 0 && exitHandlerEnd > exitHandlerStart);
  const exitHandler = bidRoutesSrc.slice(exitHandlerStart, exitHandlerEnd);

  const adminBranchEnd = exitHandler.indexOf('// Check if the user has placed a bid');
  assert.ok(adminBranchEnd > 0);
  const adminBranch = exitHandler.slice(0, adminBranchEnd);

  assert.match(
    adminBranch,
    /User\.findById\(secondHighestBid\.bidder\)\.includeInactive\(\)/
  );
  assert.match(adminBranch, /bidEntry\?\.amount/);
  assert.match(
    adminBranch,
    /if \(secondHighestBidder\) \{[\s\S]*?\}\s*\/\/ Always clear the Bid row/
  );
  assert.match(adminBranch, /player\.lastExitAt\s*=\s*new Date\(\)/);
  assert.match(adminBranch, /player\.lastExitBy\s*=\s*'system'/);
});
