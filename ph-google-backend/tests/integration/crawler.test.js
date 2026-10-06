const testDb = require('../helpers/testDb');
const { startFixtureSite } = require('../helpers/fixtureSite');
const { startCrawler } = require('../../crawler/crawler');
const { indexPage } = require('../../crawler/indexer');
const { isAllowed, getCrawlDelayMs, clearRobotsCache } = require('../../crawler/robotsChecker');
const { fetchPageDetailed } = require('../../crawler/pageFetcher');
const Page = require('../../models/Page');
const Term = require('../../models/Term');
const Website = require('../../models/Website');
const { config } = require('../../config/env');

/**
 * Crawler tests run against a local fixture site (tests/helpers/fixtureSite.js),
 * never a real external website.
 */

let site;

beforeAll(async () => {
  await testDb.connect();
  site = await startFixtureSite();
});

afterAll(async () => {
  if (site) await site.close();
  await testDb.disconnect();
});

beforeEach(async () => {
  await testDb.clear();
  clearRobotsCache();
  site.requestLog.length = 0;
});

describe('robots.txt handling', () => {
  it('allows a path that is not disallowed', async () => {
    await expect(isAllowed(`${site.url}/about`)).resolves.toBe(true);
  });

  it('refuses a disallowed path', async () => {
    await expect(isAllowed(`${site.url}/private/secret`)).resolves.toBe(false);
  });

  it('reads the Crawl-delay directive', async () => {
    // The fixture declares Crawl-delay: 0.
    await expect(getCrawlDelayMs(site.url)).resolves.toBeNull();
  });

  it('fetches robots.txt only once per host', async () => {
    await isAllowed(`${site.url}/a`);
    await isAllowed(`${site.url}/b`);
    await isAllowed(`${site.url}/c`);

    const robotsHits = site.requestLog.filter(r => r.path === '/robots.txt');
    expect(robotsHits).toHaveLength(1);
  });

  it('identifies itself with the configured user agent', async () => {
    await isAllowed(site.url);
    expect(site.requestLog[0].userAgent).toContain('PH-SearchBot');
  });

  it('does not assume it is allowed when robots.txt cannot be reached', async () => {
    // Port 1 has nothing listening. The rules are unknown, not absent — a
    // host with no robots.txt at all (a 404) is covered in crawlHardening.
    await expect(isAllowed('http://127.0.0.1:1/page')).resolves.toBe(false);
  });

  it('refuses an unparseable URL rather than crawling it', async () => {
    await expect(isAllowed('not-a-url')).resolves.toBe(false);
  });
});

describe('page fetching', () => {
  it('fetches an HTML page', async () => {
    const res = await fetchPageDetailed(`${site.url}/about`);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.html).toContain('About');
  });

  it('reports an HTTP error instead of throwing', async () => {
    const res = await fetchPageDetailed(`${site.url}/missing`);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('http_error');
    expect(res.status).toBe(404);
  });

  it('follows a redirect and reports the final URL', async () => {
    const res = await fetchPageDetailed(`${site.url}/redirect-me`);
    expect(res.ok).toBe(true);
    expect(res.finalUrl).toContain('/redirect-target');
  });

  it('rejects a non-HTML content type', async () => {
    const res = await fetchPageDetailed(`${site.url}/data.json`);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('unsupported_content_type');
  });

  it('reports a connection failure', async () => {
    const res = await fetchPageDetailed('http://127.0.0.1:1/nothing');
    expect(res.ok).toBe(false);
    expect(['network_error', 'timeout', 'dns_error']).toContain(res.reason);
  });
});

