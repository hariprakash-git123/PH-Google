const navigational = require('./navigational');

/**
 * What kind of search a query is, from its own words — only where the words
 * say so. Used to decide whether recency should count (time-sensitive), and
 * reported with the results; it never changes which pages match.
 *
 *   navigational     the query names a site to go to ("youtube", "github.com")
 *                    — navigational.detect, unchanged
 *   time-sensitive   it asks for something recent: "latest", "news", "today",
 *                    "this week", "breaking", "update(s)", "release(s)",
 *                    "announced", "upcoming", or this year or last named in it
 *   comparison       "vs", "versus", "compare", "difference between", "better than"
 *   informational    anything else (questions included; `question` says which)
 *
 * Words left out on purpose, because they are ordinary parts of names and
 * subjects: "new" (New York), "live" (live music), "current" (electric
 * current), "now".
 */

const TIME_WORDS =
  /\b(latest|news|today|tonight|yesterday|breaking|this (week|month|year)|updates?|releases?|released|announce[sd]?|upcoming|schedule)\b/i;
const COMPARISON = /\b(vs\.?|versus|compare[ds]?|comparison|difference between|better than)\b/i;
const QUESTION = /^\s*(what|how|why|when|where|who|which|is|are|can|does|do|should)\b|\?\s*$/i;
const YEAR = /\b(19|20)\d{2}\b/g;

/**
 * @param {string} query  as typed (operators included)
 * @param {{now?: Date}} [options]
 * @returns {{kind: 'navigational'|'time-sensitive'|'comparison'|'informational',
 *            timeSensitive: boolean, comparison: boolean, question: boolean,
 *            navigational: boolean}}
 */
function classify(query, { now = new Date() } = {}) {
  const text = String(query || '');
  const thisYear = now.getUTCFullYear();
  const years = (text.match(YEAR) || []).map(Number);
  const timeSensitive = TIME_WORDS.test(text) || years.some(year => year >= thisYear - 1);
  const comparison = COMPARISON.test(text);
  const question = QUESTION.test(text);
  const isNavigational = Boolean(navigational.detect(text));
  const kind = isNavigational
    ? 'navigational'
    : timeSensitive
      ? 'time-sensitive'
      : comparison
        ? 'comparison'
        : 'informational';
  return { kind, timeSensitive, comparison, question, navigational: isNavigational };
}

/** Whether recency should count for this query. */
function isTimeSensitive(query, options) {
  return classify(query, options).timeSensitive;
}

module.exports = { classify, isTimeSensitive };
