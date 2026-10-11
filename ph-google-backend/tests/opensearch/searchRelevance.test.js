/**
 * Topical relevance of the All tab, end to end: the real route and the real
 * engine over a small fixture index, with the providers mocked.
 *
 * What this protects. "Best restaurants in combatore" used to show travel
 * guides to other countries: the index has no page on the subject, so its
 * matches were pages sharing the words "best" and "restaurants"; and the
 * provider's good answer was thrown away because it spells the town
 * "Coimbatore" and the query does not. Every test here checks what the
 * results are ABOUT — never just that there are some.
 *
 * Skipped (not passed) when no cluster is reachable. Uses its own index.
 */

const previousEngine = process.env.SEARCH_ENGINE;
const previousIndex = process.env.OPENSEARCH_INDEX;
const INDEX_NAME = 'ph-google-pages-relevance-test';
process.env.SEARCH_ENGINE = 'opensearch';
process.env.OPENSEARCH_INDEX = INDEX_NAME;

const request = require('supertest');
const testDb = require('../helpers/testDb');
const {
  checkHealth,
  closeClient,
  resetClient,
  getClient
} = require('../../services/opensearch/client');
const { recreateIndex, refreshIndex } = require('../../services/opensearch/indexManager');
const {
  bulkIndexPages,
  resetIndexReadyFlag
} = require('../../services/opensearch/indexingService');
const { config } = require('../../config/env');
const externalSearch = require('../../services/externalSearch');
const openSearch = require('../../services/opensearch/searchService');
const retrievalService = require('../../services/ai/retrievalService');
const parallelClient = require('../../services/external/parallelClient');
const serpApiClient = require('../../services/external/serpApiClient');
const bingSearchClient = require('../../services/external/bingSearchClient');
const { ExternalSearchError } = require('../../services/external/externalSearchError');
const logger = require('../../utils/logger');

const available = process.env.OPENSEARCH_AVAILABLE === 'true';
const describeLive = available ? describe : describe.skip;

const page = (id, url, title, content, extra = {}) => ({
  _id: id,
  url,
  domain: new URL(url).hostname,
  title,
  description: `${title}.`,
  content,
  language: 'en',
  lastCrawledAt: new Date(Date.now() - 3600 * 1000),
  ...extra
});

const PAGES = [
  // --- Pages that share generic words with a restaurant query, and nothing else
  page(
    'albania',
    'https://travel.example.org/albania',
    'Albania – Travel guide',
    'Tirana has some of the best restaurants in the Balkans. The best beaches are in the south, and good restaurants line the promenade.'
  ),
  page(
    'old-towns',
    'https://travel.example.org/old-towns',
    'Old towns – Travel guide',
    'Old towns are best explored on foot. Good restaurants can be found in the side streets; the best places to eat are popular with locals.'
  ),
  page(
    'eiffel',
    'https://landmarks.example.org/eiffel-tower',
    'Eiffel Tower',
    'The Eiffel Tower has two restaurants. The best views are from the top in the evening.'
  ),
  page(
    'swimmer',
    'https://people.example.org/swimmer',
    'A Famous Swimmer',
    'She was named the best swimmer of the year and later opened two restaurants in her home town.'
  ),

  // --- A town the index does know: on the subject, though no title says "restaurants"
  ...Array.from({ length: 12 }, (_, i) =>
    page(
      `chennai-${i + 1}`,
      `https://chennai.example.in/food-${i + 1}`,
      `Chennai food guide ${i + 1}`,
      `Part ${i + 1} of a guide to eating out in Chennai. The restaurants of Chennai serve dosa, idli and filter coffee from early morning.`
    )
  ),

  // --- Strong subjects
  page(
    'py-tutorial',
    'https://learn.example.com/python-tutorial',
    'Python Tutorial for Beginners',
    'This Python tutorial covers variables, loops and functions. A step by step tutorial for people new to Python programming.'
  ),
  page(
    'py-tutorial-2',
    'https://learn.example.com/python-tutorial-functions',
    'Python Tutorial: Functions',
    'The second Python tutorial explains functions, arguments and return values in Python.'
  ),
  page(
    'py-tutorial-3',
    'https://learn.example.com/advanced-python-tutorial',
    'Advanced Python Tutorial',
    'An advanced Python tutorial on decorators, generators and context managers.'
  ),
  page(
    'ai-news-1',
    'https://news.example.com/ai-news-today',
    'Latest AI News Today',
    'The latest AI news: new language models, chips and research results from this week.'
  ),
  page(
    'ai-news-2',
    'https://news.example.com/ai-news-research',
    'AI News: The Latest Research Roundup',
    'A roundup of AI news from the research labs, with the latest papers on reasoning.'
  ),
  page(
    'ai-news-3',
    'https://news.example.com/ai-news-weekly',
    'The Latest AI News Weekly',
    'Weekly AI news for engineers: the latest tools, releases and benchmarks.'
  ),

  // --- Pages with ONE word of a three-word subject
  page(
    'india',
    'https://places.example.org/india',
    'India',
    'India has many cities, among them Chennai, Madurai and Tirunelveli in the south.'
  ),
  page(
    'recipes',
    'https://food.example.org/recipes',
    'World Recipes',
    'A recipe collection from around the world: every recipe has been tested twice.'
  )
];

