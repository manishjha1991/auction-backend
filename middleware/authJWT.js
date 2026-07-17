const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * JWT Authentication Middleware
 * Verifies JWT token and attaches authenticated user to request
 */
const authenticateJWT = async (req, res, next) => {
  try {
    // Get token from Authorization header or request body
    const authHeader = req.headers.authorization;
    let token = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (req.body.token) {
      token = req.body.token;
    } else if (req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ message: 'Authentication required. Please provide a valid token.' });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    
    // Find user and verify session
    const user = await User.findById(decoded.id).includeInactive();
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Bind the token to the server-side login session. A valid signature alone
    // must never be enough to impersonate another user.
    if (!user.activeSessionId || !decoded.sessionId || user.activeSessionId !== decoded.sessionId) {
      return res.status(403).json({ 
        message: 'Session expired or invalid. Please login again.',
        requiresReauth: true 
      });
    }

    // Attach user to request
    req.authenticatedUser = user;
    req.userId = user._id;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid token. Please login again.' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired. Please login again.' });
    }
    console.error('JWT Authentication Error:', error);
    return res.status(500).json({ message: 'Authentication error.' });
  }
};

module.exports = authenticateJWT;

