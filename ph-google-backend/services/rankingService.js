/**
 * Ranking engine.
 *
 * Final Score = Text Score + Title Score + Description Score + URL Score
 *             + Freshness Score + Term Coverage Score
 *
 * Every component is a small exported function so individual signals can be
 * unit-tested and re-weighted without touching the rest of the pipeline.
 * The Phase 6 weights are preserved as the defaults.
 */

const WEIGHTS = {
  termFrequencyCap: 50, // a spam page with 10,000 keywords must not auto-win
  title: 10, // exact match in <title> is heavily weighted
  description: 5, // match in meta description is moderate
  url: 10, // match in the url (e.g. "reactjs.org" for "react")
  freshnessRecent: 2, // crawled within the last 7 days
  freshnessMonth: 1, // crawled within the last 30 days
  coverage: 8 // bonus for matching *all* of the query's terms
};

/**
 * 1. Text score — how often the query terms appear in the body, taken from
 *    the inverted index and capped so keyword stuffing cannot dominate.
 */
function textScore(termFrequency, weights = WEIGHTS) {
  const frequency = Number(termFrequency) || 0;
  if (frequency <= 0) return 0;
  return Math.min(frequency, weights.termFrequencyCap);
}

/** 2. Title relevance. */
function titleScore(title, searchTerms, weights = WEIGHTS) {
  return countMatches(title, searchTerms) * weights.title;
}

/** 3. Description relevance. */
function descriptionScore(description, searchTerms, weights = WEIGHTS) {
  return countMatches(description, searchTerms) * weights.description;
}

/** 4. URL relevance. */
function urlScore(url, searchTerms, weights = WEIGHTS) {
  return countMatches(url, searchTerms) * weights.url;
}

/**
 * 5. Freshness — a graded boost rather than a cliff edge, so a page crawled
 *    8 days ago is not treated the same as one crawled two years ago.
 */
function freshnessScore(lastCrawledAt, weights = WEIGHTS) {
  if (!lastCrawledAt) return 0;

  const timestamp = new Date(lastCrawledAt).getTime();
  if (!Number.isFinite(timestamp)) return 0;

  const ageInDays = (Date.now() - timestamp) / (1000 * 60 * 60 * 24);
  if (ageInDays < 0) return 0; // clock skew / future date
  if (ageInDays < 7) return weights.freshnessRecent;
  if (ageInDays < 30) return weights.freshnessMonth;
  return 0;
}

/**
 * 6. Term coverage — a page matching every word of a multi-word query is a
 *    better answer than one matching a single word very often.
 */
function coverageScore(matchedTerms, totalTerms, weights = WEIGHTS) {
  if (!totalTerms || totalTerms <= 1) return 0;
  const matched = Math.min(Number(matchedTerms) || 0, totalTerms);
  return (matched / totalTerms) * weights.coverage;
}

/** Counts how many distinct search terms appear in a field. */
function countMatches(field, searchTerms) {
  if (!field || !Array.isArray(searchTerms) || searchTerms.length === 0) return 0;
  const haystack = String(field).toLowerCase();
  let hits = 0;
  for (const term of searchTerms) {
    if (term && haystack.includes(String(term).toLowerCase())) hits += 1;
  }
  return hits;
}

/**
 * Calculates the relevance score for one page.
 *
 * @param {Object} page            Page document (title, description, url, lastCrawledAt)
 * @param {Array<string>} searchTerms Normalised query tokens
 * @param {number} termFrequency   Summed body frequency from the inverted index
 * @param {Object} [options]       { matchedTerms, totalTerms, weights }
 * @returns {number}
 */
function calculateScore(page, searchTerms, termFrequency, options = {}) {
  const weights = options.weights || WEIGHTS;
  const terms = Array.isArray(searchTerms) ? searchTerms : [];

  return (
    textScore(termFrequency, weights) +
    titleScore(page && page.title, terms, weights) +
    descriptionScore(page && page.description, terms, weights) +
    urlScore(page && page.url, terms, weights) +
    freshnessScore(page && page.lastCrawledAt, weights) +
    coverageScore(options.matchedTerms, options.totalTerms, weights)
  );
}

/**
 * Returns the individual signal values for one page — used by the admin
 * tooling and tests to explain why a result ranked where it did.
 */
function explainScore(page, searchTerms, termFrequency, options = {}) {
  const weights = options.weights || WEIGHTS;
  const terms = Array.isArray(searchTerms) ? searchTerms : [];

  const breakdown = {
    text: textScore(termFrequency, weights),
    title: titleScore(page && page.title, terms, weights),
    description: descriptionScore(page && page.description, terms, weights),
    url: urlScore(page && page.url, terms, weights),
    freshness: freshnessScore(page && page.lastCrawledAt, weights),
    coverage: coverageScore(options.matchedTerms, options.totalTerms, weights)
  };
  breakdown.total = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
  return breakdown;
}

module.exports = {
  calculateScore,
  explainScore,
  textScore,
  titleScore,
  descriptionScore,
  urlScore,
  freshnessScore,
  coverageScore,
  countMatches,
  WEIGHTS
};
