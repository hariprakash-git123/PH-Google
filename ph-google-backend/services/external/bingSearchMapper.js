const { normalizeUrl, canonicalKey, hostnameOf } = require('../../utils/urlNormalizer');
const { sha1 } = require('../opensearch/documentMapper');
const { toDisplayUrl } = require('../opensearch/searchService');
const { respectsQuery } = require('./serpApiMapper');

/**
 * Turns Bing `data.items` into the result objects the search page already
 * renders — the same schema as index results and SerpApi's (see formatHit
 * and serpApiMapper.js), so the frontend needs nothing new.
 *
 *   title       → title
 *   link        → url (normalised; anything but http/https drops the result)
 *   description → snippet (plain text, capped)
 *   img         → not used: web results have no image field
 *
 * What Bing does not give is left empty rather than invented: no date, no
 * language, no score (Bing's order is not a score).
 */

const SNIPPET_MAX = 300;
const NO_DESCRIPTION = 'No description available.';

function clean(text, max) {
  const value = String(typeof text === 'string' || typeof text === 'number' ? text : '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > max ? `${value.slice(0, max).trim()}…` : value;
}

/**
 * @param {Object} raw  one entry of `data.items`
 * @param {number} index  its position in the list
 * @returns {Object|null} null when the item has no usable http(s) link
 */
function mapBingItem(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const url = normalizeUrl(typeof raw.link === 'string' ? raw.link : '');
  if (!url) return null;
  const key = canonicalKey(url);
  if (!key) return null;

  return {
    id: `bing:${sha1(key)}`,
    url,
    displayUrl: toDisplayUrl(url),
    domain: hostnameOf(url),
    favicon: '\u{1F310}',
    title: clean(raw.title, 300) || url,
    snippet: clean(raw.description, SNIPPET_MAX) || NO_DESCRIPTION,
    publishedAt: null,
    publishedAgo: 'Unknown',
    crawledAt: null,
    language: '',
    category: 'Bing Web',
    saved: false,
    score: null,
    source: 'bing',
    sourceRank: index + 1
  };
}

/**
 * Maps, filters and de-duplicates a list of Bing items.
 *
 * The query's own restrictions that an address can show — site:, -site:,
 * the domain filter, inurl: — are checked again here (respectsQuery), so a
 * stray result cannot contradict what was asked for.
 *
 * @returns {Array<Object>} in Bing's order; each page appears once
 */
function mapBingItems(rawItems, parsed, filters = {}) {
  const seen = new Set();
  const out = [];
  (Array.isArray(rawItems) ? rawItems : []).forEach((raw, i) => {
    const result = mapBingItem(raw, i);
    if (!result || !respectsQuery(result, parsed, filters)) return;
    const key = canonicalKey(result.url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(result);
  });
  return out;
}

module.exports = { mapBingItem, mapBingItems };
