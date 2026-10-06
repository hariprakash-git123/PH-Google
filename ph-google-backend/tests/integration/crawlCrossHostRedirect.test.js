const dns = require('dns');

const testDb = require('../helpers/testDb');
const { startHardeningSite } = require('../helpers/hardeningSite');
const { clearRobotsCache } = require('../../crawler/robotsChecker');
const { clearHostPolicyCache } = require('../../crawler/hostPolicy');
const { processHost } = require('../../crawler/crawlWorker');
const frontier = require('../../services/frontierService');
const maintenance = require('../../services/crawlMaintenanceService');
const CrawlFrontier = require('../../models/CrawlFrontier');
const CrawlJob = require('../../models/CrawlJob');
const Page = require('../../models/Page');
const { normalizeUrl, canonicalKey } = require('../../utils/urlNormalizer');
const { config } = require('../../config/env');

/**
 * A page that redirects to itself on another host:
 *
 *     example.test/path  ->  www.example.test/path
 *
 * The most common redirect on the web, and the one case where the target of
 * a cross-host redirect has the frontier row's own canonical key, so it
 * cannot simply be added as a new URL.
 *
 * Nothing about the redirect is mocked. One real HTTP server answers both
 * names; the only stand-in is name resolution, which sends `example.test`
 * and `www.example.test` to 127.0.0.1 because no DNS knows them. Every
 * request, redirect, robots.txt and page is real, and the crawl is driven
 * through `processHost`, one host slice at a time, as the queue would.
 */

const APEX = 'example.test';
const WWW = 'www.example.test';

let site;
let lookup;

beforeAll(async () => {
  await testDb.connect();
  site = await startHardeningSite();

  const realLookup = dns.lookup;
  lookup = jest.spyOn(dns, 'lookup').mockImplementation((hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const settings = typeof options === 'object' && options !== null ? options : {};
    if (hostname === APEX || hostname === WWW) {
      if (settings.all) return done(null, [{ address: '127.0.0.1', family: 4 }]);
      return done(null, '127.0.0.1', 4);
    }
    return realLookup.call(dns, hostname, options, callback);
  });
});

afterAll(async () => {
  if (lookup) lookup.mockRestore();
  if (site) await site.close();
  await testDb.disconnect();
});

beforeEach(async () => {
  await testDb.clear();
  clearRobotsCache();
  clearHostPolicyCache();
  site.reset();
});

const on = (hostname, path) => normalizeUrl(`http://${hostname}:${site.port}${path}`);
const hits = (hostname, path) => site.hostHits[`${hostname}${path}`] || 0;
const reload = job => CrawlJob.findById(job._id).lean();

/** A job seeded with a page on the bare hostname. */
async function startJob(path, scope = {}) {
  const job = await CrawlJob.create({
    seedUrl: on(APEX, ''),
    maxPages: 10,
    maxDepth: 2,
    sameDomainOnly: true,
    crawlDelayMs: 0,
    status: 'running',
    lastHeartbeatAt: new Date(),
    ...scope
  });
  await frontier.addUrls([{ url: on(APEX, path), depth: 0, priority: 1000 }], {
    crawlJobId: job._id
  });
  return job;
}

