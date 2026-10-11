const { config } = require('../config/env');
const openSearch = require('./opensearch/searchService');
const mongoSearch = require('./searchService');
const externalSearch = require('./externalSearch');
const { getClient } = require('./opensearch/client');
const { sha1 } = require('./opensearch/documentMapper');
const { buildPagination } = require('./searchService');
const navigational = require('./ranking/navigational');
const queryIntent = require('./ranking/queryIntent');
const { parseQuery } = require('./opensearch/queryParser');
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
 * With the relevance gate on, the results page also asks the index to be
 * strict when it holds no page about the query: it then returns only pages
 * that mention the query's meaningful words, rather than every page sharing a
 * generic word with it (`topicalWhenWeak`, see opensearch/searchService.js).
 * A page of partial matches is not an answer, and showing one beside — or
 * instead of — the provider's results presents it as if it were.
 *
 * @param {Object} params
 * @param {{includeExternal?: boolean}} [options]
 * @returns {Promise<{results, totalResults, responseTimeMs, engine, external?, …}>}
 */
async function webSearch(params, { includeExternal = true } = {}) {
  if (!includeExternal) return engineSearch(params);
  const forPage = config.externalSearch.relevanceGate
    ? { ...params, topicalWhenWeak: true }
    : params;
  // A search that only names a site ("youtube") is a request to go there:
  // its official pages lead the first page, when they are among the results.
  const intent = (params.page || 1) === 1 ? navigational.detect(params.query) : null;
  const outcome = await externalSearch.searchWithExternal(forPage, () => engineSearch(forPage), {
    indexedKeys: usingOpenSearch() ? indexedKeys : undefined,
    navigational: intent
  });
  if (!intent) return outcome;
  const { results, promoted } = navigational.promoteOfficial(outcome.results, intent);
  return { ...outcome, results, navigational: { site: intent.name, promoted } };
}

/**
 * The next batch of a web search, for "Load more".
 *
 * It continues both sources from where the previous batch stopped, as the
 * cursor records it: the index from its offset in the same stable ranking
 * (score, then the URL hash — see buildSearchBody), and the external answer
 * from the number of its results already shown. While the provider's answer
 * has results left, up to half of each batch is taken from it — all of it,
 * where the index did not answer the query — and the index fills the rest
 * (and the provider fills what the index cannot). The batch
 * is then ranked as one list (unifiedRanker), as the first page is. Each
 * source's next results are taken in their own order and all of them are
 * shown, so the offsets stay exact: nothing is skipped or shown twice.
 *
 * External results for pages the index holds are left out (they are, or will
 * be, among the index's own), so nothing appears twice across sources or
 * batches. A source that fails leaves the other's results in the batch.
 *
 * @param {Object} params  query, filters and `limit` (the batch size)
 * @param {{offset: number, externalOffset: number, placement: string|null,
 *          externalMore: boolean}} state  from the cursor
 * @returns {Promise<Object>} the batch, with the totals, the external status
 *          and the next state
 */
async function webSearchMore(params, state) {
  const forPage = config.externalSearch.relevanceGate
    ? { ...params, topicalWhenWeak: true }
    : params;
  const keys = usingOpenSearch() ? indexedKeys : undefined;
  const limit = params.limit;
  const startedAt = Date.now();

  const askExternal = count =>
    externalSearch.moreExternal(params, {
      offset: state.externalOffset,
      count,
      indexedKeys: keys
    });

  // Where the index did not answer the query (placement 'external', or
  // 'first' from older cursors), the provider's answer fills each batch first;
  // otherwise it gives up to half of it.
  const providerLeads = state.placement === 'external' || state.placement === 'first';
  let external = null;
  if (state.externalMore) {
    external = await askExternal(providerLeads ? limit : Math.ceil(limit / 2));
  }

  const fromExternal = external ? external.results.length : 0;
  // The index is always asked, at least for one result, so the totals and
  // whether it has more are known.
  const wanted = Math.max(1, limit - fromExternal);
  const internal = await engineSearch({ ...forPage, offset: state.offset, limit: wanted });
  const indexResults = externalSearch
    .labelIndexResults(internal.results || [], { offset: state.offset })
    .slice(0, limit - fromExternal);

  // The index ran short: the provider's answer fills the rest of the batch
  // (the same cached answer, from the same place — nothing is sent again).
  if (
    external &&
    external.status === 'ok' &&
    external.more &&
    indexResults.length + external.results.length < limit
  ) {
    external = await askExternal(limit - indexResults.length);
  }

  const externalResults = external ? external.results : [];
  const results = externalSearch.ranked(
    [...indexResults, ...externalResults],
    parseQuery(params.query),
    queryIntent.classify(params.query),
    params.sort
  );

  const pageable = Math.min(
    internal.totalResults || 0,
    internal.reachableResults ?? internal.totalResults ?? 0,
    config.search.maxResultWindow
  );
  const nextOffset = state.offset + indexResults.length;
  // A provider that failed this time keeps its place, so the next click
  // can try it again; one that answered says itself whether it has more.
  const externalMore = external && external.status === 'ok' ? external.more : state.externalMore;
  const next = {
    offset: nextOffset,
    externalOffset: state.externalOffset + externalResults.length,
    placement: providerLeads ? 'external' : state.placement ? 'ranked' : null,
    externalMore
  };

  return {
    results,
    totalResults: internal.totalResults || 0,
    reachableResults: internal.reachableResults,
    duplicatesRemoved: internal.duplicatesRemoved,
    searchTerms: internal.searchTerms,
    engine: internal.engine,
    responseTimeMs: Date.now() - startedAt,
    external: external
      ? {
          provider: external.provider,
          status: external.status,
          count: externalResults.length,
          ...(external.reason ? { reason: external.reason } : {}),
          ...(external.cached !== undefined ? { cached: external.cached } : {})
        }
      : undefined,
    next,
    hasMore: nextOffset < pageable || externalMore
  };
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

  // The legacy engine pages by number; an offset ("Load more") is served by
  // reading up to it and cutting.
  const hasOffset = Number.isInteger(params.offset) && params.offset >= 0;
  const outcome = await mongoSearch.performSearch({
    query: params.query,
    page: hasOffset ? 1 : params.page,
    limit: hasOffset ? params.offset + params.limit : params.limit,
    sort: params.sort,
    domain: params.domain,
    dateWindow: params.dateWindow,
    language: params.language
  });

  return {
    query: outcome.query,
    results: (hasOffset ? outcome.results.slice(params.offset) : outcome.results).map(r => ({
      ...r,
      displayUrl: r.url
    })),
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
 *
 * With the relevance gate on, News is as strict as the results page: when no
 * article is about the query, only articles that mention its meaningful
 * words are returned — not every article sharing one word with it. No
 * article on the subject is then an empty tab, which is the honest answer.
 */
async function newsSearch(params) {
  if (usingOpenSearch()) {
    return openSearch.search({
      ...params,
      isArticle: true,
      topicalWhenWeak: config.externalSearch.relevanceGate,
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
  webSearchMore,
  newsSearch,
  usingOpenSearch,
  describeEngine,
  buildPagination
};
