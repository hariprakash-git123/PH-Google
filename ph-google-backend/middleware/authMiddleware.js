const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { config } = require('../config/env');
const { sendError } = require('../utils/apiResponse');
const logger = require('../utils/logger');

/** Reads a bearer token out of the Authorization header. */
function extractToken(req) {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim() || null;
}

/**
 * Verifies a JWT and loads the matching user.
 * Returns the user document, or throws so callers can decide how to react.
 */
async function resolveUser(token) {
  const decoded = jwt.verify(token, config.jwt.secret);
  const user = await User.findById(decoded.id).select('-password');
  if (!user) {
    const err = new Error('User no longer exists.');
    err.code = 'USER_GONE';
    throw err;
  }
  return user;
}

/**
 * protect — requires a valid JWT. Attaches req.user, otherwise 401.
 */
const protect = async (req, res, next) => {
  const token = extractToken(req);
  if (!token) {
    return sendError(res, 'Not authorized. No token provided.', 401);
  }

  try {
    req.user = await resolveUser(token);
    return next();
  } catch (error) {
    // Distinguish expiry from tampering so the client can react appropriately.
    if (error.name === 'TokenExpiredError') {
      return sendError(res, 'Session expired. Please sign in again.', 401, {
        code: 'TOKEN_EXPIRED'
      });
    }
    if (error.code === 'USER_GONE') {
      return sendError(res, 'Not authorized. User not found.', 401);
    }
    logger.warn('Authentication failed', {
      reason: error.name || 'invalid_token',
      path: req.originalUrl
    });
    return sendError(res, 'Not authorized. Invalid token.', 401);
  }
};

/**
 * optionalAuth — attaches req.user when a valid token is present, but never
 * rejects the request. Used by endpoints that work for guests but personalise
 * for signed-in users (search, suggestions).
 */
const optionalAuth = async (req, res, next) => {
  const token = extractToken(req);
  if (!token) return next();

  try {
    req.user = await resolveUser(token);
  } catch {
    // An invalid token on an optional route is simply treated as a guest.
    req.user = undefined;
  }
  return next();
};

/**
 * adminOnly — must run after protect. Requires the 'admin' role.
 */
const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === 'admin') return next();
  logger.warn('Admin authorization denied', {
    path: req.originalUrl,
    role: req.user ? req.user.role : 'anonymous'
  });
  return sendError(res, 'Access denied. Admin privileges required.', 403);
};

/**
 * requireRole — generic role gate, e.g. requireRole('admin', 'editor').
 */
const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (req.user && roles.includes(req.user.role)) return next();
    return sendError(res, 'Access denied. Insufficient permissions.', 403);
  };

module.exports = { protect, optionalAuth, adminOnly, requireRole, extractToken };
