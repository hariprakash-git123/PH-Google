/**
 * Query understanding.
 *
 * Runs before anything touches OpenSearch and decides what kind of question
 * the user is actually asking, because "youtube.com", "\"machine learning\""
 * and "best electric cars" each deserve a different query shape.
 *
 * Output is a plain description of the query; queryBuilder turns it into the
 * OpenSearch request.
 */

const { parseDomain, parseLanguage } = require('../../utils/validators');

// A bare domain or a URL. Requires a known-looking TLD so "node.js" in prose
// is not mistaken for a site the user wants to visit.
const URL_PATTERN = /^https?:\/\/\S+$/i;
const DOMAIN_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

// Suffixes common enough that "<word>.<suffix>" is almost certainly a site.
const COMMON_TLDS = new Set([
  'com',
  'org',
  'net',
  'edu',
  'gov',
  'mil',
  'int',
  'io',
  'ai',
  'dev',
  'app',
  'co',
  'uk',
  'de',
  'fr',
  'jp',
  'cn',
  'in',
  'br',
  'ru',
  'au',
  'ca',
  'nl',
  'info',
  'biz',
  'me',
  'tv',
  'us',
  'eu',
  'xyz',
  'online',
  'site',
  'tech',
  'store',
  'blog',
  'cloud',
  'news',
  'wiki',
  'space'
]);

const QUESTION_WORDS = new Set([
  'what',
  'why',
  'how',
  'when',
  'where',
  'who',
  'whom',
  'whose',
  'which',
  'is',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'can',
  'could',
  'should',
  'would',
  'will',
  'has',
  'have',
  'had'
]);

/**
 * Pulls "quoted phrases" out of a query, returning them and the remainder.
 * Handles straight and curly quotes, and an unbalanced trailing quote.
 */
