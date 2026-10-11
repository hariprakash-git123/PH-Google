const Term = require('../models/Term');
const Page = require('../models/Page');
const { tokenizeText } = require('../utils/textProcessor');
const { calculateScore } = require('./rankingService');
const { dateWindowToCutoff, maxPageFor } = require('../utils/validators');
// One date rule for both engines (see dateLabelFor).
const { getTimeAgo, dateLabelFor } = require('./opensearch/searchService');

/**
 * Phase 7 search pipeline.
 *
 *   query -> tokens -> inverted index -> candidate pages -> filters
 *         -> ranking -> sort -> pagination -> snippets
 *
 * Performance notes:
 *  - Ranking runs on a light projection (no page body), so a wide candidate
 *    set never pulls document text into memory.
 *  - Page bodies are fetched only for the rows on the requested page, and
 *    only for rows that actually need a generated snippet.
 */

/**
 * How much of a page body to pull when generating a snippet.
 * Snippets are at most 200 characters, so a leading slice is plenty, and it
 * keeps a single search from transferring megabytes of document text.
 */
const SNIPPET_SOURCE_CHARS = 20000;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Looks up the inverted index and returns, per page id, the summed term
 * frequency and how many distinct query terms matched.
 */
async function getCandidatesFromIndex(searchTerms) {
  if (searchTerms.length === 0) return new Map();

  const terms = await Term.find({ word: { $in: searchTerms } })
    .select('word documents')
    .lean();

  const candidates = new Map();

  for (const termDoc of terms) {
    for (const doc of termDoc.documents || []) {
      if (!doc || !doc.pageId) continue;
      const key = doc.pageId.toString();
      const existing = candidates.get(key);
      const frequency = doc.frequency || 0;

      if (existing) {
        existing.frequencySum += frequency;
        existing.matchedTerms += 1;
      } else {
        candidates.set(key, {
          pageId: doc.pageId,
          frequencySum: frequency,
          matchedTerms: 1
        });
      }
    }
  }

  return candidates;
}

/**
 * Builds the Mongo filter that narrows candidate pages by the Phase 7 filters.
 * Domain matching accepts both the denormalised `domain` field and a url
 * fallback, so pages crawled before that field existed still filter correctly.
 */
function buildPageFilter(candidateIds, { domain, dateWindow, language }) {
  const filter = { _id: { $in: candidateIds } };

  if (domain) {
    filter.$or = [
      { domain },
      { domain: 'www.' + domain },
      // Fallback for legacy rows that have no `domain` value.
      { url: { $regex: '^https?://(www\\.)?' + escapeRegex(domain) + '(/|:|$)', $options: 'i' } }
    ];
  }

  const cutoff = dateWindowToCutoff(dateWindow);
  if (cutoff) {
    // Published inside the window, as on the OpenSearch engine: an undated
    // page is in no window, whenever it was crawled.
    filter.publishedAt = { $gte: cutoff };
  }

  if (language) {
    filter.language = language;
  }

  return filter;
}

/**
 * Executes a full search.
 *
 * @param {Object} params
 * @param {string} params.query       Raw user query
 * @param {number} params.page        1-based page number
 * @param {number} params.limit       Results per page
 * @param {string} params.sort        'relevance' | 'newest' | 'oldest'
 * @param {string} params.domain      Hostname filter ('' = none)
 * @param {string} params.dateWindow  'any'|'hour'|'day'|'week'|'month'|'year'
 * @param {string} params.language    Language code ('' = none)
 */
async function performSearch({
  query,
  page = 1,
  limit = 10,
  sort = 'relevance',
  domain = '',
  dateWindow = 'any',
  language = ''
}) {
  const startedAt = Date.now();
  const searchTerms = tokenizeText(query);

  const empty = () => ({
    query,
    results: [],
    searchTerms,
    totalResults: 0,
    totalPages: 0,
    page,
    limit,
    sort,
    responseTimeMs: Date.now() - startedAt
  });

  // A query of only stop-words/punctuation has nothing to look up.
  if (searchTerms.length === 0) return empty();

  // 1. Inverted index lookup.
  const candidates = await getCandidatesFromIndex(searchTerms);
  if (candidates.size === 0) return empty();

  // 2. Apply filters to the candidate set, selecting light fields only.
  const candidateIds = Array.from(candidates.values()).map(c => c.pageId);
  const pageFilter = buildPageFilter(candidateIds, { domain, dateWindow, language });

  const lightPages = await Page.find(pageFilter)
    .select('_id url domain title description language isArticle publishedAt lastCrawledAt')
    .lean();

  if (lightPages.length === 0) return empty();

  // 3. Rank every surviving candidate.
  const ranked = lightPages.map(p => {
    const stats = candidates.get(p._id.toString()) || { frequencySum: 0, matchedTerms: 0 };
    return {
      page: p,
      score: calculateScore(p, searchTerms, stats.frequencySum, {
        matchedTerms: stats.matchedTerms,
        totalTerms: searchTerms.length
      }),
      frequencySum: stats.frequencySum,
      matchedTerms: stats.matchedTerms
    };
  });

  // 4. Sort.
  sortRanked(ranked, sort);

  // 5. Paginate.
  const totalResults = ranked.length;
  const totalPages = Math.max(1, Math.ceil(totalResults / limit));
  const offset = (page - 1) * limit;
  const slice = ranked.slice(offset, offset + limit);

  // 6. Fetch body text only for the rows on this page that need a snippet,
  //    and only the leading slice of each body. A snippet is at most 200
  //    characters, so pulling a whole document (older rows hold raw HTML and
  //    can be hundreds of KB) would dominate the response time.
  const needsBody = slice.filter(r => !r.page.description).map(r => r.page._id);
  const bodyById = new Map();
  if (needsBody.length > 0) {
    const bodies = await Page.aggregate([
      { $match: { _id: { $in: needsBody } } },
      {
        $project: {
          content: { $substrCP: [{ $ifNull: ['$content', ''] }, 0, SNIPPET_SOURCE_CHARS] }
        }
      }
    ]);
    for (const b of bodies) bodyById.set(b._id.toString(), b.content || '');
  }

  const results = slice.map(r => formatResult(r, searchTerms, bodyById));

  return {
    query,
    results,
    searchTerms,
    totalResults,
    totalPages,
    page,
    limit,
    sort,
    responseTimeMs: Date.now() - startedAt
  };
}

