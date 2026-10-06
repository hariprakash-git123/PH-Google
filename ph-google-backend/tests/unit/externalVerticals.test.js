const { config } = require('../../config/env');
const externalSearch = require('../../services/externalSearch');
const externalVerticals = require('../../services/externalVerticals');
const serpApiClient = require('../../services/external/serpApiClient');
const { ExternalSearchError } = require('../../services/external/externalSearchError');
const { images, videos, places, organic } = require('../helpers/serpApiStandIn');

/**
 * The verticals service with SerpApi mocked: when the crawler's data is used
 * instead, how pages are cut from one response, how failures become an empty
 * list with a status, and — above all for the quota — that each vertical has
 * its own cache entries and shares the limits with web search.
 */

const KEY = 'verticals-unit-key-NOT-REAL-0123456789';
const original = { ...config.serpapi };
const crawlerOutcome = { results: [{ id: 'crawler-1' }], totalResults: 1, searchTerms: ['x'] };
const runInternal = jest.fn(async () => crawlerOutcome);
const params = (overrides = {}) => ({ query: 'python', page: 1, limit: 2, ...overrides });

let searchEngine;
let searchGoogle;

beforeEach(() => {
  externalSearch.reset();
  runInternal.mockClear();
  Object.assign(config.serpapi, original, {
    enabled: true,
    apiKey: KEY,
    engine: 'google',
    dailyLimit: 0,
    cacheTtlMs: 60000,
    maxConcurrent: 2
  });
  searchEngine = jest
    .spyOn(serpApiClient, 'searchEngine')
    .mockImplementation(async ({ engine }) => ({
      results:
        engine === 'google_images' ? images(5) : engine === 'google_videos' ? videos(3) : places(4)
    }));
  searchGoogle = jest
    .spyOn(serpApiClient, 'searchGoogle')
    .mockResolvedValue({ results: organic(2) });
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => Object.assign(config.serpapi, original));

describe('externalVerticals — SerpApi off', () => {
  it.each([
    ['disabled', { enabled: false }, 'disabled'],
    ['no key', { apiKey: '' }, 'not_configured']
  ])(
    '%s: the crawler vertical answers, untouched, and SerpApi is not called',
    async (_l, s, reason) => {
      Object.assign(config.serpapi, s);
      const out = await externalVerticals.search('images', params(), runInternal);
      expect(runInternal).toHaveBeenCalledTimes(1);
      expect(searchEngine).not.toHaveBeenCalled();
      expect(out).toEqual({
        ...crawlerOutcome,
        external: { provider: 'serpapi', status: 'disabled', count: 0, reason }
      });
    }
  );
});

describe('externalVerticals — SerpApi on', () => {
  it.each([
    ['images', 'google_images'],
    ['videos', 'google_videos'],
    ['maps', 'google_maps']
  ])('%s calls %s once and never the crawler vertical', async (vertical, engine) => {
    const out = await externalVerticals.search(vertical, params(), runInternal);
    expect(searchEngine).toHaveBeenCalledTimes(1);
    expect(searchEngine.mock.calls[0][0].engine).toBe(engine);
    // These tabs use their own, longer timeout — not the web search one.
    expect(searchEngine.mock.calls[0][1]).toEqual({
      settings: { timeoutMs: config.serpapi.verticalTimeoutMs }
    });
    expect(config.serpapi.verticalTimeoutMs).toBeGreaterThan(config.serpapi.timeoutMs);
    expect(runInternal).not.toHaveBeenCalled();
    expect(out.external).toEqual({ provider: 'serpapi', status: 'ok', count: 2, cached: false });
    expect(out.results.every(r => r.source === 'serpapi')).toBe(true);
  });

  it('cuts pages from one response: page 2 costs no request, the total is what came back', async () => {
    const first = await externalVerticals.search('images', params(), runInternal);
    const second = await externalVerticals.search('images', params({ page: 2 }), runInternal);
    const third = await externalVerticals.search('images', params({ page: 3 }), runInternal);
    const beyond = await externalVerticals.search('images', params({ page: 4 }), runInternal);
    expect(searchEngine).toHaveBeenCalledTimes(1);
    expect([first, second, third, beyond].map(o => o.results.map(r => r.title))).toEqual([
      ['Image 1', 'Image 2'],
      ['Image 3', 'Image 4'],
      ['Image 5'],
      []
    ]);
    expect(first.totalResults).toBe(5);
    expect(beyond.totalResults).toBe(5);
  });

  it('skips an empty query without a request', async () => {
    const out = await externalVerticals.search('videos', params({ query: '-java' }), runInternal);
    expect(searchEngine).not.toHaveBeenCalled();
    expect(out).toMatchObject({
      results: [],
      totalResults: 0,
      external: { status: 'skipped', reason: 'empty_query' }
    });
  });

  it.each(['auth', 'rate_limited', 'timeout', 'network', 'invalid_response', 'unavailable'])(
    'a %s failure is an empty list with a status, not an error',
    async code => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      searchEngine.mockRejectedValue(new ExternalSearchError(code, 'failed'));
      const out = await externalVerticals.search('maps', params(), runInternal);
      expect(out).toMatchObject({
        results: [],
        totalResults: 0,
        external: { provider: 'serpapi', status: 'unavailable', count: 0, reason: code }
      });
      expect(runInternal).not.toHaveBeenCalled();
      expect(JSON.stringify(out)).not.toContain(KEY);
    }
  );
});