function extractPhrases(raw) {
  const phrases = [];
  // Normalise curly quotes so copy-pasted text behaves the same.
  const text = String(raw).replace(/[“”]/g, '"');

  const rest = text.replace(/"([^"]+)"/g, (_match, phrase) => {
    const clean = phrase.replace(/\s+/g, ' ').trim();
    if (clean) phrases.push(clean);
    return ' ';
  });

  return { phrases, rest: rest.replace(/"/g, ' ').replace(/\s+/g, ' ').trim() };
}

/** Removes duplicate terms while preserving order. */
function dedupeTerms(terms) {
  const seen = new Set();
  const out = [];
  for (const term of terms) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/**
 * Decides whether the query names a website.
 * @returns {{isSite: boolean, domain: string, url: string}}
 */
function detectSite(text) {
  const candidate = text.trim();

  if (URL_PATTERN.test(candidate)) {
    try {
      const url = new URL(candidate);
      return {
        isSite: true,
        domain: url.hostname.toLowerCase().replace(/^www\./, ''),
        url: url.toString()
      };
    } catch {
      /* fall through */
    }
  }

  // A single token that parses as a domain with a plausible TLD.
  if (!/\s/.test(candidate) && DOMAIN_PATTERN.test(candidate)) {
    const tld = candidate.split('.').pop().toLowerCase();
    if (COMMON_TLDS.has(tld)) {
      return { isSite: true, domain: candidate.toLowerCase().replace(/^www\./, ''), url: '' };
    }
  }

  return { isSite: false, domain: '', url: '' };
}

/**
 * Whether fuzzy matching should be offered for this query.
 *
 * Fuzziness is not applied to every query: on short or precise queries it
 * pulls in noise. It is offered only when a typo is plausible — a long
 * enough single token, or multi-word queries with long words — and the
 * builder then applies it in a low-weight clause so it can only rescue a
 * weak result set, never outrank an exact one.
 */
function shouldAllowFuzzy(terms, { isSite, hasPhrase }) {
  if (isSite || hasPhrase) return false; // both are precise by nature
  if (terms.length === 0) return false;
  if (terms.length > 6) return false; // long queries match enough already

  // Every meaningful word must be long enough for an edit distance to be
  // meaningful; "the cat" should never fuzzy-match.
  const longEnough = terms.filter(t => t.length >= 4);
  return longEnough.length > 0;
}

// A question opens with an interrogative immediately followed by an
// auxiliary: "how does", "what is", "who is". Neither set is in the English
// stop list, so left in place they count as content words — "how does
// gravity work" would match any page containing "how" and "work".
const INTERROGATIVES = new Set(['what', 'why', 'how', 'when', 'where', 'who', 'which']);
const AUXILIARIES = new Set([
  'is',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'can',
  'could',
  'should',
  'would',
  'will',
  'has',
  'have',
  'had'
]);
const ARTICLES = new Set(['the', 'a', 'an']);

// OpenSearch's `_english_` stop list, which the text analyzer applies. A
// question whose topic is only these words ("how does it work") has nothing
// left to search for once the opener is removed.
const ENGLISH_STOP_WORDS = new Set([
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
  'with'
]);
const HOW_DO = new Set(['do', 'does', 'did']);
const HOW_DO_TRAILING = new Set(['work', 'works']);

/**
 * The words of a question that carry its topic.
 *
 * Strips only a leading interrogative + auxiliary pair, an optional article
 * after it, and — for "how do/does/did X work" — the trailing "work(s)".
 * A leading auxiliary on its own is never stripped ("can opener reviews",
 * "will smith movies"), nor an interrogative without an auxiliary after it
 * ("who covid guidelines", "how to cook rice").
 *
 * @returns {string[]|null} the topic terms, or null when nothing applies
 */
function questionCoreTerms(terms, isQuestion) {
  if (!isQuestion || terms.length < 2) return null;
  const lower = terms.map(t => t.toLowerCase());
  if (!INTERROGATIVES.has(lower[0]) || !AUXILIARIES.has(lower[1])) return null;

  let start = 2;
  if (ARTICLES.has(lower[start])) start += 1;

  let end = terms.length;
  // Only when a topic word remains between the opener and "work".
  if (
    lower[0] === 'how' &&
    HOW_DO.has(lower[1]) &&
    end - start >= 2 &&
    HOW_DO_TRAILING.has(lower[end - 1])
  ) {
    end -= 1;
  }

  return terms.slice(start, end);
}

// --- Operators --------------------------------------------------------
//
//   site:example.com   -site:example.com     restrict to / exclude a site
//   -word   -"a phrase"                      exclude
//   a OR b   "a b" OR "c d"                  either side
//   a AND b                                  every word required
//   intitle:word   intitle:"a phrase"        must be in the title
//   inurl:word     inurl:"a phrase"          must be in the URL
//   lang:en        -lang:en                  restrict to / exclude a language
//
// OR and AND are operators only in upper case and only as whole words, so
// "cats or dogs", "organic" and "ANDROID" are ordinary text.

/** Characters that separate terms and carry no meaning of their own. */
const TERM_SEPARATORS = /[\s,;:!?()[\]{}<>"'`|\\/]+/;

// One token: an optionally negated, optionally prefixed "quoted phrase"; a
// run of anything else; or a stray quote, which is skipped.
const TOKEN_PATTERN = /(-)?(?:(site|intitle|inurl|lang):)?"([^"]+)"|[^\s"]+|"/gi;
const OPERATOR_PATTERN = /^(site|intitle|inurl|lang):(.*)$/i;
const FIELD_OF = { intitle: 'title', inurl: 'url' };

// A word the analyzers can match needs a letter or a decimal digit (or an
// emoji, which the tokenizer keeps). "*", "&", "@" and "½" are tokenised to
// nothing, so a clause made only of them can never match a page. This
// mirrors the standard tokenizer; tests/opensearch/searchApi.test.js checks
// the two against each other.
const WORD_CHARACTER = /[\p{L}\p{Nd}\p{Extended_Pictographic}]/u;
const isSymbolOnly = word => !WORD_CHARACTER.test(word);
const isStopWord = word => ENGLISH_STOP_WORDS.has(word.toLowerCase());
/** No text field can match it: a stop word, or nothing but symbols. */
const isUnmatchable = word => isStopWord(word) || isSymbolOnly(word);