function sortRanked(ranked, sort) {
  if (sort === 'newest' || sort === 'oldest') {
    // By publication date, as on the OpenSearch engine: undated pages after
    // every dated one in both directions, then by when they were crawled.
    const direction = sort === 'newest' ? -1 : 1;
    const time = value => (value ? new Date(value).getTime() : null);
    ranked.sort((a, b) => {
      const at = time(a.page.publishedAt);
      const bt = time(b.page.publishedAt);
      if ((at === null) !== (bt === null)) return at === null ? 1 : -1;
      if (at !== bt) return (at - bt) * direction;
      const ac = time(a.page.lastCrawledAt) || 0;
      const bc = time(b.page.lastCrawledAt) || 0;
      if (ac !== bc) return (ac - bc) * direction;
      return b.score - a.score; // relevance breaks date ties
    });
    return ranked;
  }

  // Default: relevance, with url as a stable tie-breaker so paging is
  // deterministic across requests.
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.page.url).localeCompare(String(b.page.url));
  });
  return ranked;
}

/** Shapes one ranked page into the response object the frontend renders. */
function formatResult({ page, score, frequencySum, matchedTerms }, searchTerms, bodyById) {
  let domain = page.domain;
  if (!domain) {
    try {
      domain = new URL(page.url).hostname;
    } catch {
      domain = '';
    }
  }

  const snippet = page.description
    ? truncate(page.description, 220)
    : generateSnippet(bodyById.get(page._id.toString()) || '', searchTerms);

  return {
    id: page._id.toString(),
    domain,
    favicon: '\u{1F310}',
    // Publication age for articles only; a crawl date is labelled as one.
    publishedAgo: page.isArticle && page.publishedAt ? getTimeAgo(page.publishedAt) : null,
    publishedAt: page.publishedAt || null,
    dateLabel: dateLabelFor({
      publishedAt: page.publishedAt,
      crawledAt: page.lastCrawledAt,
      isArticle: Boolean(page.isArticle)
    }),
    title: page.title || page.url,
    url: page.url,
    snippet,
    language: page.language || '',
    category: 'Web Result',
    crawledAt: page.lastCrawledAt || null,
    saved: false,
    score: Number(score.toFixed(3)),
    matchedTerms,
    termFrequency: frequencySum
  };
}

function truncate(text, max) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max).trim() + '...' : clean;
}

/**
 * Picks the first sentence containing a query term, so the snippet shows the
 * user why the page matched. Falls back to the opening text.
 */
function generateSnippet(content, searchTerms) {
  if (!content) return 'No description available.';

  const cleanText = content
    .replace(/<[^>]*>?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleanText) return 'No description available.';
  if (!searchTerms || searchTerms.length === 0) return truncate(cleanText, 150);

  const sentences = cleanText.split(/(?<=[.?!])\s+/);
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (searchTerms.some(term => lower.includes(term))) {
      return truncate(sentence, 200);
    }
  }
  return truncate(cleanText, 150);
}

/**
 * Builds the pagination block returned by the search API.
 *
 * `totalResults` is the exact number of matches. `totalPages` is the number
 * of pages that hold results and can be requested: it stops at the last page
 * the API accepts for this page size (see maxPageFor), so a client following
 * it never asks for a page that would be refused; and it counts only the
 * results that can be reached (`reachableResults`, when the engine reports
 * fewer than it matched), so the last page it advertises is never empty.
 */
function buildPagination({ page, limit, totalResults, reachableResults = totalResults }) {
  const pageable = Math.min(totalResults, reachableResults);
  const totalPages = pageable === 0 ? 0 : Math.min(Math.ceil(pageable / limit), maxPageFor(limit));
  return {
    page,
    limit,
    totalResults,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1 && totalPages > 0
  };
}

module.exports = {
  performSearch,
  buildPagination,
  getCandidatesFromIndex,
  buildPageFilter,
  sortRanked,
  generateSnippet,
  getTimeAgo,
  escapeRegex,
  SNIPPET_SOURCE_CHARS
};
