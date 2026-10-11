const request = require('supertest');
const testDb = require('../helpers/testDb');
const { seedPage, seedManyPages } = require('../helpers/factories');
const { startBingStandIn, items } = require('../helpers/bingStandIn');
const { startSerpApiStandIn } = require('../helpers/serpApiStandIn');
const { config } = require('../../config/env');
const externalSearch = require('../../services/externalSearch');
const retrievalService = require('../../services/ai/retrievalService');
const bingSearchClient = require('../../services/external/bingSearchClient');
const logger = require('../../utils/logger');
const Page = require('../../models/Page');

/**
 * GET /api/search with Bing chosen as the provider of external web results,
 * and SerpApi as its fallback — both as local stand-ins. The index's results,
 * totals and pages stay the index's; Bing results are appended on page 1;
 * when Bing cannot answer, SerpApi is asked; when neither can, the index
 * answers alone. Nothing here reaches RapidAPI or SerpApi.
 */

const BING_KEY = 'bing-integration-key-NOT-REAL-abcdef0123456789';
const SERP_KEY = 'serpapi-integration-key-NOT-REAL-0123456789abcd';
const original = {
  serpapi: { ...config.serpapi },
  bing: { ...config.bing },
  externalSearch: { ...config.externalSearch }
};
let app;
let bing;
let serp;

