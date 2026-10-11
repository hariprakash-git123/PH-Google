const { config } = require('../../config/env');

/**
 * Translates a PH search into a Bing request.
 *
 * Built from queryParser's structured output, like the SerpApi translation
 * (serpApiQuery.js), so anything the parser dropped stays dropped.
 *
 * Bing understands site:, -site:, intitle:, "phrases", -word, OR and
 * language:xx. What it cannot be asked through this endpoint is refused
 * here with a reason, so the caller can ask another provider instead:
 *
 *   date window          → no parameter for it: skipped
 *   several languages    → language: takes one: skipped
 *   -lang:xx             → no equivalent: skipped
 *   sort newest/oldest   → no date sort: skipped
 *   inurl:word           → sent as a plain word; the result's address is
 *                          checked afterwards (bingSearchMapper)
 */

/** A phrase in query syntax. The parser never leaves a quote inside one. */
const quote = value => `"${String(value).replace(/"/g, '')}"`;
const alternative = ({ type, value }) => (type === 'phrase' ? quote(value) : value);

/**
 * @param {import('../opensearch/queryParser').ParsedQuery} parsed
 * @param {Object} filters  page, sort, category, domain, dateWindow, language
 * @returns {{skip: true, reason: string}
 *          | {skip: false, keyword: string, page: number, size: number, cc: string}}
 */
function buildBingRequest(parsed, filters = {}) {
  const { page = 1, sort = 'relevance', category = 'all', domain = '', language = '' } = filters;
  const dateWindow = filters.dateWindow || 'any';

  // The same rules as every external provider: first page of a web search.
  if (page !== 1) return { skip: true, reason: 'not_first_page' };
  if (category !== 'all') return { skip: true, reason: 'not_web_search' };
  if (sort !== 'relevance') return { skip: true, reason: 'date_sort' };
  if (!parsed || parsed.isEmpty) return { skip: true, reason: 'empty_query' };
  if (parsed.excludedLanguages.length > 0) return { skip: true, reason: 'unsupported_operator' };
  if (dateWindow !== 'any') return { skip: true, reason: 'unsupported_filter' };

  let languages = parsed.languages;
  if (language) {
    if (languages.length > 0 && !languages.includes(language)) {
      return { skip: true, reason: 'conflicting_filters' };
    }
    languages = [language];
  }
  if (languages.length > 1) return { skip: true, reason: 'unsupported_filter' };

  const parts = [];
  const words = parsed.orGroups.length > 0 ? parsed.plainTerms : parsed.terms;
  parts.push(...words, ...parsed.phrases.map(quote));
  for (const group of parsed.orGroups) parts.push(group.map(alternative).join(' OR '));
  parts.push(...parsed.titleTerms.map(t => `intitle:${t}`));
  parts.push(...parsed.titlePhrases.map(p => `intitle:${quote(p)}`));
  // Bing has no dependable inurl:, so the words are searched for and the
  // address is checked on the results.
  parts.push(...parsed.urlTerms, ...parsed.urlPhrases.map(quote));

  if (parts.length === 0) return { skip: true, reason: 'no_search_text' };

  const sites = [...parsed.sites];
  if (domain && !sites.includes(domain)) sites.push(domain);
  if (sites.length === 1) parts.push(`site:${sites[0]}`);
  else if (sites.length > 1) parts.push(`(${sites.map(s => `site:${s}`).join(' OR ')})`);

  parts.push(...parsed.excludedTerms.map(t => `-${t}`));
  parts.push(...parsed.excludedPhrases.map(p => `-${quote(p)}`));
  parts.push(...parsed.excludedSites.map(s => `-site:${s}`));
  parts.push(...parsed.excludedTitleTerms.map(t => `-intitle:${t}`));
  parts.push(...parsed.excludedTitlePhrases.map(p => `-intitle:${quote(p)}`));
  if (languages.length === 1) parts.push(`language:${languages[0]}`);

  return {
    skip: false,
    keyword: parts.join(' '),
    page: 0,
    size: config.bing.maxResults,
    cc: config.bing.cc
  };
}

module.exports = { buildBingRequest };
