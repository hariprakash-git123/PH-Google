const request = require('supertest');
const testDb = require('../helpers/testDb');
const { seedPage } = require('../helpers/factories');
const { startSerpApiStandIn, images } = require('../helpers/serpApiStandIn');
const { config } = require('../../config/env');
const externalSearch = require('../../services/externalSearch');
const Page = require('../../models/Page');

/**
 * GET /api/search?category=images|videos|maps with SerpApi in front of a
 * local stand-in, and category=all alongside it to show web search is
 * unchanged.
 */

const KEY = 'verticals-integration-key-NOT-REAL-abcdef0123';
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
    cacheTtlMs: 60000
  });
  await seedPage({
    url: 'https://python.org/about',
    title: 'About Python',
    description: 'Python is a programming language.',
    text: 'python python programming language'
  });
});

const search = params => request(app).get('/api/search').query(params);
const engines = () => standIn.state.requests.map(r => r.query.engine);

describe('category=images', () => {
  it('returns normalised images from google_images', async () => {
    const res = await search({ q: 'python', category: 'images', limit: 2 });
    expect(res.status).toBe(200);
    expect(engines()).toEqual(['google_images']);
    const { data } = res.body;
    expect(data.category).toBe('images');
    expect(data.results).toHaveLength(2);
    expect(data.items).toEqual(data.results);
    expect(data.results[0]).toMatchObject({
      title: 'Image 1',
      thumbnailUrl: 'https://thumbs.example/t1.jpg',
      sourceUrl: 'https://pics.example/page-1',
      source: 'serpapi'
    });
    // The total is what SerpApi returned; pages are cut from it.
    expect(data.total).toBe(3);
    expect(data.pagination).toMatchObject({ page: 1, totalPages: 2, hasNextPage: true });
    expect(data.external).toEqual({ provider: 'serpapi', status: 'ok', count: 2, cached: false });
  });

  it('page 2 comes from the cached response — no second request', async () => {
    await search({ q: 'python', category: 'images', limit: 2 });
    const res = await search({ q: 'python', category: 'images', limit: 2, page: 2 });
    expect(engines()).toEqual(['google_images']);
    expect(res.body.data.results.map(r => r.title)).toEqual(['Image 3']);
    expect(res.body.data.pagination).toMatchObject({ page: 2, hasNextPage: false });
  });

  it('drops unsafe URLs before they reach the browser', async () => {
    standIn.state.images = [
      ...images(1),
      { position: 2, title: 'Bad', thumbnail: 'javascript:alert(1)', link: 'https://x.example' },
      {
        position: 3,
        title: 'Data',
        thumbnail: 'data:image/png;base64,AAAA',
        link: 'https://x.example'
      }
    ];
    const res = await search({ q: 'python', category: 'images' });
    expect(res.body.data.results.map(r => r.title)).toEqual(['Image 1']);
    expect(JSON.stringify(res.body)).not.toMatch(/javascript:|data:image/);
  });
});

describe('category=videos', () => {
  it('returns normalised videos from google_videos', async () => {
    const res = await search({ q: 'python tutorial', category: 'videos' });
    expect(engines()).toEqual(['google_videos']);
    expect(res.body.data.results[0]).toMatchObject({
      title: 'Video 1',
      videoUrl: 'https://www.youtube.com/watch?v=vid1',
      duration: '12:34',
      sourceName: 'YouTube',
      source: 'serpapi'
    });
    expect(res.body.data.total).toBe(3);
  });
});

describe('category=maps', () => {
  it('returns normalised places from google_maps', async () => {
    const res = await search({ q: 'restaurants in Chennai', category: 'maps' });
    expect(engines()).toEqual(['google_maps']);
    expect(standIn.state.requests[0].query).toMatchObject({
      q: 'restaurants in Chennai',
      type: 'search'
    });
    expect(res.body.data.results[0]).toMatchObject({
      title: 'Place 1',
      rating: 4.4,
      reviews: 1245,
      address: '1 Anna Salai, Chennai',
      latitude: 13.06,
      longitude: 80.25,
      source: 'serpapi'
    });
    expect(res.body.data.results[0].mapsUrl).toMatch(/^https:\/\/www\.google\.com\/maps\/search\//);
  });
});

describe('verticals and web together', () => {
  it('category=all is unchanged: index first, Google web results after', async () => {
    const res = await search({ q: 'python' });
    expect(engines()).toEqual(['google']);
    expect(res.body.data.results.map(r => r.source)).toEqual([
      'index',
      'serpapi',
      'serpapi',
      'serpapi'
    ]);
    expect(res.body.data.results[1].category).toBe('Google Web');
    expect(res.body.data.pagination).toMatchObject({ totalResults: 1, totalPages: 1 });
    expect(res.body.data.total).toBe(4);
  });

  it('the same query on every tab is one request per tab, and repeats are cached', async () => {
    for (const category of ['all', 'images', 'videos', 'maps', 'all', 'images', 'videos', 'maps']) {
      await search({ q: 'python', category });
    }
    expect(engines()).toEqual(['google', 'google_images', 'google_videos', 'google_maps']);
  });

  it('news still comes from the crawler, never SerpApi', async () => {
    const res = await search({ q: 'python', category: 'news' });
    expect(res.status).toBe(200);
    expect(standIn.state.requests).toHaveLength(0);
    expect(res.body.data).not.toHaveProperty('external');
  });

  it('rejects an unsupported category', async () => {
    const res = await search({ q: 'python', category: 'shopping' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(standIn.state.requests).toHaveLength(0);
  });

  it('with SerpApi disabled, images/videos/maps are the crawler verticals as before', async () => {
    config.serpapi.enabled = false;
    for (const category of ['images', 'videos', 'maps']) {
      const res = await search({ q: 'python', category });
      expect(res.status).toBe(200);
      expect(res.body.data.results).toEqual([]);
      expect(res.body.data.external).toMatchObject({ status: 'disabled', reason: 'disabled' });
    }
    expect(standIn.state.requests).toHaveLength(0);
  });
});

describe('failures and secrets', () => {
  it.each([
    [{ mode: 'status', status: 401 }, 'auth'],
    [{ mode: 'status', status: 429 }, 'rate_limited'],
    [{ mode: 'malformed' }, 'invalid_response'],
    [{ mode: 'slow', delayMs: 3000 }, 'timeout']
  ])('%p: 200 with an empty list and a status', async (setup, reason) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    Object.assign(standIn.state, setup, { body: { error: `Invalid API key ${KEY}` } });
    config.serpapi.verticalTimeoutMs = 500;
    const res = await search({ q: 'python', category: 'images' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      results: [],
      total: 0,
      external: { provider: 'serpapi', status: 'unavailable', count: 0, reason }
    });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    jest.restoreAllMocks();
  });

  it('never puts the key in any vertical response', async () => {
    for (const category of ['all', 'images', 'videos', 'maps']) {
      const res = await search({ q: 'python', category });
      expect(JSON.stringify(res.body)).not.toContain(KEY);
    }
  });

  it('stores nothing from SerpApi', async () => {
    const before = await Page.countDocuments();
    for (const category of ['images', 'videos', 'maps']) await search({ q: 'python', category });
    expect(await Page.countDocuments()).toBe(before);
  });
});