describe('example.test -> www.example.test', () => {
  it('does not fetch the destination from the original host slice', async () => {
    const job = await startJob('/xhost/path');

    const summary = await processHost({ host: APEX, maxPages: 10 });

    // The redirect was seen; nothing at all was asked of the other host.
    expect(hits(APEX, '/xhost/path')).toBe(1);
    expect(hits(WWW, '/xhost/path')).toBe(0);
    expect(hits(WWW, '/robots.txt')).toBe(0);
    expect(summary).toMatchObject({ processed: 1, indexed: 0, skipped: 1, hasMore: false });
    expect(summary.reasons).toEqual({ redirect: 1 });
    expect(await Page.countDocuments()).toBe(0);
    // Nothing was fetched, so nothing was charged.
    expect((await reload(job)).pagesCrawled).toBe(0);
  });

  it('moves the frontier row to the destination host, still one row for the page', async () => {
    const job = await startJob('/xhost/path');
    const before = await CrawlFrontier.findOne().lean();

    await processHost({ host: APEX, maxPages: 10 });

    const rows = await CrawlFrontier.find().lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      url: on(WWW, '/xhost/path'),
      host: WWW,
      status: 'pending',
      canonicalKey: before.canonicalKey,
      depth: 0,
      leasedAt: null
    });
    expect(String(rows[0]._id)).toBe(String(before._id));
    expect(String(rows[0].crawlJobId)).toBe(String(job._id));
    // Work for the www host, none left for the bare one.
    expect(await frontier.hasPendingWork(APEX)).toBe(false);
    expect(await frontier.hasPendingWork(WWW)).toBe(true);
  });

  it('crawls the destination in its own host slot, after that host robots.txt', async () => {
    const job = await startJob('/xhost/path');
    await processHost({ host: APEX, maxPages: 10 });
    site.requestLog.length = 0;

    const summary = await processHost({ host: WWW, maxPages: 10 });

    expect(summary).toMatchObject({ processed: 1, indexed: 1 });
    expect(site.requestLog).toEqual(['/robots.txt', '/xhost/path']);
    expect(hits(WWW, '/robots.txt')).toBe(1);
    expect(hits(WWW, '/xhost/path')).toBe(1);

    const page = await Page.findOne().lean();
    expect(page).toMatchObject({ url: on(WWW, '/xhost/path'), domain: WWW });
    expect(await CrawlFrontier.findOne().lean()).toMatchObject({ status: 'done', host: WWW });
    // One page, one fetch, one page charged.
    expect(await reload(job)).toMatchObject({ pagesCrawled: 1, pagesIndexed: 1, failedPages: 0 });
  });

  it('obeys the destination host robots.txt, which differs from the original', async () => {
    site.robotsByHost[WWW] = { status: 200, body: 'User-agent: *\nDisallow: /xhost/blocked\n' };
    const job = await startJob('/xhost/blocked');

    await processHost({ host: APEX, maxPages: 10 });
    const summary = await processHost({ host: WWW, maxPages: 10 });

    expect(hits(WWW, '/robots.txt')).toBe(1);
    expect(hits(WWW, '/xhost/blocked')).toBe(0);
    expect(summary.reasons).toEqual({ robots_txt: 1 });
    expect(await CrawlFrontier.findOne().lean()).toMatchObject({
      status: 'skipped',
      lastError: 'robots_txt',
      host: WWW
    });
    expect(await Page.countDocuments()).toBe(0);
    expect(await reload(job)).toMatchObject({ pagesCrawled: 0, skippedByRobots: 1 });
  });

  it('does not fetch the destination while its robots.txt is unavailable', async () => {
    site.robotsByHost[WWW] = { status: 503, body: 'Oops' };
    await startJob('/xhost/path');

    await processHost({ host: APEX, maxPages: 10 });
    const summary = await processHost({ host: WWW, maxPages: 10 });

    expect(hits(WWW, '/xhost/path')).toBe(0);
    expect(summary).toMatchObject({ failed: 1, hostBackoff: 'robots_unavailable' });
    expect(await CrawlFrontier.findOne().lean()).toMatchObject({
      status: 'pending',
      lastError: 'robots_unavailable'
    });
  });

  it('never contacts a destination outside the crawl scope', async () => {
    const job = await startJob('/xhost/path', { excludePatterns: ['^http://www\\.'] });

    await processHost({ host: APEX, maxPages: 10 });

    expect(await CrawlFrontier.findOne().lean()).toMatchObject({
      status: 'skipped',
      lastError: 'redirect_out_of_scope',
      host: APEX
    });
    expect(await frontier.hasPendingWork(WWW)).toBe(false);
    await processHost({ host: WWW, maxPages: 10 });
    expect(hits(WWW, '/robots.txt') + hits(WWW, '/xhost/path')).toBe(0);
    expect((await reload(job)).pagesCrawled).toBe(0);
  });

  it('respects allowedDomains for the destination host', async () => {
    // "example.test" covers its subdomains, www included.
    const inside = await startJob('/xhost/path', { allowedDomains: [APEX] });
    await processHost({ host: APEX, maxPages: 10 });
    await processHost({ host: WWW, maxPages: 10 });
    expect((await reload(inside)).pagesCrawled).toBe(1);
    expect(hits(WWW, '/xhost/path')).toBe(1);
  });

  it('does not fetch the page again through a later link to either address', async () => {
    const job = await startJob('/xhost/path');
    await processHost({ host: APEX, maxPages: 10 });
    await processHost({ host: WWW, maxPages: 10 });

    const added = await frontier.addUrls(
      [
        { url: on(APEX, '/xhost/path'), depth: 1 },
        { url: on(WWW, '/xhost/path'), depth: 1 },
        { url: `${on(APEX, '/xhost/path')}?utm_source=x`, depth: 1 }
      ],
      { crawlJobId: job._id }
    );
    await processHost({ host: APEX, maxPages: 10 });
    await processHost({ host: WWW, maxPages: 10 });

    expect(added.added).toBe(0);
    expect(await CrawlFrontier.countDocuments()).toBe(1);
    expect(hits(APEX, '/xhost/path')).toBe(1);
    expect(hits(WWW, '/xhost/path')).toBe(1);
    expect(await Page.countDocuments()).toBe(1);
    expect((await reload(job)).pagesCrawled).toBe(1);
  });

  it('ends two hosts that redirect to each other, after a bounded number of requests', async () => {
    const job = await startJob('/xhost/ping');

    // Slice after slice, on whichever host the row is on now.
    for (let i = 0; i < 10; i += 1) {
      const current = await CrawlFrontier.findOne().lean();
      if (current.status !== 'pending') break;
      await processHost({ host: current.host, maxPages: 10 });
    }

    const row = await CrawlFrontier.findOne().lean();
    expect(row).toMatchObject({ status: 'failed', lastError: 'redirect_loop' });
    expect(row.attempts).toBe(config.crawler.maxAttemptsPerUrl);
    expect(hits(APEX, '/xhost/ping') + hits(WWW, '/xhost/ping')).toBe(
      config.crawler.maxAttemptsPerUrl
    );
    expect(await CrawlFrontier.countDocuments()).toBe(1);
    expect(await CrawlFrontier.countDocuments({ status: 'fetching' })).toBe(0);
    expect((await reload(job)).pagesCrawled).toBe(0);
  });

  it('counts the abandoned URL as a failed page at once, not only when the job closes', async () => {
    const job = await startJob('/xhost/ping');

    // Each bounce only moves the row: nothing has failed yet.
    while ((await CrawlFrontier.findOne().lean()).attempts < config.crawler.maxAttemptsPerUrl - 1) {
      const current = await CrawlFrontier.findOne().lean();
      await processHost({ host: current.host, maxPages: 10 });
      expect(await reload(job)).toMatchObject({ status: 'running', failedPages: 0 });
    }

    // The slice that gives the URL up.
    const last = await CrawlFrontier.findOne().lean();
    const summary = await processHost({ host: last.host, maxPages: 10 });
    expect(summary.reasons).toEqual({ redirect_loop: 1 });
    expect(await CrawlFrontier.findOne().lean()).toMatchObject({
      status: 'failed',
      lastError: 'redirect_loop'
    });

    // Already right, with the job still open and no sweep run.
    const live = await reload(job);
    expect(live).toMatchObject({ status: 'running', failedPages: 1, pagesCrawled: 0 });
    expect(live.completedAt).toBeNull();

    // Closing the job settles the count from the frontier: the same number.
    await maintenance.finaliseCompletedJobs();
    expect(await reload(job)).toMatchObject({
      status: 'completed',
      failedPages: 1,
      pagesCrawled: 0,
      pagesIndexed: 0
    });
  });

  it('does not count a redirect that is only moved, skipped or queued as a failed page', async () => {
    const moved = await startJob('/xhost/path');
    await processHost({ host: APEX, maxPages: 10 });
    expect((await reload(moved)).failedPages).toBe(0);
    await processHost({ host: WWW, maxPages: 10 });
    expect(await reload(moved)).toMatchObject({ failedPages: 0, pagesCrawled: 1 });

    await testDb.clear();
    const refused = await startJob('/xhost/path', { excludePatterns: ['^http://www\\.'] });
    await processHost({ host: APEX, maxPages: 10 });
    expect(await reload(refused)).toMatchObject({ failedPages: 0, pagesCrawled: 0 });
  });

  it('keys both addresses to one page', () => {
    expect(canonicalKey(on(APEX, '/xhost/path'))).toBe(canonicalKey(on(WWW, '/xhost/path')));
  });
});
