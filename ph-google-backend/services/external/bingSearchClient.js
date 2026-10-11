const { config } = require('../../config/env');
const { ExternalSearchError } = require('./externalSearchError');

/**
 * Bing web search through RapidAPI ("bing-search-apis").
 *
 *   GET https://bing-search-apis.p.rapidapi.com/api/rapid/web_search
 *       ?keyword=…&page=0&size=10&cc=IN
 *   x-rapidapi-key: <key>      x-rapidapi-host: bing-search-apis.p.rapidapi.com
 *
 *   → { request: {…}, data: { items: [{ title, link, description, img }],
 *       keyword_related: [], question: [] }, in_seconds }
 *
 * One request, one controlled outcome: the items, or an ExternalSearchError
 * with one of the fixed codes. The key travels in a header and is never
 * logged; no error carries it, the provider's own text, or fetch's error.
 */

function retryAfterMs(response) {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
}

/**
 * @param {Object} request
 * @param {string} request.keyword  the Bing query (already translated)
 * @param {number} [request.page]   zero-based
 * @param {number} [request.size]
 * @param {string} [request.cc]     country code
 * @param {Object} [options]
 * @param {Object} [options.settings]  overrides config.bing (tests)
 * @param {Function} [options.fetchImpl]  overrides global fetch (tests)
 * @returns {Promise<{results: Array<Object>}>} raw `data.items`
 * @throws {ExternalSearchError}
 */
async function searchWeb({ keyword, page = 0, size, cc }, options = {}) {
  const settings = { ...config.bing, ...(options.settings || {}) };
  const fetchImpl = options.fetchImpl || fetch;

  if (!settings.apiKey) {
    throw new ExternalSearchError('not_configured', 'Bing search has no API key configured.');
  }

  const url = new URL(`${settings.baseUrl || `https://${settings.host}`}/api/rapid/web_search`);
  url.searchParams.set('keyword', keyword);
  url.searchParams.set('page', String(page));
  url.searchParams.set('size', String(size || settings.maxResults));
  url.searchParams.set('cc', cc || settings.cc);

  const timedOut = () =>
    new ExternalSearchError('timeout', `Bing did not answer within ${settings.timeoutMs} ms.`);
  const isTimeout = error =>
    error && (error.name === 'TimeoutError' || error.name === 'AbortError');

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-rapidapi-key': settings.apiKey,
        'x-rapidapi-host': settings.host
      },
      signal: AbortSignal.timeout(settings.timeoutMs)
    });
  } catch (error) {
    if (isTimeout(error)) throw timedOut();
    throw new ExternalSearchError('network', 'Bing could not be reached.');
  }

  const { status } = response;
  if (status === 401 || status === 403) {
    // RapidAPI answers 403 for a wrong key and for a missing subscription alike.
    throw new ExternalSearchError('auth', 'Bing rejected the API key or subscription.', { status });
  }
  if (status === 429) {
    throw new ExternalSearchError('rate_limited', 'Bing is rate limiting this key.', {
      status,
      retryAfterMs: retryAfterMs(response)
    });
  }
  if (status >= 500) {
    throw new ExternalSearchError('unavailable', `Bing answered ${status}.`, { status });
  }
  if (status >= 400) {
    throw new ExternalSearchError('bad_request', `Bing answered ${status}.`, { status });
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    if (isTimeout(error)) throw timedOut();
    throw new ExternalSearchError('invalid_response', 'Bing returned a reply that is not JSON.', {
      status
    });
  }

  const data = body && typeof body === 'object' && !Array.isArray(body) ? body.data : null;
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
    throw new ExternalSearchError('invalid_response', 'Bing returned an unexpected reply.', {
      status
    });
  }

  return { results: data.items };
}

module.exports = { searchWeb };
