const Term = require('../models/Term');
const Page = require('../models/Page');
const { buildPagination } = require('../services/searchService');
const searchDispatcher = require('../services/searchDispatcher');
const verticalSearchService = require('../services/verticalSearchService');
const externalVerticals = require('../services/externalVerticals');
const analyticsService = require('../services/analyticsService');
const SearchLog = require('../models/SearchLog');
const Suggestion = require('../models/Suggestion');
const { sendSuccess, asyncHandler, ApiError } = require('../utils/apiResponse');
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
const { encodeCursor, decodeCursor } = require('../utils/searchCursor');
const { parseQuery } = require('../services/opensearch/queryParser');
const { dateLabelFor } = require('../services/opensearch/searchService');

/** The largest page of the Images tab: its first screen of pictures. */
const IMAGES_MAX_LIMIT = 60;

/**
 * Filters a tab cannot apply, which are therefore not applied — and the
 * response says so (`ignoredFilters`) rather than presenting the results as
 * filtered:
 *
 *   maps            a place has no publication date, language or order
 *   images, videos  no source can order them by publication date (crawled
 *                   media have none; a picture's page date is not its own)
 */
const UNSUPPORTED_FILTERS = {
  maps: ['date', 'language', 'sort'],
  images: ['sort'],
  videos: ['sort']
};

/** The filters this request set that its tab cannot apply. */
function ignoredFiltersFor(category, { sort, dateWindow, language }) {
  const unsupported = UNSUPPORTED_FILTERS[category] || [];
  const set = {
    date: dateWindow !== 'any',
    language: Boolean(language),
    sort: sort !== 'relevance'
  };
  return unsupported.filter(name => set[name]);
}

/**
 * A web result with the date it shows (`dateLabel`). The index's carry one
 * already; a provider's result shows its own stated publication date, or
 * none — never a date it does not give.
 */
function withDateLabel(result) {
  if (result.dateLabel !== undefined) return result;
  return {
    ...result,
    dateLabel: dateLabelFor({ publishedAt: result.publishedAt, fromIndex: false })
  };
}

/** The order a tab's results are really in: News is newest first unless asked otherwise. */
function appliedSortFor(category, sort, ignored) {
  if (ignored.includes('sort')) return 'relevance';
  if (category === 'news' && sort === 'relevance') return 'newest';
  return sort;
}
const externalSearch = require('../services/externalSearch');
const logger = require('../utils/logger');

/**
 * One debug line per search saying who answered it (LOG_LEVEL=debug): the
 * index, an external provider, or nobody because the tab has no provider
 * that can serve it. Names, statuses and counts only — `external` is the
 * same object the response carries, which never holds a key or a request.
 */
