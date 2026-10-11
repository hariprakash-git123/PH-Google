const {
  parseQuery,
  detectSite,
  extractPhrases,
  shouldAllowFuzzy
} = require('../../services/opensearch/queryParser');
const {
  buildSearchBody,
  buildMustClause,
  buildShouldClauses,
  buildFilters,
  buildFuzzyClause,
  minimumShouldMatch,
  FIELD_BOOSTS,
  CLAUSE_BOOSTS
} = require('../../services/opensearch/queryBuilder');
const {
  toSearchDocument,
  buildDocumentId,
  computeQualityScore,
  uniqueWordRatio,
  flattenHeadings
} = require('../../services/opensearch/documentMapper');
const { getSynonyms, isValidRule } = require('../../services/opensearch/synonyms');
const { canonicalKey, rootDomainOf } = require('../../utils/urlNormalizer');
const { MAPPINGS, buildIndexDefinition } = require('../../services/opensearch/indexSettings');

/**
 * Query construction, document mapping and deduplication keys.
 * None of this needs a running cluster — it is pure logic.
 */

describe('query understanding', () => {
  describe('phrase extraction', () => {
    it('pulls a quoted phrase out and leaves the rest', () => {
      const { phrases, rest } = extractPhrases('open source "search engine" tutorial');
      expect(phrases).toEqual(['search engine']);
      expect(rest).toBe('open source tutorial');
    });

    it('handles curly quotes pasted from a document', () => {
      expect(extractPhrases('“machine learning”').phrases).toEqual(['machine learning']);
    });

    it('handles several phrases', () => {
      expect(extractPhrases('"a b" and "c d"').phrases).toEqual(['a b', 'c d']);
    });

    it('ignores an unbalanced quote rather than breaking', () => {
      const { phrases, rest } = extractPhrases('broken "quote here');
      expect(phrases).toEqual([]);
      expect(rest).toBe('broken quote here');
    });
  });

  describe('site detection', () => {
    it.each(['youtube.com', 'react.dev', 'en.wikipedia.org', 'example.co.uk'])(
      'detects %s as a site',
      domain => {
        expect(detectSite(domain).isSite).toBe(true);
        expect(detectSite(domain).domain).toBe(domain);
      }
    );

    it('detects a full URL and extracts its host', () => {
      const site = detectSite('https://www.react.dev/learn');
      expect(site.isSite).toBe(true);
      expect(site.domain).toBe('react.dev'); // www. stripped
    });

    it('does not treat ordinary words as a site', () => {
      for (const q of ['machine learning', 'python', 'best laptops', 'node.js']) {
        expect(detectSite(q).isSite).toBe(false);
      }
    });
  });

  describe('fuzzy eligibility', () => {
    it('allows fuzzy on a long single term', () => {
      expect(shouldAllowFuzzy(['pyhton'], { isSite: false, hasPhrase: false })).toBe(true);
    });

    it('refuses fuzzy on short words, where an edit changes the meaning', () => {
      expect(shouldAllowFuzzy(['the', 'cat'], { isSite: false, hasPhrase: false })).toBe(false);
    });

    it('never fuzzies a quoted phrase or a site query', () => {
      expect(shouldAllowFuzzy(['machine'], { isSite: false, hasPhrase: true })).toBe(false);
      expect(shouldAllowFuzzy(['youtube'], { isSite: true, hasPhrase: false })).toBe(false);
    });

    it('refuses fuzzy on a long query, which already has enough signal', () => {
      expect(
        shouldAllowFuzzy(['a', 'b', 'c', 'd', 'e', 'f', 'g'], { isSite: false, hasPhrase: false })
      ).toBe(false);
    });
  });

  describe('parseQuery', () => {
    it('classifies an empty query', () => {
      expect(parseQuery('').isEmpty).toBe(true);
      expect(parseQuery('   ').isEmpty).toBe(true);
    });

    it('normalises extra whitespace', () => {
      expect(parseQuery('  best   electric  cars ').cleaned).toBe('best electric cars');
    });

    it('de-duplicates repeated terms', () => {
      expect(parseQuery('python python python').terms).toEqual(['python']);
    });

    it('recognises a question', () => {
      expect(parseQuery('how does a web crawler work?').isQuestion).toBe(true);
      expect(parseQuery('web crawler').isQuestion).toBe(false);
    });

    it('marks a single-term query as short', () => {
      expect(parseQuery('python').isShort).toBe(true);
      expect(parseQuery('python tutorial').isShort).toBe(false);
    });

    it('keeps dots inside a term like node.js', () => {
      expect(parseQuery('node.js').terms).toEqual(['node.js']);
    });
  });

  describe('question topic (coreTerms)', () => {
    const core = query => parseQuery(query).coreTerms;

    it('strips "how does … work" down to the topic', () => {
      expect(core('how does gravity work')).toEqual(['gravity']);
      expect(parseQuery('how does gravity work').coreText).toBe('gravity');
      expect(parseQuery('how does gravity work').questionStripped).toBe(true);
    });

    it('strips the opener and an article after it', () => {
      expect(core('what is the capital of india')).toEqual(['capital', 'of', 'india']);
      expect(core('who is lionel messi')).toEqual(['lionel', 'messi']);
    });

    it('drops trailing "work" only for how-do questions with a topic before it', () => {
      expect(core('how do vaccines work')).toEqual(['vaccines']);
      expect(core('how does homework work')).toEqual(['homework']);
      expect(core('how does work affect health')).toEqual(['work', 'affect', 'health']);
    });

    it('falls back to the full query when nothing meaningful would remain', () => {
      // Not a question at all (two words, no "?").
      expect(core('what is')).toEqual(['what', 'is']);
      expect(parseQuery('what is').questionStripped).toBe(false);
      // A question, but only an opener — or an opener plus stop words.
      for (const query of ['what is?', 'how does it work', 'what is it?']) {
        const parsed = parseQuery(query);
        expect(parsed.questionStripped).toBe(false);
        expect(parsed.coreTerms).toEqual(parsed.terms);
        expect(parsed.coreText).toBe(parsed.text);
      }
    });

    it('still recognises a trailing "?" as a question', () => {
      const parsed = parseQuery('what is gravity?');
      expect(parsed.isQuestion).toBe(true);
      expect(parsed.coreTerms).toEqual(['gravity']);
    });

    it('keeps quoted phrases intact', () => {
      const parsed = parseQuery('what is "machine learning"?');
      expect(parsed.phrases).toEqual(['machine learning']);
      expect(parsed.hasPhrase).toBe(true);
      expect(parsed.coreTerms).toEqual([]);
      expect(parsed.coreText).toBe('machine learning');
    });

    it.each([
      // A leading auxiliary on its own is a word, not a question opener.
      ['can opener reviews'],
      ['will smith movies'],
      // An interrogative with no auxiliary after it is not stripped either.
      ['who covid guidelines'],
      ['how to cook rice']
    ])('leaves "%s" unchanged', query => {
      const parsed = parseQuery(query);
      expect(parsed.questionStripped).toBe(false);
      expect(parsed.coreTerms).toEqual(parsed.terms);
      expect(parsed.coreText).toBe(parsed.text);
    });

    it('decides fuzziness on the topic words', () => {
      // "who is ai?" -> topic "ai": too short for an edit distance.
      expect(parseQuery('who is ai?').allowFuzzy).toBe(false);
      expect(parseQuery('what is photosynthesis').allowFuzzy).toBe(true);
    });

    it('leaves a non-question exactly as before', () => {
      const parsed = parseQuery('python programming');
      expect(parsed.questionStripped).toBe(false);
      expect(parsed.coreTerms).toBe(parsed.terms);
      expect(parsed.coreText).toBe(parsed.text);
    });
  });
});

