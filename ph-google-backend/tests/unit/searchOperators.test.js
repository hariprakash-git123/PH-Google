const { parseQuery } = require('../../services/opensearch/queryParser');
const {
  buildSearchBody,
  buildMustClause,
  buildShouldClauses,
  buildFilters,
  buildScoreFunctions,
  searchFields,
  exactFields,
  FIELD_BOOSTS,
  CLAUSE_BOOSTS
} = require('../../services/opensearch/queryBuilder');

/**
 * Advanced search operators — parsing, and the OpenSearch request they build.
 *
 * site:, -site:, -term, -"phrase", OR, AND, intitle:, inurl:, and the symbol
 * terms (c++, c#, .net). Pure logic: no cluster, no database.
 */

const term = value => ({ type: 'term', value });
const phrase = value => ({ type: 'phrase', value });

/** Every operator field in its empty state. */
const NO_OPERATORS = {
  sites: [],
  excludedSites: [],
  excludedTerms: [],
  excludedPhrases: [],
  orGroups: [],
  requireAll: false,
  requiredTerms: [],
  titleTerms: [],
  titlePhrases: [],
  urlTerms: [],
  urlPhrases: [],
  excludedTitleTerms: [],
  excludedTitlePhrases: [],
  excludedUrlTerms: [],
  excludedUrlPhrases: [],
  languages: [],
  excludedLanguages: [],
  ignoredOperators: [],
  ignoredWords: [],
  hasOperators: false
};

