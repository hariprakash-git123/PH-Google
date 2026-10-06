const { isSafeHttpUrl } = require('./contextService');

/**
 * Maps the model's citations back to real documents.
 *
 * The model only ever writes numbers. This module is the single place those
 * numbers become titles and links, and they are looked up in the evidence
 * set the backend built — so a citation can only point at a page the search
 * engine actually returned. A number outside that set is deleted, and so is
 * any web address the model wrote despite being told not to.
 *
 * Sources are returned renumbered 1..n in the order the answer first cites
 * them, with the answer's markers rewritten to match, so the reader sees
 * [1] [2] [3] rather than whatever the retrieval order happened to be.
 */

/** [1], [2, 3], [4][5] — one or more source numbers in square brackets. */
const MARKER = /\[(\s*\d+(?:\s*,\s*\d+)*\s*)\]/g;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;

function numbersIn(text) {
  const found = [];
  for (const match of String(text || '').matchAll(MARKER)) {
    for (const part of match[1].split(',')) found.push(Number(part.trim()));
  }
  return found;
}

/** Deletes web addresses and tidies the spacing left behind. */
function stripUrls(text) {
  return String(text || '')
    .replace(URL_PATTERN, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Rewrites markers through `mapping`, dropping numbers that are not in it. */
function rewriteMarkers(text, mapping) {
  return String(text || '')
    .replace(MARKER, (whole, inner) => {
      const kept = [];
      for (const part of inner.split(',')) {
        const mapped = mapping.get(Number(part.trim()));
        if (mapped && !kept.includes(mapped)) kept.push(mapped);
      }
      return kept.map(n => `[${n}]`).join('');
    })
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * @param {Object} params
 * @param {string} params.answer
 * @param {string[]} [params.keyPoints]
 * @param {number[]} [params.citedSources]  numbers the model listed
 * @param {Array<Object>} params.sources    the evidence set (index, title, url, …)
 * @returns {{answer: string, keyPoints: string[], sources: Array<Object>,
 *            invalidCitations: number[], citationCount: number}}
 */
function mapCitations({ answer, keyPoints = [], citedSources = [], sources }) {
  const byIndex = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    // A source that cannot be linked safely cannot be cited at all.
    if (source && Number.isInteger(source.index) && isSafeHttpUrl(source.url)) {
      byIndex.set(source.index, source);
    }
  }

  const cleanAnswer = stripUrls(answer);
  const cleanPoints = keyPoints.map(stripUrls).filter(Boolean);

  // Order of first appearance in the text decides the numbering.
  const inText = [...numbersIn(cleanAnswer), ...cleanPoints.flatMap(numbersIn)];
  const invalid = new Set();
  const mapping = new Map();
  for (const n of inText) {
    if (!byIndex.has(n)) {
      invalid.add(n);
      continue;
    }
    if (!mapping.has(n)) mapping.set(n, mapping.size + 1);
  }
  // Numbers the model listed but never placed in the text support nothing
  // the reader can see, so they are not shown as sources.
  for (const n of citedSources) {
    if (!byIndex.has(n)) invalid.add(n);
  }

  const mappedSources = Array.from(mapping.entries()).map(([original, renumbered]) => {
    const source = byIndex.get(original);
    return {
      index: renumbered,
      title: source.title,
      url: source.url,
      domain: source.domain,
      snippet: source.snippet,
      relevanceScore: source.relevanceScore,
      publishedAt: source.publishedAt || null,
      crawledAt: source.crawledAt || null
    };
  });

  return {
    answer: rewriteMarkers(cleanAnswer, mapping),
    keyPoints: cleanPoints.map(p => rewriteMarkers(p, mapping)).filter(Boolean),
    sources: mappedSources,
    invalidCitations: Array.from(invalid).sort((a, b) => a - b),
    citationCount: mapping.size
  };
}

module.exports = { mapCitations, stripUrls, numbersIn };
