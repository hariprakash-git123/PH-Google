const request = require('supertest');
const mongoose = require('mongoose');
const testDb = require('../helpers/testDb');
const { startSerpApiStandIn } = require('../helpers/serpApiStandIn');
const { config } = require('../../config/env');
const externalSearch = require('../../services/externalSearch');
const parallelClient = require('../../services/external/parallelClient');
const videoPlatforms = require('../../services/external/videoPlatforms');
const safeFetch = require('../../services/external/safeFetch');
const { ExternalSearchError } = require('../../services/external/externalSearchError');
const Media = require('../../models/Media');
const logger = require('../../utils/logger');

/**
 * GET /api/search?category=images|videos with SerpApi switched off and
 * PARALLEL_VERTICALS_ENABLED on: Parallel finds pages, and only what has been
 * checked against the thing itself is shown — a video the platform confirms,
 * a picture whose address really serves one. The crawler's own media come
 * first. Nothing here reaches Parallel, a video platform, a web page or
 * SerpApi: Parallel's client, the platform lookup and the page/image fetches
 * are mocked, and SerpApi is a local stand-in that must stay untouched.
 */

const PARALLEL_KEY = 'parallel-verticals-key-NOT-REAL-abcdef0123456789';
const SERP_KEY = 'serpapi-off-key-NOT-REAL-0123456789abcdef';
const original = {
  parallel: { ...config.parallel },
  serpapi: { ...config.serpapi },
  externalSearch: { ...config.externalSearch }
};
let app;
let serp;
let parallelSearch;
let lookup;
let fetched;

// ---------------------------------------------------------------- fixtures
const png = (width, height, seed = 0) => {
  const buffer = Buffer.alloc(40);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer.writeUInt32BE(seed, 32); // makes two files of one size different files
  return buffer;
};
const html = (title, body) =>
  Buffer.from(
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
  );

/** What the web serves in a test: address → HTML page, image bytes, or a failure. */
let web;
const serve = (url, value) => web.set(url, value);
const page = (url, title, body) =>
  serve(url, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
    buffer: html(title, body)
  });
const image = (url, buffer) => serve(url, { headers: { 'content-type': 'image/png' }, buffer });

const found = (url, title, excerpt = '', publishDate = null) => ({
  url,
  title,
  publish_date: publishDate,
  excerpts: excerpt ? [excerpt] : []
});
const yt = id => `https://www.youtube.com/watch?v=${id}`;
const confirmed = (title, channel = 'A Channel', id = 'x') => ({
  ok: true,
  title,
  channel,
  thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
});

beforeAll(async () => {
  await testDb.connect();
  serp = await startSerpApiStandIn();
  app = require('../../app').createApp();
});
afterAll(async () => {
  Object.assign(config.parallel, original.parallel);
  Object.assign(config.serpapi, original.serpapi);
  Object.assign(config.externalSearch, original.externalSearch);
  await serp.close();
  await testDb.disconnect();
});
beforeEach(async () => {
  await testDb.clear();
  serp.reset();
  externalSearch.reset();
  web = new Map();
  Object.assign(config.externalSearch, original.externalSearch, {
    provider: 'parallel',
    fallback: false
  });
  Object.assign(config.parallel, original.parallel, {
    enabled: true,
    verticals: true,
    apiKey: PARALLEL_KEY,
    mode: 'fast',
    timeoutMs: 1000,
    maxResults: 10,
    dailyLimit: 0,
    cacheTtlMs: 60000
  });
  // Everything SerpApi needs to answer, except the switch.
  Object.assign(config.serpapi, original.serpapi, {
    enabled: false,
    apiKey: SERP_KEY,
    engine: 'google',
    baseUrl: serp.baseUrl,
    dailyLimit: 0
  });
  parallelSearch = jest.spyOn(parallelClient, 'search').mockResolvedValue({ results: [] });
  lookup = jest
    .spyOn(videoPlatforms, 'lookup')
    .mockResolvedValue({ ok: false, reason: 'not_confirmed' });
  fetched = jest.spyOn(safeFetch, 'get').mockImplementation(async url => {
    const entry = web.get(url);
    if (!entry) return { ok: false, reason: 'upstream', status: 404 };
    if (entry.fail) return { ok: false, reason: entry.fail };
    return { ok: true, status: 200, truncated: false, finalUrl: url, ...entry };
  });
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  const serpAsked = serp.state.requests.length;
  jest.restoreAllMocks();
  if (serpAsked > 0) throw new Error('SerpApi was asked while switched off');
});

