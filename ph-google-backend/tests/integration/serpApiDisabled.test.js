const request = require('supertest');
const testDb = require('../helpers/testDb');
const { seedPage } = require('../helpers/factories');
const { startParallelStandIn } = require('../helpers/parallelStandIn');
const { startSerpApiStandIn } = require('../helpers/serpApiStandIn');
const { config } = require('../../config/env');
const externalSearch = require('../../services/externalSearch');
const trendingService = require('../../services/trendingService');
const logger = require('../../utils/logger');

/**
 * SERPAPI_ENABLED=false with Parallel as the only external provider — the
 * whole application, in front of local stand-ins for both services.
 *
 * SerpApi keeps its key and every other setting, as it would for a rollback,
 * so the only thing between a request and the stand-in is the switch. No
 * feature may reach it: not web search (as the chosen provider or as a
 * fallback), not Images, Videos or Maps, not Trending. Parallel answers web
 * search only; the tabs it has no search for are the crawler's own and are
 * never filled with its web pages.
 */

const PARALLEL_KEY = 'parallel-only-key-NOT-REAL-abcdef0123456789';
const SERP_KEY = 'serpapi-switched-off-key-NOT-REAL-0123456789';
const original = {
  parallel: { ...config.parallel },
  serpapi: { ...config.serpapi },
  externalSearch: { ...config.externalSearch }
};
let app;
let parallel;
let serp;
let debug;

beforeAll(async () => {
  await testDb.connect();
  parallel = await startParallelStandIn();
  serp = await startSerpApiStandIn();
  app = require('../../app').createApp();
});
afterAll(async () => {
  Object.assign(config.parallel, original.parallel);
  Object.assign(config.serpapi, original.serpapi);
  Object.assign(config.externalSearch, original.externalSearch);
  await parallel.close();
  await serp.close();
  await testDb.disconnect();
});
beforeEach(async () => {
  await testDb.clear();
  parallel.reset();
  serp.reset();
  externalSearch.reset();
  trendingService.reset();
  Object.assign(config.externalSearch, original.externalSearch, {
    provider: 'parallel',
    fallback: false
  });
  Object.assign(config.parallel, original.parallel, {
    enabled: true,
    apiKey: PARALLEL_KEY,
    baseUrl: parallel.baseUrl,
    mode: 'fast',
    timeoutMs: 1000,
    maxResults: 10,
    dailyLimit: 0,
    cacheTtlMs: 0
  });
  // Everything SerpApi needs to answer, except the switch.
  Object.assign(config.serpapi, original.serpapi, {
    enabled: false,
    apiKey: SERP_KEY,
    engine: 'google',
    baseUrl: serp.baseUrl,
    timeoutMs: 1000,
    verticalTimeoutMs: 1000,
    dailyLimit: 0,
    minInternalResults: 0,
    cacheTtlMs: 0
  });
  await seedPage({
    url: 'https://python.org/about',
    title: 'About Python',
    description: 'Python is a programming language.',
    text: 'python python programming language'
  });
  debug = jest.spyOn(logger, 'debug').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const search = params => request(app).get('/api/search').query(params);
const served = message => debug.mock.calls.filter(([m]) => m === message).map(([, meta]) => meta);

describe('web search', () => {
  it('is answered by the index and Parallel; SerpApi is not asked', async () => {
    const res = await search({ q: 'python' });
    expect(res.status).toBe(200);
    expect(res.body.data.results.map(r => r.source)).toEqual([
      'index',
      'parallel',
      'parallel',
      'parallel'
    ]);
    expect(res.body.data.external).toMatchObject({ provider: 'parallel', status: 'ok', count: 3 });
    expect(parallel.state.requests).toHaveLength(1);
    expect(serp.state.requests).toHaveLength(0);
  });

  it.each([
    ['an outage', { mode: 'status', status: 503 }, 'unavailable'],
    ['a rejected key', { mode: 'status', status: 401 }, 'auth'],
    ['a rate limit', { mode: 'status', status: 429 }, 'rate_limited'],
    ['a timeout', { mode: 'slow', delayMs: 1500 }, 'timeout']
  ])('%s at Parallel leaves the index results, and SerpApi alone', async (_l, state, reason) => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    Object.assign(parallel.state, state);
    config.parallel.timeoutMs = 500;
    const res = await search({ q: 'python' });
    expect(res.status).toBe(200);
    expect(res.body.data.results.map(r => r.source)).toEqual(['index']);
    expect(res.body.data.external).toMatchObject({
      provider: 'parallel',
      status: 'unavailable',
      reason
    });
    expect(serp.state.requests).toHaveLength(0);
  });

  it('with fallback on, a failing Parallel still does not fall back to SerpApi', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    config.externalSearch.fallback = true;
    Object.assign(parallel.state, { mode: 'status', status: 503 });
    const res = await search({ q: 'python' });
    expect(res.status).toBe(200);
    expect(res.body.data.results.map(r => r.source)).toEqual(['index']);
    expect(serp.state.requests).toHaveLength(0);
  });

  it('an empty answer from Parallel is an empty addition, not an error', async () => {
    parallel.state.results = [];
    const res = await search({ q: 'python' });
    expect(res.status).toBe(200);
    expect(res.body.data.results.map(r => r.source)).toEqual(['index']);
    expect(res.body.data.external).toMatchObject({ provider: 'parallel', status: 'ok', count: 0 });
    expect(serp.state.requests).toHaveLength(0);
  });

  it('with SerpApi still named as the provider, nothing external is asked', async () => {
    Object.assign(config.externalSearch, { provider: 'serpapi', fallback: false });
    const res = await search({ q: 'python' });
    expect(res.body.data.results.map(r => r.source)).toEqual(['index']);
    expect(res.body.data.external).toMatchObject({
      provider: 'serpapi',
      status: 'disabled',
      reason: 'disabled'
    });
    expect(serp.state.requests).toHaveLength(0);
    expect(parallel.state.requests).toHaveLength(0);
  });
});