beforeAll(async () => {
  await testDb.connect();
  bing = await startBingStandIn();
  serp = await startSerpApiStandIn();
  app = require('../../app').createApp();
});
afterAll(async () => {
  Object.assign(config.serpapi, original.serpapi);
  Object.assign(config.bing, original.bing);
  Object.assign(config.externalSearch, original.externalSearch);
  await bing.close();
  await serp.close();
  await testDb.disconnect();
});
beforeEach(async () => {
  await testDb.clear();
  bing.reset();
  serp.reset();
  externalSearch.reset();
  Object.assign(config.externalSearch, { provider: 'bing', fallback: true });
  Object.assign(config.bing, original.bing, {
    apiKey: BING_KEY,
    host: 'bing-search-apis.p.rapidapi.com',
    baseUrl: bing.baseUrl,
    timeoutMs: 1000,
    maxResults: 10,
    cc: 'IN',
    dailyLimit: 0,
    cacheTtlMs: 0
  });
  Object.assign(config.serpapi, original.serpapi, {
    enabled: true,
    apiKey: SERP_KEY,
    engine: 'google',
    baseUrl: serp.baseUrl,
    timeoutMs: 1000,
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
});
afterEach(() => jest.restoreAllMocks());

const search = params => request(app).get('/api/search').query(params);
const sources = res => res.body.data.results.map(r => r.source);

describe('SEARCH_PROVIDER=bing', () => {
  it('appends Bing results after the index results, in the existing schema', async () => {
    const res = await search({ q: 'python' });
    expect(res.status).toBe(200);
    expect(bing.state.requests).toHaveLength(1);
    expect(bing.state.requests[0].query).toEqual({
      keyword: 'python',
      page: '0',
      size: '10',
      cc: 'IN'
    });
    expect(serp.state.requests).toHaveLength(0);

    const { data } = res.body;
    expect(sources(res)).toEqual(['index', 'bing', 'bing', 'bing']);
    expect(data.results[1]).toMatchObject({
      url: 'https://bing.example/page-1',
      title: 'Bing result 1',
      snippet: 'Description for Bing result 1.',
      domain: 'bing.example',
      category: 'Bing Web',
      score: null,
      sourceRank: 1
    });
    // Totals and pagination follow the same rules as before.
    expect(data.total).toBe(4);
    expect(data.pagination).toMatchObject({ totalResults: 1, totalPages: 1, hasNextPage: false });
    expect(data.external).toEqual({
      provider: 'bing',
      status: 'ok',
      count: 3,
      cached: false,
      placement: 'ranked'
    });
  });

  it('drops a Bing copy of a page the index already shows', async () => {
    bing.state.items = [
      { title: 'Python', link: 'https://www.python.org/about/?utm_source=bing', description: 'd' },
      ...items(1, { start: 2 })
    ];
    const res = await search({ q: 'python' });
    expect(res.body.data.results.filter(r => r.url.includes('python.org/about'))).toHaveLength(1);
    expect(sources(res)).toEqual(['index', 'bing']);
  });

  it('page 2 asks no provider and is exactly the index page', async () => {
    await seedManyPages(25, { keyword: 'pagination' });
    const res = await search({ q: 'pagination', page: 2 });
    expect(bing.state.requests).toHaveLength(0);
    expect(serp.state.requests).toHaveLength(0);
    expect(res.body.data.results).toHaveLength(10);
    expect(sources(res).every(s => s === 'index')).toBe(true);
    expect(res.body.data.pagination).toMatchObject({ page: 2, totalResults: 25, totalPages: 3 });
    expect(res.body.data.external).toMatchObject({ status: 'skipped', reason: 'not_first_page' });
  });

  it('serves a repeat from the cache', async () => {
    config.bing.cacheTtlMs = 60000;
    await search({ q: 'python' });
    const again = await search({ q: 'python' });
    expect(bing.state.requests).toHaveLength(1);
    expect(again.body.data.external).toMatchObject({
      provider: 'bing',
      status: 'ok',
      cached: true
    });
  });

  it('respects the existing rule: no external call when the index found enough', async () => {
    config.serpapi.minInternalResults = 1;
    const res = await search({ q: 'python' });
    expect(bing.state.requests).toHaveLength(0);
    expect(res.body.data.external).toMatchObject({
      status: 'skipped',
      reason: 'enough_index_results'
    });
  });

  it('never calls Bing for AI answers, and stores nothing', async () => {
    const before = await Page.countDocuments();
    const retrieval = await retrievalService.retrieve({ query: 'python' });
    expect(bing.state.requests).toHaveLength(0);
    expect(retrieval.documents.every(d => !String(d.id).startsWith('bing:'))).toBe(true);
    await search({ q: 'python' });
    expect(await Page.countDocuments()).toBe(before);
  });

  it('keeps both keys out of the response', async () => {
    const res = await search({ q: 'python' });
    expect(JSON.stringify(res.body)).not.toContain(BING_KEY);
    expect(JSON.stringify(res.body)).not.toContain(SERP_KEY);
  });
});

describe('fallback to SerpApi', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));

  it.each([
    ['a timeout', { mode: 'slow', delayMs: 3000 }, 'timeout'],
    ['a server error', { mode: 'status', status: 503 }, 'unavailable'],
    ['a rate limit', { mode: 'status', status: 429 }, 'rate_limited'],
    ['a rejected key', { mode: 'status', status: 403 }, 'auth'],
    ['a malformed reply', { mode: 'malformed' }, 'invalid_response']
  ])('after %s from Bing, SerpApi answers', async (_label, setup, reason) => {
    Object.assign(bing.state, setup);
    config.bing.timeoutMs = 400;
    const res = await search({ q: 'python' });
    expect(res.status).toBe(200);
    expect(bing.state.requests).toHaveLength(1);
    expect(serp.state.requests).toHaveLength(1);
    expect(sources(res)).toEqual(['index', 'serpapi', 'serpapi', 'serpapi']);
    expect(res.body.data.results[1].category).toBe('Google Web');
    expect(res.body.data.external).toEqual({
      provider: 'serpapi',
      status: 'ok',
      count: 3,
      cached: false,
      fallbackFrom: 'bing',
      fallbackReason: reason,
      placement: 'ranked'
    });
  });

  it('when both fail, the index answers alone and Bing’s reason is reported', async () => {
    Object.assign(bing.state, { mode: 'status', status: 500 });
    Object.assign(serp.state, { mode: 'status', status: 500 });
    const res = await search({ q: 'python' });
    expect(res.status).toBe(200);
    expect(sources(res)).toEqual(['index']);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.external).toEqual({
      provider: 'bing',
      status: 'unavailable',
      count: 0,
      reason: 'unavailable'
    });
  });

  it('a failing Bing is paused on its own; SerpApi keeps being asked', async () => {
    Object.assign(bing.state, { mode: 'status', status: 403 });
    await search({ q: 'python' });
    await search({ q: 'python language' });
    // The rejected key paused Bing after one request; SerpApi served both.
    expect(bing.state.requests).toHaveLength(1);
    expect(serp.state.requests).toHaveLength(2);
  });

  it('with SEARCH_PROVIDER_FALLBACK=false, a Bing failure is not covered', async () => {
    config.externalSearch.fallback = false;
    Object.assign(bing.state, { mode: 'status', status: 500 });
    const res = await search({ q: 'python' });
    expect(serp.state.requests).toHaveLength(0);
    expect(sources(res)).toEqual(['index']);
    expect(res.body.data.external).toMatchObject({ provider: 'bing', status: 'unavailable' });
  });

  it('with SerpApi switched off, a Bing failure still leaves the index results', async () => {
    config.serpapi.enabled = false;
    Object.assign(bing.state, { mode: 'status', status: 500 });
    const res = await search({ q: 'python' });
    expect(res.status).toBe(200);
    expect(serp.state.requests).toHaveLength(0);
    expect(sources(res)).toEqual(['index']);
  });

  it('a request Bing has no parameter for goes to SerpApi instead', async () => {
    const res = await search({ q: 'python', date: 'week' });
    expect(bing.state.requests).toHaveLength(0);
    expect(serp.state.requests).toHaveLength(1);
    expect(serp.state.requests[0].query.tbs).toBe('qdr:w');
    expect(res.body.data.external).toMatchObject({ provider: 'serpapi', status: 'ok' });
  });

  it('without a Bing key, SerpApi is used and no request goes to Bing', async () => {
    config.bing.apiKey = '';
    const res = await search({ q: 'python' });
    expect(bing.state.requests).toHaveLength(0);
    expect(res.body.data.external).toEqual({
      provider: 'serpapi',
      status: 'ok',
      count: 3,
      cached: false,
      placement: 'ranked'
    });
  });

  it('without a Bing key or fallback, external results are simply off', async () => {
    config.bing.apiKey = '';
    config.externalSearch.fallback = false;
    const res = await search({ q: 'python' });
    expect(serp.state.requests).toHaveLength(0);
    expect(res.body.data.external).toEqual({
      provider: 'bing',
      status: 'disabled',
      count: 0,
      reason: 'not_configured'
    });
  });

  it('a bug is not treated as a provider failure: logged as an error, no fallback', async () => {
    const errorLog = jest.spyOn(logger, 'error').mockImplementation(() => {});
    jest.spyOn(bingSearchClient, 'searchWeb').mockRejectedValue(new TypeError('a bug'));
    const res = await search({ q: 'python' });
    expect(res.status).toBe(200);
    expect(serp.state.requests).toHaveLength(0);
    expect(sources(res)).toEqual(['index']);
    expect(res.body.data.external).toMatchObject({
      provider: 'bing',
      status: 'unavailable',
      reason: 'internal_error'
    });
    expect(errorLog).toHaveBeenCalledWith(
      'Unexpected error in external search (not a provider failure)',
      expect.objectContaining({ provider: 'bing' })
    );
  });

  it('logs a Bing failure without the key', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    Object.assign(bing.state, { mode: 'status', status: 401, body: { message: BING_KEY } });
    await search({ q: 'python' });
    expect(warn).toHaveBeenCalledWith('Bing request failed', {
      provider: 'bing',
      operation: 'web',
      query: 'python',
      reason: 'auth',
      status: 401,
      durationMs: expect.any(Number),
      pausedForMs: expect.any(Number),
      pauseScope: 'provider'
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(BING_KEY);
  });
});