describe('operator parsing', () => {
  describe('site:', () => {
    it('extracts the site and searches only the remaining words', () => {
      const parsed = parseQuery('site:wikipedia.org physics');
      expect(parsed.sites).toEqual(['wikipedia.org']);
      expect(parsed.terms).toEqual(['physics']);
      expect(parsed.text).toBe('physics');
      expect(parsed.coreText).toBe('physics');
      expect(parsed.hasOperators).toBe(true);
    });

    it('never searches the literal words "site" or the domain', () => {
      const parsed = parseQuery('site:wikipedia.org physics');
      expect(parsed.terms).not.toContain('site');
      expect(parsed.terms).not.toContain('wikipedia.org');
    });

    it('works with a quoted phrase', () => {
      const parsed = parseQuery('site:en.wikipedia.org "quantum physics"');
      expect(parsed.sites).toEqual(['en.wikipedia.org']);
      expect(parsed.phrases).toEqual(['quantum physics']);
      expect(parsed.terms).toEqual([]);
      expect(parsed.hasPhrase).toBe(true);
    });

    it('accepts a full URL and a www. prefix, like the domain parameter', () => {
      expect(parseQuery('site:https://www.react.dev/learn hooks').sites).toEqual(['react.dev']);
      expect(parseQuery('site:www.example.com news').sites).toEqual(['example.com']);
    });

    it('is case-insensitive on the operator and the domain', () => {
      expect(parseQuery('Site:Wikipedia.ORG physics').sites).toEqual(['wikipedia.org']);
    });

    it('can appear anywhere in the query', () => {
      const parsed = parseQuery('physics site:wikipedia.org history');
      expect(parsed.sites).toEqual(['wikipedia.org']);
      expect(parsed.terms).toEqual(['physics', 'history']);
    });

    it('collects several sites', () => {
      const parsed = parseQuery('site:a.com site:b.org python');
      expect(parsed.sites).toEqual(['a.com', 'b.org']);
    });

    it('is not an empty query when it stands alone', () => {
      const parsed = parseQuery('site:wikipedia.org');
      expect(parsed.isEmpty).toBe(false);
      expect(parsed.terms).toEqual([]);
    });

    it('is not mistaken for the bare-domain query', () => {
      const parsed = parseQuery('site:youtube.com');
      expect(parsed.isSite).toBe(false);
      expect(parsed.domain).toBe('');
      expect(parsed.sites).toEqual(['youtube.com']);
    });

    it('leaves a value that is not a domain as ordinary words', () => {
      const parsed = parseQuery('site:foo bar');
      expect(parsed.sites).toEqual([]);
      expect(parsed.terms).toEqual(['site', 'foo', 'bar']);
      expect(parsed.hasOperators).toBe(false);
    });

    it('leaves "site:" with nothing attached as an ordinary word', () => {
      const parsed = parseQuery('site: wikipedia.org physics');
      expect(parsed.sites).toEqual([]);
      expect(parsed.terms).toEqual(['site', 'wikipedia.org', 'physics']);
    });
  });

  describe('-site:', () => {
    it('excludes a site', () => {
      const parsed = parseQuery('python -site:example.com');
      expect(parsed.excludedSites).toEqual(['example.com']);
      expect(parsed.sites).toEqual([]);
      expect(parsed.terms).toEqual(['python']);
    });

    it('combines with a site restriction', () => {
      const parsed = parseQuery('site:example.org -site:blog.example.org python');
      expect(parsed.sites).toEqual(['example.org']);
      expect(parsed.excludedSites).toEqual(['blog.example.org']);
    });
  });

  describe('negative terms', () => {
    it('turns -java into an exclusion, never a required word', () => {
      const parsed = parseQuery('python -java');
      expect(parsed.terms).toEqual(['python']);
      expect(parsed.coreTerms).toEqual(['python']);
      expect(parsed.text).toBe('python');
      expect(parsed.excludedTerms).toEqual(['java']);
    });

    it('excludes a quoted phrase', () => {
      const parsed = parseQuery('python -"java programming"');
      expect(parsed.terms).toEqual(['python']);
      expect(parsed.phrases).toEqual([]);
      expect(parsed.hasPhrase).toBe(false);
      expect(parsed.excludedPhrases).toEqual(['java programming']);
    });

    it('supports several negative terms and phrases', () => {
      const parsed = parseQuery('python -java -ruby -"c sharp" -perl');
      expect(parsed.terms).toEqual(['python']);
      expect(parsed.excludedTerms).toEqual(['java', 'ruby', 'perl']);
      expect(parsed.excludedPhrases).toEqual(['c sharp']);
    });

    it('de-duplicates repeated exclusions', () => {
      expect(parseQuery('python -java -Java').excludedTerms).toEqual(['java']);
    });

    it('has nothing to search for when a query is only exclusions', () => {
      const parsed = parseQuery('-java');
      expect(parsed.excludedTerms).toEqual(['java']);
      expect(parsed.terms).toEqual([]);
      expect(parsed.isEmpty).toBe(true);
    });

    it('keeps a positive and a negative phrase apart', () => {
      const parsed = parseQuery('"machine learning" -"deep learning"');
      expect(parsed.phrases).toEqual(['machine learning']);
      expect(parsed.excludedPhrases).toEqual(['deep learning']);
    });

    it('still excludes when the closing quote is missing', () => {
      const parsed = parseQuery('python -"java');
      expect(parsed.terms).toEqual(['python']);
      expect(parsed.excludedTerms).toEqual(['java']);
    });

    it('does not let an exclusion decide fuzziness or the question topic', () => {
      expect(parseQuery('the cat -photosynthesis').allowFuzzy).toBe(false);
      const parsed = parseQuery('how does gravity work -newton');
      expect(parsed.coreTerms).toEqual(['gravity']);
      expect(parsed.excludedTerms).toEqual(['newton']);
    });
  });

  describe('hyphens that are not negation', () => {
    it('keeps a hyphen inside a word', () => {
      expect(parseQuery('wi-fi router').terms).toEqual(['wi-fi', 'router']);
      expect(parseQuery('state-of-the-art models').terms).toEqual(['state-of-the-art', 'models']);
      expect(parseQuery('wi-fi router').excludedTerms).toEqual([]);
    });

    it('ignores a hyphen standing alone', () => {
      const parsed = parseQuery('python - java');
      expect(parsed.terms).toEqual(['python', 'java']);
      expect(parsed.excludedTerms).toEqual([]);
    });

    it('does not read a double hyphen as negation', () => {
      const parsed = parseQuery('git --force push');
      expect(parsed.terms).toEqual(['git', 'force', 'push']);
      expect(parsed.excludedTerms).toEqual([]);
    });
  });

  describe('OR', () => {
    it('groups the words on either side', () => {
      const parsed = parseQuery('cats OR dogs');
      expect(parsed.orGroups).toEqual([[term('cats'), term('dogs')]]);
      expect(parsed.terms).toEqual(['cats', 'dogs']);
      expect(parsed.text).toBe('cats dogs');
      expect(parsed.hasOperators).toBe(true);
    });

    it('is never searched as a word', () => {
      const parsed = parseQuery('cats OR dogs');
      expect(parsed.terms).not.toContain('OR');
      expect(parsed.text).not.toMatch(/\bOR\b/);
    });

    it('groups phrases', () => {
      const parsed = parseQuery('"machine learning" OR "deep learning"');
      expect(parsed.orGroups).toEqual([[phrase('machine learning'), phrase('deep learning')]]);
      // Neither phrase is required on its own.
      expect(parsed.phrases).toEqual([]);
      expect(parsed.terms).toEqual([]);
      expect(parsed.isEmpty).toBe(false);
    });

    it('binds tighter than the words around it', () => {
      const parsed = parseQuery('python OR javascript tutorial');
      expect(parsed.orGroups).toEqual([[term('python'), term('javascript')]]);
      expect(parsed.terms).toEqual(['python', 'javascript', 'tutorial']);
    });

    it('chains into one group', () => {
      expect(parseQuery('cats OR dogs OR birds').orGroups).toEqual([
        [term('cats'), term('dogs'), term('birds')]
      ]);
    });

    it('keeps separate groups separate', () => {
      expect(parseQuery('cats OR dogs food OR toys').orGroups).toEqual([
        [term('cats'), term('dogs')],
        [term('food'), term('toys')]
      ]);
    });

    it('mixes a word and a phrase', () => {
      expect(parseQuery('python OR "machine learning"').orGroups).toEqual([
        [term('python'), phrase('machine learning')]
      ]);
    });

    it('only recognises the upper-case word', () => {
      const parsed = parseQuery('cats or dogs');
      expect(parsed.orGroups).toEqual([]);
      expect(parsed.terms).toEqual(['cats', 'or', 'dogs']);
      expect(parsed.hasOperators).toBe(false);
    });

    it('does not see an operator inside an ordinary word', () => {
      for (const query of ['organic oregano', 'ORACLE database', 'doctor ORDER form']) {
        expect(parseQuery(query).orGroups).toEqual([]);
        expect(parseQuery(query).hasOperators).toBe(false);
      }
    });

    it('treats an OR with a missing side as a word', () => {
      expect(parseQuery('OR gate').terms).toEqual(['OR', 'gate']);
      expect(parseQuery('OR gate').orGroups).toEqual([]);
      expect(parseQuery('cats OR').terms).toEqual(['cats', 'OR']);
      expect(parseQuery('OR').terms).toEqual(['OR']);
    });

    it('never fuzzies an OR query', () => {
      expect(parseQuery('photosynthesis OR respiration').allowFuzzy).toBe(false);
    });
  });

  describe('AND', () => {
    it('requires every word and is never searched as a word', () => {
      const parsed = parseQuery('cats AND dogs');
      expect(parsed.requireAll).toBe(true);
      expect(parsed.requiredTerms).toEqual(['cats', 'dogs']);
      expect(parsed.terms).toEqual(['cats', 'dogs']);
      expect(parsed.text).toBe('cats dogs');
      expect(parsed.hasOperators).toBe(true);
    });

    it('requires the words around it in a longer query', () => {
      const parsed = parseQuery('python AND machine learning');
      expect(parsed.requireAll).toBe(true);
      expect(parsed.requiredTerms).toEqual(['python', 'machine', 'learning']);
      expect(parsed.terms).toEqual(['python', 'machine', 'learning']);
    });

    it('does not require a stop word, which the index does not hold', () => {
      expect(parseQuery('cats AND the dogs').requiredTerms).toEqual(['cats', 'dogs']);
    });

    it('only recognises the upper-case word', () => {
      const parsed = parseQuery('cats and dogs');
      expect(parsed.requireAll).toBe(false);
      expect(parsed.requiredTerms).toEqual([]);
      expect(parsed.terms).toEqual(['cats', 'and', 'dogs']);
      expect(parsed.hasOperators).toBe(false);
    });

    it('does not see an operator inside an ordinary word', () => {
      for (const query of ['ANDROID phone', 'sand castle', 'BRAND new']) {
        expect(parseQuery(query).requireAll).toBe(false);
      }
    });

    it('treats an AND with a missing side as a word', () => {
      expect(parseQuery('AND gate').terms).toEqual(['AND', 'gate']);
      expect(parseQuery('AND gate').requireAll).toBe(false);
    });

    it('combines with OR, which binds tighter', () => {
      const parsed = parseQuery('cats OR dogs AND food');
      expect(parsed.orGroups).toEqual([[term('cats'), term('dogs')]]);
      expect(parsed.requireAll).toBe(true);
      // The OR group is required as a group; only the plain word is listed.
      expect(parsed.requiredTerms).toEqual(['food']);
    });

    it('leaves a query with no explicit operator exactly as it was', () => {
      const parsed = parseQuery('python machine learning');
      expect(parsed.requireAll).toBe(false);
      expect(parsed.requiredTerms).toEqual([]);
      expect(parsed.orGroups).toEqual([]);
    });
  });

  describe('intitle:', () => {
    it('restricts a word to the title', () => {
      const parsed = parseQuery('intitle:python');
      expect(parsed.titleTerms).toEqual(['python']);
      expect(parsed.terms).toEqual([]);
      expect(parsed.isEmpty).toBe(false);
      expect(parsed.hasOperators).toBe(true);
    });

    it('restricts a phrase to the title and searches the rest normally', () => {
      const parsed = parseQuery('intitle:"machine learning" tutorial');
      expect(parsed.titlePhrases).toEqual(['machine learning']);
      expect(parsed.titleTerms).toEqual([]);
      expect(parsed.terms).toEqual(['tutorial']);
      // A title phrase is not a free-text phrase.
      expect(parsed.phrases).toEqual([]);
    });

    it('supports exclusion through the ordinary minus', () => {
      const parsed = parseQuery('python -intitle:spam -intitle:"buy now"');
      expect(parsed.excludedTitleTerms).toEqual(['spam']);
      expect(parsed.excludedTitlePhrases).toEqual(['buy now']);
      expect(parsed.terms).toEqual(['python']);
    });

    it('leaves "intitle:" with nothing attached as an ordinary word', () => {
      expect(parseQuery('intitle: python').terms).toEqual(['intitle', 'python']);
      expect(parseQuery('intitle: python').titleTerms).toEqual([]);
    });
  });

  describe('inurl:', () => {
    it('restricts a word to the URL', () => {
      const parsed = parseQuery('inurl:python tutorial');
      expect(parsed.urlTerms).toEqual(['python']);
      expect(parsed.terms).toEqual(['tutorial']);
    });

    it('keeps the free words free', () => {
      const parsed = parseQuery('inurl:docs python');
      expect(parsed.urlTerms).toEqual(['docs']);
      expect(parsed.terms).toEqual(['python']);
    });

    it('supports a phrase and exclusion', () => {
      expect(parseQuery('inurl:"getting started"').urlPhrases).toEqual(['getting started']);
      expect(parseQuery('python -inurl:forum').excludedUrlTerms).toEqual(['forum']);
      expect(parseQuery('python -inurl:"old docs"').excludedUrlPhrases).toEqual(['old docs']);
    });
  });

  describe('symbol terms', () => {
    it.each([
      ['c++', ['c++']],
      ['c#', ['c#']],
      ['c++ c#', ['c++', 'c#']],
      ['C++ c++', ['C++']],
      ['.net', ['.net']],
      ['asp.net core', ['asp.net', 'core']],
      ['f# g++ notepad++', ['f#', 'g++', 'notepad++']],
      ['learn c++, c# and .net.', ['learn', 'c++', 'c#', 'and', '.net']]
    ])('parses %s', (query, terms) => {
      expect(parseQuery(query).terms).toEqual(terms);
    });

    it('does not collapse c, c++ and c# into one term', () => {
      expect(parseQuery('c c++ c#').terms).toEqual(['c', 'c++', 'c#']);
    });

    it('still strips punctuation that carries no meaning', () => {
      expect(parseQuery('hello... world!').terms).toEqual(['hello', 'world']);
      expect(parseQuery('#python +tutorial _notes_').terms).toEqual([
        'python',
        'tutorial',
        'notes'
      ]);
      expect(parseQuery('end. ...start').terms).toEqual(['end', 'start']);
      expect(parseQuery('++ ## ..').isEmpty).toBe(true);
    });

    it('can be excluded', () => {
      expect(parseQuery('programming -c++').excludedTerms).toEqual(['c++']);
    });

    it('keeps dots inside a term and a domain', () => {
      expect(parseQuery('node.js').terms).toEqual(['node.js']);
      expect(parseQuery('wikipedia.org physics').terms).toEqual(['wikipedia.org', 'physics']);
    });
  });

  describe('existing behaviour is preserved', () => {
    it.each([
      'python',
      'python tutorial',
      '"machine learning"',
      'open source "search engine" tutorial',
      'how does gravity work',
      'youtube.com',
      'cats or dogs',
      'wi-fi router'
    ])('reports no operators for "%s"', query => {
      expect(parseQuery(query)).toMatchObject(NO_OPERATORS);
    });

    it('reports no operators for an empty or punctuation-only query', () => {
      for (const query of ['', '   ', '!!! ???', '""', '- -']) {
        const parsed = parseQuery(query);
        expect(parsed.isEmpty).toBe(true);
        expect(parsed).toMatchObject(NO_OPERATORS);
      }
    });

    it('still extracts quoted phrases, straight and curly', () => {
      expect(parseQuery('open source "search engine" tutorial').phrases).toEqual(['search engine']);
      expect(parseQuery('“machine learning” basics').phrases).toEqual(['machine learning']);
      expect(parseQuery('"a b" and "c d"').phrases).toEqual(['a b', 'c d']);
    });

    it('still treats an unbalanced quote as plain words', () => {
      const parsed = parseQuery('broken "quote here');
      expect(parsed.phrases).toEqual([]);
      expect(parsed.terms).toEqual(['broken', 'quote', 'here']);
      expect(parsed.text).toBe('broken quote here');
    });

    it('still detects a whole-query bare domain or URL', () => {
      expect(parseQuery('youtube.com')).toMatchObject({ isSite: true, domain: 'youtube.com' });
      expect(parseQuery('https://www.react.dev/learn')).toMatchObject({
        isSite: true,
        domain: 'react.dev'
      });
    });

    it('does not turn a multi-word query into a domain', () => {
      for (const query of ['wikipedia.org physics', 'machine learning', 'node.js tutorial']) {
        expect(parseQuery(query).isSite).toBe(false);
        expect(parseQuery(query).sites).toEqual([]);
      }
    });

    it('still reduces a question to its topic', () => {
      const parsed = parseQuery('what is the capital of india');
      expect(parsed.isQuestion).toBe(true);
      expect(parsed.coreTerms).toEqual(['capital', 'of', 'india']);
    });
  });

  describe('combinations', () => {
    it('site + phrase', () => {
      const parsed = parseQuery('site:wikipedia.org "quantum physics" history');
      expect(parsed).toMatchObject({
        sites: ['wikipedia.org'],
        phrases: ['quantum physics'],
        terms: ['history']
      });
    });

    it('site + negative term', () => {
      const parsed = parseQuery('site:wikipedia.org python -snake');
      expect(parsed).toMatchObject({
        sites: ['wikipedia.org'],
        terms: ['python'],
        excludedTerms: ['snake']
      });
    });

    it('site + OR', () => {
      const parsed = parseQuery('site:wikipedia.org cats OR dogs');
      expect(parsed.sites).toEqual(['wikipedia.org']);
      expect(parsed.orGroups).toEqual([[term('cats'), term('dogs')]]);
    });

    it('does not group a site with a word across OR', () => {
      const parsed = parseQuery('site:a.com OR site:b.org python');
      expect(parsed.sites).toEqual(['a.com', 'b.org']);
      expect(parsed.orGroups).toEqual([]);
      expect(parsed.terms).toEqual(['python']);
    });

    it('intitle + site', () => {
      const parsed = parseQuery('intitle:python site:docs.example.com');
      expect(parsed).toMatchObject({ titleTerms: ['python'], sites: ['docs.example.com'] });
    });

    it('inurl + site', () => {
      const parsed = parseQuery('inurl:tutorial site:example.com python');
      expect(parsed).toMatchObject({
        urlTerms: ['tutorial'],
        sites: ['example.com'],
        terms: ['python']
      });
    });

    it('phrase + negative phrase', () => {
      const parsed = parseQuery('"electric cars" -"2019"');
      expect(parsed.phrases).toEqual(['electric cars']);
      expect(parsed.excludedPhrases).toEqual(['2019']);
    });

    it('a question with a site restriction keeps its topic', () => {
      const parsed = parseQuery('site:nasa.gov what is a black hole');
      expect(parsed.sites).toEqual(['nasa.gov']);
      expect(parsed.coreTerms).toEqual(['black', 'hole']);
    });

    it('many operators together', () => {
      const parsed = parseQuery(
        'site:example.com -site:blog.example.com intitle:guide inurl:docs ' +
          '"getting started" python OR javascript -java -"old version" c++'
      );
      expect(parsed).toMatchObject({
        sites: ['example.com'],
        excludedSites: ['blog.example.com'],
        titleTerms: ['guide'],
        urlTerms: ['docs'],
        phrases: ['getting started'],
        orGroups: [[term('python'), term('javascript')]],
        terms: ['python', 'javascript', 'c++'],
        excludedTerms: ['java'],
        excludedPhrases: ['old version'],
        requireAll: false,
        hasOperators: true,
        isSite: false,
        isEmpty: false
      });
    });

    it('never throws, whatever is typed', () => {
      for (const query of [
        'site:',
        '-site:',
        '-',
        '-"',
        'OR OR OR',
        'AND OR AND',
        'intitle:""',
        'site:http://',
        '-intitle:-inurl:x',
        'a OR -b',
        '"a" OR',
        ':::',
        'site:a.com AND -site:b.com OR "x"'
      ]) {
        expect(() => parseQuery(query)).not.toThrow();
      }
    });
  });
});

