const { config } = require('../config/env');

/**
 * Minimal structured logger — no dependencies, JSON in production,
 * human-readable in development.
 *
 * Secrets are never logged: values whose key looks sensitive are redacted,
 * and Mongo connection strings have their credentials stripped.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const activeLevel = LEVELS[config.logLevel] !== undefined ? LEVELS[config.logLevel] : LEVELS.info;

const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|mongo_?uri|connection_?string|credential|apikey|api_?key/i;

/** Removes username:password from a URI so it is safe to log. */
function redactUri(value) {
  return String(value).replace(/\/\/[^/@]*@/, '//***:***@');
}

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[deep]';

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(v => sanitize(v, depth + 1));

  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = '[REDACTED]';
      } else if (typeof v === 'string' && /mongodb(\+srv)?:\/\//.test(v)) {
        out[k] = redactUri(v);
      } else {
        out[k] = sanitize(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string' && /mongodb(\+srv)?:\/\//.test(value)) return redactUri(value);
  return value;
}

function write(level, message, meta) {
  if (LEVELS[level] > activeLevel) return;

  const payload = sanitize(meta);
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;

  if (config.isProduction) {
    stream(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg: message,
        ...(payload && typeof payload === 'object'
          ? payload
          : payload !== undefined
            ? { detail: payload }
            : {})
      })
    );
    return;
  }

  const suffix =
    payload === undefined
      ? ''
      : ' ' + (typeof payload === 'object' ? JSON.stringify(payload) : String(payload));
  stream(`[${level.toUpperCase()}] ${message}${suffix}`);
}

module.exports = {
  error: (msg, meta) => write('error', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  debug: (msg, meta) => write('debug', msg, meta),
  redactUri,
  sanitize
};
