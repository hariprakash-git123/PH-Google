const externalSearch = require('./externalSearch');
const serpApiClient = require('./external/serpApiClient');
const { config } = require('../config/env');
const { parseQuery } = require('./opensearch/queryParser');
const { buildVerticalRequest } = require('./external/serpApiQuery');
const { mapImageResults } = require('./external/serpApiImageMapper');
const { mapVideoResults } = require('./external/serpApiVideoMapper');
const { mapPlaceResults } = require('./external/serpApiMapsMapper');
const parallelVerticals = require('./parallelVerticals');

/**
 * The image, video and map verticals from SerpApi (Google Images, Google
 * Videos, Google Maps).
 *
 * While SerpApi is off (or has no key) these verticals are exactly what they
 * were: the crawler's own media and places (verticalSearchService) — unless
 * PARALLEL_VERTICALS_ENABLED is on, in which case they add what can be
 * verified from a Parallel web search (parallelVerticals.js): confirmed
 * videos, checked pictures, and places as their own pages describe them.
 * While SerpApi is on, they come from SerpApi:
 *
 *   - one SerpApi request per query and vertical, through the same cache and
 *     daily limit as web search (cache keys carry the vertical, so "python"
 *     on Images never answers "python" on Videos); repeated failures pause
 *     that vertical alone;
 *   - pages are cut from that one response, so paging costs no searches and
 *     the total is what SerpApi actually returned — never an estimate;
 *   - a failure is an empty list with a status, never an error page;
 *   - nothing is stored, and AI answers never see these results.
 */

const MAPPERS = {
  images: mapImageResults,
  videos: mapVideoResults,
  maps: mapPlaceResults
};

const VERTICALS = Object.keys(MAPPERS);

/** Whether this category is one SerpApi can serve. */
function handles(category) {
  return VERTICALS.includes(category);
}

/**
 * @param {'images'|'videos'|'maps'} category
 * @param {Object} params  query, page, limit, domain, dateWindow, language
 * @param {() => Promise<Object>} runInternal  the crawler-backed vertical
 * @returns {Promise<{results, totalResults, reachableResults?, searchTerms,
 *                    responseTimeMs, external}>}
 */
async function search(category, params, runInternal) {
  const startedAt = Date.now();
  const external = (status, extra = {}) => ({
    provider: externalSearch.PROVIDER,
    status,
    count: 0,
    ...extra
  });

  const available = externalSearch.availability();
  if (!available.ok) {
    if (parallelVerticals.handles(category) && parallelVerticals.available().ok) {
      return parallelVerticals.search(category, params);
    }
    const outcome = await runInternal();
    return { ...outcome, external: external(available.status, { reason: available.reason }) };
  }

  const empty = extra => ({
    results: [],
    totalResults: 0,
    searchTerms: [],
    responseTimeMs: Date.now() - startedAt,
    external: extra
  });

  const request = buildVerticalRequest(parseQuery(params.query), category, params);
  if (request.skip) return empty(external('skipped', { reason: request.reason }));

  const outcome = await externalSearch.fetchCached(category, request, () =>
    serpApiClient.searchEngine(
      { engine: request.engine, q: request.q, params: request.params },
      // These tabs wait longer than web search does: here SerpApi is the result.
      { settings: { timeoutMs: config.serpapi.verticalTimeoutMs } }
    )
  );
  if (outcome.status !== 'ok') {
    return empty(external(outcome.status, { reason: outcome.reason }));
  }

  const all = MAPPERS[category](outcome.results);
  const page = Math.max(1, params.page || 1);
  const limit = Math.max(1, params.limit || 10);
  // "Load more" asks for the results after those already shown.
  const start =
    Number.isInteger(params.offset) && params.offset >= 0 ? params.offset : (page - 1) * limit;
  const results = all.slice(start, start + limit);

  return {
    results,
    totalResults: all.length,
    searchTerms: [],
    responseTimeMs: Date.now() - startedAt,
    external: external('ok', { count: results.length, cached: outcome.cached })
  };
}

module.exports = { search, handles, VERTICALS };