const search = params => request(app).get('/api/search').query(params);
const media = doc =>
  Media.create({ pageId: new mongoose.Types.ObjectId(), lastCrawledAt: new Date(), ...doc });

// ------------------------------------------------------------------ videos
describe('category=videos', () => {
  it('returns the videos a platform confirms, with the platform’s own title and thumbnail', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        found(
          yt('aaaaaaaaaa1'),
          'Electric cars explained - YouTube',
          'How electric cars work.',
          '2026-01-25'
        ),
        found('https://vimeo.com/76979871', 'Electric cars on Vimeo', 'A film about electric cars.')
      ]
    });
    lookup.mockImplementation(async video =>
      video.platform === 'youtube'
        ? confirmed('Electric Cars Explained', 'Car Channel', 'aaaaaaaaaa1')
        : {
            ok: true,
            title: 'Electric cars: a short film',
            channel: 'A Studio',
            thumbnailUrl: null
          }
    );

    const res = await search({ q: 'electric cars', category: 'videos' });
    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data.results).toEqual([
      {
        id: expect.stringMatching(/^parallel-video:[0-9a-f]{40}$/),
        title: 'Electric Cars Explained',
        thumbnailUrl: 'https://i.ytimg.com/vi/aaaaaaaaaa1/hqdefault.jpg',
        videoUrl: yt('aaaaaaaaaa1'),
        sourceUrl: yt('aaaaaaaaaa1'),
        sourceDomain: 'youtube.com',
        sourceName: 'YouTube',
        channel: 'Car Channel',
        duration: null,
        publishedAt: '2026-01-25T00:00:00.000Z',
        publishedAgo: null,
        snippet: 'How electric cars work.',
        source: 'parallel',
        position: 1
      },
      expect.objectContaining({
        title: 'Electric cars: a short film',
        videoUrl: 'https://vimeo.com/76979871',
        sourceName: 'Vimeo',
        thumbnailUrl: null,
        publishedAt: null,
        position: 2
      })
    ]);
    expect(data.items).toEqual(data.results);
    expect(data.total).toBe(2);
    expect(data.pagination).toMatchObject({ page: 1, totalPages: 1, hasNextPage: false });
    expect(data.external).toEqual({
      provider: 'parallel',
      status: 'ok',
      count: 2,
      indexCount: 0,
      cached: false
    });
  });

  it('asks Parallel for videos on the platforms it can confirm with, and nowhere else', async () => {
    await search({ q: 'electric cars', category: 'videos' });
    // Parallel returns at most 20 pages a request, so the question is asked
    // three ways at once — each its own request for 20.
    expect(parallelSearch.mock.calls.map(([sent]) => sent)).toEqual(
      ['electric cars video', 'electric cars', 'best electric cars'].map(query => ({
        objective: 'videos about electric cars',
        searchQueries: [query],
        sourcePolicy: {
          include_domains: ['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com']
        },
        maxResults: 20
      }))
    );
  });

  it('asks for pages of pictures two ways, on any site', async () => {
    await search({ q: 'electric cars', category: 'images' });
    expect(parallelSearch.mock.calls.map(([sent]) => sent)).toEqual(
      ['electric cars photos', 'electric cars images'].map(query => ({
        objective: 'photos and pictures of electric cars',
        searchQueries: [query],
        sourcePolicy: {},
        maxResults: 20
      }))
    );
  });

  it('merges the answers: the best of each request first, and no video twice', async () => {
    const answers = {
      'electric cars video': [
        found(yt('aaaaaaaaaa1'), 'Electric cars 1'),
        found(yt('aaaaaaaaaa2'), 'Electric cars 2')
      ],
      'electric cars': [
        found(yt('aaaaaaaaaa3'), 'Electric cars 3'),
        found(yt('aaaaaaaaaa1'), 'Electric cars 1')
      ],
      'best electric cars': [found(yt('aaaaaaaaaa4'), 'Electric cars 4')]
    };
    parallelSearch.mockImplementation(async ({ searchQueries }) => ({
      results: answers[searchQueries[0]]
    }));
    lookup.mockImplementation(async video => confirmed(`Electric cars ${video.id.slice(-1)}`));
    const { data } = (await search({ q: 'electric cars', category: 'videos' })).body;
    expect(data.results.map(r => r.title)).toEqual([
      'Electric cars 1',
      'Electric cars 3',
      'Electric cars 4',
      'Electric cars 2'
    ]);
    expect(data.total).toBe(4);
  });

  it('one way of asking failing does not lose the answers of the others', async () => {
    parallelSearch.mockImplementation(async ({ searchQueries }) => {
      if (searchQueries[0] !== 'electric cars') {
        throw new ExternalSearchError('timeout', 'Parallel did not answer');
      }
      return { results: [found(yt('aaaaaaaaaa1'), 'Electric cars')] };
    });
    lookup.mockResolvedValue(confirmed('Electric cars'));
    const { data } = (await search({ q: 'electric cars', category: 'videos' })).body;
    expect(data.results).toHaveLength(1);
    expect(data.external).toMatchObject({ provider: 'parallel', status: 'ok', count: 1 });
  });

  it('never presents a channel, a playlist or an article as a video', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        found('https://www.youtube.com/channel/UCs5zOg5Ad0QAkRPJsYiRm9g', 'Electric Cars Channel'),
        found('https://www.youtube.com/playlist?list=PLabc', 'Electric cars playlist'),
        found('https://www.youtube.com/@ElectricCars/videos', 'Electric cars videos'),
        found('https://news.example.com/electric-cars-video', 'Watch: electric cars video'),
        found('javascript:alert(1)', 'electric cars'),
        found('not a url', 'electric cars'),
        null,
        'electric cars'
      ]
    });
    lookup.mockResolvedValue(confirmed('Electric cars'));
    const res = await search({ q: 'electric cars', category: 'videos' });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
    expect(res.body.data.external).toMatchObject({ provider: 'parallel', status: 'ok', count: 0 });
    // Not one of them was worth asking a platform about.
    expect(lookup).not.toHaveBeenCalled();
  });

  it('drops a video the platform does not confirm, or cannot be asked about in time', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        found(yt('aaaaaaaaaa1'), 'Electric cars one'),
        found(yt('aaaaaaaaaa2'), 'Electric cars two'),
        found(yt('aaaaaaaaaa3'), 'Electric cars three')
      ]
    });
    lookup.mockImplementation(async video => {
      if (video.id === 'aaaaaaaaaa1') return { ok: false, reason: 'not_confirmed' };
      if (video.id === 'aaaaaaaaaa2') return { ok: false, reason: 'timeout' };
      return confirmed('Electric cars three');
    });
    const res = await search({ q: 'electric cars', category: 'videos' });
    expect(res.body.data.results.map(r => r.videoUrl)).toEqual([yt('aaaaaaaaaa3')]);
  });

  it('drops a confirmed video that is about something else', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        found(yt('aaaaaaaaaa1'), 'x', 'Unboxing a new phone.'),
        found(yt('aaaaaaaaaa2'), 'y', 'In this video we cook sambar the Tamil way.'),
        found(yt('aaaaaaaaaa3'), 'z', 'A quick breakfast.'),
        found(yt('aaaaaaaaaa4'), 'w', 'Tamil cooking playlist: subscribe for more Tamil cooking.')
      ]
    });
    const titles = {
      aaaaaaaaaa1: ['Phone unboxing', 'Gadget Reviews'],
      aaaaaaaaaa2: ['Sambar recipe | easy lunch', 'Home Cooking'],
      // A title names the dish, not "cooking": one word of the subject is enough.
      aaaaaaaaaa3: ['Bread Uttappam Recipe in Tamil', 'Madras Samayal'],
      // The description alone says it; the platform's own title and channel do not.
      aaaaaaaaaa4: ['My holiday vlog', 'Travel Diaries']
    };
    lookup.mockImplementation(async video => confirmed(...titles[video.id]));
    const res = await search({ q: 'Tamil cooking videos', category: 'videos' });
    // The subject is "Tamil cooking": the word "videos" is not asked of a title.
    expect(res.body.data.results.map(r => r.title)).toEqual([
      'Sambar recipe | easy lunch',
      'Bread Uttappam Recipe in Tamil'
    ]);
  });

  it('shows one video once, however its address is written', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        found(yt('aaaaaaaaaa1'), 'Electric cars'),
        found('https://youtu.be/aaaaaaaaaa1?si=share', 'Electric cars'),
        found('https://m.youtube.com/watch?v=aaaaaaaaaa1&t=30s', 'Electric cars'),
        found('https://www.youtube.com/shorts/aaaaaaaaaa1', 'Electric cars')
      ]
    });
    lookup.mockResolvedValue(confirmed('Electric cars'));
    const res = await search({ q: 'electric cars', category: 'videos' });
    expect(res.body.data.results).toHaveLength(1);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('a site filter for a site that is not a video platform asks nothing', async () => {
    const res = await search({ q: 'electric cars', category: 'videos', domain: 'bbc.co.uk' });
    expect(res.status).toBe(200);
    expect(parallelSearch).not.toHaveBeenCalled();
    expect(res.body.data.external).toMatchObject({
      provider: 'parallel',
      status: 'skipped',
      reason: 'unsupported_filter'
    });
  });
});

