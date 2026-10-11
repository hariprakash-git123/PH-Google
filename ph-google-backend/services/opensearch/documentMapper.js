const crypto = require('crypto');
const {
  normalizeUrl,
  hostnameOf,
  canonicalKey,
  rootDomainOf,
  pathOf
} = require('../../utils/urlNormalizer');
const { tokenizeText } = require('../../utils/textProcessor');

/**
 * Turns a crawled page into the document stored in OpenSearch.
 *
 * Two responsibilities beyond field mapping:
 *
 *  1. Deduplication keys. `urlHash` collapses the http/https/www/tracking
 *     variants of one address; `contentHash` catches the same body text
 *     served at genuinely different URLs.
 *
 *  2. Quality signals. These are computed once at index time rather than at
 *     query time, so scoring a result costs nothing extra.
 */

const MAX_CONTENT_CHARS = 60000; // enough for relevance, bounded for storage
const MAX_HEADING_CHARS = 4000;

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

/**
 * The document _id. Derived from the canonical URL, so re-crawling a page —
 * or crawling the www/http variant of it — updates the same document rather
 * than creating a duplicate.
 */
function buildDocumentId(url) {
  const key = canonicalKey(url);
  return key ? sha1(key) : null;
}

/**
 * Measures how much of the text is distinct.
 *
 * A page repeating one phrase thousands of times to game keyword counts
 * scores near zero here; ordinary prose sits around 0.3–0.6. This is what
 * stops "contains huge amounts of repeated text" from being rewarded.
 *
 * @returns {number} 0..1
 */
function uniqueWordRatio(text) {
  const tokens = tokenizeText(text || '');
  if (tokens.length === 0) return 0;
  return Number((new Set(tokens).size / tokens.length).toFixed(3));
}

/**
 * A 0..1 quality score from signals available at index time.
 *
 * Deliberately gentle: it is a multiplier on relevance, not a replacement
 * for it. A high-quality page that does not match the query must not
 * outrank a lower-quality page that does.
 */
function computeQualityScore({
  wordCount,
  uniqueRatio,
  hasDescription,
  titleLength,
  statusCode,
  outboundLinkCount
}) {
  let score = 0.5;

  // Substance: very thin pages are usually navigation or stubs.
  if (wordCount >= 2000) score += 0.15;
  else if (wordCount >= 500) score += 0.12;
  else if (wordCount >= 150) score += 0.06;
  else if (wordCount < 50) score -= 0.2;

  // Repetition is the clearest spam signal available without a model.
  if (uniqueRatio >= 0.45) score += 0.12;
  else if (uniqueRatio >= 0.25) score += 0.05;
  else if (uniqueRatio > 0 && uniqueRatio < 0.12) score -= 0.25;

  // A curated description usually means a curated page.
  if (hasDescription) score += 0.08;

  // A missing title, or one stuffed with keywords, both read badly.
  if (titleLength >= 15 && titleLength <= 80) score += 0.08;
  else if (titleLength === 0) score -= 0.15;
  else if (titleLength > 150) score -= 0.08;

  // Some outbound links suggest a real document rather than a doorway page.
  if (outboundLinkCount > 0) score += 0.04;

  // Anything that did not return 200 is a weaker result.
  if (statusCode && statusCode !== 200) score -= 0.15;

  return Number(Math.max(0.05, Math.min(1, score)).toFixed(3));
}

/**
 * Collapses extracted headings into one searchable string.
 * Accepts an array, an object of h1/h2/h3 arrays, or a plain string.
 */
function flattenHeadings(headings) {
  if (!headings) return '';

  let parts = [];
  if (typeof headings === 'string') parts = [headings];
  else if (Array.isArray(headings)) parts = headings;
  else if (typeof headings === 'object') {
    for (const key of ['h1', 'h2', 'h3']) {
      const value = headings[key];
      if (Array.isArray(value)) parts.push(...value);
      else if (typeof value === 'string') parts.push(value);
    }
  }

  return parts
    .filter(Boolean)
    .map(p => String(p).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ')
    .slice(0, MAX_HEADING_CHARS);
}

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Maps a Page document (or an equivalent plain object from the crawler) to
 * the OpenSearch document.
 *
 * @param {Object} page  Page model document or crawl result
 * @param {Object} [extra] Crawl-time values not stored on the Page
 * @returns {{id: string, document: Object}|null} null when the URL is unusable
 */
function toSearchDocument(page, extra = {}) {
  if (!page || !page.url) return null;

  const displayUrl = normalizeUrl(page.url) || page.url;
  const id = buildDocumentId(displayUrl);
  if (!id) return null;

  const content = String(page.content || '').slice(0, MAX_CONTENT_CHARS);
  const title = String(page.title || '').trim();
  const description = String(page.description || '').trim();
  const headings = flattenHeadings(extra.headings ?? page.headings);

  const wordCount = content ? content.split(/\s+/).filter(Boolean).length : 0;
  const uniqueRatio = uniqueWordRatio(content);
  const statusCode = extra.statusCode ?? page.statusCode ?? 200;
  const outboundLinkCount = extra.outboundLinkCount ?? page.outboundLinkCount ?? 0;

  const document = {
    pageId: page._id ? String(page._id) : '',

    url: displayUrl,
    canonicalUrl: extra.canonicalUrl || page.canonicalUrl || displayUrl,
    urlHash: id,
    contentHash: content ? sha1(content.slice(0, 20000)) : '',

    domain: page.domain || hostnameOf(displayUrl),
    rootDomain: rootDomainOf(displayUrl),
    path: pathOf(displayUrl),

    title,
    description,
    headings,
    content,
    keywords: String(page.keywords || '').trim(),

    language: (page.language || '').toLowerCase(),
    country: (extra.country || page.country || '').toLowerCase(),
    contentType: extra.contentType || page.contentType || 'text/html',
    statusCode,

    publishedAt: toDate(page.publishedAt),
    updatedAt: toDate(page.updatedAt),
    crawledAt: toDate(page.lastCrawledAt) || new Date().toISOString(),

    wordCount,
    uniqueWordRatio: uniqueRatio,
    titleLength: title.length,
    hasDescription: description.length > 0,
    outboundLinkCount,
    imageCount: page.imageCount || 0,
    videoCount: page.videoCount || 0,
    isArticle: Boolean(page.isArticle),

    author: String(page.author || '').slice(0, 256),
    section: String(page.section || '').slice(0, 128),
    siteName: String(page.siteName || '').slice(0, 256),
    imageUrl: String(page.imageUrl || '').slice(0, 2048)
  };

  // The source's own Last-Modified date, only when there is one: a document
  // without it simply lacks the field, so an index that predates the field
  // (strict mapping, see indexManager.ensureIndex) still accepts it.
  const modifiedAt = toDate(page.modifiedAt);
  if (modifiedAt) document.modifiedAt = modifiedAt;

  document.qualityScore = computeQualityScore({
    wordCount,
    uniqueRatio,
    hasDescription: document.hasDescription,
    titleLength: document.titleLength,
    statusCode,
    outboundLinkCount
  });

  return { id, document };
}

module.exports = {
  toSearchDocument,
  buildDocumentId,
  computeQualityScore,
  uniqueWordRatio,
  flattenHeadings,
  sha1,
  MAX_CONTENT_CHARS
};
