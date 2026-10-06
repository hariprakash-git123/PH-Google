const { getClient, checkHealth, describeConnectionError } = require('./client');
const { INDEX } = require('./indexManager');
const { parseQuery } = require('./queryParser');
const { buildSearchBody } = require('./queryBuilder');
const { ApiError } = require('../../utils/apiResponse');
const { config } = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * The OpenSearch-backed web search.
 *
 * Replaces the MongoDB inverted index as the engine behind /api/search.
 * The response shape is unchanged, so the React frontend needed no rewrite.
 *
 * Pagination runs in two passes (see `search`): a light ranking pass that
 * collapses duplicates over every result up to the requested page, then a
 * fetch of just that page's documents with their highlights. Collapsing the
 * whole prefix is what keeps pages disjoint and the total identical on every
 * page.
 */

const DEDUPE_OVERFETCH = 3; // rank 3x the results needed, to absorb duplicates

/**
 * OpenSearch refuses to page past index.max_result_window. The index leaves
 * it at the default, and raising it only moves the cliff while making deep
 * requests expensive, so the API enforces it with a clear error instead.
 * The controller already refuses a page beyond it (validators.maxPageFor);
 * the check in `search` protects direct callers.
 */
const MAX_RESULT_WINDOW = config.search.maxResultWindow;

/**
 * Below this word count, an identical content hash is more likely to be
 * shared boilerplate than a genuinely duplicated document, so those pages
 * are left alone.
 */
const MIN_WORDS_FOR_CONTENT_DEDUPE = 10;

/** All the ranking pass needs to know about a hit. */
const RANK_FIELDS = ['urlHash', 'contentHash', 'wordCount'];

/**
 * Counts, across the entire matching set, the copies `dedupeHits` hides:
 * every document beyond the first in each group sharing a content hash.
 * Uses the same eligibility rule as `dedupeHits`, so the reported total is
 * exactly the number of results a user can page through. The index has one
 * shard, so the terms aggregation is exact.
 */
const DUPLICATES_AGG = {
  filter: {
    bool: {
      filter: [{ range: { wordCount: { gte: MIN_WORDS_FOR_CONTENT_DEDUPE } } }],
      must_not: [{ term: { contentHash: '' } }]
    }
  },
  aggs: {
    groups: { terms: { field: 'contentHash', min_doc_count: 2, size: MAX_RESULT_WINDOW } }
  }
};

function countDuplicates(aggregations) {
  const buckets = aggregations?.duplicates?.groups?.buckets || [];
  return buckets.reduce((sum, bucket) => sum + bucket.doc_count - 1, 0);
}

/**
 * Raises a 503 when the cluster is unreachable.
 *
 * Deliberately explicit: the API never silently falls back to the old
 * MongoDB index, because a user cannot tell that their results came from a
 * different, weaker engine.
 */
async function assertAvailable() {
  const health = await checkHealth();
  if (!health.ok) {
    throw new ApiError(health.error || 'Search is temporarily unavailable.', 503, {
      engine: 'opensearch',
      node: health.node
    });
  }
}

/**
 * Builds the display URL shown under a result: no scheme, no "www.",
 * path segments separated so long URLs stay readable.
 */
function toDisplayUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
    return (host + path).slice(0, 120);
  } catch {
    return String(url || '').slice(0, 120);
  }
}

/** Strips the highlight markers, leaving readable text. */
function stripMarks(text) {
  return String(text || '').replace(/<\/?mark>/g, '');
}

/**
 * The snippet.
 *
 * Prefers OpenSearch's highlighted fragment, which is the part of the page
 * that actually matched the query, and falls back to the page description.
 * That is a real improvement on the previous implementation, which returned
 * the first sentence containing any query word.
 */