describe('operator query building', () => {
  const bodyOf = (query, options = {}) => buildSearchBody(parseQuery(query), options);
  const boolOf = (query, options) => bodyOf(query, options).query.function_score.query.bool;
  const domainFilter = domain => buildFilters({ domain })[0];

  /** Every `query` string anywhere in the request. */
  const queryStrings = value => {
    const found = [];
    const walk = node => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') {
        for (const [key, child] of Object.entries(node)) {
          if (key === 'query' && typeof child === 'string') found.push(child);
          else walk(child);
        }
      }
    };
    walk(value);
    return found;
  };

  /**
   * The parts of the request that produce a score. An operator that only
   * narrows the result set must leave all of them exactly as they are for
   * the same query without the operator.
   */
  const scoring = (query, options) => {
    const body = bodyOf(query, options);
    const { must, should, minimum_should_match: msm } = body.query.function_score.query.bool;
    const { functions, score_mode: scoreMode, boost_mode: boostMode } = body.query.function_score;
    return { must, should, msm, functions, scoreMode, boostMode, sort: body.sort };
  };

  describe('a query without operators', () => {
    it.each(['python', 'python tutorial', '"machine learning"', 'youtube.com', 'what is gravity'])(
      'builds "%s" with no operator clauses',
      query => {
        const bool = boolOf(query);
        expect(Object.keys(bool)).toEqual(['must', 'should', 'filter', 'minimum_should_match']);
        expect(bool.must).toEqual([buildMustClause(parseQuery(query))]);
        expect(bool.filter).toEqual(buildFilters({}));
      }
    );
  });

  describe('site:', () => {
    it('adds the same strict filter the domain parameter uses', () => {
      const bool = boolOf('site:wikipedia.org physics');
      expect(bool.filter).toEqual(expect.arrayContaining([domainFilter('wikipedia.org')]));
      expect(JSON.stringify(domainFilter('wikipedia.org'))).toContain(
        '"rootDomain":"wikipedia.org"'
      );
    });

    it('searches only the remaining words', () => {
      expect(queryStrings(bodyOf('site:wikipedia.org physics'))).toEqual(
        queryStrings(bodyOf('physics'))
      );
      expect(JSON.stringify(bodyOf('site:wikipedia.org physics').query)).not.toContain('site:');
    });

    it('does not change how the remaining results are scored', () => {
      expect(scoring('site:wikipedia.org physics')).toEqual(scoring('physics'));
      expect(scoring('site:en.wikipedia.org "quantum physics"')).toEqual(
        scoring('"quantum physics"')
      );
      expect(scoring('site:example.com best electric cars')).toEqual(scoring('best electric cars'));
    });

    it('narrows the domain parameter rather than replacing it', () => {
      const bool = boolOf('site:en.wikipedia.org physics', { domain: 'wikipedia.org' });
      expect(bool.filter).toEqual(
        expect.arrayContaining([domainFilter('wikipedia.org'), domainFilter('en.wikipedia.org')])
      );
    });

    it('accepts any one of several sites', () => {
      const bool = boolOf('site:a.com site:b.org python');
      expect(bool.filter).toEqual(
        expect.arrayContaining([
          {
            bool: {
              should: [domainFilter('a.com'), domainFilter('b.org')],
              minimum_should_match: 1
            }
          }
        ])
      );
    });

    it('lists the site when nothing else is asked for', () => {
      const bool = boolOf('site:wikipedia.org');
      expect(bool.must).toEqual([{ match_all: {} }]);
      expect(bool.should).toEqual([]);
      expect(bool.filter).toEqual(expect.arrayContaining([domainFilter('wikipedia.org')]));
    });

    it('excludes a site with -site:', () => {
      const bool = boolOf('python -site:example.com');
      expect(bool.must_not).toEqual([domainFilter('example.com')]);
      expect(scoring('python -site:example.com')).toEqual(scoring('python'));
    });
  });

  describe('negative terms', () => {
    it('puts an excluded word in must_not, across the searched fields', () => {
      const bool = boolOf('python -java');
      expect(bool.must_not).toEqual([
        {
          multi_match: {
            query: 'java',
            type: 'best_fields',
            fields: searchFields(),
            operator: 'and'
          }
        }
      ]);
    });

    it('never requires the excluded word', () => {
      const bool = boolOf('python -java');
      const positive = { must: bool.must, should: bool.should, filter: bool.filter };
      expect(queryStrings(positive).some(q => /java/.test(q))).toBe(false);
    });

    it('excludes a phrase as a phrase', () => {
      const bool = boolOf('python -"java programming"');
      expect(bool.must_not).toEqual([
        {
          multi_match: {
            query: 'java programming',
            type: 'phrase',
            fields: exactFields(),
            slop: 0
          }
        }
      ]);
    });

    it('supports several exclusions', () => {
      const bool = boolOf('python -java -ruby -"c sharp"');
      expect(bool.must_not).toHaveLength(3);
      expect(queryStrings(bool.must_not)).toEqual(['java', 'ruby', 'c sharp']);
    });

    it('does not change how the remaining results are scored', () => {
      expect(scoring('python -java')).toEqual(scoring('python'));
      expect(scoring('python tutorial -java -"c sharp"')).toEqual(scoring('python tutorial'));
      expect(scoring('"machine learning" -"deep learning"')).toEqual(scoring('"machine learning"'));
      expect(scoring('how does gravity work -newton')).toEqual(scoring('how does gravity work'));
    });

    it('carries no boost, since an exclusion cannot score', () => {
      expect(JSON.stringify(boolOf('python -java -"c sharp" -site:a.com').must_not)).not.toContain(
        'boost'
      );
    });
  });

  describe('OR', () => {
    const alternative = query => ({
      multi_match: { query, type: 'best_fields', fields: searchFields(), tie_breaker: 0.3 }
    });

    it('admits a document matching either side', () => {
      expect(buildMustClause(parseQuery('cats OR dogs'))).toEqual({
        bool: {
          must: [
            {
              bool: {
                should: [alternative('cats'), alternative('dogs')],
                minimum_should_match: 1
              }
            }
          ]
        }
      });
    });

    it('never sends OR as a word', () => {
      for (const query of ['cats OR dogs', 'python OR javascript tutorial']) {
        expect(queryStrings(bodyOf(query)).some(q => /\bOR\b/.test(q))).toBe(false);
      }
    });

    it('matches phrase alternatives as phrases', () => {
      const [group] = buildMustClause(parseQuery('"machine learning" OR "deep learning"')).bool
        .must;
      expect(group.bool.minimum_should_match).toBe(1);
      expect(group.bool.should.map(c => c.multi_match.query)).toEqual([
        'machine learning',
        'deep learning'
      ]);
      for (const clause of group.bool.should) {
        expect(clause.multi_match).toMatchObject({
          type: 'phrase',
          slop: 0,
          fields: exactFields(),
          boost: CLAUSE_BOOSTS.quotedPhrase
        });
      }
    });

    it('still requires the words outside the group', () => {
      const { must } = buildMustClause(parseQuery('python OR javascript tutorial')).bool;
      expect(must).toHaveLength(2);
      expect(must[0].multi_match).toMatchObject({ query: 'tutorial', minimum_should_match: '1' });
      expect(must[1].bool.should.map(c => c.multi_match.query)).toEqual(['python', 'javascript']);
    });

    it('still requires a quoted phrase outside the group', () => {
      const { must } = buildMustClause(parseQuery('"getting started" python OR javascript')).bool;
      expect(must).toHaveLength(2);
      expect(must[0].multi_match).toMatchObject({ query: 'getting started', type: 'phrase' });
    });

    it('does not make either word mandatory', () => {
      const body = bodyOf('cats OR dogs');
      expect(JSON.stringify(body.query)).not.toContain('"operator":"and"');
      expect(body.query.function_score.query.bool.filter).toEqual(buildFilters({}));
    });

    it('counts a group as one word for the literal-title clause', () => {
      const titleWording = query =>
        buildShouldClauses(parseQuery(query)).find(c => c.match && c.match['title.exact']).match[
          'title.exact'
        ];
      // A title holding either word earns it, as it would for a one-word query.
      expect(titleWording('cats OR dogs').minimum_should_match).toBe('1');
      expect(titleWording('python OR javascript tutorial').minimum_should_match).toBe('2<70%');
    });

    it('keeps the quality and freshness multipliers', () => {
      expect(bodyOf('cats OR dogs').query.function_score.functions).toEqual(
        bodyOf('cats').query.function_score.functions
      );
    });
  });

  describe('AND', () => {
    const required = query => ({
      multi_match: { query, type: 'best_fields', fields: searchFields(), operator: 'and' }
    });

    it('requires every word, as a filter', () => {
      const bool = boolOf('python AND machine learning');
      expect(bool.filter).toEqual(
        expect.arrayContaining([required('python'), required('machine'), required('learning')])
      );
    });

    it('never sends AND as a word', () => {
      expect(queryStrings(bodyOf('cats AND dogs')).some(q => /\bAND\b/.test(q))).toBe(false);
    });

    it('scores exactly as the same words without the operator', () => {
      expect(scoring('cats AND dogs')).toEqual(scoring('cats dogs'));
      expect(scoring('python AND machine learning')).toEqual(scoring('python machine learning'));
    });

    it('adds no requirement when there is no explicit operator', () => {
      expect(boolOf('python machine learning').filter).toEqual(buildFilters({}));
    });
  });

  describe('intitle:', () => {
    it('requires the word in the title, at the title weight', () => {
      const bool = boolOf('intitle:python tutorial');
      expect(bool.must).toEqual([
        buildMustClause(parseQuery('tutorial')),
        { match: { title: { query: 'python', operator: 'and', boost: FIELD_BOOSTS.title } } }
      ]);
    });

    it('leaves the scoring of the free words alone', () => {
      expect(boolOf('intitle:python tutorial').should).toEqual(boolOf('tutorial').should);
      expect(bodyOf('intitle:python tutorial').query.function_score.functions).toEqual(
        bodyOf('tutorial').query.function_score.functions
      );
    });

    it('requires a phrase in the unstemmed title, in order', () => {
      const bool = boolOf('intitle:"machine learning" tutorial');
      expect(bool.must[1]).toEqual({
        match_phrase: {
          'title.exact': { query: 'machine learning', slop: 0, boost: FIELD_BOOSTS.title }
        }
      });
    });

    it('works with no free words at all', () => {
      const bool = boolOf('intitle:python');
      expect(bool.must).toEqual([
        { match: { title: { query: 'python', operator: 'and', boost: FIELD_BOOSTS.title } } }
      ]);
      expect(bool.should).toEqual([]);
    });

    it('excludes with -intitle:, without scoring', () => {
      const bool = boolOf('python -intitle:spam -intitle:"buy now"');
      expect(bool.must_not).toEqual([
        { match: { title: { query: 'spam', operator: 'and' } } },
        { match_phrase: { 'title.exact': { query: 'buy now', slop: 0 } } }
      ]);
      expect(scoring('python -intitle:spam -intitle:"buy now"')).toEqual(scoring('python'));
    });
  });

  describe('inurl:', () => {
    it('requires the word in the URL, at the URL weight', () => {
      const bool = boolOf('inurl:docs python');
      expect(bool.must).toEqual([
        buildMustClause(parseQuery('python')),
        {
          multi_match: {
            query: 'docs',
            type: 'best_fields',
            fields: ['url', 'path'],
            operator: 'and',
            boost: FIELD_BOOSTS.url
          }
        }
      ]);
      expect(bool.should).toEqual(boolOf('python').should);
    });

    it('requires a phrase in the URL', () => {
      expect(boolOf('inurl:"getting started"').must).toEqual([
        {
          multi_match: {
            query: 'getting started',
            type: 'phrase',
            fields: ['url', 'path'],
            slop: 0,
            boost: FIELD_BOOSTS.url
          }
        }
      ]);
    });

    it('excludes with -inurl:, without scoring', () => {
      const bool = boolOf('python -inurl:forum');
      expect(bool.must_not).toEqual([
        {
          multi_match: {
            query: 'forum',
            type: 'best_fields',
            fields: ['url', 'path'],
            operator: 'and'
          }
        }
      ]);
      expect(scoring('python -inurl:forum')).toEqual(scoring('python'));
    });
  });

  describe('symbol terms', () => {
    it('sends c++ and c# as typed, and looks for the exact title', () => {
      const clauses = buildShouldClauses(parseQuery('c++'));
      expect(clauses.find(c => c.term && c.term['title.raw']).term['title.raw'].value).toBe('c++');
      expect(queryStrings(bodyOf('c++ c#'))).toContain('c++ c#');
    });
  });

  describe('ranking is untouched', () => {
    it('keeps the field and clause weights', () => {
      expect(FIELD_BOOSTS).toEqual({
        title: 8,
        headings: 5,
        description: 4,
        keywords: 3,
        url: 2,
        content: 1
      });
      expect(CLAUSE_BOOSTS).toEqual({
        exactTitle: 60,
        titleExactTerms: 18,
        phraseTitle: 14,
        phraseHeadings: 8,
        phraseDescription: 6,
        phraseContent: 5,
        quotedPhrase: 25,
        domainExact: 90,
        rootDomain: 45,
        urlPath: 6,
        fuzzy: 0.4,
        questionTitle: 4
      });
    });

    it('applies the same quality and freshness multipliers to every operator query', () => {
      const expected = buildScoreFunctions({ boostFreshness: true });
      for (const query of [
        'site:wikipedia.org physics',
        'python -java',
        'cats OR dogs',
        'cats AND dogs',
        'intitle:python',
        'inurl:docs python',
        'site:wikipedia.org'
      ]) {
        const fn = bodyOf(query).query.function_score;
        expect(fn.functions).toEqual(expected);
        expect(fn.score_mode).toBe('multiply');
        expect(fn.boost_mode).toBe('multiply');
      }
    });

    it('keeps `should` from gating results', () => {
      expect(boolOf('site:wikipedia.org python -java').minimum_should_match).toBe(0);
    });
  });

  describe('combinations', () => {
    it('site + phrase + negative phrase + OR + intitle + inurl', () => {
      const bool = boolOf(
        'site:example.com -site:blog.example.com intitle:guide inurl:docs ' +
          '"getting started" python OR javascript -java -"old version"'
      );
      // Recall (the phrase and the OR group), then the two field restrictions.
      expect(bool.must).toHaveLength(3);
      expect(bool.must[0].bool.must).toHaveLength(2);
      expect(bool.filter).toEqual(expect.arrayContaining([domainFilter('example.com')]));
      expect(queryStrings(bool.must_not)).toEqual(['java', 'old version']);
      expect(bool.must_not).toEqual(expect.arrayContaining([domainFilter('blog.example.com')]));
      expect(bool.must_not).toHaveLength(3);
    });

    it('keeps the page restriction of the second search pass a pure filter', () => {
      const bool = boolOf('site:example.com python -java', { ids: ['a', 'b'] });
      expect(bool.filter).toEqual(expect.arrayContaining([{ ids: { values: ['a', 'b'] } }]));
      expect(scoring('site:example.com python -java', { ids: ['a', 'b'] })).toEqual(
        scoring('python')
      );
    });

    it('keeps the other filters and the date sort', () => {
      const body = bodyOf('site:example.com python -java', { language: 'en', sort: 'newest' });
      expect(body.query.function_score.query.bool.filter).toEqual(
        expect.arrayContaining([{ term: { language: 'en' } }, domainFilter('example.com')])
      );
      expect(body.sort[0].publishedAt.order).toBe('desc');
      expect(body.sort[body.sort.length - 1]).toEqual({ urlHash: { order: 'asc' } });
    });
  });
});

