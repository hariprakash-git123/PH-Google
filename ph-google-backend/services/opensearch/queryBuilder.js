const { dateWindowToCutoff } = require('../../utils/validators');

/**
 * Builds the OpenSearch query.
 *
 * The scoring strategy is layered rather than one arbitrary formula: each
 * signal is its own clause, so a clause can be re-weighted or removed
 * without disturbing the others, and `explain` shows exactly which one fired.
 *
 *   must    one recall clause — decides which documents qualify at all
 *   should  precision clauses — exact title, phrase, proximity, headings,
 *           url/domain. These only reorder what `must` already matched.
 *   filter  non-scoring constraints (domain, language, date, status)
 *
 * The search operators (site:, -word, OR, AND, intitle:, inurl:, lang:) are parsed
 * by queryParser and added by buildOperatorClauses.
 *
 * The whole thing is wrapped in function_score, which applies two gentle
 * multipliers: document quality and freshness. Both are bounded so that a
 * high-quality or recent page can never outrank a genuinely better match —
 * they break ties, they do not decide the ranking.
 */

/**
 * Field weights. Tuned so that a title match clearly beats a body match
 * while a body-only match is still reachable.
 *
 * These are the first thing to adjust when tuning relevance; every query
 * shape reads them from here.
 */
const FIELD_BOOSTS = {
  title: 8,
  headings: 5,
  description: 4,
  keywords: 3,
  url: 2,
  content: 1
};

/** Weights for the precision clauses, relative to the recall clause. */
const CLAUSE_BOOSTS = {
  exactTitle: 60, // the query IS the title
  titleExactTerms: 18, // literal wording in the title (no stemming)
  phraseTitle: 14,
  phraseHeadings: 8,
  phraseDescription: 6,
  phraseContent: 5, // also supplies proximity for unquoted queries
  quotedPhrase: 25, // an explicitly quoted "phrase"
  domainExact: 90, // the query names this site
  rootDomain: 45,
  urlPath: 6,
  fuzzy: 0.4, // deliberately weak: rescues, never dominates
  questionTitle: 4 // the full question in a title; questions match on their topic
};

/** Proximity: how far apart the words may drift and still count as a phrase. */
const PHRASE_SLOP = 3;

const searchFields = () => [
  `title^${FIELD_BOOSTS.title}`,
  `headings^${FIELD_BOOSTS.headings}`,
  `description^${FIELD_BOOSTS.description}`,
  `keywords^${FIELD_BOOSTS.keywords}`,
  `url^${FIELD_BOOSTS.url}`,
  `content^${FIELD_BOOSTS.content}`
];

const exactFields = () => [
  `title.exact^${FIELD_BOOSTS.title}`,
  `headings.exact^${FIELD_BOOSTS.headings}`,
  `description.exact^${FIELD_BOOSTS.description}`,
  `content.exact^${FIELD_BOOSTS.content}`
];

/**
 * How many of the query's terms a document must contain.
 *
 * "2<70%" means: up to 2 terms, require all of them; beyond that, 70%. This
 * keeps two-word queries precise while letting a long query tolerate a word
 * the page happens not to use.
 */
function minimumShouldMatch(termCount) {
  if (termCount <= 1) return '1';
  if (termCount <= 3) return '2<70%';
  return '70%';
}

/** Matches the domain itself or any subdomain of it. */
function domainClause(domain) {
  return {
    bool: {
      should: [
        { term: { domain } },
        { term: { domain: `www.${domain}` } },
        { term: { rootDomain: domain } }
      ],
      minimum_should_match: 1
    }
  };
}

