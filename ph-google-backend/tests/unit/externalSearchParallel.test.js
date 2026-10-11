const { config } = require('../../config/env');
const externalSearch = require('../../services/externalSearch');
const serpApiClient = require('../../services/external/serpApiClient');
const bingSearchClient = require('../../services/external/bingSearchClient');
const parallelClient = require('../../services/external/parallelClient');
const { ExternalSearchError } = require('../../services/external/externalSearchError');
const { organic } = require('../helpers/serpApiStandIn');
const { results: parallelResults } = require('../helpers/parallelStandIn');
const logger = require('../../utils/logger');

/**
 * Web search with Parallel as the external provider: it is asked instead of
 * SerpApi and Bing under the same rules — index results untouched, every
 * failure reported and never hidden — exclusively when fallback is off, and
 * as one link of the chain when it is on. All three clients are mocked.
 */

const PARALLEL_KEY = 'unit-test-parallel-key-NOT-REAL-0123456789';
const SERPAPI_KEY = 'unit-test-serpapi-key-NOT-REAL-9876543210';
const BING_KEY = 'unit-test-bing-key-NOT-REAL-5555555555';
const original = {
  parallel: { ...config.parallel },
  serpapi: { ...config.serpapi },
  bing: { ...config.bing },
  externalSearch: { ...config.externalSearch }
};

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
const sourcesOf = out => out.results.map(r => r.source);

let parallelSearch;
let searchGoogle;
let searchBing;

beforeEach(() => {
  externalSearch.reset();
  Object.assign(config.externalSearch, original.externalSearch, {
    provider: 'parallel',
    fallback: false,
    validateResults: false
  });
  Object.assign(config.parallel, original.parallel, {
    enabled: true,
    apiKey: PARALLEL_KEY,
    mode: 'fast',
    maxResults: 10,
    dailyLimit: 100,
    cacheTtlMs: 60000,
    maxConcurrent: 2
  });
  Object.assign(config.serpapi, original.serpapi, {
    enabled: true,
    apiKey: SERPAPI_KEY,
    engine: 'google',
    dailyLimit: 8,
    minInternalResults: 0,
    cacheTtlMs: 60000,
    maxConcurrent: 2
  });
  Object.assign(config.bing, original.bing, {
    apiKey: BING_KEY,
    dailyLimit: 50,
    cacheTtlMs: 60000
  });
  parallelSearch = jest
    .spyOn(parallelClient, 'search')
    .mockResolvedValue({ results: parallelResults(3) });
  searchGoogle = jest
    .spyOn(serpApiClient, 'searchGoogle')
    .mockResolvedValue({ results: organic(3) });
  searchBing = jest.spyOn(bingSearchClient, 'searchWeb').mockResolvedValue({ results: [] });
});
afterEach(() => {
  jest.restoreAllMocks();
});
afterAll(() => {
  Object.assign(config.parallel, original.parallel);
  Object.assign(config.serpapi, original.serpapi);
  Object.assign(config.bing, original.bing);
  Object.assign(config.externalSearch, original.externalSearch);
});