describe.each(['images', 'videos', 'maps'])('category=%s', category => {
  it('is the crawler index: no SerpApi request, and no Parallel web pages in its place', async () => {
    const res = await search({ q: 'python', category });
    expect(res.status).toBe(200);
    const { data } = res.body;
    // Nothing of this kind was crawled here, so the honest answer is empty.
    expect(data.results).toEqual([]);
    expect(data.total).toBe(0);
    expect(data.external).toMatchObject({
      provider: 'serpapi',
      status: 'disabled',
      reason: 'disabled',
      count: 0
    });
    expect(serp.state.requests).toHaveLength(0);
    expect(parallel.state.requests).toHaveLength(0);
  });

  it('is logged as not supported by the web provider', async () => {
    await search({ q: 'python', category });
    expect(served('Search served')).toEqual([
      expect.objectContaining({
        category,
        servedBy: 'index',
        results: 0,
        unsupportedBy: 'parallel',
        external: expect.objectContaining({ provider: 'serpapi', status: 'disabled' })
      })
    ]);
  });
});

describe('trending', () => {
  it('has no trends and says why; nothing is asked and nothing is invented', async () => {
    const res = await request(app).get('/api/trending').query({ region: 'IN' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      region: 'IN',
      trends: [],
      updatedAt: null,
      source: 'none',
      reason: 'disabled'
    });
    expect(serp.state.requests).toHaveLength(0);
    expect(parallel.state.requests).toHaveLength(0);
    expect(served('Trending served')).toEqual([
      expect.objectContaining({ region: 'IN', servedBy: 'none', trends: 0, reason: 'disabled' })
    ]);
  });
});

describe('the debug log', () => {
  it('names who answered a web search, and holds no key', async () => {
    await search({ q: 'python' });
    expect(served('Search served')).toEqual([
      expect.objectContaining({
        category: 'all',
        query: 'python',
        page: 1,
        servedBy: 'parallel+index',
        results: 4,
        external: expect.objectContaining({ provider: 'parallel', status: 'ok', count: 3 })
      })
    ]);
    const written = JSON.stringify(debug.mock.calls);
    expect(written).not.toContain(PARALLEL_KEY);
    expect(written).not.toContain(SERP_KEY);
  });

  it('says the index answered alone when Parallel could not', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    Object.assign(parallel.state, { mode: 'status', status: 503 });
    await search({ q: 'python' });
    expect(served('Search served')[0]).toMatchObject({
      servedBy: 'index',
      external: { provider: 'parallel', status: 'unavailable', reason: 'unavailable' }
    });
  });
});

describe('after every feature has been used', () => {
  it('SerpApi has received no request at all', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    await search({ q: 'python' });
    await search({ q: 'python', page: 2 });
    for (const category of ['images', 'videos', 'maps', 'news']) {
      await search({ q: 'python', category });
    }
    await request(app).get('/api/trending').query({ region: 'IN' });
    await request(app).get('/api/ai-answer').query({ q: 'what is python' });
    Object.assign(parallel.state, { mode: 'status', status: 500 });
    await search({ q: 'python tutorial' });
    expect(serp.state.requests).toHaveLength(0);
  });
});
