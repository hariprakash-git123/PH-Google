const { tokenizeText } = require('../../utils/textProcessor');
const { canonicalKey } = require('../../utils/urlNormalizer');
const { config } = require('../../config/env');

/**
 * Turns retrieved documents into the evidence an AI answer is written from.
 *
 * Retrieved pages are untrusted text from the open web. Everything that
 * leaves this module has been cleaned, bounded and numbered: the numbers are
 * the only thing the model may cite, and the citation mapper resolves them
 * back to the documents listed here — never to anything the model wrote.
 *
 * Pure functions: no I/O, so the whole of context construction is unit
 * tested without a search cluster or a model.
 */

/** Sentences that are page furniture rather than content. */
const BOILERPLATE = [
  /\b(accept|allow|manage|reject) (all )?cookies?\b/i,
  /\bwe use cookies\b/i,
  /\bcookie (policy|settings|preferences|consent|notice)\b/i,
  /\b(privacy policy|terms of (use|service)|all rights reserved|©|copyright \d{4})\b/i,
  /\b(skip|jump) to (main )?(content|navigation|search)\b/i,
  /\b(sign|log) ?(in|up|out)\b.{0,40}\b(account|continue|subscribe)\b/i,
  /\bsubscribe to (our|the) newsletter\b/i,
  /\b(advertisement|sponsored content|ad choices)\b/i,
  /\b(share (this|on)|follow us on|tweet this)\b/i,
  /\bjavascript (is|must be) (disabled|enabled|required)\b/i,
  /\b(toggle|open|close) (the )?(menu|navigation|sidebar)\b/i,
  /^(home|menu|search|contents?|navigation|main page|related (articles|links))$/i
];

/** Query words that say nothing about the topic. */
const QUESTION_WORDS = new Set([
  'what',
  'whats',
  'who',
  'whom',
  'whose',
  'when',
  'where',
  'which',
  'why',
  'how',
  'does',
  'did',
  'can',
  'could',
  'should',
  'would',
  'explain',
  'define',
  'tell',
  'about',
  'vs',
  'versus'
]);

/** Zero-width and direction-control characters, which can hide text from a reader. */
const INVISIBLE_CHARACTERS = new RegExp('[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]', 'g');

const MIN_SENTENCE_CHARS = 25;
const MIN_SOURCE_CHARS = 60;
const PASSAGE_TARGET_CHARS = 420;

/** Only http(s) links may ever be shown or cited. */
function isSafeHttpUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Makes a piece of web text safe to place inside the prompt.
 *
 * Control characters go; whitespace collapses; and angle brackets become
 * look-alikes, so page text cannot close the tag its evidence sits in or
 * open one that looks like an instruction block.
 */
function sanitizeText(value, maxLength = Infinity) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? value : String(value);
  text = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(INVISIBLE_CHARACTERS, '')
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

/** The topic words of a query, lowercased, without question words. */
function queryTerms(query) {
  const terms = tokenizeText(String(query || '')).filter(t => !QUESTION_WORDS.has(t));
  return Array.from(new Set(terms));
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(‘“])|\s*[•·|]\s*|\s{2,}/)
    .map(s => s.trim())
    .filter(Boolean);
}

function isBoilerplate(sentence) {
  if (sentence.length < MIN_SENTENCE_CHARS) return true;
  // A run of short capitalised fragments is a menu, not prose.
  const words = sentence.split(' ');
  // (A full stop at the very end does not make it a sentence.)
  if (words.length >= 6 && !/[.!?,;:]/.test(sentence.replace(/[.!?]+$/, ''))) {
    const capitalised = words.filter(w => /^[A-Z]/.test(w)).length;
    if (capitalised / words.length > 0.8) return true;
  }
  return BOILERPLATE.some(pattern => pattern.test(sentence));
}

/** Removes page furniture, keeping the order of what remains. */
function cleanContent(text) {
  const seen = new Set();
  const kept = [];
  for (const sentence of splitSentences(text)) {
    if (isBoilerplate(sentence)) continue;
    // Repeated lines (a footer on every section, a duplicated teaser).
    const key = sentence.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(sentence);
  }
  return kept;
}

/** Groups consecutive sentences into passages of roughly one paragraph. */
function toPassages(sentences) {
  const passages = [];
  let current = [];
  let length = 0;
  for (const sentence of sentences) {
    if (length > 0 && length + sentence.length > PASSAGE_TARGET_CHARS) {
      passages.push(current.join(' '));
      current = [];
      length = 0;
    }
    current.push(sentence);
    length += sentence.length + 1;
  }
  if (current.length > 0) passages.push(current.join(' '));
  return passages;
}

/** How many distinct query terms a passage contains, plus a little for density. */
function scorePassage(passage, terms) {
  if (terms.length === 0) return 0;
  const tokens = tokenizeText(passage);
  if (tokens.length === 0) return 0;
  const present = new Set(tokens);
  let distinct = 0;
  let occurrences = 0;
  for (const term of terms) {
    if (!present.has(term)) continue;
    distinct += 1;
    occurrences += tokens.filter(t => t === term).length;
  }
  return distinct + Math.min(occurrences / tokens.length, 0.5);
}

