const Term = require('../models/Term');
const Page = require('../models/Page');
const { buildPagination } = require('../services/searchService');
const searchDispatcher = require('../services/searchDispatcher');
const verticalSearchService = require('../services/verticalSearchService');
const externalVerticals = require('../services/externalVerticals');
const analyticsService = require('../services/analyticsService');
const SearchLog = require('../models/SearchLog');
const Suggestion = require('../models/Suggestion');
const { sendSuccess, asyncHandler } = require('../utils/apiResponse');
const {
  parseSearchQuery,
  maxPageFor,
  parsePage,
  parseLimit,
  parseEnum,
  parseDomain,
  parseLanguage,
  sanitizeString,
  SORT_OPTIONS,
  DATE_OPTIONS,
  CATEGORY_OPTIONS
} = require('../utils/validators');
const { config } = require('../config/env');

/**
 * Dispatches a category to the vertical index that backs it.
 * Each vertical is populated by the same crawler run that fills web search.
 */
function runVerticalSearch(category, params) {
  switch (category) {
    case 'images':
      return verticalSearchService.searchMedia('image', params);
    case 'videos':
      return verticalSearchService.searchMedia('video', params);
    case 'news':
      // Served from the web index filtered to articles (see searchDispatcher).
      return searchDispatcher.newsSearch(params);
    case 'maps':
      return verticalSearchService.searchPlaces(params);
    default:
      return Promise.resolve({ results: [], totalResults: 0, searchTerms: [], responseTimeMs: 0 });
  }
}

/**
 * Phase 7 — advanced search.
 *
 * GET /api/search?q=&page=&limit=&sort=&domain=&date=&language=&category=
 *
 * Pipeline: validate -> tokenize -> inverted index -> filter -> rank
 *           -> sort -> paginate -> record analytics + history.
 */
const search = asyncHandler(async (req, res) => {
  // 1. Validate and normalise every parameter up front.
  const query = parseSearchQuery(req.query.q);
  const limit = parseLimit(req.query.limit);
  // The page size decides how far the result window reaches.
  const page = parsePage(req.query.page, { limit });
  const sort = parseEnum(req.query.sort, SORT_OPTIONS, 'relevance', 'sort');
  const dateWindow = parseEnum(req.query.date, DATE_OPTIONS, 'any', 'date');
  const category = parseEnum(req.query.category, CATEGORY_OPTIONS, 'all', 'category');
  const domain = parseDomain(req.query.domain);
  const language = parseLanguage(req.query.language);

  const appliedFilters = { domain, date: dateWindow, language, category, sort };
  const userId = req.user ? req.user._id : null;

  // An empty query is a valid request that simply has nothing to search for.
  if (!query) {
    return sendSuccess(res, {
      query: '',
      category,
      sort,
      filters: appliedFilters,
      results: [],
      total: 0,
      pagination: buildPagination({ page, limit, totalResults: 0 }),
      latency: '0.000s',
      responseTimeMs: 0
    });
  }

  // 2. Non-web verticals run against their own indexes, all built by the
  //    same crawler: images/videos from Media, news from article-marked
  //    pages, maps from extracted geo data. With SerpApi enabled, images,
  //    videos and maps come from Google Images/Videos/Maps instead (see
  //    services/externalVerticals.js); news always stays the crawler's.
  if (category !== 'all') {
    const verticalParams = { query, page, limit, sort, domain, dateWindow, language };
    const outcome = externalVerticals.handles(category)
      ? await externalVerticals.search(category, verticalParams, () =>
          runVerticalSearch(category, verticalParams)
        )
      : await runVerticalSearch(category, verticalParams);

    await Promise.all([
      analyticsService.recordSearch({
        query,
        userId,
        resultCount: outcome.totalResults,
        responseTimeMs: outcome.responseTimeMs,
        page,
        filters: appliedFilters
      }),
      page === 1 ? analyticsService.recordHistory({ query, userId }) : Promise.resolve(null)
    ]);

    return sendSuccess(res, {
      query,
      category,
      sort,
      filters: appliedFilters,
      results: outcome.results,
      // `items` mirrors `results` for the category-grid components.
      items: outcome.results,
      searchTerms: outcome.searchTerms,
      total: outcome.totalResults,
      pagination: buildPagination({
        page,
        limit,
        totalResults: outcome.totalResults,
        reachableResults: outcome.reachableResults
      }),
      latency: (outcome.responseTimeMs / 1000).toFixed(3) + 's',
      responseTimeMs: outcome.responseTimeMs,
      indexed: true,
      // Provider, status and count only — never configuration or credentials.
      ...(outcome.external ? { external: outcome.external } : {})
    });
  }

  // 3. Run the real search.
  const outcome = await searchDispatcher.webSearch({
    query,
    page,
    limit,
    sort,
    domain,
    dateWindow,
    language
  });

  // 4. Record analytics and (for signed-in users) history. Both are
  //    fire-and-forget by design but awaited so tests are deterministic.
  await Promise.all([
    analyticsService.recordSearch({
      query,
      userId,
      resultCount: outcome.totalResults,
      responseTimeMs: outcome.responseTimeMs,
      page,
      filters: appliedFilters
    }),
    page === 1 ? analyticsService.recordHistory({ query, userId }) : Promise.resolve(null)
  ]);

  // Pagination is the index's alone: external results appear on page 1
  // only, after the index's results, so pages 2+ are exactly the index's.
  // The one adjustment: a first page holding only external results is
  // still one page.
  const externalCount = (outcome.external && outcome.external.count) || 0;
  const pagination = buildPagination({
    page,
    limit,
    totalResults: outcome.totalResults,
    reachableResults: outcome.reachableResults
  });
  if (pagination.totalPages === 0 && externalCount > 0) pagination.totalPages = 1;

  return sendSuccess(res, {
    query,
    category,
    sort,
    filters: appliedFilters,
    results: outcome.results,
    searchTerms: outcome.searchTerms,
    // `total` is the real number of matching documents in the index, plus
    // the external results actually shown — never a provider's estimate.
    total: outcome.totalResults + externalCount,
    pagination,
    latency: (outcome.responseTimeMs / 1000).toFixed(3) + 's',
    responseTimeMs: outcome.responseTimeMs,
    // Provider, status and count only — never configuration or credentials.
    ...(outcome.external ? { external: outcome.external } : {})
  });
});

