const { sendError } = require('../utils/apiResponse');
const { config } = require('../config/env');
const logger = require('../utils/logger');

/** 404 for any route that did not match. */
function notFoundHandler(req, res) {
  return sendError(res, `Route not found: ${req.method} ${req.originalUrl}`, 404);
}

/**
 * Central error handler — the single place that converts any thrown error into
 * the standard { success: false, message } envelope.
 *
 * Stack traces and internal messages are never sent to the client in
 * production; they go to the log instead.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = err.statusCode || err.status || 500;
  let message = err.message || 'Internal server error.';
  let errors;

  // Mongoose schema validation
  if (err.name === 'ValidationError' && err.errors) {
    status = 400;
    errors = Object.values(err.errors).map(e => e.message);
    message = errors[0] || 'Validation failed.';
  }

  // Duplicate key
  if (err.code === 11000) {
    status = 409;
    const field = Object.keys(err.keyPattern || err.keyValue || {})[0];
    message =
      field === 'email'
        ? 'An account with this email already exists.'
        : `Duplicate value for "${field || 'field'}".`;
  }

  // Bad ObjectId reaching Mongoose
  if (err.name === 'CastError') {
    status = 400;
    message = `Invalid value for "${err.path}".`;
  }

  // Malformed JSON body (raised by express.json)
  if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Invalid JSON in request body.';
  }
  if (err.type === 'entity.too.large') {
    status = 413;
    message = 'Request body too large.';
  }

  if (status >= 500) {
    logger.error('Unhandled request error', {
      method: req.method,
      path: req.originalUrl,
      status,
      error: err
    });
    // Never leak internals on a 500.
    if (config.isProduction) message = 'Internal server error.';
  } else {
    logger.debug('Request rejected', {
      method: req.method,
      path: req.originalUrl,
      status,
      message
    });
  }

  const extra = {};
  if (errors) extra.errors = errors;
  if (!config.isProduction && status >= 500) extra.stack = err.stack;

  return sendError(res, message, status, extra);
}

module.exports = { notFoundHandler, errorHandler };
