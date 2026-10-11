const { config } = require('../../config/env');
const { ExternalSearchError } = require('./externalSearchError');

/**
 * SerpApi — Google web search results as JSON.
 *
 *   GET {baseUrl}/search?engine=google&q=…&api_key=…
 *
 * One request, one controlled outcome: the organic results, or an
 * ExternalSearchError with one of a fixed set of codes. Nothing here knows
 * about the search page; services/externalSearch.js decides when to call it.
 *
 * The key travels in the URL — that is how SerpApi authenticates — so the
 * URL is built here and never leaves this function: it is not logged, and
 * no error carries it, its message or fetch's own error (whose `cause` can
 * describe the request).
 */

/** SerpApi's way of saying Google found nothing; not a failure. */
const NO_RESULTS = /hasn'?t returned any results/i;

function retryAfterMs(response) {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Classifies an error message SerpApi put in the body of a reply. */
function errorFromBody(message, status) {
  if (/invalid api key|api key.*(missing|invalid)|unauthori[sz]ed/i.test(message)) {
    return new ExternalSearchError('auth', 'SerpApi rejected the API key.', { status });
  }
  if (/run out of searches|plan.*(limit|exceeded)|rate limit|too many requests/i.test(message)) {
    return new ExternalSearchError('rate_limited', 'SerpApi reports the search limit is reached.', {
      status
    });
  }
  return new ExternalSearchError('unavailable', 'SerpApi returned an error.', { status });
}

/**
 * Where each SerpApi engine puts its list of results. Google Maps answers a
 * query naming one specific place with `place_results` (one object) instead.
 */
const RESULT_KEYS = {
  google: 'organic_results',
  google_images: 'images_results',
  google_videos: 'video_results',
  google_maps: 'local_results',
  google_trends_trending_now: 'trending_searches'
};

/** Engines that accept the `location` parameter (Maps takes coordinates instead). */
const LOCATION_ENGINES = new Set(['google', 'google_images', 'google_videos']);

/**
 * One request to a SerpApi engine.
 *
 * @param {Object} request
 * @param {string} [request.engine]  a key of RESULT_KEYS; defaults to config.serpapi.engine
 * @param {string} request.q       the query (already translated)
 * @param {Object} [request.params]  extra engine parameters: lr, tbs, type
 * @param {Object} [options]
 * @param {Object} [options.settings]  overrides config.serpapi (tests)
 * @param {Function} [options.fetchImpl]  overrides global fetch (tests)
 * @returns {Promise<{results: Array<Object>}>} the engine's raw result list
 * @throws {ExternalSearchError}
 */
async function searchEngine({ engine, q, params = {} }, options = {}) {
  const settings = { ...config.serpapi, ...(options.settings || {}) };
  const fetchImpl = options.fetchImpl || fetch;
  const engineName = engine || settings.engine;
  const resultKey = RESULT_KEYS[engineName];

  if (!settings.apiKey) {
    throw new ExternalSearchError('not_configured', 'SerpApi has no API key configured.');
  }
  if (!resultKey) {
    throw new ExternalSearchError('bad_request', 'Unsupported SerpApi engine.');
  }

  const url = new URL(`${settings.baseUrl}/search`);
  const query = {
    engine: engineName,
    q,
    output: 'json',
    hl: settings.hl,
    gl: settings.gl,
    location: LOCATION_ENGINES.has(engineName) ? settings.location : '',
    ...params
  };
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, value);
  }
  url.searchParams.set('api_key', settings.apiKey);

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(settings.timeoutMs)
    });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ExternalSearchError(
        'timeout',
        `SerpApi did not answer within ${settings.timeoutMs} ms.`
      );
    }
    throw new ExternalSearchError('network', 'SerpApi could not be reached.');
  }

  const { status } = response;
  if (status === 401 || status === 403) {
    throw new ExternalSearchError('auth', 'SerpApi rejected the API key.', { status });
  }
  if (status === 429) {
    throw new ExternalSearchError('rate_limited', 'SerpApi is rate limiting this key.', {
      status,
      retryAfterMs: retryAfterMs(response)
    });
  }
  if (status >= 500) {
    throw new ExternalSearchError('unavailable', `SerpApi answered ${status}.`, { status });
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ExternalSearchError(
        'timeout',
        `SerpApi did not answer within ${settings.timeoutMs} ms.`
      );
    }
    throw new ExternalSearchError(
      'invalid_response',
      'SerpApi returned a reply that is not JSON.',
      {
        status
      }
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ExternalSearchError('invalid_response', 'SerpApi returned an unexpected reply.', {
      status
    });
  }

  if (typeof body.error === 'string' && body.error) {
    if (NO_RESULTS.test(body.error)) return { results: [] };
    if (status >= 400 && status < 500 && !/key|limit|searches/i.test(body.error)) {
      throw new ExternalSearchError('bad_request', 'SerpApi rejected the request.', { status });
    }
    throw errorFromBody(body.error, status);
  }
  if (status >= 400) {
    throw new ExternalSearchError('bad_request', `SerpApi answered ${status}.`, { status });
  }

  const list = body[resultKey];
  if (list === undefined) {
    // One named place on Google Maps comes back as a single object.
    if (
      engineName === 'google_maps' &&
      body.place_results &&
      typeof body.place_results === 'object'
    ) {
      return { results: [body.place_results] };
    }
    // A real reply always carries its metadata; a page with no results of
    // this kind (only an answer box, say) is a valid empty result.
    if (!body.search_metadata) {
      throw new ExternalSearchError('invalid_response', 'SerpApi returned an unexpected reply.', {
        status
      });
    }
    return { results: [] };
  }
  if (!Array.isArray(list)) {
    throw new ExternalSearchError('invalid_response', 'SerpApi returned malformed results.', {
      status
    });
  }

  return { results: list };
}

/**
 * Google web search: `organic_results` from the configured engine. The web
 * integration's entry point, unchanged.
 */
function searchGoogle({ q, params = {} }, options = {}) {
  return searchEngine({ q, params }, options);
}

module.exports = { searchGoogle, searchEngine, RESULT_KEYS };
