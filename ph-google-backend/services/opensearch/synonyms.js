/**
 * Synonym configuration.
 *
 * Kept deliberately small and curated. A large scraped synonym list makes
 * relevance worse, not better: it pulls in documents that merely share a
 * loosely-related word and dilutes precise queries.
 *
 * Format is Solr-style, which is what OpenSearch's synonym_graph filter
 * expects:
 *
 *   "a, b, c"        equivalent — any one matches the others
 *   "a, b => c"      explicit mapping — a and b are rewritten to c
 *
 * These are applied at *search* time only (see indexSettings.js), so adding
 * a line here takes effect without reindexing a single document.
 */

const SYNONYMS = [
  // --- Technology ---------------------------------------------------
  'ai, artificial intelligence',
  'ml, machine learning',
  'js, javascript',
  'ts, typescript',
  'py, python',
  'db, database',
  'os, operating system',
  'ui, user interface',
  'ux, user experience',
  'api, application programming interface',
  'cpu, processor',
  'gpu, graphics card',
  'pc, computer',
  'laptop, notebook computer',
  'cellphone, mobile phone, smartphone',
  'www, web, internet',

  // --- Everyday -------------------------------------------------------
  'car, automobile, motorcar',
  'tv, television',
  'film, movie',
  'photo, photograph, picture',
  'doctor, physician',
  'holiday, vacation',
  'football, soccer',
  'bike, bicycle',
  'plane, aeroplane, airplane',
  'kid, child',

  // --- Places / spelling variants --------------------------------------
  'usa, united states, america',
  'uk, united kingdom, britain',
  'uae, united arab emirates',
  'mumbai, bombay',
  'chennai, madras',
  'kolkata, calcutta',
  'bengaluru, bangalore'
];

/**
 * Lines are validated at index-creation time: one malformed entry makes
 * OpenSearch reject the whole index, which is a confusing failure to debug.
 *
 * @returns {string[]} the usable synonym rules
 */
function getSynonyms() {
  return SYNONYMS.filter(isValidRule);
}

function isValidRule(rule) {
  if (typeof rule !== 'string') return false;
  const line = rule.trim();
  if (!line || line.startsWith('#')) return false;

  // Explicit mapping: both sides must be non-empty.
  if (line.includes('=>')) {
    const [left, right] = line.split('=>');
    return Boolean(left && left.trim() && right && right.trim());
  }

  // Equivalence: at least two distinct terms.
  const terms = line
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
  return terms.length >= 2;
}

module.exports = { getSynonyms, isValidRule, SYNONYMS };