/** A provider result in Parallel's shape. */
const hit = (url, title, excerpt) => ({ url, title, publish_date: null, excerpts: [excerpt] });

const COIMBATORE = [
  hit(
    'https://www.tripadvisor.example/coimbatore-restaurants',
    'THE 10 BEST Restaurants in Coimbatore',
    'Best dining in Coimbatore: see traveller reviews of Coimbatore restaurants.'
  ),
  hit(
    'https://www.zomato.example/coimbatore/best-restaurants',
    'The Best Restaurants in Coimbatore for Dining Out',
    'A list of the best restaurants in Coimbatore, with menus and ratings.'
  ),
  hit(
    'https://food.ndtv.example/coimbatore',
    '8 Best Restaurants In Coimbatore To Explore',
    'From biryani to filter coffee, these Coimbatore restaurants are worth a visit.'
  ),
  hit(
    'https://restaurant-guru.example/coimbatore',
    'Top 20 restaurants in Coimbatore',
    'Explore the top restaurants in Coimbatore, ranked by visitors.'
  ),
  // The provider's own near-misses for the misspelt name: other towns.
  hit(
    'https://www.tripadvisor.example/comporta-restaurants',
    'THE 10 BEST Restaurants in Comporta',
    'Best dining in Comporta, Portugal.'
  ),
  hit(
    'https://menumap.example/caboolture',
    'Caboolture restaurants, bars and cafes',
    'Places to eat in Caboolture, Queensland.'
  )
];

const HALWA = [
  hit(
    'https://cooking.example/tirunelveli-halwa',
    'Tirunelveli Halwa Recipe | Wheat Halwa',
    'How to make Tirunelveli halwa at home: a traditional recipe with wheat milk and ghee.'
  ),
  hit(
    'https://sweets.example/iruttukadai-halwa',
    'Iruttukadai Halwa: the Tirunelveli halwa',
    'The story and the recipe of the famous halwa of Tirunelveli.'
  ),
  hit(
    'https://recipes.example/godhumai-halwa',
    'Godhumai Halwa Recipe (Tirunelveli style)',
    'A Tirunelveli style halwa recipe, step by step.'
  ),
  hit(
    'https://recipes.example/dinner-ideas',
    'Recipe ideas for dinner tonight',
    'Fifty quick recipe ideas for a weeknight dinner.'
  )
];

const CHENNAI = [
  hit(
    'https://www.zomato.example/chennai/best-restaurants',
    'Best Restaurants in Chennai',
    'The best restaurants in Chennai, by neighbourhood.'
  ),
  hit(
    'https://www.tripadvisor.example/chennai-restaurants',
    'THE 10 BEST Restaurants in Chennai',
    'Reviews of Chennai restaurants.'
  )
];

// Well-formed, and about nothing the query asked for.
const OFF_TOPIC = [
  hit('https://lists.example/best-movies', 'The best movies of the year', 'Our pick of the best.'),
  hit('https://lists.example/best-phones', 'Best phones to buy', 'The best phones, ranked.'),
  hit('https://lists.example/top-books', 'Top books', 'The best books in every genre.')
];

