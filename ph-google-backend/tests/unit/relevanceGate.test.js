jest.mock('../../services/opensearch/client', () => ({
  getClient: jest.fn(),
  checkHealth: jest.fn(async () => ({ ok: true })),
  describeConnectionError: () => 'down',
  closeClient: jest.fn()
}));

const { config } = require('../../config/env');
const { parseQuery } = require('../../services/opensearch/queryParser');
const { buildSearchBody, buildQualityFilters } = require('../../services/opensearch/queryBuilder');
const openSearchClient = require('../../services/opensearch/client');
const openSearch = require('../../services/opensearch/searchService');
const externalSearch = require('../../services/externalSearch');
const bingSearchClient = require('../../services/external/bingSearchClient');
const serpApiClient = require('../../services/external/serpApiClient');
const { ExternalSearchError } = require('../../services/external/externalSearchError');
const { items } = require('../helpers/bingStandIn');
const { organic } = require('../helpers/serpApiStandIn');

/**
 * The relevance gate: external web results are asked for when the index's
 * first page does not answer the query — no page about it, or fewer than
 * three results that cover it — however many pages matched. Whatever comes
 * back is ranked with the index's results as one list (unifiedRanker).
 *
 * Three parts: the measurement (two filters beside the search), what the
 * OpenSearch service reports from them, and the decision and ordering in
 * externalSearch. No real index and no real provider is used.
 */

describe('the measurement: buildQualityFilters', () => {
  const ABOUT = ['title', 'headings', 'description', 'keywords', 'url'];
  const ALL = [...ABOUT, 'content'];
  const word = (query, fields) => ({
    multi_match: { query, type: 'best_fields', fields, operator: 'and', zero_terms_query: 'all' }
  });

  it('requires every word of the query — anywhere (full), or where a page says what it is about (about)', () => {
    const filters = buildQualityFilters(parseQuery('best pizza in chennai'));
    expect(filters.full).toEqual({
      bool: { must: ['best', 'pizza', 'in', 'chennai'].map(w => word(w, ALL)) }
    });
    expect(filters.about).toEqual({
      bool: { must: ['best', 'pizza', 'in', 'chennai'].map(w => word(w, ABOUT)) }
    });
  });

  it('lets a stop word through rather than requiring what no field holds', () => {
    const [clause] = buildQualityFilters(parseQuery('the')).about.bool.must;
    expect(clause.multi_match.zero_terms_query).toBe('all');
  });

  it('requires a quoted phrase as a phrase', () => {
    const filters = buildQualityFilters(parseQuery('"climate change" effects'));
    expect(filters.about.bool.must).toEqual([
      word('effects', ABOUT),
      { multi_match: { query: 'climate change', type: 'phrase', fields: ABOUT, slop: 0 } }
    ]);
  });

  it('requires one alternative of an OR group', () => {
    const filters = buildQualityFilters(parseQuery('python OR javascript tutorial'));
    expect(filters.about.bool.must).toEqual([
      word('tutorial', ABOUT),
      {
        bool: {
          should: [word('python', ABOUT), word('javascript', ABOUT)],
          minimum_should_match: 1
        }
      }
    ]);
  });

  it.each(['', '   ', 'site:python.org', 'lang:en', '-java'])(
    'measures nothing for a query with no free text (%j)',
    query => {
      expect(buildQualityFilters(parseQuery(query))).toBeNull();
    }
  );

  it('does not change the search itself: the ranked query is byte-for-byte what it was', () => {
    const parsed = parseQuery('best pizza in chennai');
    const before = JSON.stringify(buildSearchBody(parsed, { from: 0, size: 10 }));
    buildQualityFilters(parsed);
    expect(JSON.stringify(buildSearchBody(parsed, { from: 0, size: 10 }))).toBe(before);
    expect(before).not.toContain('zero_terms_query');
  });
});