/** Cuts at a sentence end when one is near; otherwise at a word. */
function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const sentenceEnd = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? ')
  );
  if (sentenceEnd > maxChars * 0.6) return slice.slice(0, sentenceEnd + 1).trim();
  const wordEnd = slice.lastIndexOf(' ');
  return `${slice.slice(0, wordEnd > 0 ? wordEnd : maxChars).trim()}…`;
}

/**
 * The part of one document worth showing the model: the passages that talk
 * about the query, in their original order, within the per-source budget.
 *
 * @returns {{text: string, matchScore: number}}
 */
function extractEvidence(doc, terms, maxChars) {
  const description = sanitizeText(doc.description, 600);
  const sentences = cleanContent(sanitizeText(doc.content));
  const passages = toPassages(sentences);

  const scored = passages.map((text, position) => ({
    text,
    position,
    score: scorePassage(text, terms)
  }));
  const bestScore = scored.reduce((max, p) => Math.max(max, p.score), 0);

  // Best passages first; the opening of the page breaks ties, because an
  // introduction usually says what the thing is.
  const ranked = scored
    .filter(p => (bestScore > 0 ? p.score > 0 : p.position < 2))
    .sort((a, b) => b.score - a.score || a.position - b.position);

  const chosen = [];
  let used = 0;
  const lead = description && !isBoilerplate(description) ? description : '';
  if (lead) used += lead.length + 1;

  for (const passage of ranked) {
    if (used >= maxChars) break;
    // The description is often the page's first sentence verbatim.
    if (lead && passage.text.startsWith(lead.slice(0, 80))) continue;
    const room = maxChars - used;
    const text = passage.text.length > room ? truncate(passage.text, room) : passage.text;
    if (text.length < MIN_SENTENCE_CHARS) continue;
    chosen.push({ ...passage, text });
    used += text.length + 1;
  }

  chosen.sort((a, b) => a.position - b.position);
  const text = truncate([lead, ...chosen.map(p => p.text)].filter(Boolean).join(' '), maxChars);
  const descriptionScore = lead ? scorePassage(lead, terms) : 0;
  return { text, matchScore: Math.max(bestScore, descriptionScore) };
}

/**
 * Builds the numbered evidence set.
 *
 * @param {Object} params
 * @param {string} params.query
 * @param {Array<Object>} params.documents  ranked best-first; each needs at
 *   least a url, and usually title, domain, snippet, score, content
 * @param {Object} [params.limits] overrides of the configured budgets
 * @returns {{sources: Array<Object>, totalChars: number, stats: Object}}
 */
function buildContext({ query, documents, limits = {} }) {
  const maxSources = limits.maxSources ?? config.ai.maxSources;
  const maxCharsPerSource = limits.maxCharsPerSource ?? config.ai.maxCharsPerSource;
  const maxContextChars = limits.maxContextChars ?? config.ai.maxContextChars;

  const terms = queryTerms(query);
  const stats = { candidates: 0, malformed: 0, duplicates: 0, empty: 0, overBudget: 0 };
  const seenUrls = new Set();
  const seenContent = new Set();
  const sources = [];
  let totalChars = 0;

  for (const doc of Array.isArray(documents) ? documents : []) {
    stats.candidates += 1;

    if (!doc || typeof doc !== 'object' || !isSafeHttpUrl(doc.url)) {
      stats.malformed += 1;
      continue;
    }
    const url = doc.url.trim();
    const urlKey = canonicalKey(url) || url.toLowerCase();
    if (seenUrls.has(urlKey)) {
      stats.duplicates += 1;
      continue;
    }

    const remaining = maxContextChars - totalChars;
    if (sources.length >= maxSources || remaining < MIN_SOURCE_CHARS) {
      stats.overBudget += 1;
      continue;
    }

    const evidence = extractEvidence(doc, terms, Math.min(maxCharsPerSource, remaining));
    if (evidence.text.length < MIN_SOURCE_CHARS) {
      stats.empty += 1;
      continue;
    }

    // The same article syndicated at another address is one source, not two.
    // Matched on the index's content hash when there is one, and on the
    // evidence text itself either way.
    const contentKeys = [`text:${evidence.text.toLowerCase()}`];
    if (typeof doc.contentHash === 'string' && doc.contentHash) {
      contentKeys.push(`hash:${doc.contentHash}`);
    }
    if (contentKeys.some(key => seenContent.has(key))) {
      stats.duplicates += 1;
      continue;
    }

    seenUrls.add(urlKey);
    for (const key of contentKeys) seenContent.add(key);
    totalChars += evidence.text.length;

    const score = Number(doc.score);
    sources.push({
      index: sources.length + 1,
      id: doc.id ? String(doc.id) : urlKey,
      title: sanitizeText(doc.title, 200) || url,
      url,
      domain: sanitizeText(doc.domain, 120) || new URL(url).hostname,
      snippet: sanitizeText(doc.snippet, 320),
      relevanceScore: Number.isFinite(score) ? Number(score.toFixed(3)) : 0,
      publishedAt: doc.publishedAt || null,
      crawledAt: doc.crawledAt || null,
      matchScore: Number(evidence.matchScore.toFixed(3)),
      evidence: evidence.text
    });
  }

  return { sources, totalChars, stats, terms };
}

module.exports = {
  buildContext,
  extractEvidence,
  cleanContent,
  sanitizeText,
  queryTerms,
  isSafeHttpUrl,
  truncate
};
