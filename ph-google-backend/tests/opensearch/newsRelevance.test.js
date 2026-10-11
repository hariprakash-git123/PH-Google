/**
 * Topical relevance of the News tab, end to end: the real route and the real
 * engine over a small fixture index of articles.
 *
 * What this protects. "best restaurants in coimbatore" on News used to show
 * an article about AI companies — twice. News skipped the measurement the
 * results page makes ("is any page about this query?"), so the forgiving
 * recall rule applied unchecked and one passing mention of "restaurants" was
 * a match; and the article was indexed at its own address and as a
 * web.archive.org copy, which differ by the archive's banner and so were not
 * recognised as the same text. Every test checks what the articles are
 * ABOUT, never just how many there are.
 *
 * Skipped (not passed) when no cluster is reachable. Uses its own index.
 */

const previousEngine = process.env.SEARCH_ENGINE;
const previousIndex = process.env.OPENSEARCH_INDEX;
const INDEX_NAME = 'ph-google-pages-news-relevance-test';
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
const parallelClient = require('../../services/external/parallelClient');
const serpApiClient = require('../../services/external/serpApiClient');
const bingSearchClient = require('../../services/external/bingSearchClient');

const available = process.env.OPENSEARCH_AVAILABLE === 'true';
const describeLive = available ? describe : describe.skip;

let day = 0;
const doc = (id, url, title, content, extra = {}) => ({
  _id: id,
  url,
  domain: new URL(url).hostname,
  title,
  description: extra.description || `${title}.`,
  content,
  language: 'en',
  lastCrawledAt: new Date(Date.now() - 3600 * 1000),
  ...extra
});
/** An article, each a day older than the one before, so "newest" is this order. */
const article = (id, url, title, content, extra = {}) =>
  doc(id, url, title, content, {
    isArticle: true,
    publishedAt: new Date(Date.UTC(2026, 8, 28 - day++)),
    ...extra
  });

const BIG_AI_TEXT =
  'Four of the best funded companies now sit behind most of the artificial intelligence industry. If they have their way, perhaps one day an assistant will make your travel plans and suggest convenient restaurants. Regulators are watching the cloud contracts closely.';

const PAGES = [
  // --- Section fronts: generic words ("latest", "top", "best") and little else
  article(
    'front-latest',
    'https://techfeed.example/latest',
    'Latest News | TechFeed',
    'The latest technology stories. Top stories today, the best reads of the week, and our pick of the best hotels for conference season.'
  ),
  article(
    'front-venture',
    'https://techfeed.example/venture',
    'Venture Capital News | TechFeed',
    'Funding rounds, top investors and the best new funds. OpenAI raised new funding this quarter, according to people familiar with the round.'
  ),
  article(
    'front-startups',
    'https://techfeed.example/startups',
    'Startups | TechFeed',
    'The best new startups, the top founders working from the beaches of Bali, and the latest funding news from the startup world.'
  ),
  article(
    'front-apple',
    'https://techfeed.example/apple',
    'Apple news and analysis | TechFeed',
    'Coverage of Apple. The phones announced for 2026 are expected in the autumn, and analysts rank them among the best the company has made.'
  ),

  // --- One article with a passing mention of restaurants, crawled twice:
  //     at its own address and as an archived copy with the archive's banner.
  article(
    'big-ai',
    'https://www.magazine.example/technology/archive/2023/10/big-ai/675752',
    'Big AI Is Coming for Big Tech - The Magazine',
    BIG_AI_TEXT,
    { description: 'Four companies are taking over everything.' }
  ),
  article(
    'big-ai-archived',
    'https://web.archive.org/web/20240105020744/https://www.magazine.example/technology/archive/2023/10/big-ai/675752',
    'Big AI Is Coming for Big Tech - The Magazine',
    `The Wayback Machine - captured 5 January 2024. ${BIG_AI_TEXT}`,
    { description: 'Four companies are taking over everything.' }
  ),
  // --- An archived copy whose original was never crawled: the only way to it.
  article(
    'chips-archived',
    'https://web.archive.org/web/20241110223415/https://www.wire.example/technology/chip-export-rules',
    'New chip export rules take effect - The Wire',
    'The Wayback Machine - captured 10 November 2024. New chip export rules took effect on Monday, covering advanced semiconductors.'
  ),

  // --- Subjects News does hold
  article(
    'ai-news-1',
    'https://techfeed.example/ai-news-today',
    'Latest AI News Today',
    'The latest AI news: new language models, chips and research results from this week.'
  ),
  article(
    'ai-news-2',
    'https://techfeed.example/ai-news-weekly',
    'The Latest AI News Weekly',
    'A weekly digest of the latest AI news from the labs and the companies building products.'
  ),
  article(
    'copilot-1',
    'https://codeblog.example/copilot-agents',
    'GitHub Copilot gets agent mode',
    'GitHub Copilot can now plan and carry out multi-step changes in a repository.'
  ),
  article(
    'copilot-2',
    'https://codeblog.example/podcast-42',
    'The Developer Podcast, episode 42',
    'This week we talk about how teams use GitHub Copilot in code review, and what changes next.'
  ),
  article(
    'openai-round',
    'https://techfeed.example/weekly-deals',
    'This week in deals',
    'The biggest deal of the week: OpenAI closed a funding round led by existing investors.'
  ),

  // --- Not articles: the web index knows these subjects, News does not.
  doc(
    'web-coimbatore',
    'https://food.example.in/coimbatore',
    'Best restaurants in Coimbatore',
    'A guide to the best restaurants in Coimbatore, from Annapoorna to the bakeries of RS Puram.'
  ),
  doc(
    'web-goa',
    'https://travel.example.in/goa-beaches',
    'Top beaches in Goa',
    'The top beaches in Goa: Palolem, Agonda and Morjim, with the best months to visit.'
  )
];

