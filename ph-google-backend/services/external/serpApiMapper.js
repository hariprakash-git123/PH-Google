const { normalizeUrl, canonicalKey, hostnameOf } = require('../../utils/urlNormalizer');
const { sha1 } = require('../opensearch/documentMapper');
const { toDisplayUrl, getTimeAgo } = require('../opensearch/searchService');

/**
 * Turns SerpApi `organic_results` into the result objects the search page
 * already renders (see formatHit in opensearch/searchService.js), so the
 * frontend gets one schema whichever source a result came from.
 *
 * What does not exist for an external result is left empty rather than
 * invented: it was never crawled (crawledAt null), its language is unknown,
 * and Google's order is not a score (score null).
 */

const SNIPPET_MAX = 300;
const NO_DESCRIPTION = 'No description available.';

/** Collapses whitespace and caps the length the way buildSnippet does. */
function clean(text, max) {
  const value = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > max ? `${value.slice(0, max).trim()}…` : value;
}

/**
 * SerpApi's `date` is display text: "Mar 3, 2025" or "3 days ago". A real
 * date becomes publishedAt; relative wording is shown as written.
 */
function readDate(raw) {
  const text = clean(raw, 40);
  if (!text) return { publishedAt: null, publishedAgo: 'Unknown' };
  const at = Date.parse(text);
  const plausible =
    Number.isFinite(at) && at > Date.UTC(1990, 0, 1) && at < Date.now() + 24 * 3600 * 1000;
  if (plausible) {
    const iso = new Date(at).toISOString();
    return { publishedAt: iso, publishedAgo: getTimeAgo(iso) };
  }
  return { publishedAt: null, publishedAgo: /\bago$/i.test(text) ? text : 'Unknown' };
}

/** The deduplication key — the same one that makes an index document's _id. */
function keyOf(url) {
  return canonicalKey(url);
}

/**
 * @param {Object} raw  one entry of `organic_results`
 * @param {number} index  its position in the list (fallback for `position`)
 * @returns {Object|null} null when the result has no usable http(s) link
 */
function mapOrganicResult(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const url = normalizeUrl(typeof raw.link === 'string' ? raw.link : '');
  if (!url) return null;
  const key = keyOf(url);
  if (!key) return null;

  const position = Number(raw.position);
  return {
    id: `serpapi:${sha1(key)}`,
    url,
    displayUrl: toDisplayUrl(url),
    domain: hostnameOf(url),
    favicon: '\u{1F310}',
    title: clean(raw.title, 300) || url,
    snippet: clean(raw.snippet, SNIPPET_MAX) || NO_DESCRIPTION,
    ...readDate(raw.date),
    crawledAt: null,
    language: '',
    category: 'Google Web',
    saved: false,
    score: null,
    source: 'serpapi',
    sourceRank: Number.isInteger(position) && position > 0 ? position : index + 1
  };
}

/** Whether `host` is `site` or one of its subdomains ("www." ignored). */
function onSite(host, site) {
  const h = host.replace(/^www\./, '');
  const s = site.replace(/^www\./, '');
  return h === s || h.endsWith(`.${s}`);
}

/**
 * Re-checks what can be checked on a search result against the query's
 * restrictions. Google applies them already; this keeps a stray result from
 * contradicting what the user asked for. Only the address can be checked —
 * an external result has no page text here.
 */
function respectsQuery(result, parsed, { domain = '' } = {}) {
  const host = result.domain;
  const url = result.url.toLowerCase();

  const sites = [...parsed.sites, ...(domain ? [domain] : [])];
  if (sites.length > 0 && !sites.some(site => onSite(host, site))) return false;
  if (parsed.excludedSites.some(site => onSite(host, site))) return false;
  if (parsed.urlTerms.some(term => !url.includes(term.toLowerCase()))) return false;
  if (parsed.excludedUrlTerms.some(term => url.includes(term.toLowerCase()))) return false;
  return true;
}

/**
 * Maps, filters and de-duplicates a list of organic results.
 *
 * @param {Array<Object>} rawResults
 * @param {Object} parsed  the query, from queryParser
 * @param {{domain?: string}} [filters]
 * @returns {Array<Object>} in Google's order; each key appears once
 */
function mapOrganicResults(rawResults, parsed, filters = {}) {
  const seen = new Set();
  const out = [];
  (Array.isArray(rawResults) ? rawResults : []).forEach((raw, i) => {
    const result = mapOrganicResult(raw, i);
    if (!result || !respectsQuery(result, parsed, filters)) return;
    const key = keyOf(result.url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(result);
  });
  return out;
}

module.exports = { mapOrganicResult, mapOrganicResults, respectsQuery, readDate, keyOf };