describe('Parallel as the chosen provider', () => {
  it('asks Parallel, and neither SerpApi nor Bing', async () => {
    const out = await run();
    expect(parallelSearch).toHaveBeenCalledTimes(1);
    expect(searchGoogle).not.toHaveBeenCalled();
    expect(searchBing).not.toHaveBeenCalled();
    expect(out.external).toEqual({
      provider: 'parallel',
      status: 'ok',
      count: 3,
      cached: false,
      placement: 'ranked'
    });
  });

  it('sends the translated request: objective, keyword query, source policy', async () => {
    await run(params({ query: 'how does gravity work site:nasa.gov' }));
    expect(parallelSearch).toHaveBeenCalledWith({
      objective: 'how does gravity work',
      searchQueries: ['gravity'],
      sourcePolicy: { include_domains: ['nasa.gov'] },
      maxResults: 20
    });
  });

  it('is first in the order, alone when fallback is off', () => {
    expect(externalSearch.webProviderOrder()).toEqual(['parallel']);
    config.externalSearch.fallback = true;
    expect(externalSearch.webProviderOrder()[0]).toBe('parallel');
    expect(externalSearch.webProviderOrder().sort()).toEqual(['bing', 'parallel', 'serpapi']);
  });

  it.each([
    ['PARALLEL_ENABLED is not true', { enabled: false }, 'disabled'],
    ['there is no key', { apiKey: '' }, 'not_configured'],
    ['the mode is not one the API has', { mode: 'warp' }, 'unsupported_mode']
  ])('makes no request at all when %s', async (_label, overrides, reason) => {
    Object.assign(config.parallel, overrides);
    const internal = internalOutcome();
    const out = await run(params(), internal);
    expect(parallelSearch).not.toHaveBeenCalled();
    expect(searchGoogle).not.toHaveBeenCalled();
    expect(searchBing).not.toHaveBeenCalled();
    expect(out.results.map(r => r.url)).toEqual(internal.results.map(r => r.url));
    expect(out.external).toEqual({ provider: 'parallel', status: 'disabled', count: 0, reason });
  });
});

describe('merging', () => {
  it('appends Parallel results after every index result, in Parallel order', async () => {
    const internal = internalOutcome();
    const out = await run(params(), internal);
    expect(sourcesOf(out)).toEqual(['index', 'index', 'parallel', 'parallel', 'parallel']);
    expect(out.results.slice(0, 2).map(r => [r.url, r.score])).toEqual(
      internal.results.map(r => [r.url, r.score])
    );
    expect(out.results[2]).toMatchObject({
      url: 'https://parallel.example/page-1',
      category: 'Web',
      score: null,
      sourceRank: 1
    });
  });

  it('never changes the index totals (pagination stays the index’s)', async () => {
    const internal = internalOutcome();
    const out = await run(params(), internal);
    expect(out.totalResults).toBe(internal.totalResults);
    expect(out.reachableResults).toBe(internal.reachableResults);
  });

  it('drops a Parallel result for a page the index already shows or holds', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        { url: 'https://www.python.org/about/', title: 'On the page', excerpts: [] },
        { url: 'https://held.example/deeper', title: 'Held further down', excerpts: [] },
        ...parallelResults(1)
      ]
    });
    const indexedKeys = jest.fn(
      async keys => new Set(keys.filter(k => k.includes('held.example')))
    );
    const out = await run(params(), internalOutcome(), { indexedKeys });
    expect(out.results.filter(r => r.source === 'parallel').map(r => r.url)).toEqual([
      'https://parallel.example/page-1'
    ]);
    expect(out.external.count).toBe(1);
  });

  it('shows at most PARALLEL_MAX_RESULTS', async () => {
    config.parallel.maxResults = 2;
    parallelSearch.mockResolvedValue({ results: parallelResults(8) });
    const out = await run();
    expect(out.results.filter(r => r.source === 'parallel')).toHaveLength(2);
    expect(out.external.count).toBe(2);
  });

  it('passes an index failure through unchanged (no silent switch to Parallel)', async () => {
    await expect(
      externalSearch.searchWithExternal(params(), async () => {
        throw new Error('index down');
      })
    ).rejects.toThrow('index down');
  });
});