// ------------------------------------------------------------------ images
describe('category=images', () => {
  const PAGE = 'https://cars.example/electric-cars';

  it('returns verified pictures with the page each was found on', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(PAGE, 'Electric cars: a photo guide', 'Photos of electric cars.')]
    });
    page(
      PAGE,
      'Electric cars: a photo guide',
      `<img src="/photos/model-y.png" alt="A white electric car">
       <figure><img src="https://cdn.example/p/0042.png"><figcaption>An electric car charging</figcaption></figure>`
    );
    image('https://cars.example/photos/model-y.png', png(1200, 800, 1));
    image('https://cdn.example/p/0042.png', png(1600, 900, 2));

    const res = await search({ q: 'electric cars', category: 'images' });
    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data.results).toEqual([
      {
        id: expect.stringMatching(/^parallel-image:[0-9a-f]{40}$/),
        title: 'A white electric car',
        imageUrl: 'https://cars.example/photos/model-y.png',
        thumbnailUrl: 'https://cars.example/photos/model-y.png',
        sourceUrl: PAGE,
        sourceDomain: 'cars.example',
        sourceName: '',
        width: 1200,
        height: 800,
        downloadToken: expect.any(String),
        source: 'parallel',
        position: 1
      },
      expect.objectContaining({
        title: 'An electric car charging',
        imageUrl: 'https://cdn.example/p/0042.png',
        sourceUrl: PAGE,
        width: 1600,
        height: 900,
        position: 2
      })
    ]);
    expect(data.total).toBe(2);
    // Fewer than a page: two more rounds were asked (in other words), and found
    // nothing new, so there is no more.
    expect(data.external).toEqual({
      provider: 'parallel',
      status: 'ok',
      count: 2,
      indexCount: 0,
      cached: false,
      rounds: 3
    });
    expect(data.hasMore).toBe(false);
  });

  it('the Download button works for these images: the address carries this server’s signature', async () => {
    parallelSearch.mockResolvedValue({ results: [found(PAGE, 'Electric cars')] });
    page(PAGE, 'Electric cars', '<img src="/a.png" alt="electric car">');
    image('https://cars.example/a.png', png(800, 600));
    const [result] = (await search({ q: 'electric cars', category: 'images' })).body.data.results;
    const { verifyUrl } = require('../../utils/urlSigner');
    expect(verifyUrl('image-download', result.imageUrl, result.downloadToken)).toBe(true);
  });

  it('shows no page furniture and no picture of something else', async () => {
    parallelSearch.mockResolvedValue({ results: [found(PAGE, 'Electric cars guide')] });
    page(
      PAGE,
      'Electric cars guide',
      `<img src="/static/logo.png" alt="Electric cars weekly">
       <img src="/team/editor.png" alt="Our editor at her desk">
       <img src="/photos/ev.png" alt="An electric car on the road">`
    );
    for (const path of ['/static/logo.png', '/team/editor.png', '/photos/ev.png']) {
      image(`https://cars.example${path}`, png(900, 600, path.length));
    }
    const res = await search({ q: 'electric cars', category: 'images' });
    expect(res.body.data.results.map(r => r.imageUrl)).toEqual([
      'https://cars.example/photos/ev.png'
    ]);
    // The others were never even fetched.
    const asked = fetched.mock.calls.map(([url]) => url);
    expect(asked).not.toContain('https://cars.example/static/logo.png');
    expect(asked).not.toContain('https://cars.example/team/editor.png');
  });

  it('drops malformed addresses, and addresses that do not serve a usable image', async () => {
    parallelSearch.mockResolvedValue({ results: [found(PAGE, 'Electric cars guide')] });
    page(
      PAGE,
      'Electric cars guide',
      `<img src="javascript:alert(1)" alt="electric car">
       <img src="data:image/png;base64,AAAA" alt="electric car">
       <img src="/gone.png" alt="electric car, removed">
       <img src="/page.png" alt="electric car, an error page">
       <img src="/tiny.png" alt="electric car, tiny">
       <img src="/slow.png" alt="electric car, slow">
       <img src="/good.png" alt="electric car, good">`
    );
    serve('https://cars.example/page.png', {
      headers: { 'content-type': 'image/png' },
      buffer: html('Not found', 'Not found')
    });
    image('https://cars.example/tiny.png', png(32, 32));
    serve('https://cars.example/slow.png', { fail: 'timeout' });
    image('https://cars.example/good.png', png(1024, 768));

    const res = await search({ q: 'electric cars', category: 'images' });
    expect(res.status).toBe(200);
    expect(res.body.data.results.map(r => r.imageUrl)).toEqual(['https://cars.example/good.png']);
    const asked = fetched.mock.calls.map(([url]) => url);
    expect(asked.some(url => /^(javascript|data):/.test(url))).toBe(false);
  });

  it('shows one picture once: the same address, another size of it, or the same file elsewhere', async () => {
    const OTHER = 'https://blog.example/electric-cars-photos';
    parallelSearch.mockResolvedValue({
      results: [found(PAGE, 'Electric cars guide'), found(OTHER, 'Electric cars photos')]
    });
    page(
      PAGE,
      'Electric cars guide',
      `<img src="https://cdn.example/ev.png?w=400" alt="electric car">
       <img src="https://cdn.example/ev.png?w=1600" alt="electric car, large">`
    );
    page(
      OTHER,
      'Electric cars photos',
      `<img src="https://cdn.example/ev.png?w=800" alt="electric car">
       <img src="https://mirror.example/copy-of-ev.png" alt="electric car">
       <img src="https://mirror.example/another.png" alt="electric car, another">`
    );
    const same = png(1200, 800, 7);
    image('https://cdn.example/ev.png?w=400', same);
    image('https://mirror.example/copy-of-ev.png', same);
    image('https://mirror.example/another.png', png(1200, 800, 8));

    const res = await search({ q: 'electric cars', category: 'images' });
    expect(res.body.data.results.map(r => r.imageUrl)).toEqual([
      'https://cdn.example/ev.png?w=400',
      'https://mirror.example/another.png'
    ]);
    expect(res.body.data.total).toBe(2);
  });

  it('does not read, or show pictures from, a site that names itself an adult site', async () => {
    const ADULT = 'https://videos.anyxxx.example/electric-cars';
    parallelSearch.mockResolvedValue({
      results: [found(ADULT, 'Electric cars'), found(PAGE, 'Electric cars guide')]
    });
    page(ADULT, 'Electric cars', '<img src="/a.png" alt="electric car">');
    page(
      PAGE,
      'Electric cars guide',
      `<img src="https://cdn.pornhost.example/b.png" alt="electric car">
       <img src="/ok.png" alt="electric car">`
    );
    image('https://videos.anyxxx.example/a.png', png(800, 600, 1));
    image('https://cdn.pornhost.example/b.png', png(800, 600, 2));
    image('https://cars.example/ok.png', png(800, 600, 3));
    const res = await search({ q: 'electric cars', category: 'images' });
    expect(res.body.data.results.map(r => r.imageUrl)).toEqual(['https://cars.example/ok.png']);
    const asked = fetched.mock.calls.map(([url]) => url);
    expect(asked.some(url => /anyxxx|pornhost/.test(url))).toBe(false);
  });

  it('reads only pages that are about the subject', async () => {
    const OFF = 'https://shop.example/phone-cases';
    parallelSearch.mockResolvedValue({
      results: [
        found(OFF, 'Phone cases', 'Cases for every phone.'),
        found(PAGE, 'Electric cars guide')
      ]
    });
    page(OFF, 'Phone cases', '<img src="/case.png" alt="electric car themed case">');
    page(PAGE, 'Electric cars guide', '<img src="/ev.png" alt="electric car">');
    image('https://cars.example/ev.png', png(800, 600));
    const res = await search({ q: 'electric cars', category: 'images' });
    expect(res.body.data.results.map(r => r.sourceUrl)).toEqual([PAGE]);
    expect(fetched.mock.calls.map(([url]) => url)).not.toContain(OFF);
  });

  it('a page that cannot be read, or has no picture of the subject, simply adds nothing', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        found('https://blocked.example/electric-cars', 'Electric cars'),
        found('https://slow.example/electric-cars', 'Electric cars'),
        found('https://text.example/electric-cars', 'Electric cars')
      ]
    });
    serve('https://slow.example/electric-cars', { fail: 'timeout' });
    page('https://text.example/electric-cars', 'Electric cars', '<p>No pictures here.</p>');
    const res = await search({ q: 'electric cars', category: 'images' });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.external).toMatchObject({ provider: 'parallel', status: 'ok', count: 0 });
  });
});