describeLive('topical relevance of web results', () => {
  let app;
  let parallelSearch;
  let searchGoogle;
  let searchBing;
  const original = {
    parallel: { ...config.parallel },
    serpapi: { ...config.serpapi },
    bing: { ...config.bing },
    externalSearch: { ...config.externalSearch }
  };

  const search = params => request(app).get('/api/search').query(params);
  const textOf = r => `${r.title} ${r.snippet} ${r.url}`.toLowerCase();
  const allMention = (results, ...words) =>
    results.every(r => words.every(word => textOf(r).includes(word)));
  const titlesOf = res => res.body.data.results.map(r => r.title);
  const JUNK = [
    'Albania – Travel guide',
    'Old towns – Travel guide',
    'Eiffel Tower',
    'A Famous Swimmer'
  ];

  beforeAll(async () => {
    if (config.searchEngine !== 'opensearch') {
      throw new Error('This suite must run with SEARCH_ENGINE=opensearch');
    }
    resetClient();
    const health = await checkHealth(true);
    if (!health.ok) {
      throw new Error(`OpenSearch became unreachable at ${health.node}: ${health.error || ''}`);
    }
    resetIndexReadyFlag();
    await recreateIndex();
    await bulkIndexPages(PAGES);
    await refreshIndex();
    await testDb.connect();
    app = require('../../app').createApp();
  }, 120000);

  afterAll(async () => {
    Object.assign(config.parallel, original.parallel);
    Object.assign(config.serpapi, original.serpapi);
    Object.assign(config.bing, original.bing);
    Object.assign(config.externalSearch, original.externalSearch);
    await testDb.disconnect();
    try {
      await getClient().indices.delete({ index: INDEX_NAME });
    } catch {
      /* already gone */
    }
    await closeClient();
    process.env.SEARCH_ENGINE = previousEngine;
    process.env.OPENSEARCH_INDEX = previousIndex;
  });

  beforeEach(async () => {
    await testDb.clear();
    externalSearch.reset();
    // The production arrangement: Parallel exclusively, gate and validation on.
    Object.assign(config.externalSearch, original.externalSearch, {
      provider: 'parallel',
      fallback: false,
      relevanceGate: true,
      validateResults: true
    });
    Object.assign(config.parallel, original.parallel, {
      enabled: true,
      apiKey: 'relevance-test-parallel-key-NOT-REAL',
      mode: 'fast',
      maxResults: 10,
      dailyLimit: 0,
      cacheTtlMs: 0
    });
    Object.assign(config.serpapi, original.serpapi, {
      enabled: true,
      apiKey: 'relevance-test-serpapi-key-NOT-REAL',
      engine: 'google',
      minInternalResults: 3,
      dailyLimit: 0,
      cacheTtlMs: 0
    });
    Object.assign(config.bing, original.bing, { apiKey: 'relevance-test-bing-key-NOT-REAL' });
    parallelSearch = jest.spyOn(parallelClient, 'search').mockResolvedValue({ results: [] });
    searchGoogle = jest.spyOn(serpApiClient, 'searchGoogle').mockResolvedValue({ results: [] });
    searchBing = jest.spyOn(bingSearchClient, 'searchWeb').mockResolvedValue({ results: [] });
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  // ------------------------------------------------------------------
  describe('a subject the index does not hold', () => {
    it.each(['Best restaurants in combatore', 'best restaurants in Coimbatore'])(
      '"%s" shows restaurants in Coimbatore, and nothing else',
      async q => {
        parallelSearch.mockResolvedValue({ results: COIMBATORE });
        const res = await search({ q });
        expect(res.status).toBe(200);
        const { data } = res.body;

        // Every result is about restaurants in Coimbatore.
        expect(data.results).toHaveLength(4);
        expect(allMention(data.results, 'coimbatore', 'restaurant')).toBe(true);
        expect(data.results.every(r => r.source === 'parallel')).toBe(true);
        // The provider's order is kept.
        expect(data.results.map(r => r.sourceRank)).toEqual([1, 2, 3, 4]);

        // No page that merely shares "best" and "restaurants" with the query.
        for (const title of JUNK) expect(titlesOf(res)).not.toContain(title);
        // No other town the provider guessed at.
        expect(titlesOf(res).join(' ')).not.toMatch(/Comporta|Caboolture/);

        expect(data.external).toMatchObject({
          provider: 'parallel',
          status: 'ok',
          count: 4,
          indexQuality: 'weak',
          indexCovering: 0,
          placement: 'ranked'
        });
        // The counts describe what is shown, not the pages that were set aside.
        expect(data.total).toBe(4);
        expect(data.pagination).toMatchObject({
          totalResults: 0,
          totalPages: 1,
          hasNextPage: false
        });
      }
    );

    it('the misspelling is sent as typed: the query is not rewritten', async () => {
      parallelSearch.mockResolvedValue({ results: COIMBATORE });
      await search({ q: 'Best restaurants in combatore' });
      expect(parallelSearch.mock.calls[0][0]).toMatchObject({
        objective: 'Best restaurants in combatore',
        searchQueries: ['Best restaurants in combatore']
      });
    });

    it('"Tirunelveli halwa recipe" shows halwa recipes, not pages with one of the words', async () => {
      parallelSearch.mockResolvedValue({ results: HALWA });
      const res = await search({ q: 'Tirunelveli halwa recipe' });
      const { data } = res.body;

      expect(data.results).toHaveLength(3);
      expect(allMention(data.results, 'halwa', 'tirunelveli')).toBe(true);
      // Not the provider's general recipe page, nor the index's pages that
      // mention only "Tirunelveli" or only "recipe".
      expect(titlesOf(res)).not.toContain('Recipe ideas for dinner tonight');
      expect(titlesOf(res)).not.toContain('India');
      expect(titlesOf(res)).not.toContain('World Recipes');
    });
  });

  // ------------------------------------------------------------------
  describe('a subject the index does hold', () => {
    it('"Python tutorial" is answered by the index: Python tutorials, provider not asked', async () => {
      const res = await search({ q: 'Python tutorial' });
      const { data } = res.body;

      expect(parallelSearch).not.toHaveBeenCalled();
      expect(data.results.length).toBeGreaterThanOrEqual(3);
      expect(data.results.every(r => r.source === 'index')).toBe(true);
      expect(allMention(data.results, 'python', 'tutorial')).toBe(true);
      expect(data.results[0].title).toMatch(/Python Tutorial/);
      expect(data.external).toMatchObject({
        status: 'skipped',
        reason: 'enough_index_results',
        indexQuality: 'strong'
      });
    });

    it('"latest AI news" is answered by the index: AI news pages first', async () => {
      const res = await search({ q: 'latest AI news' });
      const { data } = res.body;

      expect(parallelSearch).not.toHaveBeenCalled();
      expect(data.results.slice(0, 3).every(r => /AI News/.test(r.title))).toBe(true);
      expect(data.external).toMatchObject({ indexQuality: 'strong' });
    });

    it('a strong index answer is returned exactly as the engine ranks it', async () => {
      const res = await search({ q: 'Python tutorial' });
      const direct = await openSearch.search({ query: 'Python tutorial', page: 1, limit: 10 });
      expect(res.body.data.results.map(r => [r.id, r.score])).toEqual(
        direct.results.map(r => [r.id, r.score])
      );
      expect(res.body.data.total).toBe(direct.totalResults);
    });
  });

  // ------------------------------------------------------------------
  describe('a weak index answer and a relevant provider answer', () => {
    it('the provider leads; the index adds only its pages on the subject', async () => {
      parallelSearch.mockResolvedValue({ results: CHENNAI });
      const res = await search({ q: 'best restaurants in chennai', limit: 20 });
      const { data } = res.body;

      // No title says "restaurants", so the index is weak — but it does
      // have pages about eating out in Chennai, and those are kept.
      expect(data.external).toMatchObject({
        provider: 'parallel',
        status: 'ok',
        count: 2,
        indexQuality: 'weak',
        indexCovering: 0,
        placement: 'ranked'
      });
      expect(data.results.slice(0, 2).every(r => r.source === 'parallel')).toBe(true);
      const fromIndex = data.results.filter(r => r.source === 'index');
      expect(fromIndex).toHaveLength(12);
      expect(allMention(data.results, 'chennai', 'restaurant')).toBe(true);
      for (const title of JUNK) expect(titlesOf(res)).not.toContain(title);
      expect(data.total).toBe(14);
    });

    it('pages of the kept index results do not overlap, and the total holds', async () => {
      const first = await search({ q: 'best restaurants in chennai', page: 1, limit: 5 });
      const second = await search({ q: 'best restaurants in chennai', page: 2, limit: 5 });
      const third = await search({ q: 'best restaurants in chennai', page: 3, limit: 5 });
      const idsOf = res => res.body.data.results.filter(r => r.source === 'index').map(r => r.id);

      const all = [...idsOf(first), ...idsOf(second), ...idsOf(third)];
      expect(all).toHaveLength(12);
      expect(new Set(all).size).toBe(12);
      for (const res of [first, second, third]) {
        expect(res.body.data.pagination).toMatchObject({ totalResults: 12, totalPages: 3 });
      }
      // The provider is asked on the first page only.
      expect(second.body.data.external).toMatchObject({
        status: 'skipped',
        reason: 'not_first_page'
      });
      expect(allMention(second.body.data.results, 'chennai')).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  describe('when nothing relevant is available', () => {
    it('both the index and the provider are off the subject: an empty page, said plainly', async () => {
      parallelSearch.mockResolvedValue({ results: OFF_TOPIC });
      // The index has pages with "best" and "restaurants" (the travel guides)
      // and one that mentions Madurai — none about restaurants in Madurai.
      const loose = await openSearch.search({ query: 'best restaurants in madurai' });
      expect(loose.totalResults).toBeGreaterThan(0);

      const res = await search({ q: 'best restaurants in madurai' });
      const { data } = res.body;

      expect(res.status).toBe(200);
      // Not the provider's pages about "best", and not the index's.
      expect(data.results).toEqual([]);
      expect(data.total).toBe(0);
      expect(data.pagination).toMatchObject({ totalResults: 0, totalPages: 0, hasNextPage: false });
      expect(data.external).toEqual({
        provider: 'parallel',
        status: 'unavailable',
        count: 0,
        reason: 'irrelevant_results',
        indexQuality: 'weak',
        indexCovering: 0
      });
    });

    it('a Parallel failure is reported, and neither SerpApi nor Bing is asked instead', async () => {
      parallelSearch.mockRejectedValue(new ExternalSearchError('timeout', 'no answer in time'));
      const res = await search({ q: 'Best restaurants in combatore' });
      const { data } = res.body;

      expect(res.status).toBe(200);
      expect(parallelSearch).toHaveBeenCalledTimes(1);
      expect(searchGoogle).not.toHaveBeenCalled();
      expect(searchBing).not.toHaveBeenCalled();
      expect(data.external).toEqual({
        provider: 'parallel',
        status: 'unavailable',
        count: 0,
        reason: 'timeout',
        indexQuality: 'weak',
        indexCovering: 0
      });
      // The travel guides are still not offered as an answer.
      expect(data.results).toEqual([]);
      expect(data.results.some(r => r.source === 'serpapi' || r.source === 'bing')).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  describe('what this does not change', () => {
    it('with the relevance gate off, the index answers as it always did', async () => {
      config.externalSearch.relevanceGate = false;
      config.serpapi.minInternalResults = 1;
      const res = await search({ q: 'Best restaurants in combatore' });
      expect(parallelSearch).not.toHaveBeenCalled();
      expect(titlesOf(res)).toEqual(expect.arrayContaining(['Albania – Travel guide']));
    });

    it('AI answers retrieve from the index exactly as before', async () => {
      const direct = await openSearch.search({
        query: 'Best restaurants in combatore',
        page: 1,
        limit: config.ai.retrievalCount
      });
      const retrieval = await retrievalService.retrieve({ query: 'Best restaurants in combatore' });
      expect(parallelSearch).not.toHaveBeenCalled();
      expect(retrieval.totalResults).toBe(direct.totalResults);
      expect(retrieval.retrieved).toBe(direct.results.length);
    });

    it('the News tab asks no provider (its own relevance: newsRelevance.test.js)', async () => {
      const res = await search({ q: 'Best restaurants in combatore', category: 'news' });
      expect(res.status).toBe(200);
      expect(parallelSearch).not.toHaveBeenCalled();
    });

    it('the engine itself narrows only when asked to', async () => {
      const loose = await openSearch.search({ query: 'Best restaurants in combatore' });
      const strict = await openSearch.search({
        query: 'Best restaurants in combatore',
        topicalWhenWeak: true
      });
      expect(loose.totalResults).toBeGreaterThan(0);
      expect(loose.quality).toEqual({ fullMatches: 0, aboutMatches: 0 });
      expect(strict.totalResults).toBe(0);
      expect(strict.quality).toEqual({
        fullMatches: 0,
        aboutMatches: 0,
        looseMatches: loose.totalResults,
        topicalOnly: true
      });
    });
  });
});