/** Non-scoring constraints. Cheap, cached by OpenSearch, and exact. */
function buildFilters({ domain, dateWindow, language, isArticle, ids }) {
  const filters = [];

  // Restricts the search to documents already chosen by an earlier ranking
  // pass (see searchService). A filter, so it never changes a score.
  if (ids) filters.push({ ids: { values: ids } });

  if (domain) filters.push(domainClause(domain));

  if (language) filters.push({ term: { language } });
  if (isArticle === true) filters.push({ term: { isArticle: true } });

  const cutoff = dateWindowToCutoff(dateWindow);
  if (cutoff) {
    // Prefer the publication date; fall back to when the page was crawled.
    filters.push({
      bool: {
        should: [
          { range: { publishedAt: { gte: cutoff.toISOString() } } },
          {
            bool: {
              must_not: { exists: { field: 'publishedAt' } },
              must: { range: { crawledAt: { gte: cutoff.toISOString() } } }
            }
          }
        ],
        minimum_should_match: 1
      }
    });
  }

  // A page that did not return 200 is not a useful result.
  filters.push({
    bool: {
      should: [
        { term: { statusCode: 200 } },
        { bool: { must_not: { exists: { field: 'statusCode' } } } }
      ],
      minimum_should_match: 1
    }
  });

  return filters;
}

/**
 * The query as typed, for a query that is only quoted phrases. When the
 * query holds operators — used or ignored — or words the parser dropped,
 * the phrases are rebuilt instead, so "site:", "-word" and a dropped stop
 * word are never searched for as words.
 */
function typedText(parsed) {
  const ignored = (parsed.ignoredOperators || []).length + (parsed.ignoredWords || []).length;
  if (!parsed.hasOperators && ignored === 0) return parsed.cleaned;
  return parsed.phrases.map(phrase => `"${phrase}"`).join(' ');
}

const hasOrGroups = parsed => Boolean(parsed.orGroups) && parsed.orGroups.length > 0;

/**
 * Precision clauses — these reorder the matched set.
 * @param {import('./queryParser').ParsedQuery} parsed
 */
function buildShouldClauses(parsed) {
  const should = [];
  const text = parsed.text || typedText(parsed);
  // A question's topic ("how does gravity work" -> "gravity"). Identical to
  // `text` for every query that is not a question.
  const core = parsed.coreText || typedText(parsed);

  // A. The query is (essentially) the whole title.
  if (text) {
    should.push({
      term: {
        'title.raw': {
          value: text.toLowerCase(),
          boost: CLAUSE_BOOSTS.exactTitle
        }
      }
    });

    // B. Literal wording in the title, unaffected by stemming — this is what
    //    keeps "react" from being satisfied by "reacts"/"reaction".
    should.push({
      match: {
        'title.exact': {
          query: core,
          boost: CLAUSE_BOOSTS.titleExactTerms,
          // An OR group counts once: a title holding either word earns this.
          minimum_should_match: minimumShouldMatch(
            hasOrGroups(parsed)
              ? parsed.plainTerms.length + parsed.orGroups.length
              : parsed.coreTerms.length
          )
        }
      }
    });

    // C/D. Phrase + proximity. With slop, this also rewards documents where
    //      the words merely appear close together, which is what separates
    //      "best electric cars" as a topic from a page that happens to use
    //      all three words in unrelated paragraphs.
    if (parsed.isMultiWord) {
      should.push(
        {
          match_phrase: {
            'title.exact': { query: core, slop: 1, boost: CLAUSE_BOOSTS.phraseTitle }
          }
        },
        {
          match_phrase: {
            headings: { query: core, slop: PHRASE_SLOP, boost: CLAUSE_BOOSTS.phraseHeadings }
          }
        },
        {
          match_phrase: {
            description: { query: core, slop: PHRASE_SLOP, boost: CLAUSE_BOOSTS.phraseDescription }
          }
        },
        {
          match_phrase: {
            content: { query: core, slop: PHRASE_SLOP, boost: CLAUSE_BOOSTS.phraseContent }
          }
        }
      );
    }

    // E. A title that is the question itself ("What Is Life?") — kept, at a
    //    low weight, because the topic clauses above no longer see the opener.
    if (parsed.questionStripped) {
      should.push({
        match_phrase: {
          'title.exact': { query: text, slop: 1, boost: CLAUSE_BOOSTS.questionTitle }
        }
      });
    }

    // H. The query appears in the URL path — "react.dev/learn" for "react learn".
    should.push({
      match: { path: { query: text, boost: CLAUSE_BOOSTS.urlPath } }
    });
  }

  // I. The query names a site. Boosted hard so "youtube.com" surfaces
  //    youtube.com rather than pages that merely mention YouTube.
  if (parsed.isSite && parsed.domain) {
    should.push(
      { term: { domain: { value: parsed.domain, boost: CLAUSE_BOOSTS.domainExact } } },
      { term: { domain: { value: `www.${parsed.domain}`, boost: CLAUSE_BOOSTS.domainExact } } },
      { term: { rootDomain: { value: parsed.domain, boost: CLAUSE_BOOSTS.rootDomain } } }
    );
  }

  return should;
}

