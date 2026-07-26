/**
 * Guards admin decide endpoints so terminal requests cannot be decided again.
 * Prevents double-approve roster/purse corruption and tradesUsed inflation.
 */

const TRADE_DECIDABLE_STATUSES = Object.freeze(['admin_pending']);
const RELEASE_DECIDABLE_STATUSES = Object.freeze(['pending', 'admin_pending']);
const PICK_DECIDABLE_STATUSES = Object.freeze(['pending', 'admin_pending']);

function isAdminDecidableStatus(status, allowedStatuses) {
  return Array.isArray(allowedStatuses) && allowedStatuses.includes(status);
}

function undecidableAdminMessage(kind, status) {
  return `Cannot decide ${kind} with status '${status}'`;
}

/**
 * Atomically transition a decidable request to a terminal status.
 * Returns the pre-update document, or null if missing / already decided.
 */
async function claimAdminDecision(Model, id, allowedStatuses, { terminalStatus, adminDecision, extraSet }) {
  const $set = {
    status: terminalStatus,
    adminDecision,
    ...(extraSet || {}),
  };
  return Model.findOneAndUpdate(
    { _id: id, status: { $in: allowedStatuses } },
    { $set },
    { new: false }
  );
}

/**
 * Restore status/adminDecision (and optional extra keys) after a failed
 * claim-side-effect sequence.
 */
async function rollbackAdminDecisionClaim(Model, previousDoc, extraKeys = []) {
  if (!previousDoc?._id) return;
  const $set = {
    status: previousDoc.status,
    adminDecision: previousDoc.adminDecision,
  };
  const $unset = {};
  for (const key of extraKeys) {
    if (previousDoc[key] == null) {
      $unset[key] = 1;
    } else {
      $set[key] = previousDoc[key];
    }
  }
  const update = { $set };
  if (Object.keys($unset).length) update.$unset = $unset;
  await Model.findByIdAndUpdate(previousDoc._id, update);
}

module.exports = {
  TRADE_DECIDABLE_STATUSES,
  RELEASE_DECIDABLE_STATUSES,
  PICK_DECIDABLE_STATUSES,
  isAdminDecidableStatus,
  undecidableAdminMessage,
  claimAdminDecision,
  rollbackAdminDecisionClaim,
};
