const cheerio = require('cheerio');

/**
 * Text processing pipeline (Phase 4):
 *
 *   HTML -> clean text -> tokenise -> stop-word removal
 *        -> normalisation -> term frequency
 */

// Common English function words that carry no retrieval value.
// (Kept identical to the original list so existing index data stays valid.)
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'if',
  'in',
  'into',
  'is',
  'it',
  'no',
  'not',
  'of',
  'on',
  'or',
  'such',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'will',
  'with',
  'html',
  'body'
]);

const MIN_TOKEN_LENGTH = 2;
const MAX_TOKEN_LENGTH = 50;

// Elements whose text is never page content.
const NON_CONTENT_SELECTORS = 'script, style, noscript, template, svg, iframe, object, embed';

/**
 * Strips markup and returns the page's visible text.
 *
 * @param {string} html
 * @returns {string} whitespace-normalised plain text ('' when unparseable)
 */
function extractText(html) {
  if (!html || typeof html !== 'string') return '';

  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    // Fall back to a crude tag strip rather than losing the document.
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  $(NON_CONTENT_SELECTORS).remove();

  // <body> when the document has one, otherwise the whole fragment.
  const root = $('body').length > 0 ? $('body') : $.root();
  return root.text().replace(/\s+/g, ' ').trim();
}

/**
 * Full HTML -> tokens pipeline.
 *
 * @param {string} html
 * @returns {Array<string>} normalised tokens, stop words removed
 */
function processHtml(html) {
  if (!html) return [];
  return tokenizeText(extractText(html));
}

/**
 * Normalises and tokenises plain text.
 *
 * Lowercases, replaces every non-alphanumeric character with a separator,
 * splits on whitespace, then drops stop words and tokens outside the
 * accepted length range.
 *
 * @param {string} text
 * @returns {Array<string>}
 */
function tokenizeText(text) {
  if (!text || typeof text !== 'string') return [];

  const cleaned = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');

  const tokens = [];
  for (const token of cleaned.split(/\s+/)) {
    if (!token) continue;
    if (token.length < MIN_TOKEN_LENGTH) continue;
    if (token.length > MAX_TOKEN_LENGTH) continue;
    if (STOP_WORDS.has(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

/**
 * Counts occurrences of each token.
 *
 * @param {Array<string>} tokens
 * @returns {Object<string, number>} term -> frequency
 */
function calculateFrequencies(tokens) {
  const frequencies = Object.create(null);
  if (!Array.isArray(tokens)) return {};

  for (const token of tokens) {
    frequencies[token] = (frequencies[token] || 0) + 1;
  }
  // Return a plain object so callers can use Object.entries/JSON safely.
  return Object.assign({}, frequencies);
}

module.exports = {
  processHtml,
  extractText,
  tokenizeText,
  calculateFrequencies,
  STOP_WORDS,
  MIN_TOKEN_LENGTH,
  MAX_TOKEN_LENGTH
};
