const request = require('supertest');
const testDb = require('../helpers/testDb');
const { seedPage, seedManyPages } = require('../helpers/factories');
const { startParallelStandIn, results } = require('../helpers/parallelStandIn');
const { startSerpApiStandIn } = require('../helpers/serpApiStandIn');
const { config } = require('../../config/env');
const externalSearch = require('../../services/externalSearch');
const retrievalService = require('../../services/ai/retrievalService');
const logger = require('../../utils/logger');

/**
 * GET /api/search with Parallel chosen as the provider of external web
 * results and fallback off — the exclusive configuration — in front of local
 * stand-ins for Parallel and SerpApi. The index's results, totals and pages
 * stay the index's; Parallel results are appended on page 1; a Parallel
 * failure is reported in `external` and SerpApi is never asked instead; the
 * key never leaves the server; the Images tab and AI answers are untouched.
 * Nothing here reaches api.parallel.ai or SerpApi.
 */

const PARALLEL_KEY = 'parallel-integration-key-NOT-REAL-abcdef0123456789';
const SERP_KEY = 'serpapi-integration-key-NOT-REAL-0123456789abcd';
const original = {
  parallel: { ...config.parallel },
  serpapi: { ...config.serpapi },
  externalSearch: { ...config.externalSearch }
};
let app;
let parallel;
let serp;

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
  Object.assign(config.serpapi, original.serpapi, {
    enabled: true,
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
  await seedPage({
    url: 'https://docs.example.com/python-guide',
    title: 'Python Guide',
    description: 'A guide to python.',
    text: 'python guide tutorial'
  });
});
afterEach(() => jest.restoreAllMocks());

const search = params => request(app).get('/api/search').query(params);
const sources = res => res.body.data.results.map(r => r.source);