describe('the relevance gate and the count rule apply to Parallel too', () => {
  const measured = (aboutMatches, total = 40, urls) => {
    const internal = internalOutcome(urls);
    internal.totalResults = total;
    internal.quality = { aboutMatches };
    return internal;
  };

  it('with no indexed page about the query, Parallel is asked and its results are ranked with the index’s', async () => {
    config.serpapi.minInternalResults = 3;
    const out = await run(params(), measured(0));
    expect(parallelSearch).toHaveBeenCalledTimes(1);
    expect([...sourcesOf(out)].sort()).toEqual([
      'index',
      'index',
      'parallel',
      'parallel',
      'parallel'
    ]);
    expect(out.external).toMatchObject({
      provider: 'parallel',
      status: 'ok',
      indexQuality: 'weak',
      placement: 'ranked'
    });
  });

  it('with a strong index answer and enough results covering the query, Parallel is not asked', async () => {
    config.serpapi.minInternalResults = 3;
    const covering = [
      'https://python.org/about',
      'https://docs.python.org/3',
      'https://python.org/downloads'
    ];
    const out = await run(params(), measured(2, 40, covering));
    expect(parallelSearch).not.toHaveBeenCalled();
    expect(sourcesOf(out)).toEqual(['index', 'index', 'index']);
    expect(out.external).toMatchObject({
      provider: 'parallel',
      status: 'skipped',
      reason: 'enough_index_results',
      indexQuality: 'strong'
    });
  });

  it('an answer that does not cover the query is rejected, reported and not cached', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    config.externalSearch.validateResults = true;
    parallelSearch.mockResolvedValue({
      results: [
        { url: 'https://a.example/1', title: 'Cooking pasta', excerpts: ['Boil the water.'] },
        { url: 'https://b.example/2', title: 'Gardening', excerpts: ['Water the roses.'] }
      ]
    });
    const out = await run();
    expect(sourcesOf(out)).toEqual(['index', 'index']);
    expect(out.external).toEqual({
      provider: 'parallel',
      status: 'unavailable',
      count: 0,
      reason: 'irrelevant_results'
    });
    await run();
    expect(parallelSearch).toHaveBeenCalledTimes(2);
  });

  it('an answer that covers the query is accepted', async () => {
    config.externalSearch.validateResults = true;
    parallelSearch.mockResolvedValue({
      results: [{ url: 'https://a.example/1', title: 'Python basics', excerpts: ['Python.'] }]
    });
    expect((await run()).external).toMatchObject({ status: 'ok', count: 1 });
  });
});

describe('queries Parallel cannot honour are not sent', () => {
  it.each([
    ['intitle:python guide', {}, 'unsupported_operator'],
    ['python -snake', {}, 'unsupported_operator'],
    ['python lang:fr', {}, 'unsupported_operator'],
    ['python', { language: 'fr' }, 'unsupported_filter'],
    ['python', { dateWindow: 'hour' }, 'unsupported_filter'],
    ['python', { sort: 'newest' }, 'date_sort'],
    ['python', { page: 2 }, 'not_first_page']
  ])('%s %j', async (query, filters, reason) => {
    const internal = internalOutcome();
    const out = await run(params({ query, ...filters }), internal);
    expect(parallelSearch).not.toHaveBeenCalled();
    expect(searchGoogle).not.toHaveBeenCalled();
    expect(out.results.every(r => r.source === 'index')).toBe(true);
    expect(out.external).toEqual({ provider: 'parallel', status: 'skipped', count: 0, reason });
  });

  it('a phrase search shows only results that show the phrase', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        { url: 'https://a.example/1', title: 'Monty Python', excerpts: [] },
        { url: 'https://b.example/2', title: 'Snakes', excerpts: ['The python is a snake.'] }
      ]
    });
    const out = await run(params({ query: '"monty python"' }));
    expect(out.results.filter(r => r.source === 'parallel').map(r => r.url)).toEqual([
      'https://a.example/1'
    ]);
  });

  it('a date filter is sent as after_date and undated results are left out', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        { url: 'https://a.example/new', publish_date: new Date().toISOString().slice(0, 10) },
        { url: 'https://b.example/undated' }
      ]
    });
    const out = await run(params({ dateWindow: 'week' }));
    expect(parallelSearch.mock.calls[0][0].sourcePolicy.after_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out.results.filter(r => r.source === 'parallel').map(r => r.url)).toEqual([
      'https://a.example/new'
    ]);
  });
});

