const rateLimit = require('express-rate-limit');
const { config } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Rate limiters for the public surface.
 *
 * Limits are configurable via env and disabled entirely under NODE_ENV=test
 * (or DISABLE_RATE_LIMIT=true) so development and the test suite are never
 * throttled.
 */

const passthrough = (req, res, next) => next();

function build({ windowMs, max, message, name }) {
  if (config.rateLimit.disabled) return passthrough;

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Keep the error shape identical to every other API failure.
    handler: (req, res) => {
      logger.warn('Rate limit exceeded', { limiter: name, path: req.originalUrl });
      res.status(429).json({ success: false, message });
    }
  });
}

const authLimiter = build({
  name: 'auth',
  windowMs: config.rateLimit.authWindowMs,
  max: config.rateLimit.authMax,
  message: 'Too many authentication attempts. Please try again later.'
});

const searchLimiter = build({
  name: 'search',
  windowMs: config.rateLimit.searchWindowMs,
  max: config.rateLimit.searchMax,
  message: 'Too many search requests. Please slow down.'
});

const crawlerLimiter = build({
  name: 'crawler',
  windowMs: config.rateLimit.crawlerWindowMs,
  max: config.rateLimit.crawlerMax,
  message: 'Too many crawler control requests. Please slow down.'
});

const aiLimiter = build({
  name: 'ai',
  windowMs: config.rateLimit.aiWindowMs,
  max: config.rateLimit.aiMax,
  message: 'Too many AI answer requests. Please slow down.'
});

const imageLimiter = build({
  name: 'image',
  windowMs: config.rateLimit.imageWindowMs,
  max: config.rateLimit.imageMax,
  message: 'Too many image downloads. Please slow down.'
});

module.exports = { authLimiter, searchLimiter, crawlerLimiter, aiLimiter, imageLimiter };