describe('SEARCH_PROVIDER=serpapi (the default)', () => {
  beforeEach(() => {
    config.externalSearch.provider = 'serpapi';
  });

  it('behaves as before: Google results, and Bing is not asked', async () => {
    const res = await search({ q: 'python' });
    expect(bing.state.requests).toHaveLength(0);
    expect(serp.state.requests).toHaveLength(1);
    expect(sources(res)).toEqual(['index', 'serpapi', 'serpapi', 'serpapi']);
    expect(res.body.data.external).toEqual({
      provider: 'serpapi',
      status: 'ok',
      count: 3,
      cached: false,
      placement: 'ranked'
    });
  });

  it('falls back to Bing when SerpApi cannot answer', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    Object.assign(serp.state, { mode: 'status', status: 500 });
    const res = await search({ q: 'python' });
    expect(sources(res)).toEqual(['index', 'bing', 'bing', 'bing']);
    expect(res.body.data.external).toMatchObject({
      provider: 'bing',
      status: 'ok',
      fallbackFrom: 'serpapi',
      fallbackReason: 'unavailable'
    });
  });

  it('an unknown SEARCH_PROVIDER value means the default', async () => {
    config.externalSearch.provider = 'altavista';
    const res = await search({ q: 'python' });
    expect(res.body.data.external).toMatchObject({ provider: 'serpapi', status: 'ok' });
  });
});