/**
 * GET /api/suggestions?q=
 *
 * Autocomplete driven by real data only:
 *   1. past queries from the search log that found something (prefix match),
 *      most searched first
 *   2. indexed terms from the inverted index (prefix match), the word in the
 *      most documents first
 *   3. the legacy Suggestion collection, if it still holds rows
 *
 * Each source is ordered before it is cut to the limit, so the limit keeps
 * the best matches rather than whichever rows the database returned first.
 * Returns an empty list when nothing matches — no invented suggestions.
 *
 * Known limitation: the Term collection is written only when
 * SEARCH_ENGINE=mongo, so with OpenSearch as the engine its vocabulary is
 * the one it held when the engine was switched.
 */
const suggestions = asyncHandler(async (req, res) => {
  const raw = sanitizeString(req.query.q, 100).toLowerCase();
  const limit = parseLimit(req.query.limit, { def: 8, max: 20 });

  if (!raw) return sendSuccess(res, []);

  const prefix = new RegExp('^' + raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const out = [];
  const seen = new Set();

  const push = (text, category, trending) => {
    const key = String(text).toLowerCase();
    if (!text || seen.has(key) || out.length >= limit) return;
    seen.add(key);
    out.push({ text, category, trending: Boolean(trending) });
  };

  // 1. Real popular queries first — they are the most useful completions.
  //    A search that found nothing is not worth suggesting again, so only
  //    the searches that returned results are counted.
  const popular = await SearchLog.aggregate([
    { $match: { normalizedQuery: prefix, resultCount: { $gt: 0 } } },
    { $group: { _id: '$normalizedQuery', count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: limit }
  ]);
  for (const row of popular) {
    push(row._id, 'recent search', row.count > 1);
  }

  // 2. Indexed vocabulary. A word present in more documents is a more
  //    useful completion, and one in no document completes to nothing.
  if (out.length < limit) {
    const terms = await Term.aggregate([
      { $match: { word: prefix } },
      { $project: { word: 1, documentCount: { $size: { $ifNull: ['$documents', []] } } } },
      { $match: { documentCount: { $gt: 0 } } },
      { $sort: { documentCount: -1, word: 1 } },
      { $limit: limit }
    ]);
    for (const t of terms) push(t.word, 'indexed term', false);
  }

  // 3. Legacy curated suggestions (kept so existing seeded rows still work).
  if (out.length < limit) {
    const legacy = await Suggestion.find({ text: prefix })
      .sort({ trending: -1, text: 1 })
      .limit(limit)
      .lean();
    for (const s of legacy) push(s.text, s.category || 'search', s.trending);
  }

  return sendSuccess(res, out);
});

/**
 * GET /api/search/config — the limits and filter vocabulary the frontend
 * should respect, so the UI never has to hardcode them.
 */
const searchConfig = asyncHandler(async (req, res) => {
  // Real counts, so the UI can show how much each vertical actually holds.
  const counts = await verticalSearchService.getVerticalCounts();
  const totalPages = await Page.estimatedDocumentCount();

  return sendSuccess(res, {
    defaultLimit: config.search.defaultLimit,
    maxLimit: config.search.maxLimit,
    maxPage: config.search.maxPage,
    // Only this many results of one search can be paged through, so the
    // last page for a page size is min(maxPage, floor(maxResultWindow / limit)).
    maxResultWindow: config.search.maxResultWindow,
    maxPageAtMaxLimit: maxPageFor(config.search.maxLimit),
    maxQueryLength: config.search.maxQueryLength,
    sortOptions: SORT_OPTIONS,
    dateOptions: DATE_OPTIONS,
    categoryOptions: CATEGORY_OPTIONS,
    indexedCategories: CATEGORY_OPTIONS,
    counts: { all: totalPages, ...counts }
  });
});

module.exports = { search, suggestions, searchConfig };
