const { getClient, checkHealth, describeConnectionError } = require('./client');
const { INDEX } = require('./indexManager');
const { parseQuery } = require('./queryParser');
const { buildSearchBody, buildQualityFilters } = require('./queryBuilder');
const { buildDocumentId } = require('./documentMapper');
const { meaningfulWords, requiredMentions } = require('../external/resultRelevance');
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

/**
 * The Wayback Machine's copies among the matches. A page crawled both at its
 * own address and as web.archive.org/web/<timestamp>/<address> is one article
 * shown twice, and the content hash does not catch it: the archive adds a
 * banner, so the two texts differ by a few words.
 */
const ARCHIVE_HOST = 'web.archive.org';
/** OpenSearch returns at most 100 hits from a top_hits aggregation. */
const ARCHIVE_COPIES_CHECKED = 100;
const ARCHIVED_AGG = {
  filter: { term: { domain: ARCHIVE_HOST } },
  aggs: { copies: { top_hits: { size: ARCHIVE_COPIES_CHECKED, _source: ['url'] } } }
};

/**
 * The address a Wayback Machine URL is a copy of, or null when the URL is
 * not one: https://web.archive.org/web/20240105020744/https://example.com/a
 * (the timestamp may carry a flag such as "id_") → https://example.com/a.
 */
function archivedOriginal(url) {
  const match = /^https?:\/\/web\.archive\.org\/web\/\d{4,14}[a-z_]*\/(.+)$/i.exec(
    typeof url === 'string' ? url.trim() : ''
  );
  if (!match) return null;
  return /^https?:\/\//i.test(match[1]) ? match[1] : `http://${match[1]}`;
}

/**
 * Which archived copies duplicate a page that is itself among the matches.
 *
 * Only then is a copy left out. When the original was never crawled, or does
 * not match this search, the archived copy is the only way to that article
 * and stays. Decided from the whole matching set, not from one page of it,
 * so the answer — and with it the total — is the same on every page.
 *
 * @param {Array} copies  the archived hits (`_id`, `_source.url`)
 * @param {(ids: string[]) => Promise<Set<string>>} matching  which of these
 *        document ids the search matches
 * @returns {Promise<string[]>} ids of the copies to leave out
 */
async function archiveDuplicates(copies, matching) {
  const copiesOf = new Map(); // id of the original -> ids of its archived copies
  for (const hit of copies) {
    const original = archivedOriginal(hit && hit._source && hit._source.url);
    const originalId = original ? buildDocumentId(original) : null;
    if (!originalId || originalId === hit._id) continue;
    copiesOf.set(originalId, [...(copiesOf.get(originalId) || []), hit._id]);
  }
  if (copiesOf.size === 0) return [];
  const present = await matching([...copiesOf.keys()]);
  return [...copiesOf.entries()].filter(([id]) => present.has(id)).flatMap(([, ids]) => ids);
}

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
  const cut = text => (text.length > 300 ? `${text.slice(0, 300).trim()}…` : text);
  const join = list => list.map(stripMarks).join(' … ').replace(/\s+/g, ' ').trim();
  // A fragment with a <mark> is where the page matched the query. Content's
  // `no_match_size` fragment has none: it is only the page's opening text.
  const matched = list => (list || []).filter(fragment => /<mark>/.test(fragment));

  const fromMatches = join([...matched(highlight.content), ...matched(highlight.description)]);
  if (fromMatches) return cut(fromMatches);

  // The page matched in its title or headings only: its own description
  // says what it is about better than its first lines do.
  const description = String(source.description || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (description) return cut(description);

  const opening = join([...(highlight.content || []), ...(highlight.description || [])]);
  if (opening) return cut(opening);

  return 'No description available.';
}

/**
 * Whole calendar months from one date to another (UTC): 11 Feb 2003 to
 * 11 Oct 2026 is 284 months — 23 years 8 months, not the 24 years that
 * counting 30-day months twelve to a year (360-day years) gives.
 */
