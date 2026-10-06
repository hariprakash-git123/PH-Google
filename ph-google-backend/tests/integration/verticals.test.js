const request = require('supertest');
const testDb = require('../helpers/testDb');
const { indexPage } = require('../../crawler/indexer');
const Media = require('../../models/Media');
const Place = require('../../models/Place');
const Page = require('../../models/Page');

/**
 * Image, video, news and map search.
 *
 * Every fixture below is indexed through the real crawler indexer, so these
 * tests exercise the same extraction -> storage -> retrieval path a live
 * crawl uses.
 */

let app;

beforeAll(async () => {
  await testDb.connect();
  app = require('../../app').createApp();
});
afterAll(async () => {
  await testDb.disconnect();
});
beforeEach(async () => {
  await testDb.clear();
});

const search = params => request(app).get('/api/search').query(params);

/** A page with photographs, a video, article markup and coordinates. */
const CITY_PAGE = `
<html lang="en">
  <head>
    <title>Paris - City Guide</title>
    <meta name="description" content="A guide to Paris landmarks.">
    <meta property="og:type" content="article">
    <meta property="article:published_time" content="2026-09-01T08:00:00Z">
    <meta name="author" content="Ada Traveller">
    <meta property="og:site_name" content="City Guides">
    <meta property="og:image" content="https://cdn.example.com/paris-hero.jpg">
  </head>
  <body>
    <h1>Paris</h1>
    <p>Paris is the capital of France and home to the Eiffel Tower.</p>
    <figure>
      <img src="/images/eiffel-tower.jpg" alt="The Eiffel Tower at sunset" width="1200" height="800">
      <figcaption>The Eiffel Tower seen from the Champ de Mars</figcaption>
    </figure>
    <img src="/images/louvre-museum.jpg" alt="The Louvre museum pyramid" width="900" height="600">
    <img src="/icons/icon-menu.png" alt="menu" width="16" height="16">
    <iframe src="https://www.youtube.com/embed/abcdefghijk" title="Paris walking tour"></iframe>
    <span class="geo">48.8566; 2.3522</span>
  </body>
</html>`;

/** A second page, for domain filtering and multi-source tests. */
const TOKYO_PAGE = `
<html lang="en">
  <head>
    <title>Tokyo - Travel</title>
    <meta name="description" content="Tokyo travel notes.">
  </head>
  <body>
    <img src="/photos/tokyo-tower.jpg" alt="Tokyo Tower lit at night" width="1000" height="700">
    <video src="/clips/tokyo-streets.mp4" poster="/clips/poster.jpg" title="Tokyo streets at night"></video>
    <span class="geo">35.6897; 139.6922</span>
  </body>
</html>`;

async function seedFixtures() {
  await indexPage('https://cityguides.example.com/paris', CITY_PAGE, {
    title: 'Paris - City Guide',
    description: 'A guide to Paris landmarks.',
    language: 'en'
  });
  await indexPage('https://travel.example.org/tokyo', TOKYO_PAGE, {
    title: 'Tokyo - Travel',
    description: 'Tokyo travel notes.',
    language: 'en'
  });
}

