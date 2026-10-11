/**
 * Does a provider's answer cover the query?
 *
 * A provider can return a well-formed list that answers a different question:
 * Google's page for "tirunelveli halwa recipe" has come back holding pages
 * about the word "recipe" alone, and a Bing endpoint has answered "best pizza
 * in chennai" with pages about "best". Such a list is worse than none — it
 * would be shown above the index's results and cached.
 *
 * So the list is checked against the words of the query that carry its
 * meaning. It is a check of topic, never a ranking: results are not
 * reordered, and the order a provider gave them is kept.
 *
 *   meaningful words   the query's words minus stop words and words that fit
 *                      any subject ("best", "top", "how", …)
 *   a mention          the word, a longer form of it, or a word one or two
 *                      letters away from it — a provider that corrects a
 *                      misspelling ("combatore") answers with the right
 *                      spelling ("Coimbatore"), and that is the same word
 *   a result covers    it mentions enough of them in its title, snippet or
 *                      address: the word itself for one, both for two, 60%
 *                      (at least two) for more
 *   the answer covers  at least a third of its results do
 *
 * An answer that covers the query is accepted; the results in it that do not
 * cover the query themselves are then left out (`relevantResults`), so a page
 * about another town does not ride in beside the pages about the right one.
 *
 * A query with no meaningful words, or an empty list, is not judged.
 */

// The index analyzer's English stop words, plus question and filler words.
const STOP_WORDS = new Set(
  (
    'a an and are as at be but by for if in into is it no not of on or such that the their then ' +
    'there these they this to was will with ' +
    'how what why when where who which whom whose do does did can could should would i me my we ' +
    'you your from about near vs versus'
  ).split(' ')
);

// Words that describe any subject, so finding one says nothing about a page.
const GENERIC_WORDS = new Set(
  'best top good better great latest new newest recent list free online cheap'.split(' ')
);

const COVERING_SHARE = 1 / 3;
const WORD_SHARE = 0.6;

/** Lower case, Latin accents removed; other scripts are left as they are. */
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

function tokens(text) {
  return normalise(text).match(/[\p{L}\p{M}\p{N}]+/gu) || [];
}

/** "restaurants" also finds "restaurant"; "learn" finds "learning" by prefix. */
function stem(word) {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

/**
 * The words of the query that carry its meaning, stemmed.
 *
 * @param {import('../opensearch/queryParser').ParsedQuery} parsed
 * @returns {string[]}
 */
function meaningfulTerms(parsed) {
  return [...new Set(meaningfulWords(parsed).map(stem))];
}

/**
 * The same words as typed (lower case, not stemmed): what the index is asked
 * for when it has to show that a page is on the subject (see
 * buildTopicalFilter in opensearch/queryBuilder.js), where the analyzer does
 * its own stemming.
 *
 * @param {import('../opensearch/queryParser').ParsedQuery} parsed
 * @returns {string[]}
 */
function meaningfulWords(parsed) {
  if (!parsed) return [];
  // With OR groups only the words required on their own are certain to matter.
  const hasGroups = (parsed.orGroups || []).length > 0;
  const words = hasGroups ? parsed.plainTerms || [] : parsed.terms || [];
  const text = [...words, ...(parsed.phrases || [])].join(' ');
  const out = new Set();
  for (const token of tokens(text)) {
    if (token.length < 2 || STOP_WORDS.has(token) || GENERIC_WORDS.has(token)) continue;
    out.add(token);
  }
  return [...out];
}

/** How many of the terms a result must mention. */
function requiredMentions(termCount) {
  if (termCount <= 2) return termCount;
  return Math.max(2, Math.ceil(termCount * WORD_SHARE));
}

/**
 * How many letters a word may differ by and still be the same word misspelt.
 * None for a short word, where one letter makes another word ("rice",
 * "race"); one from five letters; two from eight.
 */
function allowedEdits(length) {
  if (length < 5) return 0;
  return length < 8 ? 1 : 2;
}

/**
 * Whether two words are within `max` edits of each other: a letter added,
 * dropped or changed, or two neighbours swapped ("pyhton"). Stops as soon as
 * the answer is known.
 */
function withinEdits(a, b, max) {
  if (a === b) return true;
  if (max <= 0 || Math.abs(a.length - b.length) > max) return false;

  let twoBack = null;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (twoBack && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, twoBack[j - 2] + 1);
      }
      current.push(value);
      if (value < best) best = value;
    }
    if (best > max) return false;
    twoBack = previous;
    previous = current;
  }
  return previous[b.length] <= max;
}

/**
 * Whether a page's word is a mention of a query term: the term itself or a
 * longer form of it, or — for a term long enough to be recognisable — a word
 * beginning with the same letter and a letter or two away from it.
 */
function mentions(token, term) {
  if (token.startsWith(term)) return true;
  const max = allowedEdits(term.length);
  if (max === 0 || token[0] !== term[0]) return false;
  return withinEdits(stem(token), term, max);
}

/**
 * How many of the terms a piece of text mentions.
 *
 * @param {string} text
 * @param {string[]} terms  from meaningfulTerms
 * @returns {number}
 */
function mentionedTerms(text, terms) {
  const found = tokens(text);
  return terms.filter(term => found.some(token => mentions(token, term))).length;
}

/** Whether one result mentions enough of the terms. */
function coversTerms(result, terms) {
  if (terms.length === 0) return true;
  const mentioned = mentionedTerms(
    `${result.title || ''} ${result.snippet || ''} ${result.url || ''}`,
    terms
  );
  return mentioned >= requiredMentions(terms.length);
}

/**
 * @param {Array<{title?: string, snippet?: string, url?: string}>} results
 *        mapped results (the result schema)
 * @param {import('../opensearch/queryParser').ParsedQuery} parsed
 * @returns {{relevant: boolean, terms: string[], covering: number, needed: number}}
 */
function assessCoverage(results, parsed) {
  const terms = meaningfulTerms(parsed);
  const list = Array.isArray(results) ? results : [];
  if (terms.length === 0 || list.length === 0) {
    return { relevant: true, terms, covering: 0, needed: 0 };
  }

  const covering = list.filter(result => coversTerms(result, terms)).length;
  const needed = Math.max(1, Math.ceil(list.length * COVERING_SHARE));
  return { relevant: covering >= needed, terms, covering, needed };
}

/** Whether the answer covers the query. */
function coversQuery(results, parsed) {
  return assessCoverage(results, parsed).relevant;
}

/**
 * The results that are themselves about the query, in the order given.
 * Applied to an answer that has been accepted, so what is shown is the part
 * of it that is on the subject. A query with no meaningful words is not
 * judged, and every result is kept.
 *
 * @param {Array<{title?: string, snippet?: string, url?: string}>} results
 * @param {import('../opensearch/queryParser').ParsedQuery} parsed
 * @returns {Array}
 */
function relevantResults(results, parsed) {
  const list = Array.isArray(results) ? results : [];
  const terms = meaningfulTerms(parsed);
  if (terms.length === 0) return list;
  return list.filter(result => coversTerms(result, terms));
}

module.exports = {
  coversQuery,
  assessCoverage,
  relevantResults,
  meaningfulTerms,
  meaningfulWords,
  mentionedTerms,
  requiredMentions
};
