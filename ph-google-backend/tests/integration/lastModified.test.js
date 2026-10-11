const http = require('http');
const request = require('supertest');
const testDb = require('../helpers/testDb');
const { crawlOne } = require('../../crawler/crawlWorker');
const { clearRobotsCache } = require('../../crawler/robotsChecker');
const Page = require('../../models/Page');

/**
 * The source's Last-Modified date, from the crawl to the search result.
 *
 * A small local server stands in for a website: each test decides what its
 * Last-Modified header says. The page is crawled with the real worker and
 * indexer (the legacy engine in this suite), then searched. Nothing outside
 * this machine is contacted.
 */

const DAY = 24 * 60 * 60 * 1000;
const httpDate = ms => new Date(ms).toUTCString();

let server;
let base;
let lastModified; // what the next response sends (undefined: no header)

const PAGE = `<!doctype html><html lang="en"><head>
<title>Lighthouse keeping guide</title>
<meta name="description" content="How lighthouse keepers tended the lamp.">
</head><body><h1>Lighthouse keeping</h1>
<p>Lighthouse keepers trimmed wicks, polished lenses and kept the lamp burning through the night.</p>
<p>Every lighthouse kept a log of weather and passing ships.</p></body></html>`;

beforeAll(async () => {
  await testDb.connect();
  server = http.createServer((req, res) => {
    const headers = { 'Content-Type': 'text/html; charset=utf-8' };
    if (lastModified !== undefined) headers['Last-Modified'] = lastModified;
    res.writeHead(200, headers);
    res.end(PAGE);
  });
  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise(resolve => {
    server.close(resolve);
  });
  await testDb.disconnect();
});
beforeEach(async () => {
  await testDb.clear();
  clearRobotsCache();
  lastModified = undefined;
});

const crawl = async () => {
  const result = await crawlOne(`${base}/lighthouse`, { respectRobots: false });
  expect(result.outcome).toBe('indexed');
  return Page.findOne({ url: { $regex: '/lighthouse$' } }).lean();
};
const searchResult = async () => {
  const app = require('../../app').createApp();
  const res = await request(app).get('/api/search').query({ q: 'lighthouse keeping' });
  return res.body.data.results[0];
};

describe('a page whose server sends a credible Last-Modified', () => {
  it('stores it, and the result shows it as "Modified …" beside the crawl date', async () => {
    const when = Date.now() - 3 * DAY;
    lastModified = httpDate(when);
    const page = await crawl();
    expect(page.modifiedAt.toISOString()).toBe(
      new Date(Math.floor(when / 1000) * 1000).toISOString()
    );

    const result = await searchResult();
    expect(result.modifiedAt).toBe(page.modifiedAt.toISOString());
    expect(result.modifiedLabel).toEqual({
      at: page.modifiedAt.toISOString(),
      text: 'Modified 3 days ago'
    });
    // The crawl date is still shown, as itself.
    expect(result.dateLabel).toMatchObject({ kind: 'crawled', text: 'Crawled just now' });
  });

  it('an old date reads as the date itself', async () => {
    lastModified = 'Sun, 06 Nov 2022 08:49:37 GMT';
    await crawl();
    const result = await searchResult();
    expect(result.modifiedLabel.text).toBe('Modified Nov 6, 2022');
  });
});

describe('no date, or none that can be trusted: none is stored or shown', () => {
  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['not a date', 'yesterday'],
    ['an ISO date (not an HTTP-date)', '2026-01-02'],
    ['a date in the future', () => httpDate(Date.now() + 30 * DAY)],
    ['"now", stamped on a generated page', () => httpDate(Date.now())],
    ['before the web', 'Thu, 01 Jan 1970 00:00:00 GMT']
  ])('%s', async (_label, value) => {
    lastModified = typeof value === 'function' ? value() : value;
    const page = await crawl();
    expect(page.modifiedAt).toBeNull();
    // The crawl time is not put in its place.
    expect(page.lastCrawledAt).toBeInstanceOf(Date);
    const result = await searchResult();
    expect(result.modifiedAt).toBeNull();
    expect(result.modifiedLabel).toBeNull();
    expect(result.dateLabel.kind).toBe('crawled');
  });
});

describe('re-crawling', () => {
  it('replaces the date with the new one, and clears it when the server stops sending one', async () => {
    lastModified = httpDate(Date.now() - 10 * DAY);
    const first = await crawl();
    expect(first.modifiedAt).not.toBeNull();

    lastModified = httpDate(Date.now() - 2 * DAY);
    const second = await crawl();
    expect(second.modifiedAt.getTime()).toBeGreaterThan(first.modifiedAt.getTime());
    expect(String(second._id)).toBe(String(first._id)); // the same page, updated

    lastModified = undefined;
    const third = await crawl();
    expect(third.modifiedAt).toBeNull();
    expect(third.title).toBe('Lighthouse keeping guide'); // nothing else lost
  });

  it('a page stored before this field existed reads as having no date', async () => {
    await crawl();
    await Page.updateOne({}, { $unset: { modifiedAt: 1 } });
    const raw = await Page.collection.findOne({});
    expect('modifiedAt' in raw).toBe(false);
    const result = await searchResult();
    expect(result.modifiedAt).toBeNull();
    expect(result.modifiedLabel).toBeNull();
  });
});
