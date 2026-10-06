const { config } = require('../../config/env');
const externalSearch = require('../../services/externalSearch');
const serpApiClient = require('../../services/external/serpApiClient');
const { ExternalSearchError } = require('../../services/external/externalSearchError');
const { organic } = require('../helpers/serpApiStandIn');
const logger = require('../../utils/logger');

/**
 * How external results are added to a web search: when SerpApi is asked,
 * how its results are merged with the index's, and how every failure leaves
 * the index's results untouched. SerpApi itself is mocked.
 */

const KEY = 'unit-test-serpapi-key-NOT-REAL-0123456789';
const original = { ...config.serpapi };

const indexResult = (url, score) => ({
  id: `id-${url}`,
  url,
  title: url,
  snippet: 's',
  score,
  category: 'Web Result'
});

const internalOutcome = (urls = ['https://python.org/about', 'https://docs.python.org/3']) => ({
  query: 'python',
  results: urls.map((url, i) => indexResult(url, 10 - i)),
  totalResults: urls.length,
  reachableResults: urls.length,
  duplicatesRemoved: 0,
  responseTimeMs: 5,
  engine: 'opensearch'
});

const params = (overrides = {}) => ({ query: 'python', page: 1, limit: 10, ...overrides });
const run = (p = params(), internal = internalOutcome(), options = {}) =>
  externalSearch.searchWithExternal(p, async () => internal, options);

let searchGoogle;

beforeEach(() => {
  externalSearch.reset();
  Object.assign(config.serpapi, original, {
    enabled: true,
    apiKey: KEY,
    engine: 'google',
    maxResults: 10,
    dailyLimit: 8,
    minInternalResults: 0,
    cacheTtlMs: 60000,
    maxConcurrent: 2
  });
  searchGoogle = jest
    .spyOn(serpApiClient, 'searchGoogle')
    .mockResolvedValue({ results: organic(3) });
});
afterEach(() => {
  jest.restoreAllMocks();
});
afterAll(() => {
  Object.assign(config.serpapi, original);
});

describe('externalSearch — when SerpApi is not used', () => {
  it('disabled: no call, index results unchanged in order, labelled index', async () => {
    config.serpapi.enabled = false;
    const internal = internalOutcome();
    const out = await run(params(), internal);
    expect(searchGoogle).not.toHaveBeenCalled();
    expect(out.external).toEqual({
      provider: 'serpapi',
      status: 'disabled',
      count: 0,
      reason: 'disabled'
    });
    expect(out.results.map(r => r.url)).toEqual(internal.results.map(r => r.url));
    expect(out.results.map(r => [r.source, r.sourceRank])).toEqual([
      ['index', 1],
      ['index', 2]
    ]);
    // Everything else is the index's outcome as it was.
    expect({ ...out, results: undefined, external: undefined }).toEqual({
      ...internal,
      results: undefined,
      external: undefined
    });
    // The index's own fields are untouched.
    expect(out.results[0]).toMatchObject(internal.results[0]);
  });

  it('enabled without a key: no call', async () => {
    config.serpapi.apiKey = '';
    const out = await run();
    expect(searchGoogle).not.toHaveBeenCalled();
    expect(out.external).toMatchObject({ status: 'disabled', reason: 'not_configured' });
  });

  it('page 2: no call, and ranks continue from page 1', async () => {
    const out = await run(params({ page: 2 }));
    expect(searchGoogle).not.toHaveBeenCalled();
    expect(out.external).toMatchObject({ status: 'skipped', reason: 'not_first_page' });
    expect(out.results.map(r => r.sourceRank)).toEqual([11, 12]);
  });

  it.each([
    ['date sort', { sort: 'newest' }, 'date_sort'],
    ['-lang:', { query: 'python -lang:de' }, 'unsupported_operator']
  ])('%s: no call', async (_label, overrides, reason) => {
    const out = await run(params(overrides));
    expect(searchGoogle).not.toHaveBeenCalled();
    expect(out.external).toMatchObject({ status: 'skipped', reason });
  });
});