describe('a Parallel failure is reported, and nobody else is asked', () => {
  it.each([
    'auth',
    'rate_limited',
    'timeout',
    'network',
    'bad_request',
    'invalid_response',
    'unavailable'
  ])('%s', async code => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    parallelSearch.mockRejectedValue(new ExternalSearchError(code, 'failed'));
    const internal = internalOutcome();
    const out = await run(params(), internal);
    expect(out.results.map(r => r.url)).toEqual(internal.results.map(r => r.url));
    // Reported by provider and reason — never hidden.
    expect(out.external).toEqual({
      provider: 'parallel',
      status: 'unavailable',
      count: 0,
      reason: code
    });
    // SerpApi and Bing are configured here and still not asked: no fallback.
    expect(searchGoogle).not.toHaveBeenCalled();
    expect(searchBing).not.toHaveBeenCalled();
  });

  it('a bug is not blamed on Parallel: logged as an error, reported as internal_error', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
    parallelSearch.mockRejectedValue(new TypeError('boom'));
    const out = await run();
    expect(out.external).toMatchObject({ status: 'unavailable', reason: 'internal_error' });
    expect(error).toHaveBeenCalled();
  });

  it('a rejected key pauses Parallel instead of retrying on every search', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    parallelSearch.mockRejectedValue(new ExternalSearchError('auth', 'rejected', { status: 401 }));
    await run();
    const second = await run(params({ query: 'another query' }));
    expect(parallelSearch).toHaveBeenCalledTimes(1);
    expect(second.external).toMatchObject({ status: 'unavailable', reason: 'auth' });
  });

  it('three failures in a row pause Parallel web search', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    parallelSearch.mockRejectedValue(new ExternalSearchError('timeout', 'slow'));
    for (const q of ['a1', 'a2', 'a3', 'a4', 'a5']) await run(params({ query: q }));
    expect(parallelSearch).toHaveBeenCalledTimes(3);
  });

  it('logs the failure by name, without any key', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    parallelSearch.mockRejectedValue(
      new ExternalSearchError('auth', 'Parallel rejected the API key.', { status: 401 })
    );
    const out = await run();
    expect(warn).toHaveBeenCalledWith(
      'Parallel request failed',
      expect.objectContaining({
        provider: 'parallel',
        operation: 'web',
        query: 'python',
        reason: 'auth',
        status: 401
      })
    );
    for (const text of [JSON.stringify(warn.mock.calls), JSON.stringify(out)]) {
      expect(text).not.toContain(PARALLEL_KEY);
      expect(text).not.toContain(SERPAPI_KEY);
      expect(text).not.toContain(BING_KEY);
    }
  });
});

