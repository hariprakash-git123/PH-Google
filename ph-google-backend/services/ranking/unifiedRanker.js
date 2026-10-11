const {
  meaningfulTerms,
  mentionedTerms,
  requiredMentions
} = require('../external/resultRelevance');
const { getSynonyms } = require('../opensearch/synonyms');
const { resultIdentityKey } = require('../../utils/urlNormalizer');
const {
  dominantScript,
  scriptOfLanguage,
  languageCompatible,
  wantedScript
} = require('./languageScript');

/**
 * One ranking for web results from every source.
 *
 * The index's results carry a BM25 score; a provider's carry only their place
 * in its answer. Those numbers measure different things and are never
 * compared. Instead every candidate is judged on the same evidence that both
 * sources have — its title, its snippet, its address and its place in its
 * own source's ranking — and given a score from explicit weights:
 *
 *   titleCoverage  0.30  share of the query's meaningful words in the title
 *   textCoverage   0.20  share of them in the title, snippet or address
 *   titlePhrase    0.15  the query's words appear together, in order, in the title
 *   exactTitle     0.10  the title, without its site suffix, is the query
 *   sourceRank     0.20  1 for its source's first result, falling with its place
 *                        (1 / (1 + (rank − 1) / 5)): each source's own, fuller
 *                        judgement counts, the same way for every source
 *   freshness      0.05  only for time-sensitive queries, and only from a real
 *                        publication date (none is assumed)
 *   junkTitle     −0.20  no real title: missing, a lone character, or an address
 *
 * A word counts as found when the text has it, a word starting with it, a
 * likely misspelling of it (resultRelevance), or one of its synonyms (the
 * index's own synonym list).
 *
 * Results are first split in two tiers: those that cover the query (enough of
 * its words, as resultRelevance requires of a provider's answer) come before
 * those that do not — a page matched only through a loose or fuzzy match never
 * outranks one that is about the query, whichever source either came from.
 * Nothing is removed. A repeat of a page already ranked higher — the same
 * address in another form, or the same title on the same site — goes after
 * every result of its tier that is not one (and loses 0.15 among repeats).
 *
 * Within the first tier, a result in another language than the query's comes
 * after those in a compatible one (languageCompatible): an English search
 * for "python" is not answered first by the Japanese article, however well
 * its title matches. Unless a language was asked for (lang:, the language
 * filter), which decides instead.
 *
 * Ties are broken by source rank, then index before provider, then address,
 * so equal inputs always give the same order.
 *
 * Last, no site fills the list (hostCrowding): from the third result of one
 * site on, its results wait until every other site's result of the same
 * tier has had its place, as a results page shows a site twice and then
 * other sites. Nothing is removed, and a list from one site keeps its order.
 *
 * Results from a single source keep that source's own order within each tier:
 * its ranking already used more evidence (the whole page, its headings, its
 * quality) than the title and snippet this ranker sees. The features decide
 * the order only where two sources' results have to be put together.
 */

const WEIGHTS = Object.freeze({
  titleCoverage: 0.3,
  textCoverage: 0.2,
  titlePhrase: 0.15,
  exactTitle: 0.1,
  sourceRank: 0.2,
  freshness: 0.05,
  junkTitle: -0.2,
  repeat: -0.15
});

const DAY = 24 * 60 * 60 * 1000;
// Separators before a site name in a page title: "Python - Wikipedia",
// "HTML | MDN", "Arctic – Travel guide at Wikivoyage", "Asthma: MedlinePlus".
const SITE_SUFFIX = /\s+[-|–—:]\s+[^-|–—:]{1,60}$/;

const lower = text =>
  String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
const words = text => lower(text).match(/[\p{L}\p{N}]+/gu) || [];
const stem = word => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word);

// Small words a title has between the query's words ("theory OF relativity").
const STOP_WORDS = new Set(
  (
    'a an and are as at be by for from in into is it of on or the to with vs versus ' +
    'how what why when where who which do does can'
  ).split(' ')
);
/** A text's words that carry meaning, stemmed as the query's are. */
const contentWords = text =>
  words(text)
    .filter(word => !STOP_WORDS.has(word))
    .map(stem);