/**
 * Regressions found by the semantic review of the operators.
 */
describe('operator regressions', () => {
  const bodyOf = (query, options = {}) => buildSearchBody(parseQuery(query), options);
  const boolOf = query => bodyOf(query).query.function_score.query.bool;

  /** A parse without the fields that only echo what was typed. */
  const meaningOf = query => {
    const {
      raw: _raw,
      cleaned: _cleaned,
      ignoredOperators: _operators,
      ignoredWords: _words,
      ...rest
    } = parseQuery(query);
    return rest;
  };

  describe('a negated operator with no usable value is ignored', () => {
    const INCOMPLETE = [
      'python -site:',
      'python -site:localhost',
      'python -site:"not a domain"',
      'python -intitle:',
      'python -intitle:" "',
      'python -intitle:!!!',
      'python -inurl:',
      'python -inurl:" "'
    ];

    it.each(INCOMPLETE)('"%s" excludes nothing', query => {
      const parsed = parseQuery(query);
      expect(parsed.excludedTerms).toEqual([]);
      expect(parsed.excludedPhrases).toEqual([]);
      expect(parsed.excludedSites).toEqual([]);
      expect(parsed.excludedTitleTerms).toEqual([]);
      expect(parsed.excludedUrlTerms).toEqual([]);
      expect(parsed.terms).toEqual(['python']);
      expect(parsed.hasOperators).toBe(false);
    });

    it.each(INCOMPLETE)('"%s" means exactly what "python" means', query => {
      expect(meaningOf(query)).toEqual(meaningOf('python'));
      expect(bodyOf(query)).toEqual(bodyOf('python'));
      expect(boolOf(query).must_not).toBeUndefined();
    });

    it('never excludes the operator name as a word', () => {
      for (const query of INCOMPLETE) {
        const json = JSON.stringify(bodyOf(query));
        expect(json).not.toMatch(/"query":"(site|intitle|inurl|localhost)"/);
      }
    });

    it('records what was ignored', () => {
      expect(parseQuery('python -site:').ignoredOperators).toEqual(['-site:']);
      expect(parseQuery('python -site:localhost').ignoredOperators).toEqual(['-site:localhost']);
      expect(parseQuery('python -intitle: -inurl:').ignoredOperators).toEqual([
        '-intitle:',
        '-inurl:'
      ]);
      expect(parseQuery('python').ignoredOperators).toEqual([]);
      expect(parseQuery('python -site:example.com').ignoredOperators).toEqual([]);
    });

    it('leaves nothing to search for when it is the whole query', () => {
      for (const query of ['-site:', '-intitle:', '-inurl:', '-site:localhost']) {
        const parsed = parseQuery(query);
        expect(parsed.isEmpty).toBe(true);
        expect(parsed.excludedTerms).toEqual([]);
      }
    });

    it('does not disturb the ranking of a phrase beside it', () => {
      expect(bodyOf('"quantum physics" -site:')).toEqual(bodyOf('"quantum physics"'));
    });

    it('still applies a complete negated operator', () => {
      expect(parseQuery('python -site:example.com').excludedSites).toEqual(['example.com']);
      expect(parseQuery('python -intitle:spam').excludedTitleTerms).toEqual(['spam']);
      expect(parseQuery('python -inurl:forum').excludedUrlTerms).toEqual(['forum']);
      expect(parseQuery('python -java').excludedTerms).toEqual(['java']);
    });

    it('still reads a positive operator with no value as the words typed', () => {
      expect(parseQuery('site: wikipedia.org').terms).toEqual(['site', 'wikipedia.org']);
      expect(parseQuery('site:foo bar').terms).toEqual(['site', 'foo', 'bar']);
      expect(parseQuery('intitle: python').terms).toEqual(['intitle', 'python']);
      expect(parseQuery('inurl: python').terms).toEqual(['inurl', 'python']);
    });
  });

  describe('a question with AND keeps its topic', () => {
    it('strips the opener and requires the topic words', () => {
      const parsed = parseQuery('what is python AND programming');
      expect(parsed.isQuestion).toBe(true);
      expect(parsed.questionStripped).toBe(true);
      expect(parsed.coreTerms).toEqual(['python', 'programming']);
      expect(parsed.coreText).toBe('python programming');
      expect(parsed.requireAll).toBe(true);
      expect(parsed.requiredTerms).toEqual(['python', 'programming']);
    });

    it('requires every topic word of a longer question', () => {
      const parsed = parseQuery('what is python AND programming language');
      expect(parsed.coreTerms).toEqual(['python', 'programming', 'language']);
      expect(parsed.requiredTerms).toEqual(['python', 'programming', 'language']);
    });

    it('handles "how does … work"', () => {
      const parsed = parseQuery('how does gravity AND magnetism work');
      expect(parsed.requiredTerms).toEqual(['gravity', 'magnetism']);
    });

    it('never requires the opener', () => {
      const { filter } = boolOf('what is python AND programming');
      const required = filter.filter(f => f.multi_match).map(f => f.multi_match.query);
      expect(required).toEqual(['python', 'programming']);
    });

    it('recalls and scores as the same question without AND', () => {
      const scoring = query => {
        const body = bodyOf(query);
        const { must, should } = body.query.function_score.query.bool;
        return { must, should, functions: body.query.function_score.functions };
      };
      expect(scoring('what is python AND programming')).toEqual(
        scoring('what is python programming')
      );
    });

    it('still takes a question with OR as written', () => {
      const parsed = parseQuery('what is python OR ruby');
      expect(parsed.questionStripped).toBe(false);
      expect(parsed.coreTerms).toEqual(parsed.terms);
    });

    it('leaves ordinary questions and non-questions as they were', () => {
      expect(parseQuery('what is python programming').coreTerms).toEqual(['python', 'programming']);
      expect(parseQuery('how does gravity work').coreTerms).toEqual(['gravity']);
      for (const query of ['will smith movies', 'can opener reviews', 'python programming']) {
        const parsed = parseQuery(query);
        expect(parsed.questionStripped).toBe(false);
        expect(parsed.coreTerms).toEqual(parsed.terms);
      }
      // AND on a non-question strips nothing; "will" is a stop word, so it
      // is searched but not required.
      expect(parseQuery('will smith AND movies').coreTerms).toEqual(['will', 'smith', 'movies']);
      expect(parseQuery('will smith AND movies').requiredTerms).toEqual(['smith', 'movies']);
      expect(parseQuery('python AND machine learning').coreTerms).toEqual([
        'python',
        'machine',
        'learning'
      ]);
    });
  });

  describe('a word repeated outside its OR group stays required', () => {
    const alternative = query => ({
      multi_match: { query, type: 'best_fields', fields: searchFields(), tie_breaker: 0.3 }
    });
    const plain = (query, count) => ({
      multi_match: {
        query,
        type: 'best_fields',
        fields: searchFields(),
        minimum_should_match: count === 1 ? '1' : '2<70%',
        tie_breaker: 0.3
      }
    });

    it.each([
      ['cats OR dogs cats', ['cats']],
      ['cats OR dogs dogs', ['dogs']],
      ['cats cats OR dogs', ['cats']],
      ['"machine learning" OR python machine', ['machine']],
      ['cats OR dogs birds', ['birds']],
      ['cats OR dogs', []],
      ['cats OR dogs cats dogs', ['cats', 'dogs']]
    ])('"%s" keeps %j outside the group', (query, expected) => {
      expect(parseQuery(query).plainTerms).toEqual(expected);
    });

    it('keeps the group itself as typed', () => {
      expect(parseQuery('cats OR dogs cats').orGroups).toEqual([[term('cats'), term('dogs')]]);
      expect(parseQuery('"machine learning" OR python machine').orGroups).toEqual([
        [phrase('machine learning'), term('python')]
      ]);
    });

    it('builds (cats OR dogs) AND cats', () => {
      expect(buildMustClause(parseQuery('cats OR dogs cats'))).toEqual({
        bool: {
          must: [
            plain('cats', 1),
            {
              bool: {
                should: [alternative('cats'), alternative('dogs')],
                minimum_should_match: 1
              }
            }
          ]
        }
      });
    });

    it('builds ("machine learning" OR python) AND machine', () => {
      const { must } = buildMustClause(parseQuery('"machine learning" OR python machine')).bool;
      expect(must).toHaveLength(2);
      expect(must[0]).toEqual(plain('machine', 1));
      expect(must[1].bool.should.map(c => c.multi_match.query)).toEqual([
        'machine learning',
        'python'
      ]);
    });

    it('requires the repeated word under AND as well', () => {
      expect(parseQuery('cats OR dogs AND cats').requiredTerms).toEqual(['cats']);
    });

    it('does not repeat an alternative within a group', () => {
      expect(parseQuery('cats OR cats OR dogs').orGroups).toEqual([[term('cats'), term('dogs')]]);
    });

    it('treats a word OR itself as that word', () => {
      const parsed = parseQuery('python OR python tutorial');
      expect(parsed.orGroups).toEqual([]);
      expect(parsed.hasOperators).toBe(false);
      expect(meaningOf('python OR python tutorial')).toEqual(meaningOf('python python tutorial'));
      expect(bodyOf('python OR python tutorial')).toEqual(bodyOf('python python tutorial'));
    });

    it('equals the core terms when there is no OR', () => {
      for (const query of ['python tutorial', 'how does gravity work', 'cats AND dogs']) {
        const parsed = parseQuery(query);
        expect(parsed.plainTerms).toEqual(parsed.coreTerms);
      }
    });

    it('leaves OR itself unchanged', () => {
      expect(buildMustClause(parseQuery('cats OR dogs'))).toEqual({
        bool: {
          must: [
            {
              bool: {
                should: [alternative('cats'), alternative('dogs')],
                minimum_should_match: 1
              }
            }
          ]
        }
      });
    });
  });

  describe('a stop word after intitle: is not required', () => {
    it('drops the stop word and searches the rest', () => {
      const parsed = parseQuery('intitle:the matrix');
      expect(parsed.titleTerms).toEqual([]);
      expect(parsed.terms).toEqual(['matrix']);
      expect(parsed.isEmpty).toBe(false);
      expect(parsed.ignoredOperators).toEqual(['intitle:the']);
    });

    it('builds no title clause for it', () => {
      expect(bodyOf('intitle:the matrix')).toEqual(bodyOf('matrix'));
      expect(JSON.stringify(bodyOf('intitle:the matrix'))).not.toContain('"query":"the"');
    });

    it('has nothing to search for when it is the whole query', () => {
      for (const query of ['intitle:the', 'intitle:The', 'intitle:of']) {
        const parsed = parseQuery(query);
        expect(parsed.isEmpty).toBe(true);
        expect(parsed.titleTerms).toEqual([]);
        // Not searched as the word "intitle" either.
        expect(parsed.terms).toEqual([]);
      }
    });

    it('keeps the words that are not stop words', () => {
      expect(parseQuery('intitle:python').titleTerms).toEqual(['python']);
      expect(parseQuery('intitle:the,matrix').titleTerms).toEqual(['matrix']);
      expect(parseQuery('intitle:matrix intitle:the').titleTerms).toEqual(['matrix']);
    });

    it('leaves a title phrase exactly as typed', () => {
      const parsed = parseQuery('intitle:"the matrix"');
      expect(parsed.titlePhrases).toEqual(['the matrix']);
      expect(boolOf('intitle:"the matrix"').must).toEqual([
        {
          match_phrase: {
            'title.exact': { query: 'the matrix', slop: 0, boost: FIELD_BOOSTS.title }
          }
        }
      ]);
    });

    it('ignores an excluded stop word in the title too', () => {
      const parsed = parseQuery('python -intitle:the');
      expect(parsed.excludedTitleTerms).toEqual([]);
      expect(bodyOf('python -intitle:the')).toEqual(bodyOf('python'));
    });

    it('does not touch inurl:, whose field keeps stop words', () => {
      expect(parseQuery('inurl:the matrix').urlTerms).toEqual(['the']);
    });
  });

  describe('a stop word outside an OR group is not required', () => {
    const DANGLING = ['cats OR dogs OR', 'OR cats OR dogs', 'cats OR dogs AND', 'cats OR dogs the'];

    it.each(DANGLING)('"%s" means exactly what "cats OR dogs" means', query => {
      expect(meaningOf(query)).toEqual(meaningOf('cats OR dogs'));
      expect(bodyOf(query)).toEqual(bodyOf('cats OR dogs'));
    });

    it.each(DANGLING)('"%s" keeps the group and requires nothing else', query => {
      const parsed = parseQuery(query);
      expect(parsed.orGroups).toEqual([[term('cats'), term('dogs')]]);
      expect(parsed.plainTerms).toEqual([]);
      expect(parsed.requireAll).toBe(false);

      const { must } = buildMustClause(parsed).bool;
      expect(must).toHaveLength(1);
      expect(must[0].bool.minimum_should_match).toBe(1);
      expect(must[0].bool.should.map(c => c.multi_match.query)).toEqual(['cats', 'dogs']);
    });

    it.each(DANGLING)('"%s" sends no clause for OR, AND or the', query => {
      const queries = [];
      JSON.stringify(bodyOf(query), (key, value) => {
        if (key === 'query' && typeof value === 'string') queries.push(value);
        return value;
      });
      expect(queries.length).toBeGreaterThan(0);
      for (const text of queries) expect(text).not.toMatch(/\b(OR|AND|the)\b/);
    });

    it('records what was dropped, as typed', () => {
      expect(parseQuery('cats OR dogs OR').ignoredWords).toEqual(['OR']);
      expect(parseQuery('cats OR dogs AND').ignoredWords).toEqual(['AND']);
      expect(parseQuery('cats OR dogs the').ignoredWords).toEqual(['the']);
      expect(parseQuery('"machine learning" of the').ignoredWords).toEqual(['of', 'the']);
      expect(parseQuery('cats OR dogs').ignoredWords).toEqual([]);
      expect(parseQuery('the cat sat').ignoredWords).toEqual([]);
    });

    it('still requires the other words outside the group', () => {
      const parsed = parseQuery('python OR ruby for beginners');
      expect(parsed.plainTerms).toEqual(['beginners']);
      expect(parsed.terms).toEqual(['python', 'ruby', 'beginners']);
      const { must } = buildMustClause(parsed).bool;
      expect(must).toHaveLength(2);
      expect(must[0].multi_match).toMatchObject({ query: 'beginners', minimum_should_match: '1' });
    });

    it('still requires a word repeated outside the group', () => {
      expect(parseQuery('cats OR dogs cats').plainTerms).toEqual(['cats']);
      expect(parseQuery('cats OR dogs dogs').plainTerms).toEqual(['dogs']);
      expect(parseQuery('cats OR dogs cats the').plainTerms).toEqual(['cats']);
      const { must } = buildMustClause(parseQuery('cats OR dogs dogs')).bool;
      expect(must).toHaveLength(2);
      expect(must[0].multi_match.query).toBe('dogs');
    });

    it('keeps a stop word that is itself an alternative', () => {
      expect(parseQuery('cats OR the').orGroups).toEqual([[term('cats'), term('the')]]);
    });

    it('combines with AND and the other operators', () => {
      const parsed = parseQuery('site:example.com cats OR dogs AND the food -fish OR');
      expect(parsed.orGroups).toEqual([[term('cats'), term('dogs')]]);
      expect(parsed.plainTerms).toEqual(['food']);
      expect(parsed.requiredTerms).toEqual(['food']);
      expect(parsed.excludedTerms).toEqual(['fish']);
    });

    it('changes nothing when there is no OR group', () => {
      expect(parseQuery('cats the').terms).toEqual(['cats', 'the']);
      expect(parseQuery('cats the').plainTerms).toEqual(['cats', 'the']);
      expect(parseQuery('OR gate').terms).toEqual(['OR', 'gate']);
      expect(parseQuery('AND gate').terms).toEqual(['AND', 'gate']);
      expect(parseQuery('cats OR').terms).toEqual(['cats', 'OR']);
      expect(parseQuery('OR').terms).toEqual(['OR']);
      expect(parseQuery('the cat sat').terms).toEqual(['the', 'cat', 'sat']);
    });
  });

  describe('stop words beside a quoted phrase are not required', () => {
    it.each(['"machine learning" the', 'the "machine learning"', '"machine learning" of the'])(
      '%s means exactly what the phrase alone means',
      query => {
        expect(meaningOf(query)).toEqual(meaningOf('"machine learning"'));
        expect(bodyOf(query)).toEqual(bodyOf('"machine learning"'));
      }
    );

    it('builds no loose-term clause for the stop word', () => {
      const { must } = buildMustClause(parseQuery('"machine learning" the')).bool;
      expect(must).toHaveLength(1);
      expect(must[0].multi_match).toMatchObject({
        query: 'machine learning',
        type: 'phrase',
        slop: 0,
        boost: CLAUSE_BOOSTS.quotedPhrase
      });
    });

    it('leaves a phrase with real words beside it exactly as it was', () => {
      const parsed = parseQuery('"machine learning" for beginners');
      expect(parsed.terms).toEqual(['for', 'beginners']);
      expect(parsed.text).toBe('for beginners');
      const { must } = buildMustClause(parsed).bool;
      expect(must).toHaveLength(2);
      expect(must[1].multi_match).toEqual({
        query: 'for beginners',
        type: 'best_fields',
        fields: searchFields(),
        minimum_should_match: '2<70%'
      });
    });

    it('leaves a question around a phrase as it was', () => {
      const parsed = parseQuery('what is "machine learning"?');
      expect(parsed.terms).toEqual(['what', 'is']);
      expect(parsed.coreTerms).toEqual([]);
      expect(parsed.coreText).toBe('machine learning');
    });

    it('leaves a query of stop words alone, with no phrase, as it was', () => {
      expect(parseQuery('the of').terms).toEqual(['the', 'of']);
      expect(parseQuery('to be or not to be').terms).toEqual(['to', 'be', 'or', 'not']);
    });
  });

  describe('stop words beside intitle:, inurl: or site: are not required', () => {
    const FIXED = [
      ['intitle:python the', 'intitle:python'],
      ['the intitle:python', 'intitle:python'],
      ['intitle:"machine learning" of the', 'intitle:"machine learning"'],
      ['inurl:docs the', 'inurl:docs'],
      ['inurl:"getting started" the', 'inurl:"getting started"'],
      ['site:wikipedia.org the', 'site:wikipedia.org'],
      ['the site:wikipedia.org', 'site:wikipedia.org'],
      ['site:wikipedia.org -java the', 'site:wikipedia.org -java'],
      ['intitle:python OR', 'intitle:python']
    ];

    it.each(FIXED)('"%s" means exactly what "%s" means', (query, equivalent) => {
      expect(meaningOf(query)).toEqual(meaningOf(equivalent));
      expect(bodyOf(query)).toEqual(bodyOf(equivalent));
    });

    it.each(FIXED)('"%s" has no free words left to require', query => {
      const parsed = parseQuery(query);
      expect(parsed.terms).toEqual([]);
      expect(parsed.plainTerms).toEqual([]);
      expect(parsed.text).toBe('');
      expect(parsed.isEmpty).toBe(false);
      expect(parsed.ignoredWords.length).toBeGreaterThan(0);
    });

    it('records the dropped words, as typed', () => {
      expect(parseQuery('intitle:python the').ignoredWords).toEqual(['the']);
      expect(parseQuery('inurl:docs The').ignoredWords).toEqual(['The']);
      expect(parseQuery('site:wikipedia.org of the').ignoredWords).toEqual(['of', 'the']);
    });

    it('sends no required clause for the stop word, and keeps the operator clause', () => {
      const multiMatchQueries = clauses =>
        clauses.filter(c => c.multi_match).map(c => c.multi_match.query);

      const title = boolOf('intitle:python the');
      expect(title.must).toEqual([
        { match: { title: { query: 'python', operator: 'and', boost: FIELD_BOOSTS.title } } }
      ]);

      const url = boolOf('inurl:docs the');
      expect(url.must).toEqual([
        {
          multi_match: {
            query: 'docs',
            type: 'best_fields',
            fields: ['url', 'path'],
            operator: 'and',
            boost: FIELD_BOOSTS.url
          }
        }
      ]);

      const site = boolOf('site:wikipedia.org the');
      expect(site.must).toEqual([{ match_all: {} }]);
      expect(site.filter).toEqual(
        expect.arrayContaining([buildFilters({ domain: 'wikipedia.org' })[0]])
      );

      for (const bool of [title, url, site]) {
        expect(multiMatchQueries(bool.must)).not.toContain('the');
        expect(multiMatchQueries(bool.filter)).not.toContain('the');
        expect(bool.must_not).toBeUndefined();
      }
    });

    it.each([
      ['intitle:python the guide', 'intitle:python', ['the', 'guide']],
      ['inurl:docs the guide', 'inurl:docs', ['the', 'guide']],
      ['site:wikipedia.org the history', 'site:wikipedia.org', ['the', 'history']]
    ])('"%s" keeps its real word', (query, operatorOnly, terms) => {
      const parsed = parseQuery(query);
      expect(parsed.terms).toEqual(terms);
      expect(parsed.text).toBe(terms.join(' '));
      expect(parsed.ignoredWords).toEqual([]);
      // The free words travel together in the ordinary recall clause.
      expect(boolOf(query).must[0]).toEqual(buildMustClause(parseQuery(terms.join(' '))));
      expect(bodyOf(query)).not.toEqual(bodyOf(operatorOnly));
    });

    it('leaves a query of stop words alone, with nothing else to match, as it was', () => {
      for (const query of [
        'the',
        'the of',
        'the -java',
        'the -site:example.com',
        'the -intitle:x'
      ]) {
        const parsed = parseQuery(query);
        expect(parsed.terms[0]).toBe('the');
        expect(parsed.ignoredWords).toEqual([]);
      }
      // Still one ordinary clause of stop words, which matches no page.
      expect(bodyOf('the')).toEqual(buildSearchBody(parseQuery('the'), {}));
      expect(boolOf('the -java').must).toEqual([buildMustClause(parseQuery('the'))]);
      expect(boolOf('the').must[0].multi_match.query).toBe('the');
    });

    it('does not treat an exclusion as something to match on', () => {
      expect(parseQuery('-site:wikipedia.org the').terms).toEqual(['the']);
      expect(parseQuery('-intitle:python the').terms).toEqual(['the']);
    });

    it('leaves the OR cases as they were', () => {
      expect(parseQuery('cats OR the').orGroups).toEqual([[term('cats'), term('the')]]);
      expect(parseQuery('cats OR the').ignoredWords).toEqual([]);
      expect(bodyOf('cats OR dogs the')).toEqual(bodyOf('cats OR dogs'));
      expect(parseQuery('python OR ruby for beginners').plainTerms).toEqual(['beginners']);
      expect(parseQuery('cats OR dogs cats').plainTerms).toEqual(['cats']);
    });

    it('leaves the phrase cases as they were', () => {
      expect(bodyOf('"machine learning" the')).toEqual(bodyOf('"machine learning"'));
      expect(bodyOf('the "machine learning"')).toEqual(bodyOf('"machine learning"'));
      const parsed = parseQuery('"machine learning" for beginners');
      expect(parsed.terms).toEqual(['for', 'beginners']);
      expect(parsed.ignoredWords).toEqual([]);
    });

    it('leaves the operators themselves as they were', () => {
      expect(boolOf('-site:wikipedia.org python').must_not).toEqual([
        buildFilters({ domain: 'wikipedia.org' })[0]
      ]);
      expect(bodyOf('python -site:')).toEqual(bodyOf('python'));
      expect(bodyOf('intitle:the matrix')).toEqual(bodyOf('matrix'));
      expect(parseQuery('intitle:the matrix').ignoredOperators).toEqual(['intitle:the']);
      expect(parseQuery('intitle:the matrix').ignoredWords).toEqual([]);
    });

    it('leaves ordinary queries with stop words as they were', () => {
      for (const query of ['the cat sat', 'python the', 'how to cook rice', 'python -java the']) {
        expect(parseQuery(query).ignoredWords).toEqual([]);
      }
      expect(parseQuery('python -java the').terms).toEqual(['python', 'the']);
    });
  });

  describe('decisions that stay as they are', () => {
    it('AND stays exact: the required words are not fuzzied', () => {
      const { filter } = boolOf('pyhton AND programing');
      const required = filter.filter(f => f.multi_match);
      expect(required.map(f => f.multi_match.query)).toEqual(['pyhton', 'programing']);
      expect(JSON.stringify(required)).not.toContain('fuzziness');
    });

    it('AND requires every searchable word, not only its neighbours', () => {
      expect(parseQuery('cats AND dogs birds fish').requiredTerms).toEqual([
        'cats',
        'dogs',
        'birds',
        'fish'
      ]);
    });
  });
});