describe('what the OpenSearch service reports', () => {
  const hit = n => ({
    _id: `id${n}`,
    _score: 10 - n,
    _source: {
      url: `https://a.example/${n}`,
      title: `Page ${n}`,
      urlHash: `id${n}`,
      wordCount: 500
    }
  });
  /** A fake cluster: answers both passes, and records what it was asked. */
  function fakeCluster({ about, full, total = 2 }) {
    const requests = [];
    openSearchClient.getClient.mockReturnValue({
      search: jest.fn(async ({ body }) => {
        requests.push(body);
        return {
          body: {
            hits: { total: { value: total }, hits: [hit(1), hit(2)].slice(0, total) },
            aggregations: body.aggs
              ? {
                  duplicates: { groups: { buckets: [] } },
                  ...(body.aggs.aboutMatches
                    ? { aboutMatches: { doc_count: about }, fullMatches: { doc_count: full } }
                    : {})
                }
              : undefined
          }
        };
      })
    });
    return requests;
  }

  it('asks for the two counts beside the first request and reports them', async () => {
    const requests = fakeCluster({ about: 0, full: 0 });
    const parsed = parseQuery('best pizza in chennai');
    const outcome = await openSearch.search({ query: 'best pizza in chennai' });

    expect(outcome.quality).toEqual({ fullMatches: 0, aboutMatches: 0 });
    const filters = buildQualityFilters(parsed);
    expect(requests[0].aggs.aboutMatches).toEqual({ filter: filters.about });
    expect(requests[0].aggs.fullMatches).toEqual({ filter: filters.full });
    // Beside the search, not inside it: the scored query is the usual one.
    expect(requests[0].query).toEqual(buildSearchBody(parsed, { from: 0, size: 30 }).query);
    // One measurement per search: the page fetch carries no aggregation.
    expect(requests[1].aggs).toBeUndefined();
    // And the results are what they would have been.
    expect(outcome.results.map(r => r.title)).toEqual(['Page 1', 'Page 2']);
    expect(outcome.totalResults).toBe(2);
  });

  it('reports a page about the query when there is one', async () => {
    fakeCluster({ about: 1, full: 37 });
    const outcome = await openSearch.search({ query: 'python programming' });
    expect(outcome.quality).toEqual({ fullMatches: 37, aboutMatches: 1 });
  });

  it('measures the News vertical too, among articles', async () => {
    const requests = fakeCluster({ about: 5, full: 5 });
    const news = await openSearch.search({ query: 'python', isArticle: true });
    // Beside a search that carries the article filter, so the counts are of articles.
    expect(requests[0].aggs.aboutMatches).toBeDefined();
    expect(requests[0].query.function_score.query.bool.filter).toEqual(
      expect.arrayContaining([{ term: { isArticle: true } }])
    );
    expect(news.quality).toEqual({ fullMatches: 5, aboutMatches: 5 });
  });

  it('does not measure a query with no free text', async () => {
    const requests = fakeCluster({ about: 5, full: 5 });
    const siteOnly = await openSearch.search({ query: 'site:python.org' });
    expect(requests[0].aggs.aboutMatches).toBeUndefined();
    expect(siteOnly).not.toHaveProperty('quality');
  });
});