/**
 * Trims the punctuation around one term, keeping what is part of a name:
 * dots, hyphens and underscores inside it (node.js, wi-fi), a trailing plus
 * or hash (c++, c#) and a single leading dot (.net).
 */
function trimTerm(token) {
  const lead = /^[.\-_+#]*/.exec(token)[0];
  let term = token.slice(lead.length);
  if (!term) return '';

  const tail = /[.\-_+#]*$/.exec(term)[0];
  term = term.slice(0, term.length - tail.length) + /^[+#]*/.exec(tail)[0];

  return lead === '.' && /^[a-z]/i.test(term) ? `.${term}` : term;
}

function splitTerms(text) {
  return String(text).split(TERM_SEPARATORS).map(trimTerm).filter(Boolean);
}

/**
 * A quote with no partner is not a phrase. It is removed so the words after
 * it are read normally — and stay attached to a "-" or "intitle:" before it,
 * so `-"java` still excludes java rather than requiring it.
 */
function dropUnmatchedQuote(text) {
  const count = (text.match(/"/g) || []).length;
  if (count % 2 === 0) return text;
  const at = text.lastIndexOf('"');
  const attached = at > 0 && /[-:]/.test(text[at - 1]);
  return text.slice(0, at) + (attached ? '' : ' ') + text.slice(at + 1);
}

/** The domain a site: operator names, or '' when the value is not one. */
function siteOf(value) {
  try {
    return parseDomain(value);
  } catch {
    return '';
  }
}

/**
 * The language code a lang: operator names ("en", "en-GB" -> "en"), using
 * the same rules as the `language` parameter; '' when the value is not one.
 */
function languageOf(value) {
  try {
    return parseLanguage(value);
  } catch {
    return '';
  }
}

/**
 * site: and lang: take one value that has to validate.
 *
 * @returns {Object|null|undefined} the entry; null when the value cannot be
 *          used; undefined when `name` is not one of these operators
 */
function valueEntry(name, value, negated) {
  if (name === 'site') {
    const site = siteOf(value);
    return site ? { type: 'site', value: site, negated } : null;
  }
  if (name === 'lang') {
    // "any" is the parameter's way of saying "no restriction".
    if (String(value).trim().toLowerCase() === 'any') return { type: 'none' };
    const language = languageOf(value);
    return language ? { type: 'lang', value: language, negated } : null;
  }
  return undefined;
}

/**
 * Reads the query into an ordered list of entries:
 *
 *   { op: 'OR' | 'AND' }
 *   { type: 'term' | 'phrase', value, negated, field }   field: null | 'title' | 'url'
 *   { type: 'site', value, negated }
 *   { type: 'lang', value, negated }
 *   { type: 'blank' }                                    a word of punctuation only
 *
 * `raw` is set on the first entry of each free-text word and holds the word
 * as typed, so `text` can be rebuilt without the operators.
 *
 * An operator that cannot be used is handled in one of two ways. Typed
 * positively with no value ("site:", "site:foo") it is read as the words
 * that were typed, as it always was. Otherwise it is dropped and listed in
 * `ignored`: a negated one ("-site:", "-site:localhost") must never turn
 * into an exclusion of the word "site"; a restriction to a word the field
 * cannot hold ("intitle:the", "intitle:*", "inurl:&") could match nothing;
 * and "lang:any" asks for no restriction at all.
 *
 * Either way the operator is listed in `unusable`, so the user can be told
 * it did not restrict the search ("lang:any", which asks for no restriction,
 * is not).
 *
 * @returns {{entries: Array, ignored: string[], unusable: string[]}}
 */
function scan(cleaned) {
  const entries = [];
  const ignored = [];
  const unusable = [];
  const text = dropUnmatchedQuote(cleaned.replace(/[“”]/g, '"'));

  const addWords = (word, negated) => {
    const terms = splitTerms(word);
    if (terms.length === 0) {
      if (!negated) entries.push({ type: 'blank', raw: word });
      return;
    }
    terms.forEach((value, i) =>
      entries.push({
        type: 'term',
        value,
        negated,
        field: null,
        raw: i === 0 && !negated ? word : undefined
      })
    );
  };

  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const [token, minus, prefix, quoted] = match;
    if (token === '"') continue;

    if (quoted !== undefined) {
      const negated = Boolean(minus);
      const value = quoted.replace(/\s+/g, ' ').trim();
      const operator = (prefix || '').toLowerCase();

      const valued = valueEntry(operator, value, negated);
      if (valued) {
        if (valued.type === 'none') ignored.push(token);
        else entries.push(valued);
        continue;
      }
      // An operator in front of something it cannot use: a site: that is
      // not a domain, a lang: that is not a language code, or
      // intitle:/inurl: with nothing in the quotes.
      if (operator && (valued === null || !value)) {
        unusable.push(token);
        if (negated) {
          ignored.push(token);
          continue;
        }
        addWords(operator, false);
      }
      if (!value) continue;

      const field = FIELD_OF[operator] || null;
      entries.push({ type: 'phrase', value, negated, field });
      continue;
    }

    if (token === 'OR' || token === 'AND') {
      entries.push({ op: token });
      continue;
    }

    // One leading hyphen negates; "--force" and a lone "-" do not.
    const negated = /^-[^-]/.test(token);
    const body = negated ? token.slice(1) : token;
    const operator = OPERATOR_PATTERN.exec(body);

    if (operator) {
      const name = operator[1].toLowerCase();
      const valued = valueEntry(name, operator[2], negated);
      if (valued) {
        if (valued.type === 'none') ignored.push(token);
        else entries.push(valued);
        continue;
      }
      if (valued === undefined) {
        const words = splitTerms(operator[2]);
        // The title analyzer removes stop words, so requiring one in the
        // title would match no page at all. The URL field keeps them, but
        // neither field holds a word made only of symbols.
        const terms = words.filter(w =>
          name === 'intitle' ? !isUnmatchable(w) : !isSymbolOnly(w)
        );
        if (terms.length > 0) {
          terms.forEach(value =>
            entries.push({ type: 'term', value, negated, field: FIELD_OF[name] })
          );
          continue;
        }
        if (words.length > 0) {
          ignored.push(token);
          unusable.push(token);
          continue;
        }
      }

      unusable.push(token);
      if (negated) {
        ignored.push(token);
        continue;
      }
    }

    addWords(body, negated);
  }

  return { entries, ignored, unusable };
}

const isOperand = entry => Boolean(entry) && !entry.op && entry.type !== 'blank';
// What may stand on either side of OR: a plain word or phrase.
const isGroupable = entry =>
  (entry.type === 'term' || entry.type === 'phrase') && !entry.negated && entry.field === null;

/**
 * Applies OR and AND to the entries around them.
 *
 * OR joins its two neighbours into a group, and a chain (a OR b OR c) into
 * one group; it binds tighter than the words around it, so
 * `python OR javascript tutorial` is (python OR javascript) tutorial.
 * An operator with nothing on one side is not an operator: "OR gate" and
 * "AND gate" stay searchable as typed.
 *
 * Membership of a group belongs to the entry, not to its value: in
 * `cats OR dogs cats` the first "cats" is an alternative and the second is
 * an ordinary required word.
 *
 * An alternative made only of symbols (`cats OR &`) can never match, so it
 * is taken out of its group and listed in `dropped`; what is left of the
 * group is read as if the alternative had not been typed.
 *
 * @returns {{entries: Array, orGroups: Array<Array>, requireAll: boolean, dropped: string[]}}
 */
function applyBooleans(scanned) {
  // "a OR OR b" — the repeats add nothing.
  const entries = scanned.filter((entry, i) => !(entry.op && i > 0 && scanned[i - 1].op));
  const orGroups = [];
  let requireAll = false;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (!entry.op) continue;

    const before = entries[i - 1];
    const after = entries[i + 1];
    if (!isOperand(before) || !isOperand(after)) {
      entries[i] = { type: 'term', value: entry.op, negated: false, field: null, raw: entry.op };
      continue;
    }

    if (entry.op === 'AND') {
      requireAll = true;
    } else if (isGroupable(before) && isGroupable(after)) {
      if (!before.group) {
        before.group = [before];
        orGroups.push(before.group);
      }
      after.group = before.group;
      after.group.push(after);
    }
  }

  // An alternative repeated within its group adds nothing, and a word OR
  // itself is just that word.
  const groups = [];
  const unusable = new Set();
  for (const group of orGroups) {
    const seen = new Set();
    const unique = group.filter(entry => {
      if (entry.type === 'term' && isSymbolOnly(entry.value)) {
        unusable.add(entry);
        return false;
      }
      const key = `${entry.type}:${entry.value.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length > 1) groups.push(unique);
    else group.forEach(entry => delete entry.group);
  }

  return {
    entries: entries.filter(entry => !entry.op && !unusable.has(entry)),
    orGroups: groups,
    requireAll,
    dropped: [...unusable].map(entry => entry.value)
  };
}

/**
 * Drops the words that would otherwise become a requirement of their own
 * that no page can meet: stop words, and words made only of symbols.
 *
 * The text analyzer removes both, so a clause made only of them matches
 * nothing. Normally they travel inside one clause with the real words and
 * are harmless ("the cat sat", "tom & jerry"). Two shapes put them in a
 * clause of their own:
 *
 *   - beside an OR group, where the words outside the group are required
 *     separately: `cats OR dogs the`, `cats OR dogs &`, and a dangling
 *     `cats OR dogs OR`, whose last word is the stop word "or";
 *   - when they are the only loose words beside something else the query
 *     matches on — a quoted phrase, intitle:, inurl:, site: or lang: —
 *     which is built as a clause of its own: `"machine learning" the`,
 *     `intitle:python the`, `site:wikipedia.org *`.
 *
 * A stop word that is an alternative inside a group is the user's own
 * choice and stays. Real words beside a phrase or an operator are left as
 * typed, stop words and symbols included. A query with nothing else to
 * match on (`the`, `*`, `the -java`) is left alone too: an exclusion is
 * not something to match on, and such a query finds nothing by design.
 *
 * Words of punctuation alone ("+", "!!!") never were terms; they are dropped
 * in the same two shapes only so that they leave no trace in the query text.
 *
 * @returns {{entries: Array, dropped: string[]}} `dropped` as typed
 */
function dropUnmatchableStopWords(entries, hasGroups) {
  const isLoose = e => e.type === 'term' && !e.negated && e.field === null && !e.group;
  const isLooseUnmatchable = e => e.type === 'blank' || (isLoose(e) && isUnmatchable(e.value));

  // Something positive the query matches on besides its loose words.
  const isAnchor = e =>
    !e.negated &&
    (e.type === 'phrase' ||
      e.type === 'site' ||
      e.type === 'lang' ||
      (e.type === 'term' && e.field !== null));
  const hasAnchor = entries.some(isAnchor);
  const onlyUnmatchable = entries.filter(isLoose).every(e => isUnmatchable(e.value));
  if (!hasGroups && !(hasAnchor && onlyUnmatchable)) return { entries, dropped: [] };

  return {
    entries: entries.filter(e => !isLooseUnmatchable(e)),
    dropped: entries.filter(isLooseUnmatchable).map(e => (e.type === 'blank' ? e.raw : e.value))
  };
}

/**
 * @typedef {Object} ParsedQuery
 * @property {string}   raw            what the user typed
 * @property {string}   cleaned        whitespace-normalised
 * @property {string}   text           the free words, minus quoted phrases
 *                                     and operators
 * @property {string[]} phrases        required quoted phrases, verbatim
 * @property {string[]} terms          de-duplicated free terms
 * @property {boolean}  hasPhrase
 * @property {boolean}  isSite         the whole query is a domain or URL
 * @property {string}   domain
 * @property {string}   url
 * @property {boolean}  isQuestion
 * @property {boolean}  questionStripped  a question opener was removed
 * @property {string[]} coreTerms      the terms to match on: `terms` minus
 *                                     any question opener
 * @property {string}   coreText       `coreTerms` as text (= `text` when
 *                                     nothing was stripped)
 * @property {string[]} plainTerms     the core terms required on their own:
 *                                     `coreTerms` minus the words that occur
 *                                     only as OR alternatives
 * @property {boolean}  isShort        one meaningful term
 * @property {boolean}  isMultiWord    of the core terms
 * @property {boolean}  allowFuzzy     of the core terms
 * @property {boolean}  isEmpty        nothing to search for
 *
 * @property {string[]} sites          site: — results must be on one of these
 * @property {string[]} excludedSites  -site:
 * @property {string[]} excludedTerms  -word
 * @property {string[]} excludedPhrases  -"a phrase"
 * @property {Array<Array<{type: 'term'|'phrase', value: string}>>} orGroups
 *                                     a OR b — one alternative of each group
 *                                     must match. Their words are in `terms`
 *                                     too; their phrases are not in `phrases`.
 * @property {boolean}  requireAll     an explicit AND was used
 * @property {string[]} requiredTerms  with AND: the words that must all be
 *                                     present (OR groups and phrases are
 *                                     required anyway)
 * @property {string[]} titleTerms     intitle:word
 * @property {string[]} titlePhrases   intitle:"a phrase"
 * @property {string[]} urlTerms       inurl:word
 * @property {string[]} urlPhrases     inurl:"a phrase"
 * @property {string[]} excludedTitleTerms    -intitle:word
 * @property {string[]} excludedTitlePhrases  -intitle:"a phrase"
 * @property {string[]} excludedUrlTerms      -inurl:word
 * @property {string[]} excludedUrlPhrases    -inurl:"a phrase"
 * @property {string[]} languages      lang: — results must be in one of these
 * @property {string[]} excludedLanguages  -lang:
 * @property {boolean}  hasOperators   any of the above is in use
 * @property {string[]} ignoredOperators  operators dropped because they had
 *                                     no usable value, as typed ("-site:")
 * @property {string[]} unusedOperators  every operator that restricted nothing
 *                                     because its value was unusable, dropped
 *                                     or read as words ("site:foo", "-site:")
 * @property {string[]} ignoredWords   stop words and symbol-only words
 *                                     dropped from beside an OR group, a
 *                                     quoted phrase or an operator, as typed
 */

/**
 * @param {string} raw
 * @returns {ParsedQuery}
 */
function parseQuery(raw) {
  const original = typeof raw === 'string' ? raw : '';
  const cleaned = original.replace(/\s+/g, ' ').trim();

  const scanned = scan(cleaned);
  const booleans = applyBooleans(scanned.entries);
  const { orGroups: groups, requireAll } = booleans;
  const kept = dropUnmatchableStopWords(booleans.entries, groups.length > 0);
  const { entries } = kept;

  /** The de-duplicated values of the entries of one kind. */
  const pick = (type, field, negated) =>
    dedupeTerms(
      entries
        .filter(e => e.type === type && e.negated === negated && (e.field || null) === field)
        .map(e => e.value)
    );

  const terms = pick('term', null, false);
  const phrases = dedupeTerms(
    entries
      .filter(e => e.type === 'phrase' && !e.negated && e.field === null && !e.group)
      .map(e => e.value)
  );
  const orGroups = groups.map(group => group.map(({ type, value }) => ({ type, value })));
  const rest = entries
    .filter(e => e.raw !== undefined)
    .map(e => e.raw)
    .join(' ');

  const operators = {
    sites: pick('site', null, false),
    excludedSites: pick('site', null, true),
    excludedTerms: pick('term', null, true),
    excludedPhrases: pick('phrase', null, true),
    orGroups,
    requireAll,
    requiredTerms: [],
    titleTerms: pick('term', 'title', false),
    titlePhrases: pick('phrase', 'title', false),
    urlTerms: pick('term', 'url', false),
    urlPhrases: pick('phrase', 'url', false),
    excludedTitleTerms: pick('term', 'title', true),
    excludedTitlePhrases: pick('phrase', 'title', true),
    excludedUrlTerms: pick('term', 'url', true),
    excludedUrlPhrases: pick('phrase', 'url', true),
    languages: pick('lang', null, false),
    excludedLanguages: pick('lang', null, true)
  };
  const hasOperators = Object.values(operators).some(v => (Array.isArray(v) ? v.length > 0 : v));

  // Something to match on: free text, a field restriction, or a site or a
  // language to list.
  const isEmpty =
    terms.length + phrases.length + orGroups.length === 0 &&
    operators.sites.length === 0 &&
    operators.languages.length === 0 &&
    operators.titleTerms.length + operators.titlePhrases.length === 0 &&
    operators.urlTerms.length + operators.urlPhrases.length === 0;

  // "youtube.com" on its own asks for the site; with operators around it,
  // the user has already said what they mean.
  const site = hasOperators ? { isSite: false, domain: '', url: '' } : detectSite(cleaned);
  const firstWord = (terms[0] || '').toLowerCase();
  const isQuestion = cleaned.endsWith('?') || (terms.length >= 3 && QUESTION_WORDS.has(firstWord));

  const hasPhrase = phrases.length > 0;
  const meaningfulCount = terms.length + phrases.length;

  // Match on the question's topic; keep the full query when stripping the
  // opener would leave nothing to search for ("what is?", "how does it work").
  // A query with OR is taken as written: its words belong to groups. AND
  // only says the words are all required, so the opener is still removed.
  const stripped = orGroups.length > 0 ? null : questionCoreTerms(terms, isQuestion);
  const meaningful = (stripped || []).filter(t => !ENGLISH_STOP_WORDS.has(t.toLowerCase()));
  const questionStripped = Boolean(stripped) && meaningful.length + phrases.length > 0;
  const coreTerms = questionStripped ? stripped : terms;
  // A question that was only an opener plus a quoted phrase searches the phrase.
  const coreText = questionStripped ? coreTerms.join(' ') || phrases.join(' ') : rest;

  // The words outside every OR group. Decided by where a word stands, not
  // by its value, so a word typed both inside and outside a group stays
  // required.
  const ungrouped = new Set(
    entries
      .filter(e => e.type === 'term' && !e.negated && e.field === null && !e.group)
      .map(e => e.value.toLowerCase())
  );
  const plainTerms =
    orGroups.length > 0 ? coreTerms.filter(t => ungrouped.has(t.toLowerCase())) : coreTerms;

  if (requireAll) {
    // Stop words and symbols are not in the index, so requiring one would
    // match nothing.
    operators.requiredTerms = plainTerms.filter(t => !isUnmatchable(t));
  }

  return {
    raw: original,
    cleaned,
    text: rest,
    phrases,
    terms,
    hasPhrase,
    isSite: site.isSite,
    domain: site.domain,
    url: site.url,
    isQuestion,
    questionStripped,
    coreTerms,
    coreText,
    plainTerms,
    isShort: meaningfulCount === 1 && !hasPhrase,
    isMultiWord: coreTerms.length > 1 || hasPhrase,
    // An OR query, like a phrase, is precise by nature.
    allowFuzzy: shouldAllowFuzzy(coreTerms, {
      isSite: site.isSite,
      hasPhrase: hasPhrase || orGroups.length > 0
    }),
    isEmpty,
    ...operators,
    hasOperators,
    ignoredOperators: scanned.ignored,
    unusedOperators: scanned.unusable,
    ignoredWords: [...booleans.dropped, ...kept.dropped]
  };
}

module.exports = {
  parseQuery,
  extractPhrases,
  detectSite,
  dedupeTerms,
  shouldAllowFuzzy,
  questionCoreTerms,
  trimTerm,
  COMMON_TLDS,
  QUESTION_WORDS
};