describe('indexing the verticals', () => {
  beforeEach(seedFixtures);

  it('stores content images and rejects icons', async () => {
    const images = await Media.find({ type: 'image' }).lean();
    const urls = images.map(i => i.url);

    expect(urls).toEqual(
      expect.arrayContaining([
        'https://cityguides.example.com/images/eiffel-tower.jpg',
        'https://cityguides.example.com/images/louvre-museum.jpg'
      ])
    );
    // The 16x16 menu icon is chrome, not content.
    expect(urls.some(u => u.includes('icon-menu'))).toBe(false);
  });

  it('keeps alt text, caption and dimensions', async () => {
    const image = await Media.findOne({ url: /eiffel-tower/ }).lean();
    expect(image).toMatchObject({
      alt: 'The Eiffel Tower at sunset',
      caption: 'The Eiffel Tower seen from the Champ de Mars',
      width: 1200,
      height: 800,
      format: 'jpg',
      domain: 'cityguides.example.com'
    });
    expect(image.terms).toEqual(expect.arrayContaining(['eiffel', 'tower', 'sunset']));
  });

  it('stores videos with their provider and thumbnail', async () => {
    const youtube = await Media.findOne({ type: 'video', provider: 'youtube' }).lean();
    expect(youtube).toMatchObject({
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      providerId: 'abcdefghijk',
      thumbnailUrl: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg'
    });

    const native = await Media.findOne({ type: 'video', provider: 'native' }).lean();
    expect(native.url).toBe('https://travel.example.org/clips/tokyo-streets.mp4');
  });

  it('records article metadata on the page', async () => {
    const page = await Page.findOne({ url: 'https://cityguides.example.com/paris' }).lean();
    expect(page).toMatchObject({
      isArticle: true,
      author: 'Ada Traveller',
      siteName: 'City Guides',
      imageUrl: 'https://cdn.example.com/paris-hero.jpg'
    });
    expect(page.publishedAt).toBeTruthy();
    expect(page.imageCount).toBeGreaterThan(0);
  });

  it('stores places with a GeoJSON point', async () => {
    const place = await Place.findOne({ name: /Paris/ }).lean();
    expect(place).toMatchObject({ latitude: 48.8566, longitude: 2.3522 });
    expect(place.location).toEqual({ type: 'Point', coordinates: [2.3522, 48.8566] });
  });

  it('replaces a page media on re-crawl instead of duplicating it', async () => {
    const before = await Media.countDocuments({ type: 'image' });
    await indexPage('https://cityguides.example.com/paris', CITY_PAGE, {
      title: 'Paris - City Guide'
    });
    expect(await Media.countDocuments({ type: 'image' })).toBe(before);
  });

  it('removes media that is gone after a re-crawl', async () => {
    await indexPage(
      'https://cityguides.example.com/paris',
      '<html><body><img src="/images/new-photo.jpg" alt="A new photo" width="800" height="600"></body></html>',
      { title: 'Paris - City Guide' }
    );
    expect(await Media.countDocuments({ url: /eiffel-tower/ })).toBe(0);
    expect(await Media.countDocuments({ url: /new-photo/ })).toBe(1);
  });
});

describe('GET /api/search?category=images', () => {
  beforeEach(seedFixtures);

  it('returns real image results', async () => {
    const res = await search({ q: 'eiffel tower', category: 'images' });

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBeGreaterThan(0);
    expect(res.body.data.indexed).toBe(true);

    const top = res.body.data.results[0];
    expect(top).toEqual(
      expect.objectContaining({
        type: 'image',
        url: expect.stringContaining('eiffel-tower'),
        title: expect.any(String),
        sourcePage: 'https://cityguides.example.com/paris',
        dimensions: '1200×800',
        format: 'JPG'
      })
    );
  });

  it('matches on caption text as well as alt text', async () => {
    const res = await search({ q: 'champ de mars', category: 'images' });
    expect(res.body.data.total).toBeGreaterThan(0);
  });

  it('every result links back to the page it was found on', async () => {
    const res = await search({ q: 'tower', category: 'images' });
    for (const item of res.body.data.results) {
      expect(item.sourcePage).toMatch(/^https?:\/\//);
    }
  });

  it('filters images by domain', async () => {
    const res = await search({ q: 'tower', category: 'images', domain: 'travel.example.org' });
    expect(res.body.data.results.every(r => r.domain === 'travel.example.org')).toBe(true);
  });

  it('paginates', async () => {
    const res = await search({ q: 'tower', category: 'images', limit: 1 });
    expect(res.body.data.results).toHaveLength(1);
    expect(res.body.data.pagination.limit).toBe(1);
  });

  it('returns an empty set for a query nothing matches', async () => {
    const res = await search({ q: 'submarine', category: 'images' });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });
});

describe('GET /api/search?category=videos', () => {
  beforeEach(seedFixtures);

  it('returns real video results with a playable embed', async () => {
    const res = await search({ q: 'paris walking tour', category: 'videos' });

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBeGreaterThan(0);

    const youtube = res.body.data.results.find(r => r.provider === 'youtube');
    expect(youtube).toEqual(
      expect.objectContaining({
        type: 'video',
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        // A privacy-preserving embed host.
        embedUrl: 'https://www.youtube-nocookie.com/embed/abcdefghijk',
        thumbnailUrl: expect.stringContaining('ytimg.com')
      })
    );
  });

  it('returns a native video with no embed URL', async () => {
    const res = await search({ q: 'tokyo streets', category: 'videos' });
    const native = res.body.data.results.find(r => r.provider === 'native');
    expect(native.embedUrl).toBe('');
    expect(native.url).toContain('.mp4');
  });

  it('does not mix images into the video vertical', async () => {
    const res = await search({ q: 'tower', category: 'videos' });
    expect(res.body.data.results.every(r => r.type === 'video')).toBe(true);
  });
});

describe('GET /api/search?category=news', () => {
  beforeEach(seedFixtures);

  it('returns only pages marked as articles', async () => {
    const res = await search({ q: 'paris', category: 'news' });

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.results[0]).toEqual(
      expect.objectContaining({
        title: 'Paris - City Guide',
        source: 'City Guides',
        author: 'Ada Traveller',
        imageUrl: 'https://cdn.example.com/paris-hero.jpg'
      })
    );
    expect(res.body.data.results[0].time).toBeTruthy();
  });

  it('excludes a page with no article markup', async () => {
    // The Tokyo page matches "tokyo" in web search but is not an article.
    const web = await search({ q: 'tokyo', category: 'all' });
    expect(web.body.data.total).toBeGreaterThan(0);

    const news = await search({ q: 'tokyo', category: 'news' });
    expect(news.body.data.total).toBe(0);
  });

  it('defaults to newest first', async () => {
    const res = await search({ q: 'paris', category: 'news' });
    expect(res.body.data.sort).toBe('relevance'); // the request's own sort value
    expect(res.body.data.results).toHaveLength(1);
  });
});

