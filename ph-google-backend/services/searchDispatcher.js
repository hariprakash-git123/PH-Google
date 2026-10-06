const { config } = require('../config/env');
const openSearch = require('./opensearch/searchService');
const mongoSearch = require('./searchService');
const externalSearch = require('./externalSearch');
const { getClient } = require('./opensearch/client');
const { sha1 } = require('./opensearch/documentMapper');
const { buildPagination } = require('./searchService');
const logger = require('../utils/logger');

/**
 * Chooses the engine that answers web search.
 *
 * OpenSearch is the architecture. The MongoDB inverted index is retained
 * behind an explicit SEARCH_ENGINE=mongo switch so a rollback is possible,
 * but it is never selected automatically — if OpenSearch is down the API
 * returns 503, because silently serving weaker results from a different
 * engine would be invisible to the user.
 *
 * Both engines return the same shape, so the controller and the frontend do
 * not know or care which one ran.
 */

function usingOpenSearch() {
  return config.searchEngine === 'opensearch';
}

/**
 * Runs a web search on the active engine.
 *
 * With `includeExternal` (the default, used by /api/search) the first page
 * may also carry Google results from SerpApi, appended after the index's
 * results — see services/externalSearch.js. That changes nothing while
 * SerpApi is disabled except labelling each result `source: 'index'`.
 * AI answers pass `includeExternal: false` and get the index's results only,
 * exactly as before.
 *
 * @param {Object} params
 * @param {{includeExternal?: boolean}} [options]
 * @returns {Promise<{results, totalResults, responseTimeMs, engine, external?, …}>}
 */
async function webSearch(params, { includeExternal = true } = {}) {
  if (!includeExternal) return engineSearch(params);
  return externalSearch.searchWithExternal(params, () => engineSearch(params), {
    indexedKeys: usingOpenSearch() ? indexedKeys : undefined
  });
}

/**
 * Which of these canonical URL keys the OpenSearch index already holds. A
 * document's _id is sha1 of its canonical key, so this is one id lookup.
 * Read-only.
 */
async function indexedKeys(keys) {
  const ids = keys.filter(Boolean).map(key => sha1(key));
  if (ids.length === 0) return new Set();
  const response = await getClient().mget({
    index: config.opensearch.index,
    body: { ids },
    _source: false
  });
  const found = new Set(
    (response?.body?.docs || []).filter(doc => doc && doc.found).map(doc => doc._id)
  );
  return new Set(keys.filter(key => key && found.has(sha1(key))));
}

/** The index search alone: OpenSearch, or the legacy MongoDB engine. */
async function engineSearch(params) {
  if (usingOpenSearch()) {
    return openSearch.search(params);
  }

  // Legacy path. Mapped onto the same result shape as OpenSearch.
  logger.warn('Serving web search from the superseded MongoDB index', {
    reason: 'SEARCH_ENGINE=mongo'
  });

  const outcome = await mongoSearch.performSearch({
    query: params.query,
    page: params.page,
    limit: params.limit,
    sort: params.sort,
    domain: params.domain,
    dateWindow: params.dateWindow,
    language: params.language
  });

  return {
    query: outcome.query,
    results: outcome.results.map(r => ({ ...r, displayUrl: r.url })),
    totalResults: outcome.totalResults,
    duplicatesRemoved: 0,
    responseTimeMs: outcome.responseTimeMs,
    engine: 'mongo'
  };
}

/**
 * News is page-level content, so it is served from the same OpenSearch index
 * filtered to articles. Images, videos and places keep their MongoDB indexes:
 * those documents are small, already have their own term arrays, and moving
 * them would add a second index without improving anything.
 */
async function newsSearch(params) {
  if (usingOpenSearch()) {
    return openSearch.search({
      ...params,
      isArticle: true,
      // News is chronological unless the caller asks for relevance.
      sort: params.sort === 'relevance' ? 'newest' : params.sort
    });
  }

  const verticalSearchService = require('./verticalSearchService');
  const outcome = await verticalSearchService.searchNews(params);
  return { ...outcome, engine: 'mongo' };
}

/** Which engine is active, for the health endpoint and the admin dashboard. */
function describeEngine() {
  return {
    engine: config.searchEngine,
    isPrimary: usingOpenSearch(),
    external: externalSearch.describe(),
    verticals: {
      web: config.searchEngine,
      news: config.searchEngine,
      images: 'mongo',
      videos: 'mongo',
      maps: 'mongo'
    }
  };
}

module.exports = {
  webSearch,
  newsSearch,
  usingOpenSearch,
  describeEngine,
  buildPagination
};