/** An explicitly quoted phrase: the words adjacent and in order, unstemmed. */
function quotedPhraseClause(phrase) {
  return {
    multi_match: {
      query: phrase,
      type: 'phrase',
      fields: exactFields(),
      slop: 0,
      boost: CLAUSE_BOOSTS.quotedPhrase
    }
  };
}

/**
 * Recall for a query with OR.
 *
 * Each group admits a document matching any one of its alternatives, and
 * scores a document matching several of them higher. Phrases and words
 * outside the groups stay required, exactly as without OR.
 */
function buildOrClause(parsed) {
  const must = parsed.phrases.map(quotedPhraseClause);
  const plain = parsed.plainTerms;

  if (plain.length > 0) {
    must.push({
      multi_match: {
        query: plain.join(' '),
        type: 'best_fields',
        fields: searchFields(),
        minimum_should_match: minimumShouldMatch(plain.length),
        tie_breaker: 0.3
      }
    });
  }

  for (const group of parsed.orGroups) {
    must.push({
      bool: {
        should: group.map(alternative =>
          alternative.type === 'phrase'
            ? quotedPhraseClause(alternative.value)
            : {
                multi_match: {
                  query: alternative.value,
                  type: 'best_fields',
                  fields: searchFields(),
                  tie_breaker: 0.3
                }
              }
        ),
        minimum_should_match: 1
      }
    });
  }

  return { bool: { must } };
}

/**
 * The recall clause: which documents qualify.
 *
 * Quoted phrases are required, so `"machine learning"` genuinely means that
 * phrase. Everything else is a best_fields match across the weighted fields.
 */
function buildMustClause(parsed) {
  if (hasOrGroups(parsed)) return buildOrClause(parsed);

  // Quoted phrases are non-negotiable.
  if (parsed.hasPhrase) {
    const phraseClauses = parsed.phrases.map(quotedPhraseClause);

    // Any loose terms alongside the phrase still need to match somewhere
    // (a question opener around the phrase is not one of them).
    if (parsed.coreTerms.length > 0) {
      phraseClauses.push({
        multi_match: {
          query: parsed.coreTerms.join(' '),
          type: 'best_fields',
          fields: searchFields(),
          minimum_should_match: minimumShouldMatch(parsed.coreTerms.length)
        }
      });
    }

    return { bool: { must: phraseClauses } };
  }

  const text = parsed.text || parsed.cleaned;

  // A site query should still return the site even though "youtube.com" is
  // unlikely to appear in any page's body text.
  if (parsed.isSite && parsed.domain) {
    return {
      bool: {
        should: [
          { term: { domain: parsed.domain } },
          { term: { domain: `www.${parsed.domain}` } },
          { term: { rootDomain: parsed.domain } },
          { match: { 'domain.text': { query: parsed.domain } } },
          { match: { url: { query: parsed.domain } } },
          {
            multi_match: {
              query: text,
              type: 'best_fields',
              fields: searchFields()
            }
          }
        ],
        minimum_should_match: 1
      }
    };
  }

  // Questions match on their topic; identical to `text` otherwise.
  const core = parsed.coreText || parsed.cleaned;

  const exactClause = {
    multi_match: {
      query: core,
      type: 'best_fields',
      fields: searchFields(),
      minimum_should_match: minimumShouldMatch(parsed.coreTerms.length),
      // A document matching one field strongly beats one matching many
      // fields weakly, but the weaker fields still contribute a little.
      tie_breaker: 0.3
    }
  };

  // When a typo is plausible, the fuzzy variant has to sit in `must` too.
  // A `should` clause can only reorder documents that `must` already
  // admitted, so a misspelling with no exact matches would return nothing
  // at all. Either clause can qualify a document; the exact one scores far
  // higher, so correctly-spelled matches still win.
  const fuzzy = buildFuzzyClause(parsed);
  if (fuzzy) {
    // Admission gate. On its own the fuzzy clause matches any one term, so a
    // multi-word query would admit a document containing a single fuzzy
    // term. The gate holds it to the exact clause's term requirement. It is
    // a filter, so scoring above is untouched: it only decides who qualifies.
    const fuzzyGate = {
      multi_match: {
        ...fuzzy.multi_match,
        minimum_should_match: minimumShouldMatch(parsed.coreTerms.length)
      }
    };

    return {
      bool: {
        should: [exactClause, fuzzy],
        minimum_should_match: 1,
        filter: [{ bool: { should: [exactClause, fuzzyGate], minimum_should_match: 1 } }]
      }
    };
  }

  return exactClause;
}