// ------------------------------------------------- empty, failing, limits
describe.each(['images', 'videos', 'maps'])(
  'category=%s when Parallel has nothing or fails',
  category => {
    it('an empty answer is an empty tab: "nothing found", not an outage', async () => {
      const res = await search({ q: 'electric cars', category });
      expect(res.status).toBe(200);
      expect(res.body.data.results).toEqual([]);
      expect(res.body.data.total).toBe(0);
      expect(res.body.data.external).toEqual({
        provider: 'parallel',
        status: 'ok',
        count: 0,
        indexCount: 0,
        cached: false
      });
    });

    it.each([
      ['timeout', 'Parallel did not answer in time'],
      ['unavailable', 'Parallel answered 503'],
      ['network', 'Parallel could not be reached'],
      ['auth', 'Parallel rejected the API key'],
      ['rate_limited', 'Parallel is limiting this key'],
      ['invalid_response', 'Parallel returned malformed results']
    ])(
      '%s: a normal page saying results are unavailable, and SerpApi is not asked',
      async (code, message) => {
        parallelSearch.mockRejectedValue(new ExternalSearchError(code, message));
        const res = await search({ q: 'electric cars', category });
        expect(res.status).toBe(200);
        expect(res.body.data.results).toEqual([]);
        expect(res.body.data.external).toEqual({
          provider: 'parallel',
          status: 'unavailable',
          count: 0,
          indexCount: 0,
          reason: code
        });
        expect(JSON.stringify(res.body)).not.toContain(PARALLEL_KEY);
      }
    );

    it('a bug while checking results is not a crash and not blamed on the provider', async () => {
      jest.spyOn(logger, 'error').mockImplementation(() => {});
      parallelSearch.mockRejectedValue(new TypeError('boom'));
      const res = await search({ q: 'electric cars', category });
      expect(res.status).toBe(200);
      expect(res.body.data.external).toMatchObject({
        status: 'unavailable',
        reason: 'internal_error'
      });
    });

    /** Requests one search of this tab sends: the question, asked this many ways. */
    const WAYS = category === 'videos' ? 3 : 2;

    it('the daily limit is shared with web search, and every request sent is counted', async () => {
      config.parallel.dailyLimit = WAYS;
      await search({ q: 'electric cars', category });
      expect(externalSearch.describe().parallel.usedToday).toBe(WAYS);
      const res = await search({ q: 'solar panels', category });
      expect(parallelSearch).toHaveBeenCalledTimes(WAYS);
      expect(res.body.data.external).toMatchObject({ status: 'skipped', reason: 'daily_limit' });
      // And web search finds the day's allowance used.
      const web = await search({ q: 'solar panels' });
      expect(web.body.data.external).toMatchObject({ status: 'skipped', reason: 'daily_limit' });
    });

    it('a repeat of the search, and its later pages, cost no second request', async () => {
      await search({ q: 'electric cars', category });
      const again = await search({ q: 'electric cars', category });
      await search({ q: 'electric cars', category, page: 2 });
      expect(parallelSearch).toHaveBeenCalledTimes(WAYS);
      expect(again.body.data.external).toMatchObject({ status: 'ok', cached: true });
    });
  }
);

