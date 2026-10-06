const openSearchClient = require('../services/opensearch/client');
const indexManager = require('../services/opensearch/indexManager');
const reindexService = require('../services/opensearch/reindexService');
const searchDispatcher = require('../services/searchDispatcher');
const { parseQuery } = require('../services/opensearch/queryParser');
const { buildSearchBody } = require('../services/opensearch/queryBuilder');
const { sendSuccess, asyncHandler, ApiError } = require('../utils/apiResponse');
const { parseSearchQuery, parseLimit, sanitizeString } = require('../utils/validators');
const { config } = require('../config/env');

/**
 * Admin APIs for the search engine itself: cluster health, index statistics,
 * rebuilding the index, and a development-only view of how a query scored.
 *
 * Every route here sits behind protect + adminOnly (see routes/adminRoutes.js).
 */

/**
 * GET /api/admin/search/status
 * Cluster health, index size and whether the index has drifted from MongoDB.
 */
const getSearchStatus = asyncHandler(async (req, res) => {
  const [health, sync] = await Promise.all([
    openSearchClient.checkHealth(true),
    reindexService.getIndexSyncStatus().catch(() => null)
  ]);

  return sendSuccess(res, {
    ...searchDispatcher.describeEngine(),
    cluster: {
      connected: health.ok,
      status: health.status,
      name: health.clusterName || null,
      node: health.node,
      nodes: health.nodes || 0,
      error: health.error || null
    },
    index: sync ? sync.index : { index: config.opensearch.index, exists: false, documentCount: 0 },
    sync: sync
      ? {
          mongoPages: sync.mongoPages,
          indexedDocuments: sync.indexedDocuments,
          drift: sync.drift,
          inSync: sync.inSync
        }
      : null,
    reindex: reindexService.getStatus()
  });
});

/**
 * POST /api/admin/search/reindex   { recreate?: boolean }
 *
 * Rebuilds the OpenSearch index from the pages stored in MongoDB. Returns
 * immediately; progress is read from GET /api/admin/search/reindex.
 */
const startReindex = asyncHandler(async (req, res) => {
  const health = await openSearchClient.checkHealth(true);
  if (!health.ok) {
    throw new ApiError(health.error || 'OpenSearch is unavailable.', 503);
  }

  if (reindexService.isRunning()) {
    throw ApiError.conflict('A reindex is already running.');
  }

  // `recreate` drops the index first, which is the only way mapping changes
  // take effect. Default is a non-destructive in-place refresh.
  const recreate = req.body.recreate === true || req.body.recreate === 'true';

  reindexService.startReindexInBackground({ recreate });

  return sendSuccess(
    res,
    {
      started: true,
      recreate,
      message: 'Reindex started. Poll GET /api/admin/search/reindex for progress.'
    },
    202
  );
});

/** GET /api/admin/search/reindex — progress of the current/last reindex. */
const getReindexStatus = asyncHandler(async (req, res) => {
  return sendSuccess(res, reindexService.getStatus());
});

/**
 * GET /api/admin/search/explain?q=...&url=...
 *
 * Development aid: shows how a query was parsed, the exact OpenSearch body
 * that would be sent, and — when a url is supplied — OpenSearch's own score
 * breakdown for that document.
 *
 * Admin-only and disabled in production: scoring internals are not something
 * ordinary users should ever see.
 */
const explainQuery = asyncHandler(async (req, res) => {
  if (config.isProduction) {
    throw ApiError.forbidden('Query explain is disabled in production.');
  }

  const query = parseSearchQuery(req.query.q);
  if (!query) throw ApiError.badRequest('A "q" parameter is required.');

  const parsed = parseQuery(query);
  const body = buildSearchBody(parsed, { from: 0, size: 5, explain: true });

  const response = {
    query,
    parsed,
    // Shows which clauses fired: exact title, phrase, domain, fuzzy, etc.
    openSearchBody: body
  };

  const url = sanitizeString(req.query.url, 2048);
  if (url) {
    const { buildDocumentId } = require('../services/opensearch/documentMapper');
    const { getClient } = require('../services/opensearch/client');
    const id = buildDocumentId(url);

    if (!id) throw ApiError.badRequest('That "url" could not be parsed.');

    try {
      const explain = await getClient().explain({
        index: indexManager.INDEX(),
        id,
        body: { query: body.query }
      });
      response.explanation = explain?.body?.explanation || null;
      response.matched = explain?.body?.matched || false;
    } catch (error) {
      if (error?.meta?.statusCode === 404) {
        response.explanation = null;
        response.matched = false;
        response.note = 'That URL is not in the index.';
      } else {
        throw error;
      }
    }
  }

  return sendSuccess(res, response);
});

/**
 * GET /api/admin/search/analyze?text=...&analyzer=...
 * Shows how text is tokenised — the quickest way to debug a synonym or
 * stemming surprise.
 */
const analyzeText = asyncHandler(async (req, res) => {
  if (config.isProduction) {
    throw ApiError.forbidden('Analyzer inspection is disabled in production.');
  }

  const text = sanitizeString(req.query.text, 500);
  if (!text) throw ApiError.badRequest('A "text" parameter is required.');

  const allowed = ['ph_text', 'ph_exact', 'ph_search', 'ph_url'];
  const analyzer = allowed.includes(req.query.analyzer) ? req.query.analyzer : 'ph_search';

  const tokens = await indexManager.analyzeText(text, analyzer);
  return sendSuccess(res, { text, analyzer, tokens, tokenCount: tokens.length });
});

/**
 * POST /api/admin/search/settings/reload
 * Re-applies the search-time analysis settings so an edit to synonyms.js
 * takes effect without a full reindex.
 */
const reloadSearchSettings = asyncHandler(async (req, res) => {
  await indexManager.updateSearchTimeSettings();
  return sendSuccess(res, {
    reloaded: true,
    message: 'Search-time analyzers and synonyms reloaded. No reindex required.'
  });
});

/**
 * GET /api/admin/search/sample?q=...
 * Runs a real search and returns the top results with their scores, so the
 * dashboard can show relevance without leaving the admin area.
 */
const sampleSearch = asyncHandler(async (req, res) => {
  const query = parseSearchQuery(req.query.q);
  if (!query) throw ApiError.badRequest('A "q" parameter is required.');

  const limit = parseLimit(req.query.limit, { def: 10, max: 25 });
  const outcome = await searchDispatcher.webSearch({
    query,
    page: 1,
    limit,
    sort: 'relevance',
    debug: !config.isProduction
  });

  return sendSuccess(res, {
    query,
    engine: outcome.engine,
    totalResults: outcome.totalResults,
    duplicatesRemoved: outcome.duplicatesRemoved || 0,
    responseTimeMs: outcome.responseTimeMs,
    results: outcome.results.map(r => ({
      title: r.title,
      url: r.url,
      domain: r.domain,
      score: r.score,
      snippet: r.snippet
    }))
  });
});

module.exports = {
  getSearchStatus,
  startReindex,
  getReindexStatus,
  explainQuery,
  analyzeText,
  reloadSearchSettings,
  sampleSearch
};