function buildSnippet(hit) {
  const highlight = hit.highlight || {};
  const source = hit._source || {};

  const fragments = [...(highlight.content || []), ...(highlight.description || [])];

  if (fragments.length > 0) {
    const joined = fragments.map(stripMarks).join(' … ').replace(/\s+/g, ' ').trim();
    if (joined) return joined.length > 300 ? `${joined.slice(0, 300).trim()}…` : joined;
  }

  const description = String(source.description || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (description)
    return description.length > 300 ? `${description.slice(0, 300).trim()}…` : description;

  return 'No description available.';
}

function getTimeAgo(date) {
  if (!date) return 'Unknown';
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 0) return 'Just now';
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;

  const days = Math.floor(seconds / 86400);
  if (days < 30) return days === 1 ? '1 day ago' : `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

/**
 * Collapses near-duplicates.
 *
 * The index already de-duplicates by canonical URL (the document _id), so
 * this catches the remaining case: the same body text published at genuinely
 * different addresses — syndicated articles, mirrors, web.archive.org copies.
 * The highest-scoring copy of each is kept.
 *
 * @param {Array} hits  in ranked order
 * @param {{url: Set, content: Set}} [seen]  carries state across batches of
 *        one ranked list, so a copy is caught however far apart the two are
 * @returns {{kept: Array, removed: number}}
 */
function dedupeHits(hits, seen = { url: new Set(), content: new Set() }) {
  const seenContent = seen.content;
  const seenUrl = seen.url;
  const kept = [];
  let removed = 0;

  for (const hit of hits) {
    const source = hit._source || {};
    const contentHash = source.contentHash;
    const urlHash = source.urlHash || hit._id;

    if (urlHash && seenUrl.has(urlHash)) {
      removed += 1;
      continue;
    }
    // Only treat a shared content hash as duplication when there is real
    // content behind it. An empty page has no hash at all, so that case is
    // already excluded; this guard additionally spares near-empty
    // boilerplate (cookie notices, "page moved" stubs) that legitimately
    // hashes alike across a site.
    if (
      contentHash &&
      (source.wordCount || 0) >= MIN_WORDS_FOR_CONTENT_DEDUPE &&
      seenContent.has(contentHash)
    ) {
      removed += 1;
      continue;
    }

    if (urlHash) seenUrl.add(urlHash);
    if (contentHash) seenContent.add(contentHash);
    kept.push(hit);
  }

  return { kept, removed };
}

/** Maps one hit to the result object the frontend already renders. */
function formatHit(hit, { includeDebug }) {
  const source = hit._source || {};

  const result = {
    id: hit._id,
    // The frontend keys results by id and links by url.
    url: source.url,
    displayUrl: toDisplayUrl(source.url),
    domain: source.domain || '',
    favicon: '\u{1F310}',
    title: source.title || source.url,
    snippet: buildSnippet(hit),
    // Show the publication date only for articles, where it is the point.
    // A reference page's declared datePublished is its creation date — a
    // wiki article created in 2001 and edited yesterday would otherwise
    // read "25 years ago". For those, when we last crawled it is both more
    // useful and more honest.
    publishedAgo: getTimeAgo(
      source.isArticle ? source.publishedAt || source.crawledAt : source.crawledAt
    ),
    publishedAt: source.publishedAt || null,
    crawledAt: source.crawledAt || null,
    language: source.language || '',
    category: 'Web Result',
    saved: false,
    score: Number((hit._score || 0).toFixed(3))
  };

  if (includeDebug) {
    result.debug = {
      qualityScore: source.qualityScore,
      wordCount: source.wordCount,
      uniqueWordRatio: source.uniqueWordRatio,
      isArticle: source.isArticle,
      contentHash: source.contentHash,
      // Present only when the request asked OpenSearch to explain.
      explanation: hit._explanation || null
    };
  }

  return result;
}

/**
 * Executes a web search.
 *
 * @param {Object} params
 * @param {string} params.query
 * @param {number} [params.page]
 * @param {number} [params.limit]
 * @param {string} [params.sort]        relevance | newest | oldest
 * @param {string} [params.domain]
 * @param {string} [params.dateWindow]
 * @param {string} [params.language]
 * @param {boolean} [params.isArticle]  restrict to news articles
 * @param {boolean} [params.debug]      include scoring detail (dev only)
 * @returns {Promise<Object>}
 */
async function search({
  query,
  page = 1,
  limit = 10,
  sort = 'relevance',
  domain = '',
  dateWindow = 'any',
  language = '',
  isArticle,
  debug = false
}) {
  const startedAt = Date.now();
  const parsed = parseQuery(query);

  const empty = () => ({
    query,
    parsed: debug ? parsed : undefined,
    results: [],
    totalResults: 0,
    duplicatesRemoved: 0,
    responseTimeMs: Date.now() - startedAt,
    engine: 'opensearch'
  });

  if (parsed.isEmpty) return empty();

  // Say so plainly rather than letting the cluster reject the request.
  if (page * limit > MAX_RESULT_WINDOW) {
    throw ApiError.badRequest(
      `Only the first ${MAX_RESULT_WINDOW.toLocaleString('en-US')} results can be paged through. ` +
        'Refine the search to narrow them down.'
    );
  }

  await assertAvailable();

  const options = { sort, domain, dateWindow, language, isArticle };

  // 1. Rank. Walk the ranked list from the top, collapsing duplicates, until
  //    this page and every page before it are filled. Collapsing the whole
  //    prefix rather than this page's window is what keeps a document shown
  //    on page 1 off page 2, and catches a copy on the far side of a page
  //    boundary. Only the dedupe keys are fetched.
  //
  //    Only the first MAX_RESULT_WINDOW ranked hits can ever be fetched. When
  //    more documents match than that and some of them are copies, the copies
  //    inside the window use up places, so fewer distinct results can be
  //    paged through than `totalResults` counts. How many depends on where
  //    the copies rank, which only the walk itself can tell: in that case it
  //    continues to the end of the window and counts them.
  const needed = page * limit;
  const seen = { url: new Set(), content: new Set() };
  const ranked = [];
  let fetched = 0;
  let totalHits = 0;
  let duplicates = 0;
  let maxScore = 0;
  let walkWholeWindow = false;

  while ((ranked.length < needed || walkWholeWindow) && fetched < MAX_RESULT_WINDOW) {
    const size = walkWholeWindow
      ? MAX_RESULT_WINDOW - fetched
      : Math.min(needed * DEDUPE_OVERFETCH, MAX_RESULT_WINDOW - fetched);
    const body = buildSearchBody(parsed, { ...options, from: fetched, size });
    delete body.highlight;
    body._source = RANK_FIELDS;
    if (fetched === 0) body.aggs = { duplicates: DUPLICATES_AGG };

    const response = await runSearch(body);
    if (!response) return empty();

    const hits = response.body.hits.hits;
    if (fetched === 0) {
      totalHits = response.body.hits.total.value;
      duplicates = countDuplicates(response.body.aggregations);
      maxScore = hits.reduce((max, hit) => Math.max(max, hit._score || 0), 0);
      walkWholeWindow = totalHits > MAX_RESULT_WINDOW && duplicates > 0;
    }
    ranked.push(...dedupeHits(hits, seen).kept);
    fetched += hits.length;
    if (hits.length < size) break; // the matching set is exhausted
  }

  // 2. Fetch this page's documents, with highlights. The ids filter does not
  //    score, so every document keeps the score it was ranked by.
  const pageKeys = ranked.slice((page - 1) * limit, needed);
  let pageHits = [];
  if (pageKeys.length > 0) {
    const response = await runSearch(
      buildSearchBody(parsed, {
        ...options,
        from: 0,
        size: pageKeys.length,
        ids: pageKeys.map(hit => hit._id),
        explain: Boolean(debug)
      })
    );
    const byId = new Map((response?.body?.hits?.hits || []).map(hit => [hit._id, hit]));
    pageHits = pageKeys.map(key => byId.get(key._id)).filter(Boolean);
  }

  return {
    query,
    parsed: debug ? parsed : undefined,
    results: pageHits.map(hit => formatHit(hit, { includeDebug: debug })),
    // Every match minus every hidden copy, the same on every page.
    totalResults: Math.max(0, totalHits - duplicates),
    // How many of them can be paged through. Equal to totalResults unless
    // the walk had to count the window (see above); buildPagination caps
    // the window itself.
    reachableResults: walkWholeWindow ? ranked.length : Math.max(0, totalHits - duplicates),
    duplicatesRemoved: duplicates,
    maxScore,
    responseTimeMs: Date.now() - startedAt,
    engine: 'opensearch'
  };
}

/**
 * Runs one search request.
 * @returns {Promise<Object|null>} null when the index does not exist yet
 */
async function runSearch(body) {
  try {
    return await getClient().search({ index: INDEX(), body });
  } catch (error) {
    // A missing index means nothing has been crawled yet — an empty result,
    // not an error the user should see.
    const type = error?.meta?.body?.error?.type;
    if (type === 'index_not_found_exception') {
      logger.warn('Search index does not exist yet', { index: INDEX() });
      return null;
    }
    // A malformed query is a client-side problem worth reporting precisely.
    if (type === 'search_phase_execution_exception' || type === 'parsing_exception') {
      logger.error('OpenSearch rejected the query', { message: error.message });
      throw new ApiError('That search query could not be processed.', 400);
    }

    logger.error('OpenSearch search failed', { message: error.message });
    throw new ApiError(describeConnectionError(error), 503);
  }
}

/**
 * Autocomplete suggestions drawn from indexed page titles.
 * Complements the existing query-log and term suggestions.
 */
async function suggestFromTitles(prefix, limit = 5) {
  if (!prefix || prefix.trim().length < 2) return [];

  try {
    await assertAvailable();
    const response = await getClient().search({
      index: INDEX(),
      body: {
        size: limit,
        _source: ['title'],
        query: {
          match_phrase_prefix: {
            'title.exact': { query: prefix, max_expansions: 20 }
          }
        }
      }
    });

    return (response?.body?.hits?.hits || [])
      .map(hit => (hit._source && hit._source.title) || '')
      .filter(Boolean);
  } catch {
    // Suggestions are a convenience; never fail the request over them.
    return [];
  }
}

module.exports = {
  search,
  suggestFromTitles,
  dedupeHits,
  formatHit,
  buildSnippet,
  toDisplayUrl,
  getTimeAgo,
  assertAvailable,
  DEDUPE_OVERFETCH,
  MAX_RESULT_WINDOW,
  MIN_WORDS_FOR_CONTENT_DEDUPE
};
