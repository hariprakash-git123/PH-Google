const testDb = require('../helpers/testDb');
const { startHardeningSite } = require('../helpers/hardeningSite');
const { urlsetXml } = require('../helpers/fixtureSite');
const { clearRobotsCache } = require('../../crawler/robotsChecker');
const { resolveDelayMs, clearHostPolicyCache } = require('../../crawler/hostPolicy');
const { processHost, crawlOne } = require('../../crawler/crawlWorker');
const frontier = require('../../services/frontierService');
const maintenance = require('../../services/crawlMaintenanceService');
const CrawlFrontier = require('../../models/CrawlFrontier');
const CrawlJob = require('../../models/CrawlJob');
const Page = require('../../models/Page');
const { normalizeUrl, canonicalKey } = require('../../utils/urlNormalizer');
const { config } = require('../../config/env');

/**
 * Regression tests for the two faults the isolated real-HTTP validation of
 * Phase 6C found:
 *
 *   1. a redirect to a page already crawled fetched that page again and
 *      charged the job a second page for it;
 *   2. a crawl job's own delay overrode a site's longer Crawl-delay, so the
 *      crawler asked faster than the site allowed.
 *
 * Local fixture and in-memory MongoDB only.
 */

let site;
let host;
const saved = {};
const SETTINGS = [
  'maxDelayMs',
  'defaultDelayMs',
  'continuous',
  'continuousMaxContinuations',
  'sitemaps'
];

beforeAll(async () => {
  await testDb.connect();
  site = await startHardeningSite();
  host = frontier.hostOf(site.url);
  for (const key of SETTINGS) saved[key] = config.crawler[key];
});

afterAll(async () => {
  for (const key of SETTINGS) config.crawler[key] = saved[key];
  if (site) await site.close();
  await testDb.disconnect();
});

beforeEach(async () => {
  await testDb.clear();
  clearRobotsCache();
  clearHostPolicyCache();
  site.reset();
  for (const key of SETTINGS) config.crawler[key] = saved[key];
});

const abs = path => normalizeUrl(`${site.url}${path}`);
const hits = path => site.hits[path] || 0;
const row = path => CrawlFrontier.findOne({ canonicalKey: canonicalKey(abs(path)) }).lean();
const reload = job => CrawlJob.findById(job._id).lean();
const robots = extra => ({ status: 200, body: `${site.DEFAULT_ROBOTS}${extra}` });
const delayRobots = seconds => ({
  status: 200,
  body: `User-agent: *\nDisallow: /private/\nCrawl-delay: ${seconds}\n`
});

/** A running job. `seeds` are [path, priority] pairs, fetched highest first. */
async function startJob({ seeds, maxPages = 10, maxDepth = 3, crawlDelayMs = 0, ...scope }) {
  const job = await CrawlJob.create({
    seedUrl: normalizeUrl(site.url),
    maxPages,
    maxDepth,
    sameDomainOnly: true,
    crawlDelayMs,
    status: 'running',
    lastHeartbeatAt: new Date(),
    ...scope
  });
  await frontier.addUrls(
    seeds.map(([path, priority]) => ({ url: abs(path), depth: 0, priority })),
    { crawlJobId: job._id }
  );
  return job;
}

async function drain(rounds = 10) {
  let summary;
  for (let i = 0; i < rounds; i += 1) {
    summary = await processHost({ host, maxPages: 10 });
    if (!summary.hasMore) break;
  }
  return summary;
}

/** The job-handling steps of one maintenance pass; the rest needs Redis. */
async function sweep() {
  await frontier.reclaimStaleLeases();
  await maintenance.finaliseCompletedJobs();
  await maintenance.skipRowsOfClosedJobs();
}

