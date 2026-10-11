const { normalizeUrl, canonicalKey, hostnameOf } = require('../../utils/urlNormalizer');
const { sha1 } = require('../opensearch/documentMapper');
const { toDisplayUrl, getTimeAgo, dateLabelFor } = require('../opensearch/searchService');
const { respectsQuery } = require('./serpApiMapper');

/**
 * Turns Parallel Search results into the result objects the search page
 * already renders (see formatHit in opensearch/searchService.js) — the same
 * schema serpApiMapper.js produces, so the frontend does not change.
 *
 * A Parallel result is { url, title?, publish_date?, excerpts[] }. What it
 * does not have is left empty rather than invented: it was never crawled
 * (crawledAt null), its language is unknown, and its position in the list
 * is not a score (score null).
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
 * Excerpts arrive as markdown. A snippet is plain text, so the markup is
 * removed and the words kept: link and image targets, heading and list
 * markers, emphasis, code fences, table bars and any HTML tag.
 */
function plainText(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every excerpt as plain text, empty ones dropped. */
function excerptsOf(raw) {
  return (Array.isArray(raw.excerpts) ? raw.excerpts : [])
    .filter(e => typeof e === 'string')
    .map(plainText)
    .filter(Boolean);
}

/**
 * `publish_date` is documented as YYYY-MM-DD. Anything else, or a date that
 * cannot be right, is treated as no date.
 */
function readDate(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  // No date given: none shown (dateLabel null), never one made up.
  const none = { publishedAt: null, publishedAgo: 'Unknown', dateLabel: null };
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return none;
  const at = Date.parse(text.slice(0, 10));
  const plausible =
    Number.isFinite(at) && at > Date.UTC(1990, 0, 1) && at < Date.now() + 24 * 3600 * 1000;
  if (!plausible) return none;
  const iso = new Date(at).toISOString();
  return {
    publishedAt: iso,
    publishedAgo: getTimeAgo(iso),
    dateLabel: dateLabelFor({ publishedAt: iso, fromIndex: false })
  };
}

/**
 * @param {Object} raw  one entry of `results`
 * @param {number} index  its position in the list
 * @returns {Object|null} null when the result has no usable http(s) link
 */
function mapResult(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const url = normalizeUrl(typeof raw.url === 'string' ? raw.url : '');
  if (!url) return null;
  const key = canonicalKey(url);
  if (!key) return null;

  const excerpts = excerptsOf(raw);
  return {
    id: `parallel:${sha1(key)}`,
    url,
    displayUrl: toDisplayUrl(url),
    domain: hostnameOf(url),
    favicon: '\u{1F310}',
    title: clean(typeof raw.title === 'string' ? raw.title : '', 300) || url,
    snippet: clean(excerpts[0], SNIPPET_MAX) || NO_DESCRIPTION,
    ...readDate(raw.publish_date),
    crawledAt: null,
    // A provider result says nothing of when its page last changed.
    modifiedAt: null,
    modifiedLabel: null,
    language: '',
    category: 'Web',
    saved: false,
    score: null,
    source: 'parallel',
    sourceRank: index + 1
  };
}

/** Lowercase, whitespace collapsed — for comparing a phrase with page text. */
const fold = text =>
  String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ');

/**
 * Whether every quoted phrase of the query appears in what Parallel returned
 * for this page (its title and excerpts). Parallel has no exact-phrase
 * operator, so this is the only way a phrase search can be kept honest: a
 * result that does not show the phrase is not presented as matching it.
 */
function showsPhrases(raw, phrases) {
  if (!phrases || phrases.length === 0) return true;
  const text = fold([typeof raw.title === 'string' ? raw.title : '', ...excerptsOf(raw)].join(' '));
  return phrases.every(phrase => text.includes(fold(phrase)));
}

/**
 * Whether the result is dated on or after `afterDate` (YYYY-MM-DD). A result
 * with no date cannot be shown to be inside the window, so it is left out.
 */
function withinDate(result, afterDate) {
  if (!afterDate) return true;
  return Boolean(result.publishedAt) && result.publishedAt.slice(0, 10) >= afterDate;
}

/**
 * Maps, filters and de-duplicates a result list.
 *
 * Parallel is asked to apply the site and date restrictions itself; they are
 * re-checked here so a stray result cannot contradict what the user asked.
 *
 * @param {Array<Object>} rawResults
 * @param {Object} parsed  the query, from queryParser
 * @param {{domain?: string, afterDate?: string|null}} [filters]
 * @returns {Array<Object>} in Parallel's order; each page appears once
 */
function mapResults(rawResults, parsed, filters = {}) {
  const seen = new Set();
  const out = [];
  (Array.isArray(rawResults) ? rawResults : []).forEach((raw, i) => {
    const result = mapResult(raw, i);
    if (!result) return;
    if (!respectsQuery(result, parsed, filters)) return;
    if (!showsPhrases(raw, parsed.phrases)) return;
    if (!withinDate(result, filters.afterDate)) return;
    const key = canonicalKey(result.url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(result);
  });
  return out;
}

module.exports = { mapResult, mapResults, plainText, readDate, showsPhrases, withinDate };
