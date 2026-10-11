const { config } = require('../../config/env');
const { ExternalSearchError } = require('./externalSearchError');

/**
 * Parallel Search API — ranked web URLs with excerpts, as JSON.
 *
 *   POST {baseUrl}/v1/search
 *   x-api-key: <key>
 *   { objective, search_queries, mode, advanced_settings: { max_results, source_policy } }
 *
 * One request, one controlled outcome: the result list, or an
 * ExternalSearchError with one of a fixed set of codes. Nothing here knows
 * about the search page; services/externalSearch.js decides when to call it.
 *
 * The key travels in a header and never leaves this function: it is not
 * logged, and no error carries it, the provider's message or fetch's own
 * error (whose `cause` can describe the request).
 */

/** The modes the API documents. Anything else is refused before sending. */
const MODES = ['turbo', 'fast', 'basic', 'advanced'];

function retryAfterMs(response) {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function timedOut(error) {
  return Boolean(error) && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * One search.
 *
 * @param {Object} request
 * @param {string} [request.objective]       the question in natural language
 * @param {string[]} request.searchQueries   keyword queries; at least one
 * @param {Object} [request.sourcePolicy]    include_domains / exclude_domains / after_date
 * @param {number} [request.maxResults]      defaults to config.parallel.maxResults
 * @param {Object} [options]
 * @param {Object} [options.settings]  overrides config.parallel (tests)
 * @param {Function} [options.fetchImpl]  overrides global fetch (tests)
 * @returns {Promise<{results: Array<Object>}>} the API's raw result list, in its order
 * @throws {ExternalSearchError}
 */
async function search({ objective, searchQueries, sourcePolicy, maxResults }, options = {}) {
  const settings = { ...config.parallel, ...(options.settings || {}) };
  const fetchImpl = options.fetchImpl || fetch;

  if (!settings.apiKey) {
    throw new ExternalSearchError('not_configured', 'Parallel has no API key configured.');
  }
  if (!MODES.includes(settings.mode)) {
    throw new ExternalSearchError('bad_request', 'Unsupported Parallel search mode.');
  }
  const queries = (Array.isArray(searchQueries) ? searchQueries : [])
    .map(q => String(q || '').trim())
    .filter(Boolean);
  if (queries.length === 0) {
    throw new ExternalSearchError('bad_request', 'A Parallel search needs at least one query.');
  }

  const advanced = { max_results: maxResults || settings.maxResults };
  if (sourcePolicy && Object.keys(sourcePolicy).length > 0) advanced.source_policy = sourcePolicy;

  const body = { search_queries: queries, mode: settings.mode, advanced_settings: advanced };
  if (objective && String(objective).trim()) body.objective = String(objective).trim();

  let response;
  try {
    response = await fetchImpl(`${settings.baseUrl}/v1/search`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': settings.apiKey
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(settings.timeoutMs)
    });
  } catch (error) {
    if (timedOut(error)) {
      throw new ExternalSearchError(
        'timeout',
        `Parallel did not answer within ${settings.timeoutMs} ms.`
      );
    }
    throw new ExternalSearchError('network', 'Parallel could not be reached.');
  }

  const { status } = response;
  if (status === 401 || status === 403) {
    throw new ExternalSearchError('auth', 'Parallel rejected the API key.', { status });
  }
  // 402 is not in Parallel's reference. If it ever arrives it means the
  // account cannot pay for the request, so it is handled like a spent quota:
  // the provider is paused rather than asked again on every search.
  if (status === 429 || status === 402) {
    throw new ExternalSearchError('rate_limited', 'Parallel is limiting this key.', {
      status,
      retryAfterMs: retryAfterMs(response)
    });
  }
  if (status >= 500) {
    throw new ExternalSearchError('unavailable', `Parallel answered ${status}.`, { status });
  }
  if (status >= 400) {
    // 422 is the documented validation error. Its body has a message, which
    // is the provider's wording and so is not passed on.
    throw new ExternalSearchError('bad_request', `Parallel rejected the request (${status}).`, {
      status
    });
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    if (timedOut(error)) {
      throw new ExternalSearchError(
        'timeout',
        `Parallel did not answer within ${settings.timeoutMs} ms.`
      );
    }
    throw new ExternalSearchError(
      'invalid_response',
      'Parallel returned a reply that is not JSON.',
      {
        status
      }
    );
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ExternalSearchError('invalid_response', 'Parallel returned an unexpected reply.', {
      status
    });
  }
  if (!Array.isArray(payload.results)) {
    throw new ExternalSearchError('invalid_response', 'Parallel returned malformed results.', {
      status
    });
  }

  return { results: payload.results };
}

module.exports = { search, MODES };
