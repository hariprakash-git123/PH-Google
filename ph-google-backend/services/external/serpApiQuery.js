/**
 * Translates a PH search into a Google query for SerpApi.
 *
 * Built from queryParser's structured output, never from the raw text, so it
 * inherits the parser's decisions: a site: that is not a domain, a lang:
 * that is not a language, "-site:" with nothing after it — everything the
 * parser dropped stays dropped, and nothing is searched for that the index
 * search would not search for.
 *
 * Google understands nearly every PH operator (site:, -site:, intitle:,
 * inurl:, "phrases", -word, OR). The differences:
 *
 *   lang:xx / language  → the `lr` parameter (lang_xx), not query text
 *   date window         → the `tbs` parameter (qdr:h|d|w|m|y)
 *   AND                 → nothing: Google requires every word anyway
 *   -lang:xx            → no Google equivalent: SerpApi is skipped
 *   sort newest/oldest  → no Google equivalent: SerpApi is skipped
 *
 * Question openers are kept ("how does gravity work"): stripping them is a
 * ranking aid for the index, and Google handles natural language itself.
 */

const DATE_TBS = { hour: 'qdr:h', day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' };

/** A phrase in Google syntax. The parser never leaves a quote inside one. */
const quote = value => `"${String(value).replace(/"/g, '')}"`;

/** One OR alternative, as typed. */
const alternative = ({ type, value }) => (type === 'phrase' ? quote(value) : value);

/**
 * @param {import('../opensearch/queryParser').ParsedQuery} parsed
 * @param {Object} filters  the request's own parameters
 * @param {number} [filters.page]
 * @param {string} [filters.sort]
 * @param {string} [filters.category]  absent for web search
 * @param {string} [filters.domain]
 * @param {string} [filters.dateWindow]
 * @param {string} [filters.language]
 * @returns {{skip: true, reason: string} | {skip: false, q: string, params: Object}}
 */
function buildSerpApiRequest(parsed, filters = {}) {
  const { page = 1, sort = 'relevance', category = 'all', domain = '', language = '' } = filters;
  const dateWindow = filters.dateWindow || 'any';

  // Only the first page of a web search is ever augmented.
  if (page !== 1) return { skip: true, reason: 'not_first_page' };
  if (category !== 'all') return { skip: true, reason: 'not_web_search' };
  if (sort !== 'relevance') return { skip: true, reason: 'date_sort' };
  if (!parsed || parsed.isEmpty) return { skip: true, reason: 'empty_query' };
  if (parsed.excludedLanguages.length > 0) return { skip: true, reason: 'unsupported_operator' };

  // The language the results must be in: the lang: operators, narrowed by
  // the language parameter exactly as the index's two filters would be.
  let languages = parsed.languages;
  if (language) {
    if (languages.length > 0 && !languages.includes(language)) {
      return { skip: true, reason: 'conflicting_filters' };
    }
    languages = [language];
  }

  const parts = [];

  // Free text: words outside any OR group, phrases, then the groups.
  const grouped = parsed.orGroups.length > 0;
  const words = grouped ? parsed.plainTerms : parsed.terms;
  parts.push(...words, ...parsed.phrases.map(quote));
  for (const group of parsed.orGroups) parts.push(group.map(alternative).join(' OR '));

  // Field restrictions.
  parts.push(...parsed.titleTerms.map(t => `intitle:${t}`));
  parts.push(...parsed.titlePhrases.map(p => `intitle:${quote(p)}`));
  parts.push(...parsed.urlTerms.map(t => `inurl:${t}`));
  parts.push(...parsed.urlPhrases.map(p => `inurl:${quote(p)}`));

  // Something positive to look for. A query of exclusions, sites or a
  // language alone lists pages in the index; Google needs words.
  if (parts.length === 0) return { skip: true, reason: 'no_search_text' };

  const sites = [...parsed.sites];
  if (domain && !sites.includes(domain)) sites.push(domain);
  if (sites.length === 1) parts.push(`site:${sites[0]}`);
  else if (sites.length > 1) parts.push(sites.map(s => `site:${s}`).join(' OR '));

  parts.push(...parsed.excludedTerms.map(t => `-${t}`));
  parts.push(...parsed.excludedPhrases.map(p => `-${quote(p)}`));
  parts.push(...parsed.excludedSites.map(s => `-site:${s}`));
  parts.push(...parsed.excludedTitleTerms.map(t => `-intitle:${t}`));
  parts.push(...parsed.excludedTitlePhrases.map(p => `-intitle:${quote(p)}`));
  parts.push(...parsed.excludedUrlTerms.map(t => `-inurl:${t}`));
  parts.push(...parsed.excludedUrlPhrases.map(p => `-inurl:${quote(p)}`));

  const params = {};
  if (languages.length > 0) params.lr = languages.map(l => `lang_${l}`).join('|');
  if (DATE_TBS[dateWindow]) params.tbs = DATE_TBS[dateWindow];

  return { skip: false, q: parts.join(' '), params };
}

/** The SerpApi engine behind each vertical. */
const VERTICAL_ENGINES = {
  images: 'google_images',
  videos: 'google_videos',
  maps: 'google_maps'
};

/**
 * A request for the image, video or map vertical.
 *
 * Images and videos take the same Google query as web search (operators,
 * site:, the domain/language/date filters), built by buildSerpApiRequest.
 * The vertical has no date sort of its own, so the sort is not a reason to
 * skip: results come in Google's order.
 *
 * Maps takes plain words: operators mean nothing to a map search, so only
 * the query's words and phrases are sent, and the filters do not apply.
 *
 * Every vertical asks for SerpApi's first page only; later pages of the
 * vertical are cut from that one response (see services/externalVerticals.js).
 *
 * @param {import('../opensearch/queryParser').ParsedQuery} parsed
 * @param {'images'|'videos'|'maps'} vertical
 * @param {Object} [filters]  domain, dateWindow, language
 * @returns {{skip: true, reason: string} | {skip: false, engine: string, q: string, params: Object}}
 */
function buildVerticalRequest(parsed, vertical, filters = {}) {
  const engine = VERTICAL_ENGINES[vertical];
  if (!engine) return { skip: true, reason: 'not_web_search' };
  if (!parsed || parsed.isEmpty) return { skip: true, reason: 'empty_query' };

  if (vertical === 'maps') {
    const words = [...parsed.terms, ...parsed.phrases];
    for (const group of parsed.orGroups) words.push(...group.map(a => a.value));
    const q = words.join(' ').trim();
    if (!q) return { skip: true, reason: 'no_search_text' };
    return { skip: false, engine, q, params: { type: 'search' } };
  }

  const web = buildSerpApiRequest(parsed, {
    page: 1,
    sort: 'relevance',
    category: 'all',
    domain: filters.domain || '',
    dateWindow: filters.dateWindow || 'any',
    language: filters.language || ''
  });
  if (web.skip) return web;
  return { skip: false, engine, q: web.q, params: web.params };
}

module.exports = { buildSerpApiRequest, buildVerticalRequest, DATE_TBS, VERTICAL_ENGINES };