describe('externalSearch — merging', () => {
  it('appends Google results after every index result, in Google order', async () => {
    const out = await run();
    expect(searchGoogle).toHaveBeenCalledWith({ q: 'python', params: {} });
    expect(out.results.map(r => r.source)).toEqual([
      'index',
      'index',
      'serpapi',
      'serpapi',
      'serpapi'
    ]);
    expect(out.results.slice(2).map(r => r.sourceRank)).toEqual([1, 2, 3]);
    expect(out.external).toEqual({ provider: 'serpapi', status: 'ok', count: 3, cached: false });
  });

  it('never changes the index totals (pagination stays the index’s)', async () => {
    const internal = internalOutcome();
    const out = await run(params(), internal);
    expect(out.totalResults).toBe(internal.totalResults);
    expect(out.reachableResults).toBe(internal.reachableResults);
  });

  it('drops a Google result for a page already on the page — the index copy wins', async () => {
    searchGoogle.mockResolvedValue({
      results: [
        { position: 1, title: 'dup', link: 'https://www.python.org/about/?utm_source=g' },
        { position: 2, title: 'new', link: 'https://new.example/x' }
      ]
    });
    const out = await run();
    expect(out.results.map(r => [r.source, r.url])).toEqual([
      ['index', 'https://python.org/about'],
      ['index', 'https://docs.python.org/3'],
      ['serpapi', 'https://new.example/x']
    ]);
    expect(out.results[0].title).toBe('https://python.org/about'); // the index's own record
    expect(out.external.count).toBe(1);
  });

  it('drops a Google result for a page the index holds further down', async () => {
    const indexedKeys = jest.fn(async keys => new Set(keys.filter(k => k.includes('page-2'))));
    const out = await run(params(), internalOutcome(), { indexedKeys });
    expect(indexedKeys).toHaveBeenCalledWith([
      'external.example/page-1',
      'external.example/page-2',
      'external.example/page-3'
    ]);
    expect(out.results.filter(r => r.source === 'serpapi').map(r => r.url)).toEqual([
      'https://external.example/page-1',
      'https://external.example/page-3'
    ]);
  });

  it('keeps the external results if the index check fails', async () => {
    const indexedKeys = jest.fn().mockRejectedValue(new Error('index down'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const out = await run(params(), internalOutcome(), { indexedKeys });
    expect(out.external.count).toBe(3);
  });

  it('shows at most SERPAPI_MAX_RESULTS', async () => {
    config.serpapi.maxResults = 2;
    searchGoogle.mockResolvedValue({ results: organic(8) });
    expect((await run()).external.count).toBe(2);
  });

  it('works when the index found nothing', async () => {
    const out = await run(params(), internalOutcome([]));
    expect(out.results.map(r => r.source)).toEqual(['serpapi', 'serpapi', 'serpapi']);
    expect(out.totalResults).toBe(0);
  });

  it('passes an index failure through unchanged (no silent switch to Google)', async () => {
    const boom = Object.assign(new Error('Search is temporarily unavailable.'), {
      statusCode: 503
    });
    await expect(
      externalSearch.searchWithExternal(params(), async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
  });
});

describe('externalSearch — failures leave the index results', () => {
  it.each(['auth', 'rate_limited', 'timeout', 'network', 'invalid_response', 'unavailable'])(
    '%s',
    async code => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
      searchGoogle.mockRejectedValue(new ExternalSearchError(code, 'failed'));
      const internal = internalOutcome();
      const out = await run(params(), internal);
      expect(out.results.map(r => r.url)).toEqual(internal.results.map(r => r.url));
      expect(out.external).toEqual({
        provider: 'serpapi',
        status: 'unavailable',
        count: 0,
        reason: code
      });
    }
  );

  it('an unexpected error is reported as unavailable', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    searchGoogle.mockRejectedValue(new TypeError('boom'));
    expect((await run()).external).toMatchObject({ status: 'unavailable', reason: 'unavailable' });
  });

  it('a rejected key pauses SerpApi instead of retrying on every search', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    searchGoogle.mockRejectedValue(new ExternalSearchError('auth', 'rejected', { status: 401 }));
    await run();
    const second = await run(params({ query: 'another query' }));
    expect(searchGoogle).toHaveBeenCalledTimes(1);
    expect(second.external).toMatchObject({ status: 'unavailable', reason: 'auth' });
  });

  it('three failures in a row pause SerpApi', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    searchGoogle.mockRejectedValue(new ExternalSearchError('timeout', 'slow'));
    for (const q of ['a1', 'a2', 'a3', 'a4', 'a5']) await run(params({ query: q }));
    expect(searchGoogle).toHaveBeenCalledTimes(3);
  });

  it('logs the failure without the key', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    searchGoogle.mockRejectedValue(
      new ExternalSearchError('auth', 'SerpApi rejected the API key.', { status: 401 })
    );
    const out = await run();
    expect(warn).toHaveBeenCalledWith('SerpApi request failed; showing index results only', {
      reason: 'auth',
      status: 401,
      pausedForMs: expect.any(Number)
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
    expect(JSON.stringify(out)).not.toContain(KEY);
  });
});

describe('externalSearch — usage control', () => {
  it('serves a repeat from the cache', async () => {
    await run();
    const again = await run();
    expect(searchGoogle).toHaveBeenCalledTimes(1);
    expect(again.external).toMatchObject({ status: 'ok', count: 3, cached: true });
  });

  it('shares one request between identical searches in flight', async () => {
    let release;
    searchGoogle.mockReturnValue(
      new Promise(resolve => {
        release = () => resolve({ results: organic(2) });
      })
    );
    const both = Promise.all([run(), run()]);
    await new Promise(r => {
      setImmediate(r);
    });
    release();
    const [a, b] = await both;
    expect(searchGoogle).toHaveBeenCalledTimes(1);
    expect(a.external.count).toBe(2);
    expect(b.external.count).toBe(2);
  });

  it('stops at the daily limit', async () => {
    config.serpapi.dailyLimit = 2;
    for (const q of ['q1', 'q2', 'q3']) await run(params({ query: q }));
    expect(searchGoogle).toHaveBeenCalledTimes(2);
    expect((await run(params({ query: 'q4' }))).external).toMatchObject({
      status: 'skipped',
      reason: 'daily_limit'
    });
  });

  it('a failure hands its daily slot back', async () => {
    config.serpapi.dailyLimit = 1;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    searchGoogle.mockRejectedValueOnce(new ExternalSearchError('unavailable', 'outage'));
    await run(params({ query: 'f1' }));
    expect(externalSearch.describe().usedToday).toBe(0);
    searchGoogle.mockResolvedValue({ results: organic(1) });
    expect((await run(params({ query: 's1' }))).external.status).toBe('ok');
    expect(externalSearch.describe().usedToday).toBe(1);
  });

  it('skips SerpApi rather than queueing when too many requests are in flight', async () => {
    config.serpapi.maxConcurrent = 1;
    let release;
    searchGoogle.mockReturnValueOnce(
      new Promise(resolve => {
        release = () => resolve({ results: organic(1) });
      })
    );
    const first = run(params({ query: 'first' }));
    await new Promise(r => {
      setImmediate(r);
    });
    const second = await run(params({ query: 'second' }));
    expect(second.external).toMatchObject({ status: 'skipped', reason: 'busy' });
    release();
    expect((await first).external.status).toBe('ok');
  });

  it('with a threshold, asks only when the index found too little', async () => {
    config.serpapi.minInternalResults = 2;
    const enough = await run(params(), internalOutcome());
    expect(searchGoogle).not.toHaveBeenCalled();
    expect(enough.external).toMatchObject({ status: 'skipped', reason: 'enough_index_results' });

    const thin = await run(params({ query: 'rare' }), internalOutcome(['https://a.example/x']));
    expect(searchGoogle).toHaveBeenCalledTimes(1);
    expect(thin.external.status).toBe('ok');
  });

  it('describe() reports whether a key exists, never the key', () => {
    const description = externalSearch.describe();
    expect(description).toMatchObject({ provider: 'serpapi', enabled: true, configured: true });
    expect(JSON.stringify(description)).not.toContain(KEY);
  });
});
