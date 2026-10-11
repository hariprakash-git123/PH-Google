const request = require('supertest');
const testDb = require('../helpers/testDb');
const { startSerpApiStandIn, trending } = require('../helpers/serpApiStandIn');
const { config } = require('../../config/env');
const externalSearch = require('../../services/externalSearch');
const trendingService = require('../../services/trendingService');

/**
 * GET /api/trending with SerpApi in front of a local stand-in: real trends
 * when it answers, the last good ones when it does not, an empty list when
 * there never were any — and never an error for a provider problem.
 */

const KEY = 'trending-test-key-NOT-REAL-0123456789abcdef';
const originalSerp = { ...config.serpapi };
const originalTrending = { ...config.trending };
let app;
let standIn;

beforeAll(async () => {
  await testDb.connect();
  standIn = await startSerpApiStandIn();
  app = require('../../app').createApp();
});
afterAll(async () => {
  Object.assign(config.serpapi, originalSerp);
  Object.assign(config.trending, originalTrending);
  await standIn.close();
  await testDb.disconnect();
});
beforeEach(() => {
  standIn.reset();
  externalSearch.reset();
  trendingService.reset();
  jest.useRealTimers();
  Object.assign(config.serpapi, originalSerp, {
    enabled: true,
    apiKey: KEY,
    engine: 'google',
    baseUrl: standIn.baseUrl,
    dailyLimit: 0,
    cacheTtlMs: 0
  });
  Object.assign(config.trending, originalTrending, {
    region: 'IN',
    cacheTtlMs: 10 * 60 * 1000,
    timeoutMs: 1000,
    maxItems: 8
  });
});

const get = (query = {}) => request(app).get('/api/trending').query(query);
const calls = () =>
  standIn.state.requests.filter(r => r.query.engine === 'google_trends_trending_now');
/** Makes whatever is cached look `ms` old without waiting. */
const age = ms => {
  const now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now + ms);
};
afterEach(() => jest.restoreAllMocks());