describe('cache key separation', () => {
  it('the same query on web, images, videos and maps is four requests, each cached on its own', async () => {
    const webParams = { query: 'python', page: 1, limit: 10 };
    await externalSearch.searchWithExternal(webParams, async () => ({
      results: [],
      totalResults: 0
    }));
    for (const vertical of ['images', 'videos', 'maps']) {
      await externalVerticals.search(vertical, params(), runInternal);
    }
    expect(searchGoogle).toHaveBeenCalledTimes(1);
    expect(searchEngine.mock.calls.map(c => c[0].engine)).toEqual([
      'google_images',
      'google_videos',
      'google_maps'
    ]);

    // Again: every one from its own cache entry.
    const web = await externalSearch.searchWithExternal(webParams, async () => ({
      results: [],
      totalResults: 0
    }));
    const again = {};
    for (const vertical of ['images', 'videos', 'maps']) {
      again[vertical] = await externalVerticals.search(vertical, params(), runInternal);
    }
    expect(searchGoogle).toHaveBeenCalledTimes(1);
    expect(searchEngine).toHaveBeenCalledTimes(3);
    expect(web.external.cached).toBe(true);
    expect(again.images.results[0].thumbnailUrl).toBeTruthy(); // images, not web results
    expect(again.videos.results[0].videoUrl).toBeTruthy();
    expect(again.maps.results[0].mapsUrl).toBeTruthy();
    for (const v of Object.values(again)) expect(v.external.cached).toBe(true);
  });

  it('verticals share the daily limit and the pause with web search', async () => {
    config.serpapi.dailyLimit = 1;
    await externalVerticals.search('images', params(), runInternal);
    const out = await externalVerticals.search('videos', params(), runInternal);
    expect(out.external).toMatchObject({ status: 'skipped', reason: 'daily_limit' });

    externalSearch.reset();
    config.serpapi.dailyLimit = 0;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    searchEngine.mockRejectedValueOnce(
      new ExternalSearchError('auth', 'rejected', { status: 401 })
    );
    await externalVerticals.search('images', params({ query: 'a' }), runInternal);
    const web = await externalSearch.searchWithExternal(
      { query: 'b', page: 1, limit: 10 },
      async () => ({ results: [], totalResults: 0 })
    );
    expect(searchGoogle).not.toHaveBeenCalled();
    expect(web.external).toMatchObject({ status: 'unavailable', reason: 'auth' });
  });
});