// ---------------------------------------------------------------------------
describe('isFreshlyCrawled', () => {
  const url = 'https://example.com/page';

  it('is false for a URL the frontier does not know', async () => {
    expect(await frontier.isFreshlyCrawled(url)).toBe(false);
    expect(await frontier.isFreshlyCrawled('not a url')).toBe(false);
  });

  it('is false while the URL is only pending', async () => {
    await frontier.addUrls([{ url }]);
    expect(await frontier.isFreshlyCrawled(url)).toBe(false);
  });

  it('is true once it is crawled, under any spelling of the same page', async () => {
    await frontier.addUrls([{ url }]);
    await frontier.markDone(url);
    expect(await frontier.isFreshlyCrawled(url)).toBe(true);
    expect(await frontier.isFreshlyCrawled('http://www.example.com/page/?utm_source=x')).toBe(true);
  });

  it('is false again when the page is due for its re-crawl', async () => {
    await frontier.addUrls([{ url }]);
    await frontier.markDone(url);
    await CrawlFrontier.updateOne({ url }, { $set: { nextCrawlAt: new Date(Date.now() - 1000) } });
    expect(await frontier.isFreshlyCrawled(url)).toBe(false);
  });

  it('is false for a failed or skipped URL', async () => {
    await frontier.addUrls([{ url }, { url: 'https://example.com/other' }]);
    await frontier.markFailed(url, { reason: 'http_error', retryable: false });
    await frontier.markSkipped('https://example.com/other', 'robots_txt');
    expect(await frontier.isFreshlyCrawled(url)).toBe(false);
    expect(await frontier.isFreshlyCrawled('https://example.com/other')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('a redirect to a page that is already crawled', () => {
  it('A/B. is not followed: one fetch in total, one page charged', async () => {
    // /final first, then the URL that redirects to it.
    const job = await startJob({
      seeds: [
        ['/final', 1000],
        ['/redir/same', 900]
      ]
    });

    const summary = await drain();

    expect(hits('/final')).toBe(1);
    expect(hits('/redir/same')).toBe(1);
    expect(await Page.countDocuments()).toBe(1);
    expect(await row('/redir/same')).toMatchObject({
      status: 'skipped',
      lastError: 'redirect_duplicate'
    });
    expect(await row('/final')).toMatchObject({ status: 'done' });
    expect(summary.reasons).toEqual({ redirect_duplicate: 1 });
    expect(await reload(job)).toMatchObject({ pagesCrawled: 1, pagesIndexed: 1, failedPages: 0 });
  });

  it('C. is followed when the destination is due for its re-crawl', async () => {
    const first = await startJob({ seeds: [['/final', 1000]] });
    await drain();
    await sweep();
    expect((await reload(first)).status).toBe('completed');
    // The page falls due. Its row is still `done`; nothing has re-queued it.
    await CrawlFrontier.updateOne(
      { canonicalKey: canonicalKey(abs('/final')) },
      { $set: { nextCrawlAt: new Date(Date.now() - 1000) } }
    );

    const second = await startJob({ seeds: [['/redir/same', 1000]] });
    await drain();

    expect(hits('/final')).toBe(2);
    expect(await row('/redir/same')).toMatchObject({ status: 'done' });
    const destination = await row('/final');
    expect(destination.status).toBe('done');
    expect(destination.nextCrawlAt.getTime()).toBeGreaterThan(Date.now());
    expect((await reload(second)).pagesCrawled).toBe(1);
  });

  it('D. is followed when the destination is only pending, which is then not fetched again', async () => {
    const job = await startJob({
      seeds: [
        ['/redir/same', 1000],
        ['/final', 900]
      ]
    });

    await drain();

    expect(hits('/final')).toBe(1);
    expect(await row('/redir/same')).toMatchObject({ status: 'done' });
    expect(await row('/final')).toMatchObject({ status: 'done' });
    expect(await reload(job)).toMatchObject({ pagesCrawled: 1, pagesIndexed: 1 });
  });

  it('D. charges the job that fetched, when the pending destination belongs to another job', async () => {
    const owner = await startJob({ seeds: [['/final', 100]] });
    const other = await startJob({ seeds: [['/redir/same', 1000]] });

    await drain();

    expect(hits('/final')).toBe(1);
    // One fetch, one page charged — to the job whose URL was being crawled.
    expect((await reload(other)).pagesCrawled).toBe(1);
    expect((await reload(owner)).pagesCrawled).toBe(0);
    const destination = await row('/final');
    expect(destination.status).toBe('done');
    // The row stays the owner's: only its state changed.
    expect(String(destination.crawlJobId)).toBe(String(owner._id));
  });

  it('E. on another host, adds no work and fetches nothing', async () => {
    const elsewhere = normalizeUrl(`${site.otherHostUrl}/elsewhere`);
    await frontier.markFetchedAs(elsewhere);
    const job = await startJob({
      seeds: [['/redir/cross', 1000]],
      allowedDomains: ['127.0.0.1', 'localhost']
    });

    await drain();

    expect(hits('/elsewhere')).toBe(0);
    expect(await CrawlFrontier.countDocuments()).toBe(2);
    expect(await CrawlFrontier.findOne({ url: elsewhere }).lean()).toMatchObject({
      status: 'done'
    });
    expect(await row('/redir/cross')).toMatchObject({ status: 'skipped', lastError: 'redirect' });
    expect((await reload(job)).pagesCrawled).toBe(0);
  });

  it('F. stops a redirect chain before its already-crawled end', async () => {
    const job = await startJob({
      seeds: [
        ['/final', 1000],
        ['/redir/chain1', 900]
      ]
    });

    await drain();

    expect(hits('/final')).toBe(1);
    // The hops themselves were made; only the last one was not.
    expect([hits('/redir/chain1'), hits('/redir/chain2'), hits('/redir/chain3')]).toEqual([
      1, 1, 1
    ]);
    expect(await row('/redir/chain1')).toMatchObject({
      status: 'skipped',
      lastError: 'redirect_duplicate'
    });
    expect((await reload(job)).pagesCrawled).toBe(1);
  });

  it('F. still follows a chain to a page not yet crawled', async () => {
    const job = await startJob({ seeds: [['/redir/chain1', 1000]] });
    await drain();

    expect(hits('/final')).toBe(1);
    expect(await row('/redir/chain1')).toMatchObject({ status: 'done' });
    expect((await reload(job)).pagesCrawled).toBe(1);
  });

  it('G. still detects a redirect loop', async () => {
    const job = await startJob({
      seeds: [
        ['/final', 1000],
        ['/redir/loop-a', 900],
        ['/redir/self', 800]
      ]
    });

    await drain();

    for (const path of ['/redir/loop-a', '/redir/self']) {
      expect(await row(path)).toMatchObject({
        status: 'failed',
        lastError: 'redirect_loop',
        attempts: 1
      });
    }
    expect(await reload(job)).toMatchObject({ pagesCrawled: 1, failedPages: 2 });
  });

  it('still refuses a redirect out of scope or into a disallowed path', async () => {
    await startJob({
      seeds: [
        ['/redir/excluded', 1000],
        ['/redir/private', 900]
      ],
      excludePatterns: ['/excluded/']
    });

    await drain();

    expect(hits('/excluded/page') + hits('/private/secret')).toBe(0);
    expect((await row('/redir/excluded')).lastError).toBe('redirect_out_of_scope');
    expect((await row('/redir/private')).lastError).toBe('redirect_robots_txt');
  });

  it('H. costs a continuation job nothing', async () => {
    config.crawler.continuous = true;
    config.crawler.continuousMaxContinuations = 3;
    const root = await startJob({
      maxPages: 1,
      seeds: [
        ['/final', 1000],
        ['/redir/same', 900]
      ]
    });

    // The root job crawls /final and has no budget left for the redirect.
    await drain();
    expect(await row('/redir/same')).toMatchObject({ status: 'pending' });
    await sweep();
    const child = await CrawlJob.findOne({ chainId: root._id }).lean();
    expect(child).toBeTruthy();

    await drain();

    expect(hits('/final')).toBe(1);
    expect(await row('/redir/same')).toMatchObject({
      status: 'skipped',
      lastError: 'redirect_duplicate'
    });
    expect((await reload(root)).pagesCrawled).toBe(1);
    expect((await CrawlJob.findById(child._id).lean()).pagesCrawled).toBe(0);
  });

  describe('I. with a destination the sitemap discovered', () => {
    beforeEach(() => {
      config.crawler.sitemaps = true;
      site.robots = robots(`Sitemap: ${site.url}/sitemap.xml\n`);
      site.sitemap = urlsetXml([`${site.url}/final`]);
    });

    it('follows the redirect while the sitemap URL is still pending, and fetches it once', async () => {
      const job = await startJob({
        seeds: [
          ['/hidden', 1000],
          ['/redir/same', 900]
        ],
        sitemaps: true
      });

      await drain();

      expect(hits('/sitemap.xml')).toBe(1);
      expect(hits('/final')).toBe(1);
      const destination = await row('/final');
      expect(destination).toMatchObject({ status: 'done', referrerUrl: abs('/sitemap.xml') });
      expect((await reload(job)).pagesCrawled).toBe(2);
    });

    it('does not follow the redirect once the sitemap URL has been crawled', async () => {
      const job = await startJob({
        seeds: [
          ['/hidden', 1000],
          ['/redir/same', -50]
        ],
        sitemaps: true
      });

      await drain();

      expect(hits('/final')).toBe(1);
      expect(await row('/redir/same')).toMatchObject({
        status: 'skipped',
        lastError: 'redirect_duplicate'
      });
      expect((await reload(job)).pagesCrawled).toBe(2);
    });
  });

  it('crawlOne skips the redirect only when told the destination is in hand', async () => {
    const asked = [];
    const skipped = await crawlOne(`${site.url}/redir/same`, {
      alreadyCrawled: async next => {
        asked.push(next);
        return true;
      }
    });
    expect(skipped).toMatchObject({ outcome: 'skipped', reason: 'redirect_duplicate' });
    expect(asked).toEqual([`${site.url}/final`]);
    expect(hits('/final')).toBe(0);

    const followed = await crawlOne(`${site.url}/redir/same`);
    expect(followed).toMatchObject({ outcome: 'indexed', url: `${site.url}/final` });
  });
});

// ---------------------------------------------------------------------------
describe('the delay between requests to a host', () => {
  it('A. is the site Crawl-delay when that is longer than the job delay', async () => {
    site.robots = delayRobots(2);
    await expect(resolveDelayMs(site.url, { overrideMs: 1000 })).resolves.toBe(2000);
    await expect(resolveDelayMs(site.url, { overrideMs: 0 })).resolves.toBe(2000);
  });

  it('B. is the job delay when that is longer than the site Crawl-delay', async () => {
    site.robots = delayRobots(2);
    await expect(resolveDelayMs(site.url, { overrideMs: 3000 })).resolves.toBe(3000);
  });

  it('C. is that delay when both are equal', async () => {
    site.robots = delayRobots(2);
    await expect(resolveDelayMs(site.url, { overrideMs: 2000 })).resolves.toBe(2000);
  });

  it('D. is capped at CRAWLER_MAX_DELAY_MS, whichever side asked for more', async () => {
    config.crawler.maxDelayMs = 4000;
    site.robots = delayRobots(5);
    await expect(resolveDelayMs(site.url, { overrideMs: 3000 })).resolves.toBe(4000);
    await expect(resolveDelayMs(site.url)).resolves.toBe(4000);

    clearRobotsCache();
    clearHostPolicyCache();
    site.robots = delayRobots(1);
    await expect(resolveDelayMs(site.url, { overrideMs: 9000 })).resolves.toBe(4000);
  });

  it('E. is the job delay, or the default, when the site declares none', async () => {
    config.crawler.defaultDelayMs = 700;
    await expect(resolveDelayMs(site.url, { overrideMs: 1500 })).resolves.toBe(1500);
    await expect(resolveDelayMs(site.url, { overrideMs: 0 })).resolves.toBe(0);
    await expect(resolveDelayMs(site.url)).resolves.toBe(700);
  });

  it('is the site Crawl-delay, not the default, when there is no job delay', async () => {
    config.crawler.defaultDelayMs = 700;
    site.robots = delayRobots(2);
    await expect(resolveDelayMs(site.url)).resolves.toBe(2000);
  });

  it('ignores Crawl-delay only when told to ignore robots.txt', async () => {
    site.robots = delayRobots(2);
    await expect(resolveDelayMs(site.url, { overrideMs: 500, respectRobots: false })).resolves.toBe(
      500
    );
  });

  it('reads robots.txt once per host however many delays are resolved', async () => {
    site.robots = delayRobots(2);
    await resolveDelayMs(site.url, { overrideMs: 1000 });
    await resolveDelayMs(`${site.url}/final`, { overrideMs: 3000 });
    await resolveDelayMs(`${site.url}/hidden`);
    expect(hits('/robots.txt')).toBe(1);
  });

  it('F. a re-crawl outside any job waits the site Crawl-delay', async () => {
    site.robots = delayRobots(1);
    await frontier.addUrls([{ url: abs('/final') }]);

    const summary = await processHost({ host, maxPages: 1 });

    expect(summary).toMatchObject({ indexed: 1, delayMs: 1000 });
  });

  it('G. a job with a shorter delay waits the site Crawl-delay', async () => {
    site.robots = delayRobots(1);
    await startJob({ seeds: [['/final', 1000]], crawlDelayMs: 0 });
    expect((await processHost({ host, maxPages: 1 })).delayMs).toBe(1000);
  });

  it('G. a job with a longer delay keeps its own', async () => {
    site.robots = delayRobots(1);
    await startJob({ seeds: [['/final', 1000]], crawlDelayMs: 2500 });
    expect((await processHost({ host, maxPages: 1 })).delayMs).toBe(2500);
  });

  it('G. requests of a job are actually spaced by the site Crawl-delay', async () => {
    site.robots = delayRobots(1);
    await startJob({
      crawlDelayMs: 0,
      maxDepth: 0,
      seeds: [
        ['/final', 1000],
        ['/hidden', 900],
        ['/elsewhere', 800]
      ]
    });

    await processHost({ host, maxPages: 3 });

    const at = ['/final', '/hidden', '/elsewhere'].map(path => site.times[path][0]);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(950);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(950);
  });

  it('H. a continuation job waits the site Crawl-delay too', async () => {
    config.crawler.continuous = true;
    config.crawler.continuousMaxContinuations = 3;
    site.robots = delayRobots(1);
    const root = await startJob({
      maxPages: 1,
      maxDepth: 0,
      crawlDelayMs: 0,
      seeds: [
        ['/final', 1000],
        ['/hidden', 900]
      ]
    });

    await processHost({ host, maxPages: 1 });
    await sweep();
    const child = await CrawlJob.findOne({ chainId: root._id }).lean();
    expect(child).toMatchObject({ crawlDelayMs: 0 });

    const summary = await processHost({ host, maxPages: 1 });

    expect(summary).toMatchObject({ indexed: 1, delayMs: 1000 });
    expect(hits('/hidden')).toBe(1);
  });

  it('I. sitemap discovery and the URLs it adds wait the site Crawl-delay', async () => {
    config.crawler.sitemaps = true;
    site.robots = {
      status: 200,
      body: `User-agent: *\nCrawl-delay: 1\nSitemap: ${site.url}/sitemap.xml\n`
    };
    site.sitemap = urlsetXml([`${site.url}/final`]);
    await startJob({ seeds: [['/hidden', 1000]], crawlDelayMs: 0, sitemaps: true });

    const summary = await processHost({ host, maxPages: 2 });

    expect(summary).toMatchObject({ indexed: 2, delayMs: 1000 });
    const seed = site.times['/hidden'][0];
    const sitemap = site.times['/sitemap.xml'][0];
    const page = site.times['/final'][0];
    // The sitemap request comes a full delay after the page before it, and
    // the page it listed a full delay after that.
    expect(sitemap - seed).toBeGreaterThanOrEqual(950);
    expect(page - sitemap).toBeGreaterThanOrEqual(950);
  });
});