describe('with SEARCH_PROVIDER_FALLBACK on, Parallel is one link of the chain', () => {
  beforeEach(() => {
    config.externalSearch.fallback = true;
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  it('when Parallel cannot answer, the next configured provider is asked', async () => {
    parallelSearch.mockRejectedValue(new ExternalSearchError('timeout', 'slow'));
    const out = await run();
    expect(searchGoogle).toHaveBeenCalledTimes(1);
    expect(out.external).toMatchObject({
      provider: 'serpapi',
      status: 'ok',
      fallbackFrom: 'parallel',
      fallbackReason: 'timeout'
    });
  });

  it('SerpApi first: Parallel is a fallback only while PARALLEL_ENABLED is true', async () => {
    config.externalSearch.provider = 'serpapi';
    config.bing.apiKey = '';
    searchGoogle.mockRejectedValue(new ExternalSearchError('unavailable', 'down'));

    const withParallel = await run();
    expect(withParallel.external).toMatchObject({ provider: 'parallel', fallbackFrom: 'serpapi' });

    externalSearch.reset();
    parallelSearch.mockClear();
    config.parallel.enabled = false;
    const without = await run(params({ query: 'other' }));
    expect(parallelSearch).not.toHaveBeenCalled();
    expect(without.external).toMatchObject({ provider: 'serpapi', status: 'unavailable' });
  });
});

describe('usage control', () => {
  it('serves a repeat from the cache', async () => {
    await run();
    const second = await run();
    expect(parallelSearch).toHaveBeenCalledTimes(1);
    expect(second.external).toMatchObject({ status: 'ok', cached: true });
  });

  it('shares one request between identical searches in flight', async () => {
    let release;
    parallelSearch.mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve({ results: parallelResults(2) });
        })
    );
    const both = Promise.all([run(), run()]);
    await new Promise(resolve => {
      setImmediate(resolve);
    });
    release();
    const [a, b] = await both;
    expect(parallelSearch).toHaveBeenCalledTimes(1);
    expect(a.external.count).toBe(2);
    expect(b.external.count).toBe(2);
  });

  it('stops at PARALLEL_DAILY_LIMIT', async () => {
    config.parallel.dailyLimit = 2;
    await run(params({ query: 'q1' }));
    await run(params({ query: 'q2' }));
    const third = await run(params({ query: 'q3' }));
    expect(parallelSearch).toHaveBeenCalledTimes(2);
    expect(third.external).toMatchObject({ status: 'skipped', reason: 'daily_limit' });
  });

  it('a failed request still counts against the daily limit', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    parallelSearch.mockRejectedValueOnce(new ExternalSearchError('timeout', 'slow'));
    await run(params({ query: 'q1' }));
    expect(externalSearch.describe().parallel.usedToday).toBe(1);
    await run(params({ query: 'q2' }));
    expect(externalSearch.describe().parallel.usedToday).toBe(2);
  });

  it('a failed SerpApi request is still handed back, as before', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    config.externalSearch.provider = 'serpapi';
    searchGoogle.mockRejectedValueOnce(new ExternalSearchError('timeout', 'slow'));
    await run(params({ query: 'q1' }));
    expect(externalSearch.describe().usedToday).toBe(0);
  });

  it('skips Parallel rather than queueing when too many requests are in flight', async () => {
    config.parallel.maxConcurrent = 1;
    let release;
    parallelSearch.mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve({ results: [] });
        })
    );
    const first = run(params({ query: 'q1' }));
    await new Promise(resolve => {
      setImmediate(resolve);
    });
    const second = await run(params({ query: 'q2' }));
    expect(second.external).toMatchObject({ status: 'skipped', reason: 'busy' });
    release();
    await first;
  });

  it('describe() reports Parallel beside the others, never a key', () => {
    const description = externalSearch.describe();
    expect(description).toMatchObject({
      webProvider: 'parallel',
      fallback: false,
      parallel: { enabled: true, configured: true, usedToday: 0, dailyLimit: 100 }
    });
    const text = JSON.stringify(description);
    expect(text).not.toContain(PARALLEL_KEY);
    expect(text).not.toContain(SERPAPI_KEY);
    expect(text).not.toContain(BING_KEY);
  });
});

describe('Parallel and SerpApi do not share limits', () => {
  const imageRequest = { engine: 'google_images', q: 'python', params: {} };

  it('Parallel being paused does not stop the SerpApi tabs', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    parallelSearch.mockRejectedValue(new ExternalSearchError('auth', 'rejected', { status: 401 }));
    await run();
    expect((await run(params({ query: 'again' }))).external.reason).toBe('auth');

    const send = jest.fn().mockResolvedValue({ results: [{ title: 'image' }] });
    const images = await externalSearch.fetchCached('images', imageRequest, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(images).toMatchObject({ status: 'ok', cached: false });
  });

  it('Parallel reaching its daily limit leaves SerpApi its own', async () => {
    config.parallel.dailyLimit = 1;
    await run(params({ query: 'q1' }));
    expect((await run(params({ query: 'q2' }))).external.reason).toBe('daily_limit');

    const send = jest.fn().mockResolvedValue({ results: [] });
    expect((await externalSearch.fetchCached('images', imageRequest, send)).status).toBe('ok');
  });

  it('the tabs ask about SerpApi, whichever provider web search uses', () => {
    config.parallel.enabled = false;
    expect(externalSearch.availability()).toEqual({ ok: true });
    expect(externalSearch.parallelAvailability()).toMatchObject({ ok: false, reason: 'disabled' });
    expect(externalSearch.PROVIDER).toBe('serpapi');
  });
});