describe('query building', () => {
  describe('minimumShouldMatch', () => {
    it('requires the single term of a one-word query', () => {
      expect(minimumShouldMatch(1)).toBe('1');
    });

    it('requires both words of a two-word query, for precision', () => {
      expect(minimumShouldMatch(2)).toBe('2<70%');
    });

    it('relaxes for longer queries so one missing word is tolerated', () => {
      expect(minimumShouldMatch(6)).toBe('70%');
    });
  });

  describe('field weighting', () => {
    it('weights the title far above body content', () => {
      expect(FIELD_BOOSTS.title).toBeGreaterThan(FIELD_BOOSTS.content * 4);
    });

    it('weights headings above description, and description above content', () => {
      expect(FIELD_BOOSTS.headings).toBeGreaterThan(FIELD_BOOSTS.description);
      expect(FIELD_BOOSTS.description).toBeGreaterThan(FIELD_BOOSTS.content);
    });
  });

  describe('must clause', () => {
    it('requires a quoted phrase as a phrase match', () => {
      const clause = buildMustClause(parseQuery('"machine learning"'));
      const phraseClause = clause.bool.must[0];
      expect(phraseClause.multi_match.type).toBe('phrase');
      expect(phraseClause.multi_match.query).toBe('machine learning');
      // slop 0 -> the words must be adjacent, in order.
      expect(phraseClause.multi_match.slop).toBe(0);
    });

    it('requires loose terms alongside a quoted phrase', () => {
      const clause = buildMustClause(parseQuery('"search engine" tutorial'));
      expect(clause.bool.must).toHaveLength(2);
      expect(clause.bool.must[1].multi_match.query).toBe('tutorial');
    });

    it('uses best_fields for an ordinary keyword query', () => {
      // "the cat" is too short for fuzzy, so the clause is unwrapped.
      const clause = buildMustClause(parseQuery('the cat sat'));
      expect(clause.multi_match.type).toBe('best_fields');
      expect(clause.multi_match.fields).toEqual(
        expect.arrayContaining([`title^${FIELD_BOOSTS.title}`, `content^${FIELD_BOOSTS.content}`])
      );
    });

    it('lets fuzzy admit documents, not merely reorder them', () => {
      // A `should` clause can only reorder what `must` already matched, so a
      // misspelling with no exact matches would return nothing at all. When
      // fuzzy is allowed it joins `must` as an alternative way to qualify.
      const clause = buildMustClause(parseQuery('best electric cars'));
      expect(clause.bool.minimum_should_match).toBe(1);
      expect(clause.bool.should).toHaveLength(2);

      const [exact, fuzzy] = clause.bool.should;
      expect(exact.multi_match.type).toBe('best_fields');
      expect(exact.multi_match.fuzziness).toBeUndefined();
      expect(fuzzy.multi_match.fuzziness).toBe('AUTO');
      // The fuzzy alternative is weighted well below the exact one.
      expect(fuzzy.multi_match.boost).toBeLessThan(1);
    });

    it('matches the domain directly for a site query', () => {
      const clause = buildMustClause(parseQuery('youtube.com'));
      const terms = JSON.stringify(clause);
      expect(terms).toContain('"domain":"youtube.com"');
      expect(terms).toContain('rootDomain');
    });
  });

  describe('should clauses', () => {
    it('boosts an exact whole-title match hardest', () => {
      const clauses = buildShouldClauses(parseQuery('python tutorial'));
      const exact = clauses.find(c => c.term && c.term['title.raw']);
      expect(exact.term['title.raw'].value).toBe('python tutorial');
      expect(exact.term['title.raw'].boost).toBe(CLAUSE_BOOSTS.exactTitle);
    });

    it('adds unstemmed title matching so literal wording wins', () => {
      const clauses = buildShouldClauses(parseQuery('react'));
      expect(clauses.some(c => c.match && c.match['title.exact'])).toBe(true);
    });

    it('adds phrase/proximity clauses only for multi-word queries', () => {
      const multi = buildShouldClauses(parseQuery('best electric cars'));
      expect(multi.some(c => c.match_phrase && c.match_phrase.content)).toBe(true);

      const single = buildShouldClauses(parseQuery('python'));
      expect(single.some(c => c.match_phrase && c.match_phrase.content)).toBe(false);
    });

    it('boosts the exact domain for a site query', () => {
      const clauses = buildShouldClauses(parseQuery('youtube.com'));
      const domainClause = clauses.find(
        c => c.term && c.term.domain && c.term.domain.value === 'youtube.com'
      );
      expect(domainClause.term.domain.boost).toBe(CLAUSE_BOOSTS.domainExact);
      // A site match must outweigh any title match, or pages *about* the
      // site would outrank the site itself.
      expect(CLAUSE_BOOSTS.domainExact).toBeGreaterThan(CLAUSE_BOOSTS.exactTitle);
    });
  });

  describe('question queries', () => {
    const titleTerms = clauses => clauses.find(c => c.match && c.match['title.exact']);
    const questionTitle = clauses =>
      clauses.filter(
        c =>
          c.match_phrase &&
          c.match_phrase['title.exact'] &&
          c.match_phrase['title.exact'].boost === CLAUSE_BOOSTS.questionTitle
      );

    it('recalls on the topic, with the topic word requirement', () => {
      const [exact, fuzzy] = buildMustClause(parseQuery('how does gravity work')).bool.should;
      expect(exact.multi_match.query).toBe('gravity');
      expect(exact.multi_match.minimum_should_match).toBe('1');
      expect(fuzzy.multi_match.query).toBe('gravity');
    });

    it('holds the fuzzy gate to the topic word requirement', () => {
      const parsed = parseQuery('what is the capital of india');
      const gate = buildMustClause(parsed).bool.filter[0].bool;
      const [exactGate, fuzzyGate] = gate.should;
      expect(fuzzyGate.multi_match.query).toBe('capital of india');
      expect(fuzzyGate.multi_match.minimum_should_match).toBe(minimumShouldMatch(3));
      expect(exactGate.multi_match.minimum_should_match).toBe(minimumShouldMatch(3));
    });

    it('matches title wording and phrases on the topic', () => {
      const clauses = buildShouldClauses(parseQuery('how does machine learning work'));
      expect(titleTerms(clauses).match['title.exact'].query).toBe('machine learning');
      expect(titleTerms(clauses).match['title.exact'].minimum_should_match).toBe(
        minimumShouldMatch(2)
      );
      const content = clauses.find(c => c.match_phrase && c.match_phrase.content);
      expect(content.match_phrase.content.query).toBe('machine learning');
    });

    it('adds no proximity clauses when the topic is one word', () => {
      const clauses = buildShouldClauses(parseQuery('how does gravity work'));
      expect(clauses.some(c => c.match_phrase && c.match_phrase.content)).toBe(false);
    });

    it('keeps one low-weight clause for a title that is the whole question', () => {
      const clauses = questionTitle(buildShouldClauses(parseQuery('what is life')));
      expect(clauses).toHaveLength(1);
      expect(clauses[0].match_phrase['title.exact'].query).toBe('what is life');
      expect(CLAUSE_BOOSTS.questionTitle).toBeLessThan(CLAUSE_BOOSTS.phraseContent);
    });

    it.each([
      ['python programming'],
      ['mathematics'],
      ['can opener reviews'],
      ['will smith movies'],
      ['who covid guidelines'],
      ['how to cook rice']
    ])('builds "%s" on the full query, with no question clause', query => {
      const parsed = parseQuery(query);
      const [exact] = buildMustClause(parsed).bool.should;
      expect(exact.multi_match.query).toBe(parsed.text);
      expect(exact.multi_match.minimum_should_match).toBe(minimumShouldMatch(parsed.terms.length));
      const clauses = buildShouldClauses(parsed);
      expect(titleTerms(clauses).match['title.exact'].query).toBe(parsed.text);
      expect(questionTitle(clauses)).toHaveLength(0);
    });
  });

  describe('fuzzy clause', () => {
    it('is added for a likely typo, at a low weight', () => {
      const clause = buildFuzzyClause(parseQuery('pyhton'));
      expect(clause.multi_match.fuzziness).toBe('AUTO');
      expect(clause.multi_match.prefix_length).toBe(2);
      // Must not be able to outrank an exact match.
      expect(clause.multi_match.boost).toBeLessThan(1);
    });

    it('is omitted for phrases and site queries', () => {
      expect(buildFuzzyClause(parseQuery('"machine learning"'))).toBeNull();
      expect(buildFuzzyClause(parseQuery('youtube.com'))).toBeNull();
    });

    /** The non-scoring gate that decides which documents qualify. */
    const gateOf = query => buildMustClause(parseQuery(query)).bool.filter[0].bool;

    it('gates a single-word query on its one term', () => {
      const gate = gateOf('photosynthesis');
      expect(gate.minimum_should_match).toBe(1);
      expect(gate.should[1].multi_match.fuzziness).toBe('AUTO');
      expect(gate.should[1].multi_match.minimum_should_match).toBe('1');
    });

    it('gates a multi-word query on as many terms as the exact clause requires', () => {
      // Without the gate, the fuzzy alternative in `must` would admit a
      // document matching just one fuzzy term and bypass the exact rule.
      // Counted on the words actually searched: for a question that is its
      // topic ("what is photosynthesis" -> "photosynthesis"); otherwise all terms.
      for (const query of ['python programming', 'pyhton programming', 'what is photosynthesis']) {
        const parsed = parseQuery(query);
        const [exactGate, fuzzyGate] = gateOf(query).should;
        expect(fuzzyGate.multi_match.minimum_should_match).toBe(
          minimumShouldMatch(parsed.coreTerms.length)
        );
        expect(fuzzyGate.multi_match.minimum_should_match).toBe(
          exactGate.multi_match.minimum_should_match
        );
      }
    });

    it('leaves the scoring clauses exactly as they were', () => {
      // The gate is a filter, so it contributes nothing to the score; the
      // scoring fuzzy clause keeps its original shape.
      const parsed = parseQuery('python programming');
      const [exact, fuzzy] = buildMustClause(parsed).bool.should;
      expect(fuzzy).toEqual(buildFuzzyClause(parsed));
      expect(fuzzy.multi_match.minimum_should_match).toBeUndefined();
      expect(exact.multi_match.fuzziness).toBeUndefined();
    });

    it('leaves the field and clause weights unchanged', () => {
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
  });

  describe('filters', () => {
    it('filters by domain including the www variant and subdomains', () => {
      const filters = buildFilters({ domain: 'example.com', dateWindow: 'any', language: '' });
      const json = JSON.stringify(filters);
      expect(json).toContain('"domain":"example.com"');
      expect(json).toContain('"domain":"www.example.com"');
      expect(json).toContain('"rootDomain":"example.com"');
    });

    it('filters by language', () => {
      const filters = buildFilters({ domain: '', dateWindow: 'any', language: 'en' });
      expect(filters).toEqual(expect.arrayContaining([{ term: { language: 'en' } }]));
    });

    it('adds a date range for a relative window', () => {
      const filters = buildFilters({ domain: '', dateWindow: 'week', language: '' });
      expect(JSON.stringify(filters)).toContain('publishedAt');
    });

    it('adds no date range for "any"', () => {
      const filters = buildFilters({ domain: '', dateWindow: 'any', language: '' });
      expect(JSON.stringify(filters)).not.toContain('publishedAt');
    });

    it('always excludes non-200 pages', () => {
      const filters = buildFilters({ domain: '', dateWindow: 'any', language: '' });
      expect(JSON.stringify(filters)).toContain('"statusCode":200');
    });

    it('restricts to articles for the news vertical', () => {
      const filters = buildFilters({
        domain: '',
        dateWindow: 'any',
        language: '',
        isArticle: true
      });
      expect(filters).toEqual(expect.arrayContaining([{ term: { isArticle: true } }]));
    });
  });

  describe('complete search body', () => {
    it('applies pagination through from/size', () => {
      const body = buildSearchBody(parseQuery('python'), { from: 20, size: 10 });
      expect(body.from).toBe(20);
      expect(body.size).toBe(10);
    });

    it('never ships page bodies back to the API layer', () => {
      const body = buildSearchBody(parseQuery('python'), {});
      expect(body._source.excludes).toEqual(expect.arrayContaining(['content']));
    });

    it('requests highlighting so snippets show the matching text', () => {
      const body = buildSearchBody(parseQuery('python'), {});
      expect(body.highlight.fields.content).toBeDefined();
      expect(body.highlight.pre_tags).toEqual(['<mark>']);
    });

    it('applies quality and freshness as bounded multipliers', () => {
      const body = buildSearchBody(parseQuery('latest python news'), {});
      expect(body.query.function_score.boost_mode).toBe('multiply');

      const fns = body.query.function_score.functions;
      expect(fns.some(f => f.script_score)).toBe(true); // quality
      expect(fns.some(f => f.weight && f.filter && f.filter.range)).toBe(true); // freshness
    });

    it.each([
      'latest python news',
      'python release',
      'python 3.14 updates',
      `elections ${new Date().getUTCFullYear()}`
    ])('lifts recent pages for a time-sensitive query: %s', query => {
      const fns = buildSearchBody(parseQuery(query), {}).query.function_score.functions;
      expect(fns.some(f => f.weight && f.filter && f.filter.range)).toBe(true);
    });

    it.each([
      'python',
      'theory of relativity',
      'new york',
      'electric current',
      'what is a web crawler',
      'battle of 1066'
    ])('leaves recency out when the query does not ask for it: %s', query => {
      const fns = buildSearchBody(parseQuery(query), {}).query.function_score.functions;
      expect(fns.some(f => f.weight)).toBe(false);
      expect(fns.some(f => f.script_score)).toBe(true); // quality still applies
    });

    it('bounds freshness so it can only lift a recent page, never bury an old one', () => {
      // Regression: a decay function here scored ~1e-42 for a 2001-dated
      // page and erased it from the results entirely.
      const fns = buildSearchBody(parseQuery('latest python news'), {}).query.function_score
        .functions;

      // No unbounded decay curve.
      expect(fns.some(f => f.gauss || f.exp || f.linear)).toBe(false);

      // Every freshness function is a capped, filtered weight.
      const weights = fns.filter(f => f.weight).map(f => f.weight);
      expect(weights.length).toBeGreaterThan(0);
      for (const w of weights) {
        expect(w).toBeGreaterThanOrEqual(1); // never demotes
        expect(w).toBeLessThanOrEqual(1.25); // never dominates
      }
      // Each one is scoped to a date range, so undated pages are untouched.
      expect(fns.filter(f => f.weight).every(f => f.filter && f.filter.range.publishedAt)).toBe(
        true
      );
    });

    it('drops the freshness multiplier when sorting by date explicitly', () => {
      const body = buildSearchBody(parseQuery('python'), { sort: 'newest' });
      expect(body.query.function_score.functions.some(f => f.weight)).toBe(false);
      expect(body.sort[0].publishedAt.order).toBe('desc');
    });

    it('sorts oldest-first with missing dates placed first', () => {
      const body = buildSearchBody(parseQuery('python'), { sort: 'oldest' });
      expect(body.sort[0].publishedAt.order).toBe('asc');
    });

    it('sorts relevance by score, with the url hash only breaking ties', () => {
      const body = buildSearchBody(parseQuery('python'), { sort: 'relevance' });
      expect(body.sort).toEqual([{ _score: { order: 'desc' } }, { urlHash: { order: 'asc' } }]);
    });

    it('ends every date sort with the same deterministic tie-breaker', () => {
      for (const sort of ['newest', 'oldest']) {
        const body = buildSearchBody(parseQuery('python'), { sort });
        expect(body.sort[body.sort.length - 1]).toEqual({ urlHash: { order: 'asc' } });
      }
    });

    it('can restrict the search to known document ids without scoring them', () => {
      const body = buildSearchBody(parseQuery('python'), { ids: ['a', 'b'] });
      expect(body.query.function_score.query.bool.filter).toEqual(
        expect.arrayContaining([{ ids: { values: ['a', 'b'] } }])
      );
      // Without ids the filter is absent.
      const plain = buildSearchBody(parseQuery('python'), {});
      expect(JSON.stringify(plain.query)).not.toContain('"ids"');
    });

    it('asks for an explanation only in debug mode', () => {
      expect(buildSearchBody(parseQuery('x'), { explain: true }).explain).toBe(true);
      expect(buildSearchBody(parseQuery('x'), {}).explain).toBeUndefined();
    });

    it('counts total hits accurately rather than capping at 10000', () => {
      expect(buildSearchBody(parseQuery('x'), {}).track_total_hits).toBe(true);
    });
  });
});

describe('document mapping', () => {
  const basePage = {
    _id: 'abc123',
    url: 'https://example.com/guide',
    domain: 'example.com',
    title: 'A Complete Guide to Testing',
    description: 'How to test software properly.',
    content: 'testing is important '.repeat(40),
    language: 'en',
    lastCrawledAt: new Date('2026-09-01T00:00:00Z')
  };

  it('maps a page into the indexed document', () => {
    const { id, document } = toSearchDocument(basePage);
    expect(id).toMatch(/^[a-f0-9]{40}$/);
    expect(document).toMatchObject({
      pageId: 'abc123',
      url: 'https://example.com/guide',
      domain: 'example.com',
      rootDomain: 'example.com',
      path: '/guide',
      title: 'A Complete Guide to Testing',
      language: 'en'
    });
  });

  it('returns null for a page with no usable URL', () => {
    expect(toSearchDocument({ url: 'not a url' })).toBeNull();
    expect(toSearchDocument({})).toBeNull();
    expect(toSearchDocument(null)).toBeNull();
  });

  describe('deterministic ids (deduplication)', () => {
    it('gives every variant of one address the same id', () => {
      const ids = [
        'http://example.com/page',
        'https://example.com/page',
        'https://www.example.com/page/',
        'https://example.com/page?utm_source=twitter',
        'https://EXAMPLE.com/page#section'
      ].map(buildDocumentId);

      expect(new Set(ids).size).toBe(1);
    });

    it('gives different pages different ids', () => {
      expect(buildDocumentId('https://example.com/a')).not.toBe(
        buildDocumentId('https://example.com/b')
      );
    });

    it('keeps meaningful query parameters significant', () => {
      expect(buildDocumentId('https://e.com/s?q=cats')).not.toBe(
        buildDocumentId('https://e.com/s?q=dogs')
      );
    });

    it('is order-insensitive for query parameters', () => {
      expect(canonicalKey('https://e.com/s?b=2&a=1')).toBe(canonicalKey('https://e.com/s?a=1&b=2'));
    });
  });

  describe('quality signals', () => {
    it('scores a substantial, well-described page highly', () => {
      const score = computeQualityScore({
        wordCount: 2500,
        uniqueRatio: 0.5,
        hasDescription: true,
        titleLength: 45,
        statusCode: 200,
        outboundLinkCount: 20
      });
      expect(score).toBeGreaterThan(0.85);
    });

    it('penalises a page that repeats the same words', () => {
      const stuffed = computeQualityScore({
        wordCount: 5000,
        uniqueRatio: 0.02,
        hasDescription: false,
        titleLength: 200,
        statusCode: 200,
        outboundLinkCount: 0
      });
      const normal = computeQualityScore({
        wordCount: 800,
        uniqueRatio: 0.45,
        hasDescription: true,
        titleLength: 50,
        statusCode: 200,
        outboundLinkCount: 5
      });
      expect(stuffed).toBeLessThan(normal);
    });

    it('penalises a thin page', () => {
      const thin = computeQualityScore({
        wordCount: 20,
        uniqueRatio: 0.9,
        hasDescription: false,
        titleLength: 10,
        statusCode: 200,
        outboundLinkCount: 0
      });
      expect(thin).toBeLessThan(0.55);
    });

    it('stays within 0..1 for any input', () => {
      for (const wordCount of [0, 10, 100000]) {
        const s = computeQualityScore({
          wordCount,
          uniqueRatio: 0,
          hasDescription: false,
          titleLength: 0,
          statusCode: 500,
          outboundLinkCount: 0
        });
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('uniqueWordRatio', () => {
    it('is low for repeated text', () => {
      expect(uniqueWordRatio('spam spam spam spam spam spam')).toBeLessThan(0.2);
    });

    it('is high for varied prose', () => {
      expect(uniqueWordRatio('the quick brown fox jumps over lazy dogs today')).toBeGreaterThan(
        0.8
      );
    });

    it('is zero for empty text', () => {
      expect(uniqueWordRatio('')).toBe(0);
    });
  });

  describe('headings', () => {
    it('flattens the h1/h2/h3 structure into searchable text', () => {
      const flat = flattenHeadings({ h1: ['Title'], h2: ['One', 'Two'], h3: ['Deep'] });
      expect(flat).toContain('Title');
      expect(flat).toContain('One');
      expect(flat).toContain('Deep');
    });

    it('accepts an array or a string', () => {
      expect(flattenHeadings(['A', 'B'])).toContain('A');
      expect(flattenHeadings('Just one')).toBe('Just one');
    });

    it('returns an empty string for nothing', () => {
      expect(flattenHeadings(null)).toBe('');
      expect(flattenHeadings({})).toBe('');
    });
  });

  it('computes a content hash so syndicated copies can be collapsed', () => {
    const a = toSearchDocument({ ...basePage, url: 'https://a.com/x' });
    const b = toSearchDocument({ ...basePage, url: 'https://b.com/y' });
    // Same body text at two addresses -> same content hash, different ids.
    expect(a.document.contentHash).toBe(b.document.contentHash);
    expect(a.id).not.toBe(b.id);
  });

  it('derives the root domain from a subdomain', () => {
    expect(rootDomainOf('https://blog.example.co.uk/post')).toBe('example.co.uk');
  });
});

describe('index definition', () => {
  it('maps title with exact and raw sub-fields', () => {
    const title = MAPPINGS.properties.title;
    expect(title.type).toBe('text');
    expect(title.fields.exact.analyzer).toBe('ph_exact');
    expect(title.fields.raw.type).toBe('keyword');
  });

  it('applies synonyms at search time only, so edits need no reindex', () => {
    const title = MAPPINGS.properties.title;
    expect(title.analyzer).toBe('ph_text');
    expect(title.search_analyzer).toBe('ph_search');
  });

  it('uses keyword types for filterable fields', () => {
    for (const field of ['domain', 'rootDomain', 'language', 'urlHash', 'contentHash']) {
      expect(MAPPINGS.properties[field].type).toBe('keyword');
    }
  });

  it('uses date types for the time fields', () => {
    for (const field of ['publishedAt', 'updatedAt', 'crawledAt']) {
      expect(MAPPINGS.properties[field].type).toBe('date');
    }
  });

  it('rejects unmapped fields rather than guessing a type', () => {
    expect(MAPPINGS.dynamic).toBe('strict');
  });

  it('builds a definition with both settings and mappings', () => {
    const definition = buildIndexDefinition();
    expect(definition.settings.analysis.analyzer.ph_search).toBeDefined();
    expect(definition.mappings.properties.title).toBeDefined();
  });

  it('parses synonyms before the graph filter, which OpenSearch requires', () => {
    const chain = buildIndexDefinition().settings.analysis.analyzer.ph_search.filter;
    // word_delimiter_graph cannot precede synonym_graph.
    expect(chain.indexOf('ph_synonyms')).toBeLessThan(chain.indexOf('ph_word_delimiter'));
  });
});

describe('synonyms', () => {
  it('provides a curated, non-empty list', () => {
    const synonyms = getSynonyms();
    expect(synonyms.length).toBeGreaterThan(10);
    // Deliberately small — a huge list hurts precision.
    expect(synonyms.length).toBeLessThan(200);
  });

  it('accepts valid rules', () => {
    expect(isValidRule('car, automobile')).toBe(true);
    expect(isValidRule('tv, telly => television')).toBe(true);
  });

  it('rejects malformed rules that would break index creation', () => {
    expect(isValidRule('')).toBe(false);
    expect(isValidRule('lonely')).toBe(false); // no second term
    expect(isValidRule('=> nothing')).toBe(false);
    expect(isValidRule('# a comment')).toBe(false);
    expect(isValidRule(null)).toBe(false);
  });

  it('every shipped rule is valid', () => {
    for (const rule of getSynonyms()) {
      expect(isValidRule(rule)).toBe(true);
    }
  });
});