// ------------------------------------------------------ the crawler index
describe('the crawler’s own media', () => {
  const PAGE = 'https://cars.example/electric-cars';

  it('relevant crawled images come first, in the same shape, and Parallel’s follow without repeats', async () => {
    await media({
      type: 'image',
      url: 'https://crawled.example/img/ev-crawled.png',
      pageUrl: 'https://crawled.example/electric',
      pageTitle: 'Electric cars',
      domain: 'crawled.example',
      alt: 'An electric car we crawled',
      terms: ['electric', 'car', 'cars'],
      width: 640,
      height: 480
    });
    // Crawled too, and also found by Parallel: shown once, as the crawler's.
    await media({
      type: 'image',
      url: 'https://cdn.example/shared.png',
      pageUrl: 'https://crawled.example/electric',
      domain: 'crawled.example',
      alt: 'Shared electric car picture',
      terms: ['electric', 'car', 'cars']
    });
    // Matches a word of the query but is about something else.
    await media({
      type: 'image',
      url: 'https://crawled.example/img/toy.png',
      pageUrl: 'https://crawled.example/toys',
      domain: 'crawled.example',
      alt: 'A wooden toy',
      terms: ['cars', 'toy']
    });
    parallelSearch.mockResolvedValue({ results: [found(PAGE, 'Electric cars guide')] });
    page(
      PAGE,
      'Electric cars guide',
      `<img src="https://cdn.example/shared.png?w=1200" alt="electric car">
       <img src="/new.png" alt="electric car, new">`
    );
    image('https://cdn.example/shared.png?w=1200', png(1200, 800, 1));
    image('https://cars.example/new.png', png(1200, 800, 2));

    const { data } = (await search({ q: 'electric cars', category: 'images' })).body;
    expect(data.results.map(r => [r.source, r.imageUrl])).toEqual([
      ['index', 'https://crawled.example/img/ev-crawled.png'],
      ['index', 'https://cdn.example/shared.png'],
      ['parallel', 'https://cars.example/new.png']
    ]);
    expect(data.results[0]).toMatchObject({
      id: expect.stringMatching(/^index-image:/),
      title: 'An electric car we crawled',
      thumbnailUrl: 'https://crawled.example/img/ev-crawled.png',
      sourceUrl: 'https://crawled.example/electric',
      sourceDomain: 'crawled.example',
      width: 640,
      height: 480,
      downloadToken: expect.any(String)
    });
    expect(data.total).toBe(3);
    expect(data.external).toMatchObject({
      provider: 'parallel',
      status: 'ok',
      count: 1,
      indexCount: 2
    });
  });

  it('relevant crawled videos come first, and the same video from Parallel is not repeated', async () => {
    await media({
      type: 'video',
      url: 'https://www.youtube.com/embed/aaaaaaaaaa1',
      pageUrl: 'https://crawled.example/electric',
      pageTitle: 'Electric cars',
      domain: 'crawled.example',
      title: 'Electric cars: our review',
      provider: 'youtube',
      providerId: 'aaaaaaaaaa1',
      thumbnailUrl: 'https://i.ytimg.com/vi/aaaaaaaaaa1/hqdefault.jpg',
      terms: ['electric', 'car', 'cars']
    });
    parallelSearch.mockResolvedValue({
      results: [
        found(yt('aaaaaaaaaa1'), 'Electric cars'),
        found(yt('aaaaaaaaaa2'), 'Electric cars')
      ]
    });
    lookup.mockResolvedValue(confirmed('Electric cars from Parallel'));

    const { data } = (await search({ q: 'electric cars', category: 'videos' })).body;
    expect(data.results.map(r => [r.source, r.videoUrl])).toEqual([
      ['index', yt('aaaaaaaaaa1')],
      ['parallel', yt('aaaaaaaaaa2')]
    ]);
    expect(data.results[0]).toMatchObject({
      id: expect.stringMatching(/^index-video:/),
      title: 'Electric cars: our review',
      sourceUrl: 'https://crawled.example/electric',
      sourceName: 'YouTube',
      thumbnailUrl: 'https://i.ytimg.com/vi/aaaaaaaaaa1/hqdefault.jpg'
    });
    expect(data.external).toMatchObject({ count: 1, indexCount: 1 });
  });

  it.each(['images', 'videos'])(
    '%s: crawled results are still shown when Parallel fails',
    async category => {
      await media({
        type: category === 'images' ? 'image' : 'video',
        url: 'https://crawled.example/media/ev.png',
        pageUrl: 'https://crawled.example/electric',
        domain: 'crawled.example',
        title: 'Electric car',
        alt: 'Electric car',
        terms: ['electric', 'car', 'cars']
      });
      parallelSearch.mockRejectedValue(
        new ExternalSearchError('timeout', 'Parallel did not answer')
      );
      const { data } = (await search({ q: 'electric cars', category })).body;
      expect(data.results).toHaveLength(1);
      expect(data.results[0].source).toBe('index');
      expect(data.external).toMatchObject({
        status: 'unavailable',
        reason: 'timeout',
        indexCount: 1
      });
    }
  );

  it('pages are cut from the combined list, and the total is what can be paged through', async () => {
    parallelSearch.mockResolvedValue({
      results: Array.from({ length: 5 }, (_, i) => found(yt(`aaaaaaaaaa${i}`), 'Electric cars'))
    });
    lookup.mockResolvedValue(confirmed('Electric cars'));
    const first = (await search({ q: 'electric cars', category: 'videos', limit: 2 })).body.data;
    const third = (await search({ q: 'electric cars', category: 'videos', limit: 2, page: 3 })).body
      .data;
    expect(first.total).toBe(5);
    expect(first.pagination).toMatchObject({ totalPages: 3, hasNextPage: true });
    expect(first.results.map(r => r.position)).toEqual([1, 2]);
    expect(third.results.map(r => r.position)).toEqual([5]);
    // One search of the tab (three requests), whatever the page.
    expect(parallelSearch).toHaveBeenCalledTimes(3);
  });
});