const SECTION_FRONTS = [
  'Latest News | TechFeed',
  'Venture Capital News | TechFeed',
  'Startups | TechFeed',
  'Apple news and analysis | TechFeed'
];

describeLive('topical relevance of the News tab', () => {
  let app;
  let parallelSearch;
  let searchEngine;
  let searchGoogle;
  let searchBing;
  const original = {
    serpapi: { ...config.serpapi },
    externalSearch: { ...config.externalSearch }
  };

  const news = (q, extra = {}) =>
    request(app)
      .get('/api/search')
      .query({ q, category: 'news', ...extra });
  const titlesOf = res => res.body.data.results.map(r => r.title);
  const textOf = r => `${r.title} ${r.snippet}`.toLowerCase();

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
    Object.assign(config.serpapi, original.serpapi);
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
    Object.assign(config.externalSearch, original.externalSearch, { relevanceGate: true });
    // The arrangement in use: SerpApi switched off.
    Object.assign(config.serpapi, original.serpapi, { enabled: false });
    parallelSearch = jest.spyOn(parallelClient, 'search').mockResolvedValue({ results: [] });
    searchEngine = jest.spyOn(serpApiClient, 'searchEngine').mockResolvedValue({ results: [] });
    searchGoogle = jest.spyOn(serpApiClient, 'searchGoogle').mockResolvedValue({ results: [] });
    searchBing = jest.spyOn(bingSearchClient, 'searchWeb').mockResolvedValue({ results: [] });
  });
  afterEach(() => {
    // News is the index's alone: no provider is ever asked for it.
    const asked = [parallelSearch, searchEngine, searchGoogle, searchBing].some(
      spy => spy.mock.calls.length > 0
    );
    jest.restoreAllMocks();
    if (asked) throw new Error('A provider was asked during a News search');
  });

  // ------------------------------------------------------------------
  describe('no article is on the subject', () => {
    it.each(['best restaurants in coimbatore', 'top beaches in goa', 'best hotels in madurai'])(
      '"%s" shows no news, rather than articles sharing a generic word',
      async q => {
        const res = await news(q);
        expect(res.status).toBe(200);
        const { data } = res.body;
        expect(data.results).toEqual([]);
        expect(data.total).toBe(0);
        expect(data.pagination).toMatchObject({ totalResults: 0, totalPages: 0 });
      }
    );

    it('those queries did match articles on a generic or passing word before', async () => {
      Object.assign(config.externalSearch, { relevanceGate: false });
      const restaurants = await news('best restaurants in coimbatore');
      expect(titlesOf(restaurants)).toContain('Big AI Is Coming for Big Tech - The Magazine');
      const beaches = await news('top beaches in goa');
      expect(titlesOf(beaches).some(title => SECTION_FRONTS.includes(title))).toBe(true);
      const hotels = await news('best hotels in madurai');
      expect(titlesOf(hotels).some(title => SECTION_FRONTS.includes(title))).toBe(true);
    });

    it('a web page about the subject does not make News look covered', async () => {
      // The All tab's index has the page; News measures articles only.
      const web = await openSearch.search({ query: 'best restaurants in coimbatore' });
      expect(web.results.map(r => r.title)).toContain('Best restaurants in Coimbatore');
      expect(web.quality.aboutMatches).toBeGreaterThan(0);
      const res = await news('best restaurants in coimbatore');
      expect(res.body.data.results).toEqual([]);
    });
  });

  describe('articles that mention the subject without being titled for it', () => {
    it('"best phones 2026" keeps the article about the 2026 phones, not every "best" list', async () => {
      const res = await news('best phones 2026');
      expect(titlesOf(res)).toEqual(['Apple news and analysis | TechFeed']);
      expect(res.body.data.total).toBe(1);
      expect(textOf(res.body.data.results[0])).toMatch(/phones/);
    });

    it('"openai funding" keeps the articles that report it, not every funding page', async () => {
      const res = await news('openai funding');
      expect(titlesOf(res).sort()).toEqual([
        'This week in deals',
        'Venture Capital News | TechFeed'
      ]);
      expect(titlesOf(res)).not.toContain('Startups | TechFeed');
      expect(res.body.data.total).toBe(2);
    });
  });

  describe('subjects News does hold are returned exactly as before', () => {
    it.each(['latest AI news', 'github copilot'])('"%s"', async q => {
      const gated = await news(q);
      Object.assign(config.externalSearch, { relevanceGate: false });
      const ungated = await news(q);
      expect(gated.body.data.results.length).toBeGreaterThan(0);
      expect(titlesOf(gated)).toEqual(titlesOf(ungated));
      expect(gated.body.data.total).toBe(ungated.body.data.total);
      expect(gated.body.data.pagination).toEqual(ungated.body.data.pagination);
    });

    it('"latest AI news" leads with the AI news articles when sorted by relevance', async () => {
      const outcome = await openSearch.search({
        query: 'latest AI news',
        isArticle: true,
        topicalWhenWeak: true
      });
      expect(outcome.quality.aboutMatches).toBeGreaterThan(0);
      expect(outcome.quality.topicalOnly).toBeUndefined();
      expect(
        outcome.results
          .slice(0, 2)
          .map(r => r.title)
          .sort()
      ).toEqual(['Latest AI News Today', 'The Latest AI News Weekly']);
    });

    it('"github copilot" includes the article that only discusses it', async () => {
      const res = await news('github copilot');
      expect(titlesOf(res)).toEqual(
        expect.arrayContaining([
          'GitHub Copilot gets agent mode',
          'The Developer Podcast, episode 42'
        ])
      );
    });

    it('News ranks by relevance, labelled so; Newest first is chronological when chosen', async () => {
      const ranked = await news('latest AI news');
      expect(ranked.body.data.appliedSort).toBe('relevance');
      expect(ranked.body.data.results.length).toBeGreaterThan(1);

      const newest = await news('latest AI news', { sort: 'newest' });
      expect(newest.body.data.appliedSort).toBe('newest');
      const dates = newest.body.data.results.map(r => r.publishedAt);
      expect(dates).toEqual([...dates].sort().reverse());
      // The same articles either way: the order changes, not what matches.
      const ids = res => res.body.data.results.map(r => r.url).sort();
      expect(ids(newest)).toEqual(ids(ranked));
    });
  });

  describe('archived copies', () => {
    const ORIGINAL = 'https://www.magazine.example/technology/archive/2023/10/big-ai/675752';

    it('an article and its web.archive.org copy are shown once, at the original address', async () => {
      const res = await news('artificial intelligence industry');
      const copies = res.body.data.results.filter(r => /Big AI Is Coming/.test(r.title));
      expect(copies.map(r => r.url)).toEqual([ORIGINAL]);
      // The total counts what is shown.
      expect(res.body.data.total).toBe(res.body.data.results.length);
    });

    it('the same holds on the All tab, and for the engine called directly', async () => {
      const outcome = await openSearch.search({ query: 'artificial intelligence industry' });
      const urls = outcome.results.map(r => r.url);
      expect(urls).toContain(ORIGINAL);
      expect(urls.some(url => url.startsWith('https://web.archive.org/'))).toBe(false);
      expect(outcome.totalResults).toBe(outcome.results.length);
    });

    it('the total and the pages agree when the copy would have fallen on a page boundary', async () => {
      const first = await news('artificial intelligence industry', { limit: 1 });
      expect(first.body.data.total).toBe(1);
      expect(first.body.data.pagination).toMatchObject({ totalPages: 1, hasNextPage: false });
    });

    it('an archived copy whose original is not indexed is kept: it is the only copy', async () => {
      const res = await news('chip export rules');
      expect(titlesOf(res)).toEqual(['New chip export rules take effect - The Wire']);
      expect(res.body.data.results[0].url).toMatch(/^https:\/\/web\.archive\.org\/web\//);
    });

    it('an archived copy is kept when its original does not match the search', async () => {
      // Only the archived copy carries the archive's banner text.
      const res = await news('wayback machine captured');
      expect(res.body.data.results.map(r => r.url)).toEqual(
        expect.arrayContaining([
          'https://web.archive.org/web/20240105020744/https://www.magazine.example/technology/archive/2023/10/big-ai/675752'
        ])
      );
    });
  });

  describe('what this does not change', () => {
    it('with the relevance gate off, News answers as it always did', async () => {
      Object.assign(config.externalSearch, { relevanceGate: false });
      const res = await news('top beaches in goa');
      expect(res.body.data.results.length).toBeGreaterThan(0);
    });

    it('the engine narrows an article search only when asked to', async () => {
      const loose = await openSearch.search({ query: 'top beaches in goa', isArticle: true });
      const strict = await openSearch.search({
        query: 'top beaches in goa',
        isArticle: true,
        topicalWhenWeak: true
      });
      expect(loose.totalResults).toBeGreaterThan(0);
      expect(loose.quality).toEqual({ fullMatches: 0, aboutMatches: 0 });
      expect(strict.totalResults).toBe(0);
      expect(strict.quality).toMatchObject({ aboutMatches: 0, topicalOnly: true });
    });

    it('the date filter and the site filter still apply to News', async () => {
      const site = await news('latest AI news', { domain: 'codeblog.example' });
      expect(site.body.data.results.every(r => r.domain === 'codeblog.example')).toBe(true);
      const sorted = await news('latest AI news', { sort: 'oldest' });
      const dates = sorted.body.data.results.map(r => r.publishedAt);
      expect(dates).toEqual([...dates].sort());
    });
  });
});