describe('GET /api/trending — success', () => {
  it('returns current trends for India by default', async () => {
    const before = Date.now();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const { data } = res.body;
    expect(data.region).toBe('IN');
    expect(data.source).toBe('serpapi');
    expect(data.stale).toBe(false);
    expect(data.trends).toEqual([
      { title: 'trend 1', query: 'trend 1' },
      { title: 'trend 2', query: 'trend 2' },
      { title: 'trend 3', query: 'trend 3' },
      { title: 'trend 4', query: 'trend 4' },
      { title: 'trend 5', query: 'trend 5' }
    ]);
    // A real timestamp: when the trends were fetched, not invented.
    expect(Date.parse(data.updatedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(data.updatedAt)).toBeLessThanOrEqual(Date.now() + 1000);
    // The right engine and country were asked, with the key and no query text.
    expect(calls()).toHaveLength(1);
    expect(calls()[0].query).toMatchObject({ geo: 'IN', api_key: KEY });
    expect(calls()[0].query).not.toHaveProperty('q');
  });

  it.each([
    ['US', 'US'],
    ['us', 'US'],
    ['GB', 'GB'],
    ['UK', 'GB'],
    ['AU', 'AU']
  ])('region=%s asks for %s', async (region, geo) => {
    const res = await get({ region });
    expect(res.body.data.region).toBe(geo);
    expect(calls()[0].query.geo).toBe(geo);
  });

  it('rejects an unsupported region without calling the provider', async () => {
    for (const region of ['ZZ', 'india', '<script>', 'IN,US']) {
      const res = await get({ region });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    }
    expect(calls()).toHaveLength(0);
  });

  it('cleans, de-duplicates and caps what the provider sends', async () => {
    config.trending.maxItems = 3;
    standIn.state.trending = [
      { query: '  india   vs australia ' },
      { query: 'India vs Australia' },
      { query: '' },
      { nothing: true },
      null,
      { query: 'x'.repeat(200) },
      { query: 'gold rate today' },
      { query: 'one too many' }
    ];
    const { trends } = (await get()).body.data;
    expect(trends.map(t => t.title)).toEqual([
      'india vs australia',
      `${'x'.repeat(80)}…`,
      'gold rate today'
    ]);
  });

  it('never includes the key or provider detail in the response', async () => {
    const res = await get();
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(Object.keys(res.body.data).sort()).toEqual([
      'region',
      'source',
      'stale',
      'trends',
      'updatedAt'
    ]);
  });
});

describe('GET /api/trending — cache', () => {
  it('serves repeat requests from the cache, with the same timestamp', async () => {
    const first = (await get()).body.data;
    const second = (await get()).body.data;
    const third = (await get()).body.data;
    expect(calls()).toHaveLength(1);
    expect(second).toEqual(first);
    expect(third.updatedAt).toBe(first.updatedAt);
  });

  it('asks again once the cache is older than its lifetime', async () => {
    const first = (await get()).body.data;
    age(9 * 60 * 1000);
    await get();
    expect(calls()).toHaveLength(1);
    jest.restoreAllMocks();
    age(11 * 60 * 1000);
    standIn.state.trending = trending(2);
    const refreshed = (await get()).body.data;
    expect(calls()).toHaveLength(2);
    expect(refreshed.trends).toHaveLength(2);
    expect(Date.parse(refreshed.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
  });

  it('caches each country separately', async () => {
    await get({ region: 'IN' });
    await get({ region: 'US' });
    await get({ region: 'IN' });
    await get({ region: 'US' });
    expect(calls().map(c => c.query.geo)).toEqual(['IN', 'US']);
  });

  it('makes one provider request for simultaneous visitors', async () => {
    Object.assign(standIn.state, { mode: 'slow', delayMs: 200 });
    const all = await Promise.all([get(), get(), get(), get()]);
    expect(calls()).toHaveLength(1);
    for (const res of all) expect(res.body.data.trends).toHaveLength(5);
  });
});

describe('GET /api/trending — when the provider cannot answer', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));

  it.each([
    ['invalid key', { mode: 'status', status: 401 }, 'auth'],
    ['rate limited', { mode: 'status', status: 429 }, 'rate_limited'],
    ['server error', { mode: 'status', status: 500 }, 'unavailable'],
    ['malformed reply', { mode: 'malformed' }, 'invalid_response'],
    ['timeout', { mode: 'slow', delayMs: 3000 }, 'timeout']
  ])('%s with nothing cached: 200 with an empty list and the reason', async (_l, setup, reason) => {
    Object.assign(standIn.state, setup, { body: { error: `Invalid API key ${KEY}` } });
    config.trending.timeoutMs = 400;
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      region: 'IN',
      updatedAt: null,
      trends: [],
      source: 'none',
      stale: false,
      reason
    });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it('keeps serving the last good trends, marked stale, with their real timestamp', async () => {
    const good = (await get()).body.data;
    age(11 * 60 * 1000);
    Object.assign(standIn.state, { mode: 'status', status: 500 });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ...good, stale: true, reason: 'unavailable' });
  });

  it('an empty provider reply does not replace good trends', async () => {
    const good = (await get()).body.data;
    age(11 * 60 * 1000);
    standIn.state.trending = [];
    const res = await get();
    expect(res.body.data).toEqual({ ...good, stale: true, reason: 'empty' });
  });

  it('an empty provider reply with nothing cached is an empty list', async () => {
    standIn.state.trending = [];
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ trends: [], updatedAt: null, reason: 'empty' });
  });

  it.each([
    ['SerpApi switched off', { enabled: false }, 'disabled'],
    ['no key', { apiKey: '' }, 'not_configured']
  ])('%s: no request, an empty list', async (_l, settings, reason) => {
    Object.assign(config.serpapi, settings);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ trends: [], updatedAt: null, source: 'none', reason });
    expect(calls()).toHaveLength(0);
  });

  it('the daily limit stops refreshes but not the card', async () => {
    config.serpapi.dailyLimit = 1;
    const good = (await get()).body.data;
    age(11 * 60 * 1000);
    const res = await get();
    expect(calls()).toHaveLength(1);
    expect(res.body.data).toEqual({ ...good, stale: true, reason: 'daily_limit' });
  });
});