function logServed(category, query, page, outcome) {
  const external = outcome.external || null;
  const fromProvider = external && external.status === 'ok' ? external.count || 0 : 0;
  const total = (outcome.results || []).length;
  const vertical = externalVerticals.handles(category);
  const providerOff = Boolean(external) && external.status === 'disabled';

  let servedBy = 'index';
  if (fromProvider > 0) {
    servedBy = total > fromProvider ? `${external.provider}+index` : external.provider;
  } else if (vertical && external && !providerOff) {
    // The tab's provider is on but gave nothing; the crawler's index is not
    // asked instead (services/externalVerticals.js).
    servedBy = 'none';
  }
  const details = { category, query, page, servedBy, results: total, external };
  // Images, videos and maps have one external provider. With it off, the
  // web-result provider does not take over: it has no such search.
  if (vertical && providerOff) {
    const webProvider = externalSearch.webProviderOrder()[0];
    if (webProvider !== external.provider) details.unsupportedBy = webProvider;
  }
  logger.debug('Search served', details);
}

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
  const category = parseEnum(req.query.category, CATEGORY_OPTIONS, 'all', 'category');
  // The Images grid shows up to IMAGES_MAX_LIMIT pictures before Load more;
  // every other tab keeps the server's own maximum.
  const limit = parseLimit(
    req.query.limit,
    category === 'images' ? { max: Math.max(config.search.maxLimit, IMAGES_MAX_LIMIT) } : undefined
  );
  // The page size decides how far the result window reaches.
  const page = parsePage(req.query.page, { limit });
  const sort = parseEnum(req.query.sort, SORT_OPTIONS, 'relevance', 'sort');
  const dateWindow = parseEnum(req.query.date, DATE_OPTIONS, 'any', 'date');
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

  // "Load more": a cursor from the previous response says where the next
  // batch starts. It belongs to this exact search — the query, tab and
  // filters — and is refused for any other. Without one, `page` works as
  // it always has.
  const identity = { query, category, sort, domain, dateWindow, language };
  // Operators typed with a value they cannot use ("site:foo", "lang:xx9"):
  // they restricted nothing, which the page says rather than implying they did.
  const unusedOperators = parseQuery(query).unusedOperators || [];
  const cursor =
    req.query.cursor !== undefined && req.query.cursor !== ''
      ? decodeCursor(String(req.query.cursor), identity)
      : null;
  // Where this batch starts in the source's own list.
  const start = cursor ? cursor.offset : (page - 1) * limit;
  // A batch of more results is not a new search: it is counted in the
  // analytics as the page it reaches, and not added to history again.
  const batchPage = cursor ? Math.floor(start / limit) + 1 : page;
  const isNewSearch = !cursor && page === 1;
  /** How far a source's list can be read: its total, within the result window. */
  const pageableOf = outcome =>
    Math.min(
      outcome.totalResults || 0,
      outcome.reachableResults ?? outcome.totalResults ?? 0,
      config.search.maxResultWindow
    );

  // 2. Non-web verticals run against their own indexes, all built by the
  //    same crawler: images/videos from Media, news from article-marked
  //    pages, maps from extracted geo data. With SerpApi enabled, images,
  //    videos and maps come from Google Images/Videos/Maps instead (see
  //    services/externalVerticals.js); news always stays the crawler's.
  if (category !== 'all') {
    const ignoredFilters = ignoredFiltersFor(category, { sort, dateWindow, language });
    const verticalParams = {
      query,
      page,
      limit,
      sort: ignoredFilters.includes('sort') ? 'relevance' : sort,
      domain,
      dateWindow: ignoredFilters.includes('date') ? 'any' : dateWindow,
      language: ignoredFilters.includes('language') ? '' : language,
      ...(cursor ? { offset: start, rounds: cursor.rounds || 1 } : {})
    };
    const outcome = externalVerticals.handles(category)
      ? await externalVerticals.search(category, verticalParams, () =>
          runVerticalSearch(category, verticalParams)
        )
      : await runVerticalSearch(category, verticalParams);
    logServed(category, query, batchPage, outcome);

    // "Load more" needed a further round of provider requests and could not
    // have it (unavailable, paused, or the day's limit): an error to retry,
    // not the end of the list.
    if (cursor && outcome.results.length === 0 && outcome.moreFailed) {
      throw ApiError.serviceUnavailable(
        outcome.moreFailed.reason === 'daily_limit'
          ? 'No more results can be loaded today: the daily search limit has been reached.'
          : 'More results could not be loaded right now. Try again in a moment.'
      );
    }

    await Promise.all([
      analyticsService.recordSearch({
        query,
        userId,
        resultCount: outcome.totalResults,
        responseTimeMs: outcome.responseTimeMs,
        page: batchPage,
        filters: appliedFilters
      }),
      isNewSearch ? analyticsService.recordHistory({ query, userId }) : Promise.resolve(null)
    ]);

    // Each vertical is one list (the index's, or a provider's answer cut into
    // batches); more exists while that list has results not yet shown — or,
    // for Images and Videos from Parallel, while a further round of requests
    // may still find some (`moreRounds`).
    const nextOffset = start + outcome.results.length;
    const hasMore =
      outcome.results.length > 0 &&
      (nextOffset < pageableOf(outcome) || Boolean(outcome.moreRounds));

    return sendSuccess(res, {
      query,
      category,
      sort,
      filters: appliedFilters,
      // What was really done with them: the order the results are in, and
      // the filters this tab could not apply (not applied, and not claimed).
      appliedSort: appliedSortFor(category, sort, ignoredFilters),
      ignoredFilters,
      unusedOperators,
      results: outcome.results,
      // `items` mirrors `results` for the category-grid components.
      items: outcome.results,
      searchTerms: outcome.searchTerms,
      total: outcome.totalResults,
      pagination: buildPagination({
        page: batchPage,
        limit,
        totalResults: outcome.totalResults,
        reachableResults: outcome.reachableResults
      }),
      hasMore,
      nextCursor: hasMore
        ? encodeCursor(identity, { offset: nextOffset, rounds: outcome.rounds || 0 })
        : null,
      latency: (outcome.responseTimeMs / 1000).toFixed(3) + 's',
      responseTimeMs: outcome.responseTimeMs,
      indexed: true,
      // Provider, status and count only — never configuration or credentials.
      ...(outcome.external ? { external: outcome.external } : {})
    });
  }

  // 3. Run the real search: the first page, or the next batch of one.
  const searchParams = { query, page, limit, sort, domain, dateWindow, language };
  const outcome = cursor
    ? await searchDispatcher.webSearchMore(searchParams, cursor)
    : await searchDispatcher.webSearch(searchParams);
  logServed(category, query, batchPage, outcome);

  // 4. Record analytics and (for signed-in users) history. Both are
  //    fire-and-forget by design but awaited so tests are deterministic.
  await Promise.all([
    analyticsService.recordSearch({
      query,
      userId,
      resultCount: outcome.totalResults,
      responseTimeMs: outcome.responseTimeMs,
      page: batchPage,
      filters: appliedFilters
    }),
    isNewSearch ? analyticsService.recordHistory({ query, userId }) : Promise.resolve(null)
  ]);

  // Where the next batch starts: the index's own offset, and how many of the
  // external answer's results have been shown and where they go.
  let next;
  let hasMore;
  if (cursor) {
    ({ next, hasMore } = outcome);
  } else {
    const continuation = outcome.continuation || {
      externalOffset: 0,
      externalMore: false,
      placement: null
    };
    const fromIndex = outcome.results.filter(result => result.source === 'index').length;
    next = { offset: start + fromIndex, ...continuation };
    hasMore = next.offset < pageableOf(outcome) || continuation.externalMore;
  }

  // Pagination is the index's alone: external results appear on page 1
  // only, after the index's results, so pages 2+ are exactly the index's.
  // The one adjustment: a first page holding only external results is
  // still one page.
  const externalCount = (outcome.external && outcome.external.count) || 0;
  const pagination = buildPagination({
    page: batchPage,
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
    appliedSort: sort,
    ignoredFilters: [],
    unusedOperators,
    results: outcome.results.map(withDateLabel),
    searchTerms: outcome.searchTerms,
    // `total` is the real number of matching documents in the index, plus
    // the external results shown so far — never a provider's estimate.
    total: outcome.totalResults + (cursor ? next.externalOffset : externalCount),
    pagination,
    hasMore,
    nextCursor: hasMore ? encodeCursor(identity, next) : null,
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