describe('indexing', () => {
  it('stores the page and builds inverted-index postings', async () => {
    const html = `<html lang="en"><head><title>Index Test</title>
      <meta name="description" content="A page about indexing."></head>
      <body><p>indexing indexing search engine</p></body></html>`;

    const result = await indexPage(`${site.url}/index-test`, html, {
      title: 'Index Test',
      description: 'A page about indexing.',
      language: 'en'
    });

    expect(result.ok).toBe(true);

    const page = await Page.findOne({ url: `${site.url}/index-test` });
    expect(page.title).toBe('Index Test');
    expect(page.status).toBe('indexed');
    expect(page.language).toBe('en');
    expect(page.domain).toBe('127.0.0.1');
    expect(page.lastCrawledAt).toBeTruthy();

    const term = await Term.findOne({ word: 'indexing' });
    expect(term.documents).toHaveLength(1);
    // Twice in the body, plus once in the meta description: the title and
    // description are indexed alongside the body text.
    expect(term.documents[0].frequency).toBe(3);
  });

  it('indexes words that appear only in the title', async () => {
    await indexPage(
      `${site.url}/title-only`,
      '<html><head><title>Kangaroo</title></head><body><p>Unrelated body text here.</p></body></html>',
      { title: 'Kangaroo' }
    );

    // A page whose subject is named only in its title must still be findable.
    const term = await Term.findOne({ word: 'kangaroo' });
    expect(term).toBeTruthy();
    expect(term.documents).toHaveLength(1);
  });

  it('stores extracted text rather than raw HTML', async () => {
    await indexPage(
      `${site.url}/text-test`,
      '<html><body><p>Visible text here</p><script>hidden()</script></body></html>',
      {}
    );
    const page = await Page.findOne({ url: `${site.url}/text-test` });

    expect(page.content).toBe('Visible text here');
    expect(page.content).not.toContain('<');
    expect(page.content).not.toContain('hidden');
  });

  it('creates the Website record for a new host', async () => {
    await indexPage(`${site.url}/site-test`, '<html><body>hello world</body></html>', {});
    const website = await Website.findOne({ domain: '127.0.0.1' });
    expect(website).toBeTruthy();
    expect(website.status).toBe('completed');
  });

  it('updates rather than duplicates a page on re-crawl', async () => {
    const url = `${site.url}/recrawl`;
    await indexPage(url, '<html><body>original content alpha</body></html>', { title: 'First' });
    await indexPage(url, '<html><body>updated content beta</body></html>', { title: 'Second' });

    expect(await Page.countDocuments({ url })).toBe(1);
    const page = await Page.findOne({ url });
    expect(page.title).toBe('Second');
    expect(page.content).toContain('beta');
  });

  it('removes stale postings when a re-crawl drops a word', async () => {
    const url = `${site.url}/stale`;
    await indexPage(url, '<html><body>alpha beta</body></html>', {});

    let alpha = await Term.findOne({ word: 'alpha' });
    expect(alpha.documents).toHaveLength(1);

    // "alpha" is gone from the new version of the page.
    await indexPage(url, '<html><body>gamma delta</body></html>', {});

    alpha = await Term.findOne({ word: 'alpha' });
    expect(alpha.documents).toHaveLength(0);

    const gamma = await Term.findOne({ word: 'gamma' });
    expect(gamma.documents).toHaveLength(1);
  });

  it('does not create duplicate postings for the same page and word', async () => {
    const url = `${site.url}/dupe`;
    await indexPage(url, '<html><body>repeat repeat</body></html>', {});
    await indexPage(url, '<html><body>repeat repeat repeat</body></html>', {});

    const term = await Term.findOne({ word: 'repeat' });
    expect(term.documents).toHaveLength(1);
    expect(term.documents[0].frequency).toBe(3);
  });

  it('reports failure for an invalid URL instead of throwing', async () => {
    const result = await indexPage('not-a-valid-url', '<html><body>x</body></html>', {});
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('crawl runs', () => {
  it('crawls, extracts links and indexes pages', async () => {
    const stats = await startCrawler(site.url, 5, { crawlDelayMs: 0 });

    expect(stats.pagesCrawled).toBeGreaterThan(1);
    expect(stats.pagesIndexed).toBeGreaterThan(1);
    expect(stats.pagesDiscovered).toBeGreaterThan(stats.pagesCrawled);

    const pages = await Page.find().lean();
    expect(pages.length).toBe(stats.pagesIndexed);
    // Followed the link from the home page to /about.
    expect(pages.map(p => p.url)).toContain(`${site.url}/about`);
  });

  it('never exceeds maxPages', async () => {
    const stats = await startCrawler(site.url, 2, { crawlDelayMs: 0 });
    expect(stats.pagesCrawled).toBe(2);
    expect(await Page.countDocuments()).toBeLessThanOrEqual(2);
  });

  it('respects robots.txt during a crawl', async () => {
    await startCrawler(site.url, 10, { crawlDelayMs: 0 });

    // /private/secret is linked from the home page but disallowed.
    expect(await Page.countDocuments({ url: `${site.url}/private/secret` })).toBe(0);
    expect(site.requestLog.some(r => r.path === '/private/secret')).toBe(false);
  });

  it('can be told to ignore robots.txt', async () => {
    const stats = await startCrawler(site.url, 10, { crawlDelayMs: 0, respectRobots: false });
    expect(stats.skippedByRobots).toBe(0);
    expect(await Page.countDocuments({ url: `${site.url}/private/secret` })).toBe(1);
  });

  it('counts a disallowed page as skipped, not failed', async () => {
    const stats = await startCrawler(site.url, 10, { crawlDelayMs: 0 });
    expect(stats.skippedByRobots).toBeGreaterThan(0);
  });

  it('never requests the same URL twice', async () => {
    await startCrawler(site.url, 10, { crawlDelayMs: 0 });

    const pageRequests = site.requestLog.filter(r => r.path !== '/robots.txt').map(r => r.path);
    expect(new Set(pageRequests).size).toBe(pageRequests.length);
  });

  it('records a failed fetch without aborting the crawl', async () => {
    const stats = await startCrawler(site.url, 10, { crawlDelayMs: 0 });

    // /missing returns 404 and is linked from the home page.
    expect(stats.failedPages).toBeGreaterThan(0);
    expect(stats.failures.some(f => f.reason === 'http_error')).toBe(true);
    // The crawl still completed other pages.
    expect(stats.pagesIndexed).toBeGreaterThan(1);
  });

  it('skips a non-HTML response', async () => {
    await startCrawler(site.url, 10, { crawlDelayMs: 0 });
    expect(await Page.countDocuments({ url: `${site.url}/data.json` })).toBe(0);
  });

  it('indexes a redirected page under its final URL', async () => {
    await startCrawler(site.url, 10, { crawlDelayMs: 0 });

    expect(await Page.countDocuments({ url: `${site.url}/redirect-target` })).toBe(1);
    expect(await Page.countDocuments({ url: `${site.url}/redirect-me` })).toBe(0);
  });

  it('stays on the seed domain by default', async () => {
    await startCrawler(site.url, 10, { crawlDelayMs: 0 });

    const pages = await Page.find().lean();
    // external.example.org is linked from the home page but must not be crawled.
    expect(pages.every(p => p.domain === '127.0.0.1')).toBe(true);
    expect(pages.some(p => p.url.includes('external.example.org'))).toBe(false);
  });

  it('honours maxDepth', async () => {
    // Depth 0 crawls the seed only; its links are never enqueued.
    const stats = await startCrawler(site.url, 10, { crawlDelayMs: 0, maxDepth: 0 });
    expect(stats.pagesCrawled).toBe(1);
    expect(await Page.countDocuments()).toBe(1);
  });

  it('stops gracefully when asked, without killing the process', async () => {
    let calls = 0;
    const stats = await startCrawler(site.url, 10, {
      crawlDelayMs: 0,
      // Request a stop after the first page.
      shouldStop: () => {
        calls += 1;
        return calls > 1;
      }
    });

    expect(stats.stopped).toBe(true);
    expect(stats.pagesCrawled).toBe(1);
    // The process is still alive and the DB reflects the partial crawl.
    expect(await Page.countDocuments()).toBe(1);
  });

  it('reports progress as it goes', async () => {
    const snapshots = [];
    await startCrawler(site.url, 3, {
      crawlDelayMs: 0,
      onProgress: s => {
        snapshots.push(s.pagesCrawled);
      }
    });

    expect(snapshots.length).toBeGreaterThan(1);
    // Progress never goes backwards.
    expect(snapshots).toEqual([...snapshots].sort((a, b) => a - b));
  });

  it('does not let a progress callback failure break the crawl', async () => {
    const stats = await startCrawler(site.url, 2, {
      crawlDelayMs: 0,
      onProgress: () => {
        throw new Error('callback exploded');
      }
    });
    expect(stats.pagesCrawled).toBe(2);
  });

  it('handles an invalid seed URL without throwing', async () => {
    const stats = await startCrawler('not-a-url', 5, { crawlDelayMs: 0 });
    expect(stats.pagesCrawled).toBe(0);
    expect(stats.failures[0].reason).toBe('invalid_seed_url');
  });

  it('handles an unreachable seed without throwing', async () => {
    const stats = await startCrawler('http://127.0.0.1:1/', 3, { crawlDelayMs: 0 });
    expect(stats.pagesCrawled).toBe(0);
    expect(stats.failedPages).toBe(1);
  });

  it('clamps maxPages to the configured hard limit', async () => {
    // Against the configured limit rather than a literal: the limit is an
    // operator's choice and was raised from 200 to 10000 when the crawler
    // moved to a worker, so a hardcoded number tests the old config, not
    // the clamp.
    const stats = await startCrawler(site.url, config.crawler.maxPagesHardLimit + 1, {
      crawlDelayMs: 0,
      maxDepth: 0
    });
    expect(stats.maxPages).toBe(config.crawler.maxPagesHardLimit);
  });

  it('can run twice in the same process — the queue is not shared', async () => {
    const first = await startCrawler(site.url, 3, { crawlDelayMs: 0 });
    expect(first.pagesCrawled).toBe(3);

    // A second run must re-visit the same URLs, not skip them as "seen".
    const second = await startCrawler(site.url, 3, { crawlDelayMs: 0 });
    expect(second.pagesCrawled).toBe(3);
    expect(second.pagesIndexed).toBe(3);
  });

  it('applies a politeness delay between requests', async () => {
    const startedAt = Date.now();
    await startCrawler(site.url, 3, { crawlDelayMs: 150 });
    // Two gaps between three pages.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
  });
});