/**
 * Phase 7B — words made only of symbols, and the lang: operator.
 */
describe('symbol-only words', () => {
  const bodyOf = (query, options = {}) => buildSearchBody(parseQuery(query), options);
  const boolOf = query => bodyOf(query).query.function_score.query.bool;
  const meaningOf = query => {
    const {
      raw: _raw,
      cleaned: _cleaned,
      ignoredOperators: _operators,
      ignoredWords: _words,
      ...rest
    } = parseQuery(query);
    return rest;
  };
  const queryStrings = value => {
    const found = [];
    JSON.stringify(value, (key, child) => {
      if (key === 'query' && typeof child === 'string') found.push(child);
      return child;
    });
    return found;
  };

  describe('beside something else the query matches on', () => {
    const FIXED = [
      ['site:wikipedia.org *', 'site:wikipedia.org'],
      ['site:wikipedia.org &', 'site:wikipedia.org'],
      ['site:wikipedia.org +', 'site:wikipedia.org'],
      ['site:wikipedia.org !!!', 'site:wikipedia.org'],
      ['site:wikipedia.org * the', 'site:wikipedia.org'],
      ['* site:wikipedia.org', 'site:wikipedia.org'],
      ['intitle:python *', 'intitle:python'],
      ['inurl:docs *', 'inurl:docs'],
      ['lang:en &', 'lang:en'],
      ['"machine learning" &', '"machine learning"'],
      ['"tom" & "jerry"', '"tom" "jerry"'],
      ['cats OR dogs &', 'cats OR dogs'],
      ['cats OR dogs *', 'cats OR dogs'],
      ['cats OR dogs + the', 'cats OR dogs']
    ];

    it.each(FIXED)('"%s" means exactly what "%s" means', (query, equivalent) => {
      expect(meaningOf(query)).toEqual(meaningOf(equivalent));
      expect(bodyOf(query)).toEqual(bodyOf(equivalent));
    });

    it.each(FIXED)('"%s" sends no clause for the symbol', query => {
      for (const text of queryStrings(bodyOf(query))) expect(text).not.toMatch(/[*&+!]/);
    });

    it('records what was dropped, as typed', () => {
      expect(parseQuery('site:wikipedia.org *').ignoredWords).toEqual(['*']);
      expect(parseQuery('site:wikipedia.org +').ignoredWords).toEqual(['+']);
      expect(parseQuery('cats OR dogs &').ignoredWords).toEqual(['&']);
      expect(parseQuery('site:wikipedia.org * the').ignoredWords).toEqual(['*', 'the']);
    });

    it('keeps a real word, and the symbol typed beside it', () => {
      const parsed = parseQuery('intitle:python & guide');
      expect(parsed.terms).toEqual(['&', 'guide']);
      expect(parsed.text).toBe('& guide');
      expect(parsed.ignoredWords).toEqual([]);
      expect(boolOf('intitle:python & guide').must[0]).toEqual(
        buildMustClause(parseQuery('& guide'))
      );
    });
  });

  describe('inside an OR group', () => {
    it('drops an alternative that can never match', () => {
      expect(meaningOf('cats OR &')).toEqual(meaningOf('cats'));
      expect(bodyOf('cats OR &')).toEqual(bodyOf('cats'));
      expect(parseQuery('cats OR &').ignoredWords).toEqual(['&']);
    });

    it('keeps the rest of the group', () => {
      expect(meaningOf('cats OR dogs OR *')).toEqual(meaningOf('cats OR dogs'));
      expect(meaningOf('* OR cats OR dogs')).toEqual(meaningOf('cats OR dogs'));
      expect(parseQuery('cats OR * OR dogs').orGroups).toEqual([[term('cats'), term('dogs')]]);
    });

    it('keeps an alternative the analyzer can match', () => {
      expect(parseQuery('c++ OR c#').orGroups).toEqual([[term('c++'), term('c#')]]);
      expect(parseQuery('cats OR node.js').orGroups).toEqual([[term('cats'), term('node.js')]]);
      // A stop word is still the user's own alternative.
      expect(parseQuery('cats OR the').orGroups).toEqual([[term('cats'), term('the')]]);
    });

    it('has nothing to search for when every alternative is a symbol', () => {
      const parsed = parseQuery('* OR &');
      expect(parsed.isEmpty).toBe(true);
      expect(parsed.orGroups).toEqual([]);
    });
  });

  describe('with nothing else to match on', () => {
    it.each(['*', '&', 'the *', 'the -java *', '* &'])('"%s" is left as typed', query => {
      const parsed = parseQuery(query);
      expect(parsed.ignoredWords).toEqual([]);
      expect(parsed.hasOperators).toBe(query.includes('-java'));
      expect(parsed.text).toBe(query.replace(' -java', ''));
      // Still one ordinary clause, which matches no page.
      expect(boolOf(query).must).toEqual([buildMustClause(parsed)]);
    });

    it('"+" alone is still an empty query', () => {
      expect(parseQuery('+').isEmpty).toBe(true);
      expect(parseQuery('+ - _').isEmpty).toBe(true);
    });

    it('a real word keeps the symbol in its own clause, where it is harmless', () => {
      const parsed = parseQuery('python *');
      expect(parsed.terms).toEqual(['python', '*']);
      expect(parsed.ignoredWords).toEqual([]);
      expect(parsed.hasOperators).toBe(false);
      const [exact] = boolOf('python *').must[0].bool.should;
      expect(exact.multi_match.query).toBe('python *');
      expect(parseQuery('tom & jerry').terms).toEqual(['tom', '&', 'jerry']);
    });
  });

  describe('negated', () => {
    it('never becomes a positive word', () => {
      const parsed = parseQuery('python -*');
      expect(parsed.terms).toEqual(['python']);
      expect(parsed.excludedTerms).toEqual(['*']);
      expect(queryStrings(boolOf('python -*').must)).not.toContain('*');
      expect(parseQuery('python -&').terms).toEqual(['python']);
    });

    it('is not something to match on', () => {
      expect(parseQuery('-*').isEmpty).toBe(true);
      expect(parseQuery('-& the').terms).toEqual(['the']);
      expect(parseQuery('-& the').ignoredWords).toEqual([]);
    });
  });

  describe('where a single word is required', () => {
    it('is not required by AND', () => {
      expect(parseQuery('cats AND *').requiredTerms).toEqual(['cats']);
      expect(parseQuery('cats AND & dogs').requiredTerms).toEqual(['cats', 'dogs']);
    });

    it('is not a usable intitle: or inurl: value', () => {
      for (const query of ['intitle:* python', 'inurl:& python', '-intitle:* python']) {
        expect(bodyOf(query)).toEqual(bodyOf('python'));
        expect(parseQuery(query).ignoredOperators).toHaveLength(1);
      }
      expect(parseQuery('intitle:*').isEmpty).toBe(true);
      // The URL field does hold stop words.
      expect(parseQuery('inurl:the python').urlTerms).toEqual(['the']);
    });
  });

  describe('words that only contain symbols', () => {
    it.each([
      ['c++', ['c++']],
      ['c#', ['c#']],
      ['c++ c#', ['c++', 'c#']],
      ['node.js', ['node.js']],
      ['.net', ['.net']],
      ['wi-fi', ['wi-fi']],
      ['a+', ['a+']]
    ])('leaves %s as it was', (query, terms) => {
      const parsed = parseQuery(query);
      expect(parsed.terms).toEqual(terms);
      expect(parsed.ignoredWords).toEqual([]);
    });

    it('keeps them beside an operator and in a group', () => {
      expect(parseQuery('site:wikipedia.org c++').terms).toEqual(['c++']);
      expect(parseQuery('site:wikipedia.org c++').ignoredWords).toEqual([]);
      expect(parseQuery('cats OR dogs c#').plainTerms).toEqual(['c#']);
      expect(parseQuery('intitle:c++').titleTerms).toEqual(['c++']);
    });

    it('keeps words in other scripts, digits and emoji', () => {
      for (const word of ['日本', 'naïve', '2024', '😀']) {
        expect(parseQuery(`site:wikipedia.org ${word}`).terms).toEqual([word]);
      }
    });
  });

  it('never throws, whatever symbols are typed', () => {
    for (const query of [
      '* & + # @',
      '-* -&',
      '* OR',
      'OR *',
      '"*" &',
      'site:a.com -* OR &',
      '½'
    ]) {
      expect(() => bodyOf(query)).not.toThrow();
    }
  });
});

