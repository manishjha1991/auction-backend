const User = require('../models/User');
const AppSettings = require('../models/AppSettings');

async function getTradeApprovalSettings() {
  const doc = await AppSettings.findOne()
    .select('tradeApprovalMode enableTradeBundles')
    .lean();
  return {
    tradeApprovalMode: doc?.tradeApprovalMode || 'any_admin',
    enableTradeBundles: doc?.enableTradeBundles !== false,
  };
}

async function assertCanApproveTrades(adminUserId) {
  if (!adminUserId) {
    const err = new Error('adminUserId required');
    err.statusCode = 400;
    throw err;
  }
  const admin = await User.findById(adminUserId).select('isAdmin isCommissioner name').lean();
  if (!admin?.isAdmin) {
    const err = new Error('Only admin can perform this action');
    err.statusCode = 403;
    throw err;
  }
  const { tradeApprovalMode } = await getTradeApprovalSettings();
  if (tradeApprovalMode === 'commissioner_only' && !admin.isCommissioner) {
    const err = new Error(
      'Only the league commissioner can approve standalone trades. Multi-leg bundles auto-approve when all legs are valid.'
    );
    err.statusCode = 403;
    throw err;
  }
  return admin;
}

module.exports = {
  getTradeApprovalSettings,
  assertCanApproveTrades,
};