describe('EXTERNAL_SEARCH_PROVIDER=parallel', () => {
  it('appends Parallel results after the index results, in the existing schema', async () => {
    const res = await search({ q: 'python' });
    expect(res.status).toBe(200);
    const { data } = res.body;

    expect(parallel.state.requests).toHaveLength(1);
    expect(serp.state.requests).toHaveLength(0);
    expect(sources(res)).toEqual(['index', 'index', 'parallel', 'parallel', 'parallel']);
    expect(data.results[2]).toMatchObject({
      url: 'https://parallel.example/page-1',
      title: 'Parallel result 1',
      snippet: 'Excerpt for parallel result 1 with a link.',
      category: 'Web',
      score: null
    });
    // total counts what is shown; pagination stays the index's own.
    expect(data.total).toBe(5);
    expect(data.pagination).toMatchObject({ totalResults: 2, totalPages: 1, hasNextPage: false });
    expect(data.external).toEqual({
      provider: 'parallel',
      status: 'ok',
      count: 3,
      cached: false,
      placement: 'ranked'
    });
  });

  it('calls POST /v1/search with the key in the x-api-key header and the documented body', async () => {
    await search({ q: 'how does gravity work', domain: 'nasa.gov' });
    const [sent] = parallel.state.requests;
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe('/v1/search');
    expect(sent.headers['x-api-key']).toBe(PARALLEL_KEY);
    expect(sent.body).toEqual({
      objective: 'how does gravity work',
      search_queries: ['gravity'],
      mode: 'fast',
      // The most Parallel gives to one request: the first page shows 10 of
      // them, "Load more" the rest of the same answer.
      advanced_settings: { max_results: 20, source_policy: { include_domains: ['nasa.gov'] } }
    });
  });

  it('gives every result the fields an index result has', async () => {
    const { data } = (await search({ q: 'python' })).body;
    const [fromIndex] = data.results;
    const fromParallel = data.results.find(r => r.source === 'parallel');
    for (const field of ['id', 'url', 'displayUrl', 'domain', 'title', 'snippet', 'category']) {
      expect(typeof fromIndex[field]).toBe('string');
      expect(typeof fromParallel[field]).toBe('string');
    }
  });

  it('keeps both keys out of the response', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const ok = await search({ q: 'python' });
    Object.assign(parallel.state, { mode: 'status', status: 401 });
    const rejected = await search({ q: 'python again' });
    for (const res of [ok, rejected]) {
      const text = JSON.stringify(res.body) + JSON.stringify(res.headers);
      expect(text).not.toContain(PARALLEL_KEY);
      expect(text).not.toContain(SERP_KEY);
    }
  });

  it('drops a Parallel copy of a page the index already shows', async () => {
    parallel.state.results = [
      { url: 'https://www.python.org/about/', title: 'Python', excerpts: ['About.'] },
      ...results(1, { start: 2 })
    ];
    const { data } = (await search({ q: 'python' })).body;
    expect(data.results.filter(r => r.url.includes('python.org/about'))).toHaveLength(1);
    expect(data.results.find(r => r.url.includes('python.org/about')).source).toBe('index');
    expect(data.external.count).toBe(1);
  });

  it('a site filter holds after the merge: an off-site Parallel answer is not shown', async () => {
    // Parallel was asked for docs.example.com only; a stray answer from
    // elsewhere must not reach the page.
    parallel.state.results = [
      ...results(1, { host: 'docs.example.com', start: 10 }),
      ...results(1, { host: 'parallel.example', start: 20 }),
      ...results(1, { host: 'api.docs.example.com', start: 30 })
    ];
    const { data } = (await search({ q: 'python', domain: 'docs.example.com' })).body;
    expect(parallel.state.requests[0].body.advanced_settings.source_policy).toEqual({
      include_domains: ['docs.example.com']
    });
    expect(data.results.length).toBeGreaterThan(1);
    expect(data.results.some(r => r.source === 'parallel')).toBe(true);
    for (const result of data.results) {
      expect(result.domain === 'docs.example.com' || result.domain.endsWith('.docs.example.com')).toBe(
        true
      );
    }
  });

  it('an excluded site stays excluded after the merge', async () => {
    parallel.state.results = [
      ...results(1, { host: 'python.org', start: 10 }),
      ...results(1, { host: 'parallel.example', start: 20 })
    ];
    const { data } = (await search({ q: 'python -site:python.org' })).body;
    expect(parallel.state.requests[0].body.advanced_settings.source_policy).toEqual({
      exclude_domains: ['python.org']
    });
    // Parallel's own python.org answer is dropped. (This suite runs the
    // legacy MongoDB engine, which has no operators: its python.org page is
    // not the merge's to remove. -site: on the index: tests/opensearch.)
    const external = data.results.filter(r => r.source === 'parallel');
    expect(external.map(r => r.domain)).toEqual(['parallel.example']);
  });

  it('page 2 asks no provider and is exactly the index page', async () => {
    await seedManyPages(25, { keyword: 'pagination' });
    const res = await search({ q: 'pagination', page: 2 });
    expect(parallel.state.requests).toHaveLength(0);
    expect(serp.state.requests).toHaveLength(0);
    expect(res.body.data.results).toHaveLength(10);
    expect(res.body.data.results.every(r => r.source === 'index')).toBe(true);
    expect(res.body.data.pagination).toMatchObject({ page: 2, totalResults: 25, totalPages: 3 });
    expect(res.body.data.external).toMatchObject({ status: 'skipped', reason: 'not_first_page' });
  });

  it('serves a repeat from the cache', async () => {
    config.parallel.cacheTtlMs = 60000;
    await search({ q: 'python' });
    const again = await search({ q: 'python' });
    expect(parallel.state.requests).toHaveLength(1);
    expect(again.body.data.external).toMatchObject({ status: 'ok', cached: true });
  });

  it('respects the existing rule: no external call when the index found enough', async () => {
    config.serpapi.minInternalResults = 2;
    const res = await search({ q: 'python' });
    expect(parallel.state.requests).toHaveLength(0);
    expect(res.body.data.external).toMatchObject({
      provider: 'parallel',
      status: 'skipped',
      reason: 'enough_index_results'
    });
  });

  it('shows at most PARALLEL_MAX_RESULTS on the first page, and asks for the most one request gives', async () => {
    config.parallel.maxResults = 2;
    parallel.state.results = results(8);
    const { data } = (await search({ q: 'python' })).body;
    expect(parallel.state.requests[0].body.advanced_settings.max_results).toBe(20);
    expect(data.results.filter(r => r.source === 'parallel')).toHaveLength(2);
    // The rest of the same answer is there for "Load more".
    expect(data.hasMore).toBe(true);
  });
});

describe('queries Parallel cannot honour are answered by the index alone', () => {
  it.each([
    [{ q: 'python -snake' }, 'unsupported_operator'],
    [{ q: 'intitle:python' }, 'unsupported_operator'],
    [{ q: 'python', language: 'fr' }, 'unsupported_filter'],
    [{ q: 'python', date: 'hour' }, 'unsupported_filter'],
    [{ q: 'python', sort: 'newest' }, 'date_sort']
  ])('%j', async (params, reason) => {
    const res = await search(params);
    expect(res.status).toBe(200);
    expect(parallel.state.requests).toHaveLength(0);
    expect(serp.state.requests).toHaveLength(0);
    expect(res.body.data.results.every(r => r.source === 'index')).toBe(true);
    expect(res.body.data.external).toEqual({
      provider: 'parallel',
      status: 'skipped',
      count: 0,
      reason
    });
  });
});

