const request = require('supertest');
const testDb = require('../helpers/testDb');
const { seedPage, seedManyPages } = require('../helpers/factories');
const { startSerpApiStandIn, organic } = require('../helpers/serpApiStandIn');
const { config } = require('../../config/env');
const externalSearch = require('../../services/externalSearch');
const retrievalService = require('../../services/ai/retrievalService');
const Page = require('../../models/Page');
const SearchLog = require('../../models/SearchLog');

/**
 * GET /api/search with SerpApi in front of a local stand-in: the index's
 * results, totals and pages stay the index's; Google results only ever
 * appear after them on page 1; a SerpApi failure is invisible apart from
 * the `external` status; AI answers never touch SerpApi.
 */

const KEY = 'integration-serpapi-key-NOT-REAL-abcdef0123456789';
const original = { ...config.serpapi };
let app;
let standIn;

beforeAll(async () => {
  await testDb.connect();
  standIn = await startSerpApiStandIn();
  app = require('../../app').createApp();
});
afterAll(async () => {
  Object.assign(config.serpapi, original);
  await standIn.close();
  await testDb.disconnect();
});
beforeEach(async () => {
  await testDb.clear();
  standIn.reset();
  externalSearch.reset();
  Object.assign(config.serpapi, original, {
    enabled: true,
    apiKey: KEY,
    engine: 'google',
    baseUrl: standIn.baseUrl,
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
  await seedPage({
    url: 'https://docs.example.com/python-guide',
    title: 'Python Guide',
    description: 'A guide to python.',
    text: 'python guide tutorial'
  });
});

const search = params => request(app).get('/api/search').query(params);

describe('SerpApi disabled', () => {
  it('makes no request and returns the index results exactly as before', async () => {
    config.serpapi.enabled = false;
    const res = await search({ q: 'python' });
    expect(res.status).toBe(200);
    expect(standIn.state.requests).toHaveLength(0);
    const { data } = res.body;
    expect(data.results).toHaveLength(2);
    expect(data.results.every(r => r.source === 'index')).toBe(true);
    expect(data.total).toBe(2);
    expect(data.pagination).toEqual({
      page: 1,
      limit: 10,
      totalResults: 2,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false
    });
    expect(data.external).toEqual({
      provider: 'serpapi',
      status: 'disabled',
      count: 0,
      reason: 'disabled'
    });
  });
});

describe('SerpApi enabled', () => {
  it('appends Google results after the index results on page 1', async () => {
    const res = await search({ q: 'python' });
    const { data } = res.body;
    expect(standIn.state.requests).toHaveLength(1);
    expect(standIn.state.requests[0].query).toMatchObject({ engine: 'google', q: 'python' });
    expect(data.results.map(r => r.source)).toEqual([
      'index',
      'index',
      'serpapi',
      'serpapi',
      'serpapi'
    ]);
    expect(data.results[2]).toMatchObject({
      url: 'https://external.example/page-1',
      category: 'Google Web',
      score: null
    });
    // total counts what is shown: the index's exact total + the Google results on the page.
    expect(data.total).toBe(5);
    // Pagination stays the index's own.
    expect(data.pagination).toMatchObject({ totalResults: 2, totalPages: 1, hasNextPage: false });
    expect(data.external).toEqual({
      provider: 'serpapi',
      status: 'ok',
      count: 3,
      cached: false,
      placement: 'ranked'
    });
  });

  it('drops a Google copy of a page the index already shows', async () => {
    standIn.state.organic = [
      { position: 1, title: 'Python', link: 'https://www.python.org/about/' },
      ...organic(1, { start: 2 })
    ];
    const { data } = (await search({ q: 'python' })).body;
    expect(data.results.filter(r => r.url.includes('python.org/about'))).toHaveLength(1);
    expect(data.results.find(r => r.url.includes('python.org/about')).source).toBe('index');
    expect(data.external.count).toBe(1);
  });

  it('page 2 makes no SerpApi call and is exactly the index page', async () => {
    await seedManyPages(25, { keyword: 'pagination' });
    const res = await search({ q: 'pagination', page: 2 });
    expect(standIn.state.requests).toHaveLength(0);
    expect(res.body.data.results).toHaveLength(10);
    expect(res.body.data.results.every(r => r.source === 'index')).toBe(true);
    expect(res.body.data.pagination).toMatchObject({ page: 2, totalResults: 25, totalPages: 3 });
    expect(res.body.data.external).toMatchObject({ status: 'skipped', reason: 'not_first_page' });
  });

  it('page 1 keeps all of the index page, with Google results after it', async () => {
    await seedManyPages(25, { keyword: 'pagination' });
    const { data } = (await search({ q: 'pagination' })).body;
    expect(data.results.slice(0, 10).every(r => r.source === 'index')).toBe(true);
    expect(data.results.slice(10).every(r => r.source === 'serpapi')).toBe(true);
    expect(data.pagination).toMatchObject({ totalResults: 25, totalPages: 3, hasNextPage: true });
    expect(data.total).toBe(28);
  });

  it('a first page of Google results only is one page', async () => {
    const { data } = (await search({ q: 'quantum chromodynamics' })).body;
    expect(data.results.every(r => r.source === 'serpapi')).toBe(true);
    expect(data.total).toBe(3);
    expect(data.pagination).toMatchObject({ totalResults: 0, totalPages: 1, hasNextPage: false });
  });

  it('does not store SerpApi results anywhere', async () => {
    const pagesBefore = await Page.countDocuments();
    await search({ q: 'python' });
    expect(await Page.countDocuments()).toBe(pagesBefore);
    expect(await Page.countDocuments({ url: /external\.example/ })).toBe(0);
    // Analytics count the index's matches, not Google's.
    const log = await SearchLog.findOne({ normalizedQuery: 'python' }).lean();
    expect(log.resultCount).toBe(2);
  });
});

describe('SerpApi failures', () => {
  it.each([
    ['invalid key (401)', { mode: 'status', status: 401 }, 'auth'],
    ['forbidden (403)', { mode: 'status', status: 403 }, 'auth'],
    ['rate limited (429)', { mode: 'status', status: 429 }, 'rate_limited'],
    ['server error (500)', { mode: 'status', status: 500 }, 'unavailable'],
    ['malformed JSON', { mode: 'malformed' }, 'invalid_response'],
    ['timeout', { mode: 'slow', delayMs: 3000 }, 'timeout']
  ])('%s: still 200 with the index results', async (_label, setup, reason) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    Object.assign(standIn.state, setup, { body: { error: `Invalid API key: ${KEY}` } });
    config.serpapi.timeoutMs = 500;
    const res = await search({ q: 'python' });
    expect(res.status).toBe(200);
    expect(res.body.data.results.map(r => r.source)).toEqual(['index', 'index']);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.external).toEqual({
      provider: 'serpapi',
      status: 'unavailable',
      count: 0,
      reason
    });
    jest.restoreAllMocks();
  });

  it('a network failure: still 200 with the index results', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    config.serpapi.baseUrl = 'http://127.0.0.1:1';
    const res = await search({ q: 'python' });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(2);
    expect(res.body.data.external).toMatchObject({ status: 'unavailable', reason: 'network' });
    jest.restoreAllMocks();
  });

  it('never puts the key in a response, whether it worked or not', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const ok = await search({ q: 'python' });
    Object.assign(standIn.state, {
      mode: 'status',
      status: 401,
      body: { error: `Invalid API key ${KEY}` }
    });
    externalSearch.reset();
    const failed = await search({ q: 'python guide' });
    const config_ = await request(app).get('/api/search/config');
    for (const res of [ok, failed, config_]) expect(JSON.stringify(res.body)).not.toContain(KEY);
    jest.restoreAllMocks();
  });
});

describe('AI answers stay on the index', () => {
  it('retrieval never calls SerpApi and returns index documents only', async () => {
    const retrieval = await retrievalService.retrieve({ query: 'python' });
    expect(standIn.state.requests).toHaveLength(0);
    expect(retrieval.documents.length).toBeGreaterThan(0);
    expect(retrieval.documents.every(d => !String(d.id).startsWith('serpapi:'))).toBe(true);
  });
});