/**
 * Typo tolerance.
 *
 * Returned as a separate low-weight clause rather than fuzziness on the main
 * query: an exact match always scores far above a fuzzy one, so this can
 * only add results when the precise query found little.
 */
function buildFuzzyClause(parsed) {
  if (!parsed.allowFuzzy) return null;

  return {
    multi_match: {
      query: parsed.coreText || parsed.cleaned,
      type: 'best_fields',
      fields: [`title^${FIELD_BOOSTS.title}`, `headings^${FIELD_BOOSTS.headings}`, 'content'],
      // AUTO scales the allowed edits with word length: none below 3 chars,
      // one edit to 5, two beyond — so short words are never fuzzied.
      fuzziness: 'AUTO',
      prefix_length: 2, // the first two letters must be right
      max_expansions: 30,
      boost: CLAUSE_BOOSTS.fuzzy
    }
  };
}

/** A word or phrase held to one field: intitle: and inurl:. */
function fieldClause(field, type, query, boost) {
  const weight = boost === undefined ? {} : { boost };

  if (field === 'title') {
    return type === 'phrase'
      ? { match_phrase: { 'title.exact': { query, slop: 0, ...weight } } }
      : { match: { title: { query, operator: 'and', ...weight } } };
  }

  const fields = ['url', 'path'];
  return type === 'phrase'
    ? { multi_match: { query, type: 'phrase', fields, slop: 0, ...weight } }
    : { multi_match: { query, type: 'best_fields', fields, operator: 'and', ...weight } };
}

/** A word that must (AND) or must not (-word) appear in the searched fields. */
function wordClause(query) {
  return { multi_match: { query, type: 'best_fields', fields: searchFields(), operator: 'and' } };
}

/**
 * The clauses the search operators add.
 *
 *   filter   site:, lang:, and the words an explicit AND requires
 *   mustNot  -word, -"phrase", -site:, -lang:, -intitle:, -inurl:
 *   must     intitle: and inurl:
 *
 * `filter` and `mustNot` decide only which documents qualify; they add
 * nothing to a score, so a document that remains is ranked exactly as it
 * would be without them. intitle: and inurl: are the user naming a field, so
 * they score — at that field's existing weight — and sit beside the recall
 * clause rather than inside it.
 *
 * @param {import('./queryParser').ParsedQuery} parsed
 */
