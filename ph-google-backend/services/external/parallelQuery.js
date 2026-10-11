const { dateWindowToCutoff } = require('../../utils/validators');

/**
 * Translates a PH search into a Parallel Search request.
 *
 * Built from queryParser's structured output, never from the raw text — the
 * same rule as serpApiQuery.js — so whatever the parser dropped stays dropped.
 *
 * Parallel is not Google: it takes a natural-language objective and keyword
 * queries, and has no search operators. What it can be told directly:
 *
 *   site: / the domain filter  → source_policy.include_domains
 *   -site:                     → source_policy.exclude_domains
 *   date window (day … year)   → source_policy.after_date (a calendar date)
 *   "a phrase"                 → sent quoted, and every result is checked
 *                                for the phrase afterwards (parallelMapper)
 *   a OR b                     → sent as written
 *
 * What it cannot honour is not sent at all. Asking anyway and showing the
 * answer would present results that ignore part of the query as if they
 * matched it, so these skip Parallel and the index's results stand alone:
 *
 *   intitle: / inurl: (and their negations)   no equivalent
 *   -word / -"a phrase"                       cannot exclude page text
 *   lang: / -lang: / the language filter      no language parameter
 *   the "past hour" filter                    after_date is a whole day
 *   sort newest/oldest                        results come in Parallel's order
 *
 * A question keeps its wording in the objective ("how does gravity work"),
 * while the keyword query is its topic ("gravity") — what the parser already
 * works out for the index.
 */

/** A phrase in quotes. The parser never leaves a quote inside one. */
const quote = value => `"${String(value).replace(/"/g, '')}"`;

/** One OR alternative, as typed. */
const alternative = ({ type, value }) => (type === 'phrase' ? quote(value) : value);

/** The operators Parallel has no way to apply. */
const UNSUPPORTED = [
  'titleTerms',
  'titlePhrases',
  'urlTerms',
  'urlPhrases',
  'excludedTitleTerms',
  'excludedTitlePhrases',
  'excludedUrlTerms',
  'excludedUrlPhrases',
  'excludedTerms',
  'excludedPhrases',
  'languages',
  'excludedLanguages'
];

/**
 * @param {import('../opensearch/queryParser').ParsedQuery} parsed
 * @param {Object} filters  the request's own parameters
 * @param {number} [filters.page]
 * @param {string} [filters.sort]
 * @param {string} [filters.category]  absent for web search
 * @param {string} [filters.domain]
 * @param {string} [filters.dateWindow]
 * @param {string} [filters.language]
 * @returns {{skip: true, reason: string}
 *          | {skip: false, objective: string, searchQueries: string[],
 *             sourcePolicy: Object, afterDate: string|null}}
 */
function buildParallelRequest(parsed, filters = {}) {
  const { page = 1, sort = 'relevance', category = 'all', domain = '', language = '' } = filters;
  const dateWindow = filters.dateWindow || 'any';

  if (page !== 1) return { skip: true, reason: 'not_first_page' };
  if (category !== 'all') return { skip: true, reason: 'not_web_search' };
  if (sort !== 'relevance') return { skip: true, reason: 'date_sort' };
  if (!parsed || parsed.isEmpty) return { skip: true, reason: 'empty_query' };

  if (UNSUPPORTED.some(name => Array.isArray(parsed[name]) && parsed[name].length > 0)) {
    return { skip: true, reason: 'unsupported_operator' };
  }
  if (language) return { skip: true, reason: 'unsupported_filter' };
  if (dateWindow === 'hour') return { skip: true, reason: 'unsupported_filter' };

  const grouped = parsed.orGroups.length > 0;
  const tail = [
    ...parsed.phrases.map(quote),
    ...parsed.orGroups.map(group => group.map(alternative).join(' OR '))
  ];

  // The topic, for the keyword query; the question as asked, for the objective.
  const keywords = [...(grouped ? parsed.plainTerms : parsed.coreTerms), ...tail].join(' ').trim();
  const asked = [...(grouped ? parsed.plainTerms : parsed.terms), ...tail].join(' ').trim();
  if (!keywords) return { skip: true, reason: 'no_search_text' };

  const sourcePolicy = {};
  const sites = [...parsed.sites];
  if (domain && !sites.includes(domain)) sites.push(domain);
  if (sites.length > 0) sourcePolicy.include_domains = sites;
  if (parsed.excludedSites.length > 0) sourcePolicy.exclude_domains = [...parsed.excludedSites];

  let afterDate = null;
  const cutoff = dateWindowToCutoff(dateWindow);
  if (cutoff) {
    afterDate = cutoff.toISOString().slice(0, 10);
    sourcePolicy.after_date = afterDate;
  }

  return {
    skip: false,
    objective: asked || keywords,
    searchQueries: [keywords],
    sourcePolicy,
    afterDate
  };
}

module.exports = { buildParallelRequest, UNSUPPORTED };
