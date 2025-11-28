function extractForwardedIp(headerValue = '') {
  if (!headerValue) return null;
  const first = headerValue.split(',')[0].trim();
  return first || null;
}

function sanitizeIp(ip) {
  if (!ip) return null;
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

function getClientIp(req) {
  const forwarded = extractForwardedIp(req.get('x-forwarded-for'));
  const realIp = forwarded || req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress;
  return sanitizeIp(realIp) || '0.0.0.0';
}

function isLocalIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.');
}

module.exports = { getClientIp, isLocalIp };