describe('lang: operator', () => {
  const bodyOf = (query, options = {}) => buildSearchBody(parseQuery(query), options);
  const boolOf = (query, options) => bodyOf(query, options).query.function_score.query.bool;
  const languageFilter = language => buildFilters({ language })[0];
  const scoring = (query, options) => {
    const body = bodyOf(query, options);
    const { must, should, minimum_should_match: msm } = body.query.function_score.query.bool;
    return { must, should, msm, functions: body.query.function_score.functions, sort: body.sort };
  };

  describe('parsing', () => {
    it('extracts the language and searches the remaining words', () => {
      const parsed = parseQuery('lang:en python');
      expect(parsed.languages).toEqual(['en']);
      expect(parsed.terms).toEqual(['python']);
      expect(parsed.text).toBe('python');
      expect(parsed.hasOperators).toBe(true);
    });

    it('can appear anywhere, in any case', () => {
      expect(parseQuery('python lang:en tutorial')).toMatchObject({
        languages: ['en'],
        terms: ['python', 'tutorial']
      });
      expect(parseQuery('Lang:EN python').languages).toEqual(['en']);
      expect(parseQuery('lang:"en" python').languages).toEqual(['en']);
    });

    it('accepts what the language parameter accepts', () => {
      expect(parseQuery('lang:en-GB x').languages).toEqual(['en']);
      expect(parseQuery('lang:pt_BR x').languages).toEqual(['pt']);
      expect(parseQuery('lang:fil x').languages).toEqual(['fil']);
    });

    it('excludes with the ordinary minus', () => {
      const parsed = parseQuery('python -lang:en');
      expect(parsed.excludedLanguages).toEqual(['en']);
      expect(parsed.languages).toEqual([]);
      expect(parsed.terms).toEqual(['python']);
    });

    it('collects several languages, once each', () => {
      expect(parseQuery('lang:en lang:fr lang:EN python').languages).toEqual(['en', 'fr']);
      expect(parseQuery('python -lang:en -lang:fr').excludedLanguages).toEqual(['en', 'fr']);
    });

    it('combines with the other operators', () => {
      expect(parseQuery('lang:en -java')).toMatchObject({
        languages: ['en'],
        excludedTerms: ['java'],
        terms: []
      });
      expect(parseQuery('lang:en site:wikipedia.org')).toMatchObject({
        languages: ['en'],
        sites: ['wikipedia.org']
      });
      expect(parseQuery('lang:en intitle:python cats OR dogs')).toMatchObject({
        languages: ['en'],
        titleTerms: ['python'],
        orGroups: [[term('cats'), term('dogs')]]
      });
    });

    it('is not grouped by OR', () => {
      const parsed = parseQuery('lang:en OR python');
      expect(parsed.languages).toEqual(['en']);
      expect(parsed.orGroups).toEqual([]);
      expect(parsed.terms).toEqual(['python']);
    });

    it('is something to match on by itself', () => {
      const parsed = parseQuery('lang:en');
      expect(parsed.isEmpty).toBe(false);
      expect(parsed.terms).toEqual([]);
      expect(parseQuery('-lang:en').isEmpty).toBe(true);
    });

    it('drops stop words and symbols typed beside it alone', () => {
      expect(bodyOf('lang:en the')).toEqual(bodyOf('lang:en'));
      expect(bodyOf('lang:en *')).toEqual(bodyOf('lang:en'));
    });

    it('reads "lang:any" as no restriction', () => {
      expect(bodyOf('python lang:any')).toEqual(bodyOf('python'));
      expect(bodyOf('python -lang:any')).toEqual(bodyOf('python'));
      expect(parseQuery('python lang:any').ignoredOperators).toEqual(['lang:any']);
      expect(parseQuery('python lang:any').languages).toEqual([]);
    });

    it.each(['lang:english python', 'lang:e1 python', 'lang:e python', 'lang:en,fr python'])(
      'reads the malformed "%s" as the words typed, like site:foo',
      query => {
        const parsed = parseQuery(query);
        expect(parsed.languages).toEqual([]);
        expect(parsed.terms[0]).toBe('lang');
        expect(parsed.terms).toContain('python');
      }
    );

    it('reads "lang:" with nothing attached as an ordinary word', () => {
      expect(parseQuery('lang: python').terms).toEqual(['lang', 'python']);
      expect(parseQuery('lang: python').languages).toEqual([]);
    });

    it.each(['python -lang:', 'python -lang:english', 'python -lang:"not a code"'])(
      'ignores the malformed negative "%s"',
      query => {
        expect(bodyOf(query)).toEqual(bodyOf('python'));
        expect(parseQuery(query).excludedLanguages).toEqual([]);
        expect(parseQuery(query).excludedTerms).toEqual([]);
        expect(parseQuery(query).ignoredOperators).toHaveLength(1);
      }
    );

    it('leaves a word that merely contains "lang" alone', () => {
      expect(parseQuery('golang:en').languages).toEqual([]);
      expect(parseQuery('language python').languages).toEqual([]);
      expect(parseQuery('language python').hasOperators).toBe(false);
    });
  });

  describe('request building', () => {
    it('adds the same filter the language parameter uses', () => {
      const bool = boolOf('lang:en python');
      expect(languageFilter('en')).toEqual({ term: { language: 'en' } });
      expect(bool.filter).toEqual(expect.arrayContaining([languageFilter('en')]));
      expect(bool.must_not).toBeUndefined();
    });

    it('is a filter, not a scoring clause', () => {
      expect(scoring('lang:en python')).toEqual(scoring('python'));
      expect(scoring('python tutorial lang:fr')).toEqual(scoring('python tutorial'));
      expect(scoring('"machine learning" lang:en')).toEqual(scoring('"machine learning"'));
      expect(scoring('python -lang:en')).toEqual(scoring('python'));
    });

    it('never searches for the words "lang" or the code', () => {
      const queries = [];
      JSON.stringify(bodyOf('lang:en python').query, (key, value) => {
        if (key === 'query' && typeof value === 'string') queries.push(value);
        return value;
      });
      expect(queries.every(q => q === 'python')).toBe(true);
    });

    it('excludes a language in must_not', () => {
      const bool = boolOf('python -lang:en');
      expect(bool.must_not).toEqual([{ term: { language: 'en' } }]);
      expect(bool.filter).toEqual(buildFilters({}));
    });

    it('accepts any one of several languages', () => {
      expect(boolOf('lang:en lang:fr python').filter).toEqual(
        expect.arrayContaining([{ terms: { language: ['en', 'fr'] } }])
      );
    });

    it('narrows the language parameter rather than replacing it', () => {
      const bool = boolOf('lang:fr python', { language: 'en' });
      expect(bool.filter).toEqual(
        expect.arrayContaining([languageFilter('en'), { term: { language: 'fr' } }])
      );
    });

    it('lists the language when nothing else is asked for', () => {
      const bool = boolOf('lang:en');
      expect(bool.must).toEqual([{ match_all: {} }]);
      expect(bool.should).toEqual([]);
      expect(bool.filter).toEqual(expect.arrayContaining([languageFilter('en')]));
    });

    it('sits beside the other operators in their own places', () => {
      const bool = boolOf('lang:en site:wikipedia.org python -java -lang:fr');
      expect(bool.filter).toEqual(
        expect.arrayContaining([languageFilter('en'), buildFilters({ domain: 'wikipedia.org' })[0]])
      );
      expect(bool.must_not).toHaveLength(2);
      expect(bool.must_not).toEqual(expect.arrayContaining([{ term: { language: 'fr' } }]));
      expect(scoring('lang:en site:wikipedia.org python -java -lang:fr')).toEqual(
        scoring('python')
      );
    });

    it('leaves the ranking weights alone', () => {
      expect(bodyOf('lang:en python').query.function_score.functions).toEqual(
        buildScoreFunctions({ boostFreshness: true })
      );
      expect(FIELD_BOOSTS.title).toBe(8);
      expect(CLAUSE_BOOSTS.exactTitle).toBe(60);
    });
  });
});