function buildOperatorClauses(parsed) {
  const must = [];
  const filter = [];
  const mustNot = [];
  if (!parsed.hasOperators) return { must, filter, mustNot };

  // A page is on one site, so several site: operators mean "any of these".
  if (parsed.sites.length === 1) {
    filter.push(domainClause(parsed.sites[0]));
  } else if (parsed.sites.length > 1) {
    filter.push({ bool: { should: parsed.sites.map(domainClause), minimum_should_match: 1 } });
  }
  // The same holds for a language. One lang: is the `language` filter of
  // buildFilters, clause for clause.
  if (parsed.languages.length === 1) {
    filter.push({ term: { language: parsed.languages[0] } });
  } else if (parsed.languages.length > 1) {
    filter.push({ terms: { language: parsed.languages } });
  }
  for (const term of parsed.requiredTerms) filter.push(wordClause(term));

  for (const term of parsed.titleTerms) {
    must.push(fieldClause('title', 'term', term, FIELD_BOOSTS.title));
  }
  for (const phrase of parsed.titlePhrases) {
    must.push(fieldClause('title', 'phrase', phrase, FIELD_BOOSTS.title));
  }
  for (const term of parsed.urlTerms) must.push(fieldClause('url', 'term', term, FIELD_BOOSTS.url));
  for (const phrase of parsed.urlPhrases) {
    must.push(fieldClause('url', 'phrase', phrase, FIELD_BOOSTS.url));
  }

  for (const term of parsed.excludedTerms) mustNot.push(wordClause(term));
  for (const phrase of parsed.excludedPhrases) {
    mustNot.push({
      multi_match: { query: phrase, type: 'phrase', fields: exactFields(), slop: 0 }
    });
  }
  for (const site of parsed.excludedSites) mustNot.push(domainClause(site));
  for (const language of parsed.excludedLanguages) mustNot.push({ term: { language } });
  for (const term of parsed.excludedTitleTerms) mustNot.push(fieldClause('title', 'term', term));
  for (const phrase of parsed.excludedTitlePhrases) {
    mustNot.push(fieldClause('title', 'phrase', phrase));
  }
  for (const term of parsed.excludedUrlTerms) mustNot.push(fieldClause('url', 'term', term));
  for (const phrase of parsed.excludedUrlPhrases)
    mustNot.push(fieldClause('url', 'phrase', phrase));

  return { must, filter, mustNot };
}

/**
 * Bounded quality and freshness multipliers.
 *
 * Both are deliberately narrow. Quality moves a score by at most ±25% and
 * freshness by at most −15%, so neither can promote an irrelevant document
 * above a relevant one.
 */
function buildScoreFunctions({ boostFreshness }) {
  const functions = [
    {
      // qualityScore is 0.05..1 -> multiplier 0.775..1.25
      script_score: {
        script: {
          source:
            "double q = doc['qualityScore'].size() == 0 ? 0.5 : doc['qualityScore'].value; " +
            'return 0.75 + (0.5 * q);'
        }
      }
    }
  ];

  if (boostFreshness) {
    // Freshness is applied as bounded buckets rather than a decay curve.
    //
    // A gauss/exp decay is the obvious choice here and it is a trap: `decay`
    // is the multiplier at ONE scale unit, and the curve keeps falling
    // quadratically beyond that. With a 365d scale, a page published in 2001
    // is ~25 scale units away and scores 0.85^(25^2) — around 1e-42 — which
    // silently erases every older document from the results no matter how
    // well it matches.
    //
    // These buckets can only ever lift a recent page (max +15%); a document
    // matching none of them is left untouched at 1.0. Age never demotes.
    functions.push(
      { filter: { range: { publishedAt: { gte: 'now-2d' } } }, weight: 1.15 },
      { filter: { range: { publishedAt: { gte: 'now-14d', lt: 'now-2d' } } }, weight: 1.1 },
      { filter: { range: { publishedAt: { gte: 'now-90d', lt: 'now-14d' } } }, weight: 1.05 }
    );
  }

  return functions;
}