describe('the decision and the ordering', () => {
  const original = {
    serpapi: { ...config.serpapi },
    bing: { ...config.bing },
    externalSearch: { ...config.externalSearch }
  };
  const indexResult = (url, title = url, snippet = 's') => ({
    id: `id-${url}`,
    url,
    title,
    snippet,
    score: 5
  });
  const INDEX_URLS = [
    'https://en.wikipedia.org/wiki/Christianity_in_Asia',
    'https://en.wikipedia.org/wiki/Cinema_of_India',
    'https://en.wikipedia.org/wiki/Chennai'
  ];
  /** An index outcome: 28 matches, with the given quality measurement. */
  const internal = (quality, urls = INDEX_URLS, totalResults = 28) => ({
    query: 'best pizza in chennai',
    results: urls.map(url => (typeof url === 'string' ? indexResult(url) : url)),
    totalResults,
    reachableResults: totalResults,
    duplicatesRemoved: 0,
    responseTimeMs: 5,
    engine: 'opensearch',
    ...(quality ? { quality } : {})
  });
  const WEAK = { fullMatches: 0, aboutMatches: 0 };
  const STRONG = { fullMatches: 37, aboutMatches: 1 };
  const params = (overrides = {}) => ({
    query: 'best pizza in chennai',
    page: 1,
    limit: 10,
    ...overrides
  });
  const run = (outcome, p = params(), options = {}) =>
    externalSearch.searchWithExternal(p, async () => outcome, options);
  const order = out => out.results.map(r => r.source);
  /** Index pages that are about "python programming". */
  const pythonPages = n =>
    Array.from({ length: n }, (_, i) =>
      indexResult(
        `https://py.example/guide-${i + 1}`,
        `Python programming guide ${i + 1}`,
        'Learn Python programming.'
      )
    );

  let bing;
  let serp;

  beforeEach(() => {
    externalSearch.reset();
    Object.assign(config.externalSearch, { provider: 'bing', fallback: true, relevanceGate: true });
    Object.assign(config.bing, original.bing, {
      apiKey: 'gate-test-bing-key-NOT-REAL',
      maxResults: 10,
      dailyLimit: 0,
      cacheTtlMs: 60000
    });
    Object.assign(config.serpapi, original.serpapi, {
      enabled: true,
      apiKey: 'gate-test-serpapi-key-NOT-REAL',
      engine: 'google',
      minInternalResults: 3,
      dailyLimit: 0,
      cacheTtlMs: 60000
    });
    bing = jest.spyOn(bingSearchClient, 'searchWeb').mockResolvedValue({ results: items(3) });
    serp = jest.spyOn(serpApiClient, 'searchGoogle').mockResolvedValue({ results: organic(2) });
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => {
    Object.assign(config.serpapi, original.serpapi);
    Object.assign(config.bing, original.bing);
    Object.assign(config.externalSearch, original.externalSearch);
  });

  describe('when a provider is asked', () => {
    it('the index has no page about the query: asked although 28 pages matched', async () => {
      const out = await run(internal(WEAK));
      expect(bing).toHaveBeenCalledTimes(1);
      expect(bing.mock.calls[0][0]).toMatchObject({ keyword: 'best pizza in chennai', page: 0 });
      expect(serp).not.toHaveBeenCalled();
      expect(out.external).toEqual({
        provider: 'bing',
        status: 'ok',
        count: 3,
        cached: false,
        indexQuality: 'weak',
        indexCovering: 0,
        placement: 'ranked'
      });
    });

    it('one page about the query is not enough: fewer than 3 results that cover it, and the provider is asked', async () => {
      // OpenSearch found a page "about" it, but on this page of results only
      // one covers the query; the rest are loose matches.
      const given = internal(STRONG, [
        indexResult('https://pizza.example/chennai', 'Best pizza in Chennai'),
        ...INDEX_URLS
      ]);
      const out = await run(given);
      expect(bing).toHaveBeenCalledTimes(1);
      expect(out.external).toMatchObject({ indexQuality: 'weak', indexCovering: 1 });
    });

    it('enough results that cover the query: no provider is asked, and the index answers alone', async () => {
      const given = internal(STRONG, pythonPages(3), 38);
      const out = await run(given, params({ query: 'python programming' }));
      expect(bing).not.toHaveBeenCalled();
      expect(serp).not.toHaveBeenCalled();
      expect(order(out)).toEqual(['index', 'index', 'index']);
      expect(out.external).toEqual({
        provider: 'bing',
        status: 'skipped',
        count: 0,
        reason: 'enough_index_results',
        indexQuality: 'strong',
        indexCovering: 3
      });
    });

    it('too few results: the provider is asked whatever their quality', async () => {
      const given = internal(STRONG, pythonPages(1), 1);
      await run(given, params({ query: 'python programming' }));
      expect(bing).toHaveBeenCalledTimes(1);
    });

    it('Load more continues from the provider first where the index did not answer; shares batches otherwise', async () => {
      const weak = await run(internal(WEAK));
      expect(weak.continuation.placement).toBe('external');
      config.externalSearch.relevanceGate = false;
      const counted = await run(internal(WEAK, [INDEX_URLS[0]], 1), params({ query: 'other' }));
      expect(counted.continuation.placement).toBe('ranked');
    });

    it('keeps the index totals, so pagination is unchanged', async () => {
      const out = await run(internal(WEAK));
      expect(out.totalResults).toBe(28);
      expect(out.reachableResults).toBe(28);
    });
  });

  describe('one ranking for both sources', () => {
    it('results about the query lead, from whichever source; loose matches follow', async () => {
      bing.mockResolvedValue({
        results: [
          { title: 'Pizza dough recipe', link: 'https://food.example/dough' },
          { title: 'Best pizza in Chennai: 12 places', link: 'https://food.example/chennai-pizza' }
        ]
      });
      const given = internal(WEAK, [
        INDEX_URLS[0],
        indexResult('https://pizza.example/chennai', 'Pizza in Chennai', 'Where to eat pizza.'),
        INDEX_URLS[1]
      ]);
      const out = await run(given);
      expect(out.results.map(r => r.url)).toEqual([
        // Both sources' pages about pizza in Chennai lead — the index's first,
        // its title being exactly the query's words…
        'https://pizza.example/chennai',
        'https://food.example/chennai-pizza',
        // …then what only partly matches, in each source's own order.
        'https://food.example/dough',
        INDEX_URLS[0],
        INDEX_URLS[1]
      ]);
    });

    it('a provider result is not put first for being external: equal evidence, the index leads', async () => {
      bing.mockResolvedValue({
        results: [{ title: 'Pizza in Chennai', link: 'https://other.example/pizza-chennai' }]
      });
      const given = internal(WEAK, [
        indexResult('https://pizza.example/chennai', 'Pizza in Chennai', '')
      ]);
      const out = await run(given);
      expect(order(out)).toEqual(['index', 'bing']);
    });

    it('the same inputs always give the same order', async () => {
      const first = await run(internal(WEAK));
      externalSearch.reset();
      const second = await run(internal(WEAK));
      expect(second.results.map(r => r.url)).toEqual(first.results.map(r => r.url));
    });

    it('still drops an external copy of an indexed page — the index copy is kept', async () => {
      bing.mockResolvedValue({
        results: [
          {
            title: 'Chennai (copy)',
            link: 'https://www.en.wikipedia.org/wiki/Chennai/?utm_source=bing'
          },
          // The mobile copy of an indexed page is the same page too.
          { title: 'Chennai (mobile)', link: 'https://en.m.wikipedia.org/wiki/Chennai' },
          { title: 'Best pizza places', link: 'https://food.example/pizza-chennai' }
        ]
      });
      const out = await run(internal(WEAK));
      expect(out.results.filter(r => r.source === 'bing').map(r => r.title)).toEqual([
        'Best pizza places'
      ]);
      expect(
        out.results
          .filter(r => r.source === 'index')
          .map(r => r.url)
          .sort()
      ).toEqual([...INDEX_URLS].sort());
      expect(out.external.count).toBe(1);
    });

    it('still drops an external result for a page the index holds further down', async () => {
      const indexedKeys = jest.fn(async keys => new Set(keys.filter(k => k.includes('page-2'))));
      const out = await run(internal(WEAK), params(), { indexedKeys });
      expect(out.results.filter(r => r.source === 'bing').map(r => r.title)).toEqual([
        'Bing result 1',
        'Bing result 3'
      ]);
    });

    it('falls back to SerpApi when Bing fails — ranked the same way', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      bing.mockRejectedValue(new ExternalSearchError('timeout', 'slow'));
      const out = await run(internal(WEAK));
      expect(order(out).filter(s => s === 'serpapi')).toHaveLength(2);
      expect(out.external).toEqual({
        provider: 'serpapi',
        status: 'ok',
        count: 2,
        cached: false,
        fallbackFrom: 'bing',
        fallbackReason: 'timeout',
        indexQuality: 'weak',
        indexCovering: 0,
        placement: 'ranked'
      });
    });

    it('when no provider answers, the index results are shown in their own order', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      bing.mockRejectedValue(new ExternalSearchError('unavailable', 'down'));
      serp.mockRejectedValue(new ExternalSearchError('unavailable', 'down'));
      const out = await run(internal(WEAK));
      expect(out.results.map(r => r.url)).toEqual(INDEX_URLS);
      expect(out.external).toEqual({
        provider: 'bing',
        status: 'unavailable',
        count: 0,
        reason: 'unavailable',
        indexQuality: 'weak',
        indexCovering: 0
      });
    });

    it('uses the cache for a repeat — the gate does not spend quota twice', async () => {
      await run(internal(WEAK));
      const again = await run(internal(WEAK));
      expect(bing).toHaveBeenCalledTimes(1);
      expect(again.external).toMatchObject({ cached: true, placement: 'ranked' });
      expect(order(again).filter(s => s === 'bing')).toHaveLength(3);
    });

    it('respects the daily limit', async () => {
      config.bing.dailyLimit = 1;
      config.externalSearch.fallback = false;
      await run(internal(WEAK), params({ query: 'first weak query' }));
      const out = await run(internal(WEAK), params({ query: 'second weak query' }));
      expect(bing).toHaveBeenCalledTimes(1);
      expect(out.external).toMatchObject({ status: 'skipped', reason: 'daily_limit' });
      expect(out.results.map(r => r.url)).toEqual(INDEX_URLS);
    });

    it('page 2 asks no provider, weak index or not', async () => {
      const out = await run(internal(WEAK), params({ page: 2 }));
      expect(bing).not.toHaveBeenCalled();
      expect(out.external).toMatchObject({ status: 'skipped', reason: 'not_first_page' });
      expect(order(out)).toEqual(['index', 'index', 'index']);
    });

    it('a search sorted by date keeps the order of its dates', async () => {
      config.serpapi.minInternalResults = 0;
      bing.mockResolvedValue({
        results: [{ title: 'Best pizza in Chennai', link: 'https://food.example/x' }]
      });
      const out = await run(internal(STRONG), params({ sort: 'newest' }));
      // Not merged at all: the provider is not asked for a date sort.
      expect(out.results.map(r => r.url)).toEqual(INDEX_URLS);
    });
  });

  describe('when the gate does not apply', () => {
    it('EXTERNAL_RELEVANCE_GATE=false restores the count rule', async () => {
      config.externalSearch.relevanceGate = false;
      const skipped = await run(internal(WEAK));
      expect(bing).not.toHaveBeenCalled();
      expect(skipped.external).toEqual({
        provider: 'bing',
        status: 'skipped',
        count: 0,
        reason: 'enough_index_results'
      });

      const few = await run(internal(WEAK, [INDEX_URLS[0]], 1), params({ query: 'another' }));
      expect(order(few).filter(s => s === 'bing')).toHaveLength(3);
      expect(few.external).toEqual({
        provider: 'bing',
        status: 'ok',
        count: 3,
        cached: false,
        placement: 'ranked'
      });
    });

    it('an engine that does not measure (the legacy index) keeps the count rule', async () => {
      const out = await run(internal(null));
      expect(bing).not.toHaveBeenCalled();
      expect(out.external).toEqual({
        provider: 'bing',
        status: 'skipped',
        count: 0,
        reason: 'enough_index_results'
      });
    });

    it.each([
      [{ fullMatches: 0 }, null],
      [{ aboutMatches: '0' }, null],
      [{ aboutMatches: 0 }, { level: 'weak', covering: 0 }],
      [{ aboutMatches: 3 }, { level: 'weak', covering: 0 }]
    ])('indexQuality(%j) with no covering results → %j', (quality, expected) => {
      expect(externalSearch.indexQuality({ quality }, parseQuery('python programming'))).toEqual(
        expected
      );
    });

    it('indexQuality is strong with a page about the query and enough results covering it', () => {
      expect(
        externalSearch.indexQuality(
          { quality: { aboutMatches: 3 }, results: pythonPages(3) },
          parseQuery('python programming')
        )
      ).toEqual({ level: 'strong', covering: 3 });
    });
  });
});
