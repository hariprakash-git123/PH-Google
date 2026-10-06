/**
 * Consistent API envelope used by every endpoint.
 *
 *   success -> { success: true,  data: {...} }
 *   failure -> { success: false, message: "...", errors?: [...] }
 */

function sendSuccess(res, data = null, status = 200, extra = {}) {
  return res.status(status).json({ success: true, data, ...extra });
}

function sendError(res, message, status = 400, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

/**
 * Application error carrying an HTTP status code.
 * Thrown from controllers/services; translated by the central error handler.
 */
class ApiError extends Error {
  constructor(message, statusCode = 400, details) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.isOperational = true;
    if (details) this.details = details;
  }

  static badRequest(msg, details) {
    return new ApiError(msg, 400, details);
  }
  static unauthorized(msg = 'Not authorized.') {
    return new ApiError(msg, 401);
  }
  static forbidden(msg = 'Access denied.') {
    return new ApiError(msg, 403);
  }
  static notFound(msg = 'Resource not found.') {
    return new ApiError(msg, 404);
  }
  static conflict(msg) {
    return new ApiError(msg, 409);
  }
  static tooMany(msg = 'Too many requests.') {
    return new ApiError(msg, 429);
  }
  /** A dependency this request needs is down — Redis, OpenSearch, MongoDB. */
  static serviceUnavailable(msg = 'Service temporarily unavailable.', details) {
    return new ApiError(msg, 503, details);
  }
}

/** Wraps an async route handler so rejected promises reach the error middleware. */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { sendSuccess, sendError, ApiError, asyncHandler };
