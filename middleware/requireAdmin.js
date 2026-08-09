/**
 * Requires authenticateJWT to have run first.
 * Blocks non-admin callers from admin-only mutation routes.
 */
function requireAdmin(req, res, next) {
  if (!req.authenticatedUser) {
    return res.status(401).json({ message: 'Authentication required.' });
  }
  if (!req.authenticatedUser.isAdmin) {
    return res.status(403).json({ message: 'Admin access required.' });
  }
  next();
}

module.exports = requireAdmin;