/**
 * Assembles the complete search request body.
 *
 * @param {import('./queryParser').ParsedQuery} parsed
 * @param {Object} options
 * @param {number} options.from
 * @param {number} options.size
 * @param {string} options.sort           'relevance' | 'newest' | 'oldest'
 * @param {string} [options.domain]
 * @param {string} [options.dateWindow]
 * @param {string} [options.language]
 * @param {boolean} [options.isArticle]   restrict to news articles
 * @param {string[]} [options.ids]        restrict to these document ids
 * @param {boolean} [options.explain]     development scoring breakdown
 */
function buildSearchBody(parsed, options = {}) {
  const {
    from = 0,
    size = 10,
    sort = 'relevance',
    domain = '',
    dateWindow = 'any',
    language = '',
    isArticle,
    ids,
    explain = false
  } = options;

  // The fuzzy clause is folded into `must` (see buildMustClause) so it can
  // admit documents, not merely reorder them.
  const should = buildShouldClauses(parsed);
  const operators = buildOperatorClauses(parsed);

  // A query of operators alone (site:, lang:, intitle:, inurl:) has no free
  // text to recall on; with nothing but a site or a language, every page of
  // it matches.
  const hasFreeText = parsed.terms.length + parsed.phrases.length > 0 || hasOrGroups(parsed);
  const must = parsed.hasOperators && !hasFreeText ? [] : [buildMustClause(parsed)];
  must.push(...operators.must);
  if (must.length === 0) must.push({ match_all: {} });

  const boolQuery = {
    bool: {
      must,
      should,
      // The domain parameter and site: are both strict, so together they
      // narrow: domain=wikipedia.org with site:en.wikipedia.org is the latter.
      filter: [
        ...buildFilters({ domain, dateWindow, language, isArticle, ids }),
        ...operators.filter
      ],
      // `should` here only reorders; it must never gate what matches.
      minimum_should_match: 0
    }
  };
  if (operators.mustNot.length > 0) boolQuery.bool.must_not = operators.mustNot;

  // Sorting by date explicitly means the user wants chronology, so relevance
  // scoring is left alone rather than being blended with recency.
  const sortingByDate = sort === 'newest' || sort === 'oldest';

  const query = {
    function_score: {
      query: boolQuery,
      functions: buildScoreFunctions({ boostFreshness: !sortingByDate }),
      score_mode: 'multiply',
      boost_mode: 'multiply'
    }
  };

  const body = {
    query,
    from,
    size,
    // Never ship page bodies to the API layer; the snippet comes from
    // highlighting, and everything else is small.
    _source: {
      excludes: ['content', 'content.exact', 'headings']
    },
    highlight: {
      pre_tags: ['<mark>'],
      post_tags: ['</mark>'],
      fields: {
        content: {
          fragment_size: 180,
          number_of_fragments: 2,
          no_match_size: 180 // still return an opening snippet
        },
        description: { fragment_size: 180, number_of_fragments: 1 },
        title: { number_of_fragments: 0 }
      }
    },
    track_total_hits: true
  };

  // Equal scores are common (79 adjacent ties for "mathematics"), and without
  // a tie-breaker OpenSearch orders them by internal document number, which a
  // segment merge or reindex can change — moving results across page
  // boundaries. The url hash (= the document _id) is unique and has doc
  // values, so it makes the order total without touching the ranking.
  const tieBreaker = { urlHash: { order: 'asc' } };

  if (sortingByDate) {
    const order = sort === 'newest' ? 'desc' : 'asc';
    body.sort = [
      // Pages with no publication date sort last rather than first.
      { publishedAt: { order, missing: order === 'desc' ? '_last' : '_first' } },
      { crawledAt: { order } },
      '_score',
      tieBreaker
    ];
  } else {
    body.sort = [{ _score: { order: 'desc' } }, tieBreaker];
  }

  if (explain) body.explain = true;

  return body;
}

module.exports = {
  buildSearchBody,
  buildMustClause,
  buildShouldClauses,
  buildFilters,
  buildOperatorClauses,
  buildFuzzyClause,
  buildScoreFunctions,
  minimumShouldMatch,
  searchFields,
  exactFields,
  FIELD_BOOSTS,
  CLAUSE_BOOSTS,
  PHRASE_SLOP
};