function calendarMonthsBetween(from, to) {
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  // The month is not complete until its day (and time) is reached.
  const dayOfMonth = d =>
    d.getUTCDate() * 86400000 +
    (d.getTime() - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (dayOfMonth(to) < dayOfMonth(from)) months -= 1;
  return Math.max(0, months);
}

function getTimeAgo(date, now = Date.now()) {
  if (!date) return 'Unknown';
  const at = new Date(date);
  if (!Number.isFinite(at.getTime())) return 'Unknown';
  const seconds = Math.floor((now - at.getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;

  const days = Math.floor(seconds / 86400);
  const months = calendarMonthsBetween(at, new Date(now));
  if (months < 1) return days === 1 ? '1 day ago' : `${days} days ago`;
  if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC'
});

/**
 * The date a result shows, and what kind of date it is — or null for none.
 *
 *   published  the page's own publication date: an article's (index), or
 *              the date a provider gives as its publish date
 *   crawled    when PH last crawled the page: index pages that are not
 *              articles, or articles that state no date. A reference page's
 *              declared datePublished is when it was created (a wiki
 *              article from 2001, edited last week), so it is not shown as
 *              if it were the page's age; when PH read it is, said as such.
 *
 * A crawl date is never presented as a publication date, and no date is
 * made up: a provider's result without one shows none. Under a year old the
 * date reads relative ("3 days ago"); older, as the date itself.
 *
 * @param {{publishedAt?: string|null, crawledAt?: string|null,
 *          isArticle?: boolean, fromIndex?: boolean}} fields
 * @returns {{kind: 'published'|'crawled', at: string, text: string}|null}
 */
function dateLabelFor(
  { publishedAt, crawledAt, isArticle = false, fromIndex = true },
  now = Date.now()
) {
  const valid = value => value && Number.isFinite(new Date(value).getTime());
  let kind = null;
  let at = null;
  if (valid(publishedAt) && (!fromIndex || isArticle)) {
    kind = 'published';
    at = new Date(publishedAt);
  } else if (fromIndex && valid(crawledAt)) {
    kind = 'crawled';
    at = new Date(crawledAt);
  }
  if (!kind) return null;
  // A date in the future is not trusted as a publication date.
  if (kind === 'published' && at.getTime() > now + 86400000) return null;
  const when =
    calendarMonthsBetween(at, new Date(now)) >= 12 ? DATE_FORMAT.format(at) : getTimeAgo(at, now);
  return {
    kind,
    at: at.toISOString(),
    text: `${kind === 'published' ? 'Published' : 'Crawled'} ${when === 'Just now' ? 'just now' : when}`
  };
}

/**
 * When the source says the page last changed — its own Last-Modified date,
 * shown beside the date above and labelled as what it is ("Modified …").
 * Null when the source gave none, or one that cannot be right (in the
 * future): no date is ever put in its place.
 *
 * @param {string|Date|null} modifiedAt
 * @returns {{at: string, text: string}|null}
 */
function modifiedLabelFor(modifiedAt, now = Date.now()) {
  if (!modifiedAt) return null;
  const at = new Date(modifiedAt);
  if (!Number.isFinite(at.getTime()) || at.getTime() > now + 60 * 1000) return null;
  const when =
    calendarMonthsBetween(at, new Date(now)) >= 12 ? DATE_FORMAT.format(at) : getTimeAgo(at, now);
  return { at: at.toISOString(), text: `Modified ${when === 'Just now' ? 'just now' : when}` };
}

/**
 * Collapses near-duplicates.
 *
 * The index already de-duplicates by canonical URL (the document _id), so
 * this catches the remaining case: the same body text published at genuinely
 * different addresses — syndicated articles and mirrors. The highest-scoring
 * copy of each is kept. (A web.archive.org copy differs from its original by
 * the archive's banner, so it is left out earlier: see archiveDuplicates.)
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
    // How long ago it was published: articles only, from their own date —
    // never from when it was crawled. What the result shows is `dateLabel`.
    publishedAgo: source.isArticle && source.publishedAt ? getTimeAgo(source.publishedAt) : null,
    publishedAt: source.publishedAt || null,
    crawledAt: source.crawledAt || null,
    dateLabel: dateLabelFor({
      publishedAt: source.publishedAt,
      crawledAt: source.crawledAt,
      isArticle: Boolean(source.isArticle)
    }),
    // The source's own Last-Modified date, when it gave one.
    modifiedAt: source.modifiedAt || null,
    modifiedLabel: modifiedLabelFor(source.modifiedAt),
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
 * @param {number} [params.offset]     where the results start in the ranked,
 *        de-duplicated list, instead of (page - 1) * limit. "Load more" asks
 *        for the next results after the ones already shown, whatever the
 *        size of the batches before; the walk below is the same either way.
 * @param {string} [params.sort]        relevance | newest | oldest
 * @param {string} [params.domain]
 * @param {string} [params.dateWindow]
 * @param {string} [params.language]
 * @param {boolean} [params.isArticle]  restrict to news articles
 * @param {boolean} [params.topicalWhenWeak]  when the index holds no page
 *        about the query, return only the pages that mention its meaningful
 *        words instead of every partial match (see buildTopicalFilter). Off
 *        unless asked for: the results page and the News tab ask, AI answers
 *        do not. With `isArticle`, "no page" means no article.
 * @param {boolean} [params.topicalAlways]  return only pages that mention the
 *        query's meaningful words whatever the index holds (the News tab)
 * @param {boolean} [params.freshness]  the bounded lift for recent pages,
 *        whatever the query's words (the News tab: news is about time)
 * @param {boolean} [params.debug]      include scoring detail (dev only)
 * @returns {Promise<Object>}
 */
async function search({
  query,
  page = 1,
  limit = 10,
  offset,
  sort = 'relevance',
  domain = '',
  dateWindow = 'any',
  language = '',
  isArticle,
  topicalWhenWeak = false,
  topicalAlways = false,
  freshness = false,
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
  const start = Number.isInteger(offset) && offset >= 0 ? offset : (page - 1) * limit;
  const end = start + limit;
  if (end > MAX_RESULT_WINDOW) {
    throw ApiError.badRequest(
      `Only the first ${MAX_RESULT_WINDOW.toLocaleString('en-US')} results can be paged through. ` +
        'Refine the search to narrow them down.'
    );
  }

  await assertAvailable();

  const options = { sort, domain, dateWindow, language, isArticle, freshness };

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
  const needed = end;
  const seen = { url: new Set(), content: new Set() };
  const ranked = [];
  let fetched = 0;
  let totalHits = 0;
  let duplicates = 0;
  let maxScore = 0;
  let walkWholeWindow = false;
  // Measured beside the search, so under the same filters: for News the
  // counts are of articles, which is what its own relevance decision needs.
  const qualityFilters = buildQualityFilters(parsed);
  let quality = null;
  // Set once the index has been found to hold no page about the query: the
  // words a page must then mention to be shown (see below). From the start,
  // when every result has to be on the subject (topicalAlways).
  let topical = null;
  if (topicalAlways) {
    const words = meaningfulWords(parsed);
    if (words.length > 0) topical = { words, required: requiredMentions(words.length) };
  }
  // Archived copies of pages that are themselves among the matches.
  let excludeIds = [];
  let archiveChecked = false;

  while ((ranked.length < needed || walkWholeWindow) && fetched < MAX_RESULT_WINDOW) {
    const size = walkWholeWindow
      ? MAX_RESULT_WINDOW - fetched
      : Math.min(needed * DEDUPE_OVERFETCH, MAX_RESULT_WINDOW - fetched);
    const body = buildSearchBody(parsed, {
      ...options,
      topical,
      excludeIds,
      from: fetched,
      size
    });
    delete body.highlight;
    body._source = RANK_FIELDS;
    if (fetched === 0) {
      body.aggs = { duplicates: DUPLICATES_AGG };
      if (!archiveChecked) body.aggs.archived = ARCHIVED_AGG;
      // How well the index covers this query (see buildQualityFilters).
      // Filters beside the search: they count, and change no score.
      if (qualityFilters && !topical) {
        body.aggs.fullMatches = { filter: qualityFilters.full };
        body.aggs.aboutMatches = { filter: qualityFilters.about };
      }
    }

    const response = await runSearch(body);
    if (!response) return empty();

    const hits = response.body.hits.hits;
    if (fetched === 0) {
      totalHits = response.body.hits.total.value;
      duplicates = countDuplicates(response.body.aggregations);
      const aggregations = response.body.aggregations || {};
      if (qualityFilters && aggregations.aboutMatches && aggregations.fullMatches) {
        quality = {
          fullMatches: aggregations.fullMatches.doc_count,
          aboutMatches: aggregations.aboutMatches.doc_count
        };
      }

      // No page is about the query, so what matched did so on scattered
      // words — and with a long query, on its generic ones ("best", "in").
      // Those are not answers. The ranking is run again keeping only pages
      // that mention the words carrying the query's meaning; totals and
      // pages are then counted from that set, the same on every page.
      if (topicalWhenWeak && !topical && quality && quality.aboutMatches === 0) {
        const words = meaningfulWords(parsed);
        if (words.length > 0) {
          topical = { words, required: requiredMentions(words.length) };
          quality.looseMatches = Math.max(0, totalHits - duplicates);
          quality.topicalOnly = true;
          continue;
        }
      }

      // An archived copy of a page that also matches is the same article
      // twice. The ranking is run once more without those copies, so the
      // total and every page are counted from what is actually shown.
      if (!archiveChecked) {
        archiveChecked = true;
        const copies = aggregations.archived?.copies?.hits?.hits || [];
        if (copies.length > 0) {
          excludeIds = await archiveDuplicates(copies, async ids => {
            const check = buildSearchBody(parsed, { ...options, topical, ids, size: ids.length });
            delete check.highlight;
            check._source = false;
            const found = await runSearch(check);
            return new Set((found?.body?.hits?.hits || []).map(hit => hit._id));
          });
          if (excludeIds.length > 0) continue;
        }
      }

      maxScore = hits.reduce((max, hit) => Math.max(max, hit._score || 0), 0);
      walkWholeWindow = totalHits > MAX_RESULT_WINDOW && duplicates > 0;
    }
    ranked.push(...dedupeHits(hits, seen).kept);
    fetched += hits.length;
    if (hits.length < size) break; // the matching set is exhausted
  }

  // 2. Fetch this page's documents, with highlights. The ids filter does not
  //    score, so every document keeps the score it was ranked by.
  const pageKeys = ranked.slice(start, needed);
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
    // { fullMatches, aboutMatches } — how many matching pages contain every
    // word of the query, and how many are about it. Absent when the query
    // has no free text to measure.
    ...(quality ? { quality } : {}),
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
  archivedOriginal,
  archiveDuplicates,
  search,
  suggestFromTitles,
  dedupeHits,
  formatHit,
  buildSnippet,
  toDisplayUrl,
  getTimeAgo,
  dateLabelFor,
  modifiedLabelFor,
  calendarMonthsBetween,
  assertAvailable,
  DEDUPE_OVERFETCH,
  MAX_RESULT_WINDOW,
  MIN_WORDS_FOR_CONTENT_DEDUPE
};
