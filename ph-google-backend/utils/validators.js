const { config } = require('../config/env');
const { ApiError } = require('./apiResponse');

/**
 * Small hand-rolled validation helpers.
 * Each parser returns a clean, typed value or throws ApiError(400) with a
 * message that is useful to the caller (never an internal stack trace).
 */

const SORT_OPTIONS = ['relevance', 'newest', 'oldest'];
const DATE_OPTIONS = ['any', 'hour', 'day', 'week', 'month', 'year'];
const CATEGORY_OPTIONS = ['all', 'images', 'news', 'videos', 'maps'];

/** Strips control characters that have no business in a query string. */
function sanitizeString(value, maxLength = 500) {
  if (value === undefined || value === null) return '';
  return (
    String(value)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .trim()
      .slice(0, maxLength)
  );
}

function parseSearchQuery(raw) {
  const q = sanitizeString(raw, config.search.maxQueryLength + 1);
  if (q.length > config.search.maxQueryLength) {
    throw ApiError.badRequest(
      `Search query must be ${config.search.maxQueryLength} characters or fewer.`
    );
  }
  return q;
}

/**
 * The last page of search results that can be asked for at a page size.
 *
 * Two limits apply: the configured maximum page, and the result window —
 * only the first `maxResultWindow` results of a search can be paged through,
 * so 50 per page ends at page 200, not 500.
 */
function maxPageFor(limit) {
  const withinWindow = Math.floor(config.search.maxResultWindow / limit);
  return Math.max(1, Math.min(config.search.maxPage, withinWindow));
}

/**
 * @param {*} raw
 * @param {Object} [options]
 * @param {number} [options.limit] the page size of a search request; when
 *        given, the page is also held to the result window
 */
function parsePage(raw, { limit } = {}) {
  if (raw === undefined || raw === '') return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw ApiError.badRequest('Invalid "page" parameter: must be an integer of 1 or greater.');
  }
  const max = limit ? maxPageFor(limit) : config.search.maxPage;
  if (n > max) {
    const window = config.search.maxResultWindow.toLocaleString('en-US');
    throw ApiError.badRequest(
      max < config.search.maxPage
        ? `Invalid "page" parameter: maximum is ${max} for a limit of ${limit}. ` +
            `Only the first ${window} results can be paged through.`
        : `Invalid "page" parameter: maximum is ${max}.`
    );
  }
  return n;
}

function parseLimit(raw, { def = config.search.defaultLimit, max = config.search.maxLimit } = {}) {
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw ApiError.badRequest('Invalid "limit" parameter: must be an integer of 1 or greater.');
  }
  if (n > max) {
    throw ApiError.badRequest(`Invalid "limit" parameter: maximum is ${max}.`);
  }
  return n;
}

function parseEnum(raw, allowed, fallback, name) {
  if (raw === undefined || raw === '') return fallback;
  const value = String(raw).trim().toLowerCase();
  if (!allowed.includes(value)) {
    throw ApiError.badRequest(
      `Invalid "${name}" parameter. Allowed values: ${allowed.join(', ')}.`
    );
  }
  return value;
}

const DOMAIN_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** Accepts "example.com" or a full URL, and returns the bare hostname. */
function parseDomain(raw) {
  if (raw === undefined || raw === '') return '';
  let value = sanitizeString(raw, 255).toLowerCase();
  if (!value) return '';

  if (value.includes('://')) {
    try {
      value = new URL(value).hostname;
    } catch {
      throw ApiError.badRequest('Invalid "domain" parameter: not a valid domain or URL.');
    }
  }
  value = value
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '');

  if (!DOMAIN_PATTERN.test(value)) {
    throw ApiError.badRequest('Invalid "domain" parameter: expected something like "example.com".');
  }
  return value;
}

/** Normalises a language input to a 2-letter code (e.g. "en-GB" -> "en"). */
function parseLanguage(raw) {
  if (raw === undefined || raw === '') return '';
  const value = sanitizeString(raw, 20).toLowerCase();
  if (!value || value === 'any') return '';
  const code = value.split(/[-_]/)[0];
  if (!/^[a-z]{2,3}$/.test(code)) {
    throw ApiError.badRequest(
      'Invalid "language" parameter: expected a language code such as "en".'
    );
  }
  return code;
}

/** Turns a relative date window into a cutoff Date (null = no filter). */
function dateWindowToCutoff(window) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  switch (window) {
    case 'hour':
      return new Date(now - hour);
    case 'day':
      return new Date(now - 24 * hour);
    case 'week':
      return new Date(now - 7 * 24 * hour);
    case 'month':
      return new Date(now - 30 * 24 * hour);
    case 'year':
      return new Date(now - 365 * 24 * hour);
    default:
      return null;
  }
}

/** Validates a crawl seed URL: http/https only, hostname required, no localhost/IP targets. */
function parseSeedUrl(raw) {
  const value = sanitizeString(raw, 2048);
  if (!value) throw ApiError.badRequest('"seedUrl" is required.');

  let url;
  try {
    url = new URL(value);
  } catch {
    throw ApiError.badRequest('Invalid "seedUrl": must be an absolute http(s) URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw ApiError.badRequest('Invalid "seedUrl": only http and https are supported.');
  }
  if (!url.hostname) {
    throw ApiError.badRequest('Invalid "seedUrl": missing hostname.');
  }

  // Block crawling the machine the server runs on / private networks (SSRF guard).
  const host = url.hostname.toLowerCase();
  const isBlockedHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (isBlockedHost && !config.isTest) {
    throw ApiError.badRequest(
      'Invalid "seedUrl": localhost and private network addresses cannot be crawled.'
    );
  }

  return url.toString();
}

function parseEmail(raw) {
  const value = sanitizeString(raw, 254).toLowerCase();
  if (!value) throw ApiError.badRequest('Email is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
    throw ApiError.badRequest('Please provide a valid email address.');
  }
  return value;
}

function parsePassword(raw) {
  const value = typeof raw === 'string' ? raw : '';
  if (!value) throw ApiError.badRequest('Password is required.');
  if (value.length < 6) throw ApiError.badRequest('Password must be at least 6 characters.');
  if (value.length > 128) throw ApiError.badRequest('Password must be 128 characters or fewer.');
  return value;
}

function parseName(raw) {
  const value = sanitizeString(raw, 80);
  if (!value) throw ApiError.badRequest('Name is required.');
  if (value.length < 2) throw ApiError.badRequest('Name must be at least 2 characters.');
  return value;
}

/** Guards against passing an arbitrary string to Mongo as an ObjectId. */
function isValidObjectId(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);
}

function parseObjectId(raw, name = 'id') {
  if (!isValidObjectId(raw)) {
    throw ApiError.badRequest(`Invalid "${name}": expected a 24-character identifier.`);
  }
  return raw;
}

module.exports = {
  SORT_OPTIONS,
  DATE_OPTIONS,
  CATEGORY_OPTIONS,
  sanitizeString,
  parseSearchQuery,
  maxPageFor,
  parsePage,
  parseLimit,
  parseEnum,
  parseDomain,
  parseLanguage,
  dateWindowToCutoff,
  parseSeedUrl,
  parseEmail,
  parsePassword,
  parseName,
  isValidObjectId,
  parseObjectId
};
