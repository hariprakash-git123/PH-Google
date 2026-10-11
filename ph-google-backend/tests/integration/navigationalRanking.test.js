const request = require('supertest');
const testDb = require('../helpers/testDb');
const { seedPage, seedManyPages } = require('../helpers/factories');
const { config } = require('../../config/env');
const externalSearch = require('../../services/externalSearch');
const parallelClient = require('../../services/external/parallelClient');
const serpApiClient = require('../../services/external/serpApiClient');
const logger = require('../../utils/logger');

/**
 * GET /api/search for a search that only names a site. The site's own pages
 * lead the first page when they are among the results — from the index or
 * from the provider — and a search that asks for something more about the
 * site keeps the order relevance gave it. Parallel is mocked; SerpApi must
 * not be asked.
 */

const original = {
  parallel: { ...config.parallel },
  serpapi: { ...config.serpapi },
  externalSearch: { ...config.externalSearch }
};
let app;
let parallelSearch;

const found = (url, title, excerpt = '') => ({
  url,
  title,
  publish_date: null,
  excerpts: [excerpt || title]
});

/** What Parallel answered for "youtube" in testing, in its order. */
const YOUTUBE_ANSWER = [
  found(
    'https://play.google.com/store/apps/details?id=com.google.android.youtube',
    'YouTube - Apps on Google Play'
  ),
  found('https://sv.wikipedia.org/wiki/Youtube', 'Youtube – Wikipedia'),
  found('https://emojidb.org/youtube-emojis', 'Youtube Emojis'),
  found('https://www.youtube.com/YouTube/en', 'YouTube - YouTube'),
  found('https://sea.mashable.com/youtube', 'YouTube'),
  found('https://www.youtube.com', 'YouTube')
];