describe('a Parallel failure is reported, and SerpApi is not asked instead', () => {
  const failing = [
    ['a rejected key', { mode: 'status', status: 401 }, 'auth'],
    ['a rate limit', { mode: 'status', status: 429 }, 'rate_limited'],
    ['a validation error', { mode: 'status', status: 422 }, 'bad_request'],
    ['an outage', { mode: 'status', status: 503 }, 'unavailable'],
    ['a reply that is not JSON', { mode: 'malformed' }, 'invalid_response'],
    ['no answer in time', { mode: 'slow', delayMs: 1500 }, 'timeout']
  ];

  it.each(failing)('%s', async (_label, state, reason) => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    Object.assign(parallel.state, state);
    if (state.mode === 'slow') config.parallel.timeoutMs = 500;

    const res = await search({ q: 'python' });
    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(sources(res)).toEqual(['index', 'index']);
    expect(data.total).toBe(2);
    // Reported through the response's own `external` field, not hidden.
    expect(data.external).toEqual({
      provider: 'parallel',
      status: 'unavailable',
      count: 0,
      reason
    });
    // SerpApi is enabled in this test and is still never asked: no fallback.
    expect(parallel.state.requests).toHaveLength(1);
    expect(serp.state.requests).toHaveLength(0);
  });

  it('without a key, no request is made and the status says why', async () => {
    config.parallel.apiKey = '';
    const res = await search({ q: 'python' });
    expect(parallel.state.requests).toHaveLength(0);
    expect(serp.state.requests).toHaveLength(0);
    expect(res.body.data.external).toEqual({
      provider: 'parallel',
      status: 'disabled',
      count: 0,
      reason: 'not_configured'
    });
  });

  it('logs a Parallel failure without the key', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    Object.assign(parallel.state, { mode: 'status', status: 401 });
    await search({ q: 'python' });
    expect(warn).toHaveBeenCalledWith(
      'Parallel request failed',
      expect.objectContaining({ provider: 'parallel', reason: 'auth', status: 401 })
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PARALLEL_KEY);
  });
});

describe('what choosing Parallel does not touch', () => {
  it('the Images tab still comes from SerpApi', async () => {
    const res = await search({ q: 'python', category: 'images' });
    expect(res.status).toBe(200);
    expect(parallel.state.requests).toHaveLength(0);
    expect(serp.state.requests).toHaveLength(1);
    expect(serp.state.requests[0].query.engine).toBe('google_images');
    expect(res.body.data.external).toMatchObject({ provider: 'serpapi', status: 'ok' });
  });

  it('AI retrieval never calls a provider and returns index documents only', async () => {
    const retrieval = await retrievalService.retrieve({ query: 'python' });
    expect(parallel.state.requests).toHaveLength(0);
    expect(serp.state.requests).toHaveLength(0);
    expect(retrieval.documents.length).toBeGreaterThan(0);
    expect(retrieval.documents.every(d => !String(d.id).startsWith('parallel:'))).toBe(true);
  });
});

describe('switching provider through the environment', () => {
  it('SEARCH_PROVIDER=serpapi asks SerpApi and never Parallel', async () => {
    config.externalSearch.provider = 'serpapi';
    const res = await search({ q: 'python' });
    expect(parallel.state.requests).toHaveLength(0);
    expect(serp.state.requests).toHaveLength(1);
    expect(res.body.data.external).toMatchObject({ provider: 'serpapi', status: 'ok' });
    expect(sources(res).filter(s => s === 'parallel')).toHaveLength(0);
  });

  it('with fallback on, a Parallel failure is covered by SerpApi and says so', async () => {
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    config.externalSearch.fallback = true;
    Object.assign(parallel.state, { mode: 'status', status: 503 });
    const res = await search({ q: 'python' });
    expect(parallel.state.requests).toHaveLength(1);
    expect(serp.state.requests).toHaveLength(1);
    expect(res.body.data.external).toMatchObject({
      provider: 'serpapi',
      status: 'ok',
      fallbackFrom: 'parallel',
      fallbackReason: 'unavailable'
    });
  });
});