describe('GET /api/search?category=maps', () => {
  beforeEach(seedFixtures);

  it('returns places with coordinates and a map embed', async () => {
    const res = await search({ q: 'paris', category: 'maps' });

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBeGreaterThan(0);

    const place = res.body.data.results[0];
    expect(place).toEqual(
      expect.objectContaining({
        name: expect.stringContaining('Paris'),
        latitude: 48.8566,
        longitude: 2.3522
      })
    );
    // Key-free OpenStreetMap links.
    expect(place.mapUrl).toContain('openstreetmap.org');
    expect(place.embedUrl).toContain('openstreetmap.org/export/embed.html');
  });

  it('finds a different place for a different query', async () => {
    const res = await search({ q: 'tokyo', category: 'maps' });
    expect(res.body.data.results[0].latitude).toBeCloseTo(35.6897, 3);
  });

  it('returns nothing for a place that is not indexed', async () => {
    const res = await search({ q: 'reykjavik', category: 'maps' });
    expect(res.body.data.results).toEqual([]);
  });
});

describe('vertical search plumbing', () => {
  beforeEach(seedFixtures);

  it('reports real per-vertical counts in the search config', async () => {
    const res = await request(app).get('/api/search/config');

    expect(res.status).toBe(200);
    expect(res.body.data.indexedCategories).toEqual(
      expect.arrayContaining(['all', 'images', 'videos', 'news', 'maps'])
    );
    expect(res.body.data.counts.images).toBeGreaterThan(0);
    expect(res.body.data.counts.videos).toBeGreaterThan(0);
    expect(res.body.data.counts.maps).toBeGreaterThan(0);
    expect(res.body.data.counts.news).toBe(1);
  });

  it('records analytics for a vertical search', async () => {
    const SearchLog = require('../../models/SearchLog');
    await search({ q: 'eiffel', category: 'images' });

    const log = await SearchLog.findOne({ normalizedQuery: 'eiffel' }).lean();
    expect(log).toBeTruthy();
    expect(log.filters.category).toBe('images');
    expect(log.resultCount).toBeGreaterThan(0);
  });

  it('rejects an unknown category', async () => {
    const res = await search({ q: 'paris', category: 'podcasts' });
    expect(res.status).toBe(400);
  });

  it('returns an empty set rather than erroring on a blank query', async () => {
    for (const category of ['images', 'videos', 'news', 'maps']) {
      const res = await search({ q: '', category });
      expect(res.status).toBe(200);
      expect(res.body.data.results).toEqual([]);
    }
  });

  it('does not treat a vertical query as a regular expression', async () => {
    const res = await search({ q: '.*', category: 'images' });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
  });

  it('removes a page media and places when the page is removed', async () => {
    const { removePageFromIndex } = require('../../crawler/indexer');
    const page = await Page.findOne({ url: 'https://cityguides.example.com/paris' });

    await removePageFromIndex(page._id);

    expect(await Media.countDocuments({ pageId: page._id })).toBe(0);
    expect(await Place.countDocuments({ pageId: page._id })).toBe(0);
  });
});