beforeAll(async () => {
  await testDb.connect();
  app = require('../../app').createApp();
});
afterAll(async () => {
  Object.assign(config.parallel, original.parallel);
  Object.assign(config.serpapi, original.serpapi);
  Object.assign(config.externalSearch, original.externalSearch);
  await testDb.disconnect();
});
beforeEach(async () => {
  await testDb.clear();
  externalSearch.reset();
  Object.assign(config.externalSearch, original.externalSearch, {
    provider: 'parallel',
    fallback: false
  });
  Object.assign(config.parallel, original.parallel, {
    enabled: true,
    verticals: false,
    apiKey: 'navigational-test-key-NOT-REAL',
    mode: 'fast',
    maxResults: 10,
    dailyLimit: 0,
    cacheTtlMs: 60000
  });
  // The deployed rule: ask the provider only when the index needs help.
  Object.assign(config.serpapi, original.serpapi, { enabled: false, minInternalResults: 3 });
  parallelSearch = jest
    .spyOn(parallelClient, 'search')
    .mockResolvedValue({ results: YOUTUBE_ANSWER });
  jest
    .spyOn(serpApiClient, 'searchGoogle')
    .mockRejectedValue(new Error('SerpApi must not be asked'));
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const search = params => request(app).get('/api/search').query(params);
// Addresses compared without a trailing slash: the provider's mapper drops it.
const urls = res => res.body.data.results.map(r => r.url.replace(/\/$/, ''));

describe('a search that only names a site', () => {
  it('"youtube": the official site leads, above the Play Store, home page first', async () => {
    const res = await search({ q: 'youtube' });
    expect(res.status).toBe(200);
    expect(urls(res)).toEqual([
      'https://www.youtube.com',
      'https://www.youtube.com/YouTube/en',
      'https://play.google.com/store/apps/details?id=com.google.android.youtube',
      'https://sv.wikipedia.org/wiki/Youtube',
      'https://emojidb.org/youtube-emojis',
      'https://sea.mashable.com/youtube'
    ]);
    // Moved, not changed: still the provider's results, labelled as such.
    expect(res.body.data.results.every(r => r.source === 'parallel')).toBe(true);
    expect(res.body.data.external).toMatchObject({ provider: 'parallel', status: 'ok', count: 6 });
  });

  it('"youtube official site" is the same search', async () => {
    const res = await search({ q: 'youtube official site' });
    expect(urls(res)[0]).toBe('https://www.youtube.com');
  });

  it('"gmail": Gmail’s own pages lead, above pages about Gmail elsewhere', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        found('https://developers.google.com/workspace/gmail/api/guides', 'Gmail API overview'),
        found('https://simple.wikipedia.org/wiki/Gmail', 'Gmail - Wikipedia'),
        found('https://google.com/gmail/about', 'Gmail: Private and secure email'),
        found('https://mail.google.com', 'Gmail')
      ]
    });
    const res = await search({ q: 'gmail' });
    expect(urls(res)).toEqual([
      'https://mail.google.com',
      'https://google.com/gmail/about',
      'https://developers.google.com/workspace/gmail/api/guides',
      'https://simple.wikipedia.org/wiki/Gmail'
    ]);
  });

  it('when the official site is not among the results, nothing is invented', async () => {
    parallelSearch.mockResolvedValue({
      results: YOUTUBE_ANSWER.filter(r => !r.url.includes('www.youtube.com'))
    });
    const res = await search({ q: 'youtube' });
    expect(urls(res)).toEqual([
      'https://play.google.com/store/apps/details?id=com.google.android.youtube',
      'https://sv.wikipedia.org/wiki/Youtube',
      'https://emojidb.org/youtube-emojis',
      'https://sea.mashable.com/youtube'
    ]);
    expect(urls(res).some(url => url.includes('youtube.com'))).toBe(false);
  });

  it('the index’s own copy of the official site leads, and the provider’s copy of it is not shown twice', async () => {
    await seedPage({
      url: 'https://www.youtube.com',
      title: 'YouTube',
      text: 'youtube videos music'
    });
    await seedPage({
      url: 'https://fans.example/youtube-tips',
      title: 'YouTube tips',
      text: 'youtube youtube tips'
    });
    await seedPage({
      url: 'https://blog.example/youtube',
      title: 'About YouTube',
      text: 'youtube youtube youtube'
    });
    parallelSearch.mockResolvedValue({
      results: [...YOUTUBE_ANSWER, found('https://youtube.com/', 'YouTube')]
    });
    const res = await search({ q: 'youtube' });
    const shown = urls(res);
    expect(shown[0]).toBe('https://www.youtube.com');
    expect(res.body.data.results[0].source).toBe('index');
    // youtube.com/ and www.youtube.com/ are one page: shown once.
    expect(shown.filter(url => /^https:\/\/(www\.)?youtube\.com\/?$/.test(url))).toHaveLength(1);
    // The index answered with the official site itself: the provider was not needed.
    expect(parallelSearch).not.toHaveBeenCalled();
  });

  it('an index full of pages about the site, but not the site itself, asks the provider for it', async () => {
    await seedManyPages(5, { keyword: 'youtube', domain: 'fans.example' });
    const res = await search({ q: 'youtube' });
    expect(parallelSearch).toHaveBeenCalledTimes(1);
    expect(urls(res)[0]).toBe('https://www.youtube.com');
    // The index's results are all still there.
    expect(res.body.data.results.filter(r => r.source === 'index')).toHaveLength(5);
  });

  it('page 2 is the index’s own order, untouched', async () => {
    await seedManyPages(15, { keyword: 'youtube', domain: 'fans.example' });
    const res = await search({ q: 'youtube', page: 2 });
    expect(res.body.data.results.map(r => r.sourceRank)).toEqual([11, 12, 13, 14, 15]);
  });

  it('Load more continues as before', async () => {
    const first = (await search({ q: 'youtube' })).body.data;
    expect(typeof first.hasMore).toBe('boolean');
    if (first.hasMore) {
      const more = await search({ q: 'youtube', cursor: first.nextCursor });
      expect(more.status).toBe(200);
    }
  });
});

describe('a search that asks for something more keeps its order', () => {
  it('"youtube app download": app stores may lead; the official site is not forced up', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        found(
          'https://apps.apple.com/app/youtube/id544007664',
          'YouTube on the App Store',
          'Download the YouTube app'
        ),
        found(
          'https://play.google.com/store/apps/details?id=com.google.android.youtube',
          'YouTube - Apps on Google Play',
          'Download the YouTube app'
        ),
        found('https://www.youtube.com', 'YouTube', 'Download the YouTube app')
      ]
    });
    const res = await search({ q: 'youtube app download' });
    expect(urls(res)).toEqual([
      'https://apps.apple.com/app/youtube/id544007664',
      'https://play.google.com/store/apps/details?id=com.google.android.youtube',
      'https://www.youtube.com'
    ]);
  });

  it('"youtube tutorial": tutorials keep the order relevance gave them', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        found('https://learn.example/youtube-tutorial', 'YouTube tutorial for beginners'),
        found('https://www.youtube.com', 'YouTube', 'YouTube tutorial'),
        found('https://guide.example/youtube-tutorial', 'A YouTube tutorial')
      ]
    });
    const res = await search({ q: 'youtube tutorial' });
    expect(urls(res)).toEqual([
      'https://learn.example/youtube-tutorial',
      'https://www.youtube.com',
      'https://guide.example/youtube-tutorial'
    ]);
  });
});
