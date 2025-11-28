const crypto = require('crypto');

/**
 * Generate a device fingerprint from user agent and IP
 * This helps identify if the same device is being used for multiple accounts
 */
function generateDeviceFingerprint(userAgent, ipAddress) {
  const data = `${userAgent || 'unknown'}-${ipAddress || 'unknown'}`;
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
}

module.exports = { generateDeviceFingerprint };