// ------------------------------------------------- what this leaves alone
describe('what this does not change', () => {
  it('with PARALLEL_VERTICALS_ENABLED off, the tabs are the crawler verticals as before', async () => {
    config.parallel.verticals = false;
    for (const category of ['images', 'videos', 'maps']) {
      const res = await search({ q: 'electric cars', category });
      expect(res.body.data.results).toEqual([]);
      expect(res.body.data.external).toMatchObject({
        provider: 'serpapi',
        status: 'disabled',
        reason: 'disabled'
      });
    }
    expect(parallelSearch).not.toHaveBeenCalled();
  });

  it.each([
    ['Parallel is switched off', { enabled: false }],
    ['Parallel has no key', { apiKey: '' }]
  ])('when %s, nothing is asked', async (_label, settings) => {
    Object.assign(config.parallel, settings);
    const res = await search({ q: 'electric cars', category: 'videos' });
    expect(res.body.data.external).toMatchObject({ provider: 'serpapi', status: 'disabled' });
    expect(parallelSearch).not.toHaveBeenCalled();
  });

  it('Maps shows only places a page describes in structured data (see parallelMaps.test.js)', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        found('https://cars.example/showrooms', 'Electric car showrooms', 'Showrooms list.')
      ]
    });
    page(
      'https://cars.example/showrooms',
      'Electric car showrooms',
      '<p>12 Main Road. GPS 11.0, 77.0</p>'
    );
    const res = await search({ q: 'electric car showrooms', category: 'maps' });
    expect(res.body.data.results).toEqual([]);
    expect(res.body.data.external).toMatchObject({ provider: 'parallel', status: 'ok', count: 0 });
  });

  it('News is the index’s alone', async () => {
    const res = await search({ q: 'electric cars', category: 'news' });
    expect(res.status).toBe(200);
    expect(res.body.data.external).toBeUndefined();
    expect(parallelSearch).not.toHaveBeenCalled();
  });

  it('web search asks Parallel as it always did: its own request, its own cache entry', async () => {
    parallelSearch.mockResolvedValue({
      results: [found('https://cars.example/a', 'Electric cars', 'All about electric cars.')]
    });
    await search({ q: 'electric cars', category: 'videos' });
    const res = await search({ q: 'electric cars' });
    expect(parallelSearch).toHaveBeenCalledTimes(4);
    expect(parallelSearch.mock.calls[3][0]).toEqual({
      objective: 'electric cars',
      searchQueries: ['electric cars'],
      sourcePolicy: {},
      maxResults: 20
    });
    expect(res.body.data.external).toMatchObject({ provider: 'parallel', status: 'ok' });
    // A page from the web answer is a web result, never a video.
    expect(res.body.data.results.every(r => r.source !== 'parallel' || r.category === 'Web')).toBe(
      true
    );
  });

  it('with SerpApi switched on, these tabs are SerpApi’s and Parallel is not asked', async () => {
    config.serpapi.enabled = true;
    const res = await search({ q: 'electric cars', category: 'images' });
    expect(res.body.data.external).toMatchObject({ provider: 'serpapi', status: 'ok' });
    expect(parallelSearch).not.toHaveBeenCalled();
    expect(serp.state.requests.map(r => r.query.engine)).toEqual(['google_images']);
    serp.reset(); // asked on purpose in this one test
  });
});