/** Synonym groups from the index's own list: "ai, artificial intelligence". */
const SYNONYM_GROUPS = getSynonyms().map(rule =>
  rule
    .split(',')
    .map(part => lower(part).trim())
    .filter(Boolean)
);

/** Every way a meaningful word can appear: itself and its synonyms. */
function alternativesFor(term) {
  const alternatives = new Set([term]);
  for (const group of SYNONYM_GROUPS) {
    if (group.some(entry => entry === term || stem(entry) === term)) {
      group.forEach(entry => alternatives.add(entry));
    }
  }
  return [...alternatives];
}

/** How many of the query's words a text has (each word once, by any of its forms). */
function countFound(text, termForms) {
  const normalised = ` ${words(text).join(' ')} `;
  return termForms.filter(forms =>
    forms.some(form =>
      form.includes(' ') ? normalised.includes(` ${form} `) : mentionedTerms(text, [form]) > 0
    )
  ).length;
}

/** The title without the site's name after it. */
function titleCore(title) {
  const text = String(title || '').trim();
  const core = text.replace(SITE_SUFFIX, '').trim();
  return core.length > 0 ? core : text;
}

function isJunkTitle(result) {
  const title = String(result.title || '').trim();
  if (!title) return true;
  if (/^https?:\/\//i.test(title) || title === result.url) return true;
  return words(title).join('').length < 2;
}

function freshnessOf(result, now) {
  const at = Date.parse(result.publishedAt || '');
  if (!Number.isFinite(at)) return 0;
  const age = now - at;
  if (age < 0) return 0;
  if (age <= 2 * DAY) return 1;
  if (age <= 14 * DAY) return 0.7;
  if (age <= 90 * DAY) return 0.4;
  if (age <= 365 * DAY) return 0.15;
  return 0;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** At most this many results of one site before every other site's of the same tier. */
const PER_HOST = 2;

/**
 * Host crowding: within each run of results of the same tier, a site's
 * third and later results move after the other sites' results of that run
 * that are about the query as well (`answers`: the title is), keeping their
 * own order — never behind a page that only mentions the query in passing,
 * unless they only mention it too. A run from a single site is unchanged.
 *
 * Only a provider's results are moved. The index's keep their place: its
 * order is the one "Load more" and every page continue from.
 *
 * @param {Array<{result: Object, tier: string, answers: boolean}>} entries
 *        in rank order
 */
function crowdHosts(entries) {
  const out = [];
  let i = 0;
  while (i < entries.length) {
    let j = i;
    while (j < entries.length && entries[j].tier === entries[i].tier) j += 1;
    const seen = new Map();
    const first = [];
    const later = [];
    for (const entry of entries.slice(i, j)) {
      const host = hostOf(entry.result.url);
      const count = seen.get(host) || 0;
      seen.set(host, count + 1);
      const movable = (entry.result.source || 'index') !== 'index';
      (host && movable && count >= PER_HOST ? later : first).push(entry);
    }
    // Deferred pages about the query go after the run's last other page
    // about it; deferred pages that only mention it, at the run's end.
    let cut = 0;
    first.forEach((entry, k) => {
      if (entry.answers) cut = k + 1;
    });
    out.push(
      ...first.slice(0, cut),
      ...later.filter(entry => entry.answers),
      ...first.slice(cut),
      ...later.filter(entry => !entry.answers)
    );
    i = j;
  }
  return out;
}

/** Whether a result's title is about the query (as countAnswering judges it). */
function answersQuery(features, query) {
  return (
    query.termCount === 0 || Math.round(features.titleCoverage * query.termCount) >= query.required
  );
}

/**
 * The evidence for one result.
 *
 * @param {Object} result  { title, snippet, url, source, sourceRank, publishedAt }
 * @param {Object} query   from prepareQuery
 * @param {{timeSensitive?: boolean, now?: number}} [options]
 */
function featuresOf(result, query, { timeSensitive = false, now = Date.now() } = {}) {
  const { termForms, termCount, required, phrase } = query;
  const title = String(result.title || '');
  const text = `${title} ${result.snippet || ''} ${result.url || ''}`;
  const inTitle = termCount ? countFound(title, termForms) : 0;
  const inText = termCount ? countFound(text, termForms) : 0;
  const core = titleCore(title);
  const rank =
    Number.isInteger(result.sourceRank) && result.sourceRank > 0 ? result.sourceRank : 50;
  return {
    titleCoverage: termCount ? inTitle / termCount : 0,
    textCoverage: termCount ? inText / termCount : 0,
    titlePhrase:
      termCount >= 2 && phrase && ` ${contentWords(title).join(' ')} `.includes(` ${phrase} `)
        ? 1
        : 0,
    exactTitle: termCount > 0 && contentWords(core).join(' ') === phrase ? 1 : 0,
    sourceRank: 1 / (1 + (rank - 1) / 5),
    freshness: timeSensitive ? freshnessOf(result, now) : 0,
    junkTitle: isJunkTitle(result) ? 1 : 0,
    covers: termCount === 0 || inText >= required
  };
}

/** What the ranker needs from a parsed query. */
function prepareQuery(parsed) {
  const terms = meaningfulTerms(parsed);
  return {
    terms,
    termForms: terms.map(alternativesFor),
    termCount: terms.length,
    required: requiredMentions(terms.length),
    // The meaningful words, in the order typed: what a title "is" when it is the query.
    phrase: terms.join(' ')
  };
}

function scoreOf(features) {
  return (
    WEIGHTS.titleCoverage * features.titleCoverage +
    WEIGHTS.textCoverage * features.textCoverage +
    WEIGHTS.titlePhrase * features.titlePhrase +
    WEIGHTS.exactTitle * features.exactTitle +
    WEIGHTS.sourceRank * features.sourceRank +
    WEIGHTS.freshness * features.freshness +
    WEIGHTS.junkTitle * features.junkTitle
  );
}

const SOURCE_ORDER = result => (result.source === 'index' ? 0 : 1);

function compare(a, b) {
  return (
    Number(b.covers) - Number(a.covers) ||
    Number(b.compatible) - Number(a.compatible) ||
    Number(Boolean(a.repeat)) - Number(Boolean(b.repeat)) ||
    b.score - a.score ||
    a.rank - b.rank ||
    SOURCE_ORDER(a.result) - SOURCE_ORDER(b.result) ||
    String(a.result.url).localeCompare(String(b.result.url))
  );
}

/**
 * Ranks web results from any mix of sources.
 *
 * @param {Array<Object>} results  each with title, snippet, url, source and
 *        sourceRank (its place in its own source's ranking, from 1)
 * @param {Object} parsed  the parsed query (queryParser)
 * @param {{timeSensitive?: boolean, now?: number, explain?: boolean,
 *          language?: string}} [options]  `language`: the language filter, if set
 * @returns {Array<Object>} the same results, best first; with `explain`, each
 *          carries `ranking: { score, covers, compatible, features }`
 */
function rankResults(results, parsed, options = {}) {
  const list = Array.isArray(results) ? results : [];
  if (list.length < 2 && !options.explain) return list.slice();
  const query = prepareQuery(parsed);
  const queryScript = wantedScript(parsed, options);
  const tierOf = entry => `${entry.covers}|${entry.compatible}|${Boolean(entry.repeat)}`;
  const sources = new Set(list.map(result => result.source || 'index'));
  const singleSource = sources.size === 1;
  const rankOf = result => (Number.isInteger(result.sourceRank) ? result.sourceRank : 1e6);
  if (singleSource && sources.has('index') && !options.explain) {
    // The index alone: those that cover the query first, each tier in the
    // index's own order. Nothing more moves: its order is pageable — one
    // page of 40 is two pages of 20 — and the index weighs language itself
    // (queryBuilder), the same on every page.
    return list
      .map(result => ({ result, covers: featuresOf(result, query, options).covers }))
      .sort(
        (a, b) =>
          Number(b.covers) - Number(a.covers) ||
          rankOf(a.result) - rankOf(b.result) ||
          String(a.result.url).localeCompare(String(b.result.url))
      )
      .map(entry => entry.result);
  }
  if (singleSource && !options.explain) {
    // One provider: those that cover the query first, then those in a
    // compatible language, each tier in the provider's own order (its rank;
    // then the address, for equal ranks), with no site filling the list.
    const sorted = list
      .map(result => {
        const features = featuresOf(result, query, options);
        return {
          result,
          covers: features.covers,
          answers: answersQuery(features, query),
          compatible: languageCompatible(result, queryScript)
        };
      })
      .sort(
        (a, b) =>
          Number(b.covers) - Number(a.covers) ||
          Number(b.compatible) - Number(a.compatible) ||
          rankOf(a.result) - rankOf(b.result) ||
          String(a.result.url).localeCompare(String(b.result.url))
      )
      .map(entry => ({ ...entry, tier: tierOf(entry) }));
    return crowdHosts(sorted).map(entry => entry.result);
  }
  const scored = list.map(result => {
    const features = featuresOf(result, query, options);
    return {
      result,
      features,
      covers: features.covers,
      answers: answersQuery(features, query),
      compatible: languageCompatible(result, queryScript),
      score: scoreOf(features),
      rank: Number.isInteger(result.sourceRank) ? result.sourceRank : 1e6
    };
  });
  scored.sort(compare);

  // A repeat of a page ranked above it loses ground, then the order is settled.
  const seenKeys = new Set();
  const seenTitles = new Set();
  for (const entry of scored) {
    const key = resultIdentityKey(entry.result.url);
    // The whole title: two pages of one site share its suffix ("Node.js — About
    // Node.js®", "Node.js — Run JavaScript Everywhere") without being one page.
    const titleKey = `${hostOf(entry.result.url)}|${words(entry.result.title).join(' ')}`;
    const repeat = (key && seenKeys.has(key)) || seenTitles.has(titleKey);
    if (repeat) {
      entry.repeat = true;
      entry.score += WEIGHTS.repeat;
      entry.features.repeat = 1;
    }
    if (key) seenKeys.add(key);
    seenTitles.add(titleKey);
  }
  scored.sort(compare);
  const crowded = crowdHosts(scored.map(entry => ({ ...entry, tier: tierOf(entry) })));

  return crowded.map(entry =>
    options.explain
      ? {
          ...entry.result,
          ranking: {
            score: Number(entry.score.toFixed(4)),
            covers: entry.covers,
            compatible: entry.compatible,
            features: entry.features
          }
        }
      : entry.result
  );
}

/** How many of these results cover the query (the first tier). */
function countCovering(results, parsed) {
  const query = prepareQuery(parsed);
  if (query.termCount === 0) return (results || []).length;
  return (results || []).filter(result => featuresOf(result, query).covers).length;
}

/**
 * How many of these results are themselves about the query: enough of its
 * meaningful words in the title (the same share `covers` asks of the whole
 * text). Stricter than covering — a snippet mentions words in passing
 * ("…nerve, muscle, and immune systems…" in a page about vitamin D), a title
 * says what the page is. Used to decide whether the index has answered.
 */
function countAnswering(results, parsed) {
  const query = prepareQuery(parsed);
  if (query.termCount === 0) return (results || []).length;
  return (results || []).filter(
    result =>
      Math.round(featuresOf(result, query).titleCoverage * query.termCount) >= query.required
  ).length;
}

module.exports = {
  rankResults,
  countCovering,
  countAnswering,
  featuresOf,
  prepareQuery,
  titleCore,
  languageCompatible,
  wantedScript,
  dominantScript,
  scriptOfLanguage,
  PER_HOST,
  WEIGHTS
};
