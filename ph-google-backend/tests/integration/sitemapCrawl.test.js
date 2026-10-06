const testDb = require('../helpers/testDb');
const { startFixtureSite, ROBOTS, urlsetXml } = require('../helpers/fixtureSite');
const { clearRobotsCache } = require('../../crawler/robotsChecker');
const { clearHostPolicyCache } = require('../../crawler/hostPolicy');
const { processHost } = require('../../crawler/crawlWorker');
const sitemapDiscovery = require('../../services/sitemapDiscoveryService');
const frontier = require('../../services/frontierService');
const maintenance = require('../../services/crawlMaintenanceService');
const CrawlFrontier = require('../../models/CrawlFrontier');
const CrawlJob = require('../../models/CrawlJob');
const SitemapDiscovery = require('../../models/SitemapDiscovery');
const Page = require('../../models/Page');
const { normalizeUrl } = require('../../utils/urlNormalizer');
const { config } = require('../../config/env');

/**
 * Sitemap discovery inside the crawl (Step 6B Phase C): the worker runs it
 * after the chain's first page on a host is indexed, once per chain and host.
 *
 * Local fixture site and in-memory MongoDB only. The sitemap lists two real
 * fixture pages that no followed link reaches — /nofollow (linked only with
 * rel=nofollow) and /redirect-target (reached only through a redirect). The
 * crawl records where a redirect ended up, so /redirect-target may have a row
 * of its own; the rows counted here are the ones the sitemap put there.
 */

let site;
let host;
const saved = {};
const SETTINGS = [
  'sitemaps',
  'continuous',
  'continuousMaxContinuations',
  'sitemapDiscoveryLeaseMs',
  'sitemapDiscoveryMaxAttempts',
  'maxAttemptsPerUrl'
];

beforeAll(async () => {
  await testDb.connect();
  site = await startFixtureSite({ sitemaps: true });
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
  site.requestLog.length = 0;
  for (const key of SETTINGS) config.crawler[key] = saved[key];
  config.crawler.sitemaps = true;
  config.crawler.continuous = false;
  site.robots = `${ROBOTS}Sitemap: ${abs('/sitemap.xml')}\n`;
  site.files = { '/sitemap.xml': { body: urlsetXml(SITEMAP_ONLY.map(abs)) } };
});

afterEach(() => {
  jest.restoreAllMocks();
});

const SITEMAP_ONLY = ['/nofollow', '/redirect-target'];
const abs = path => normalizeUrl(`${site.url}${path}`);
const sitemapRequests = () => site.requestLog.filter(r => r.path === '/sitemap.xml').length;
const sitemapRows = () =>
  CrawlFrontier.find({ url: { $in: SITEMAP_ONLY.map(abs) }, referrerUrl: abs('/sitemap.xml') })
    .sort({ url: 1 })
    .lean();

/**
 * A running job with its seed in the frontier, as startJob creates one. Its
 * seed opted in to sitemaps (Step 6B Phase D), so the global switch decides.
 */
async function seedJob({ maxPages = 10, path = '' } = {}) {
  const seedUrl = normalizeUrl(`${site.url}${path}`);
  const job = await CrawlJob.create({
    seedUrl: normalizeUrl(site.url),
    maxPages,
    maxDepth: 3,
    sameDomainOnly: true,
    sitemaps: true,
    crawlDelayMs: 0,
    status: 'running',
    lastHeartbeatAt: new Date()
  });
  await frontier.addUrls([{ url: seedUrl, depth: 0, priority: 1000 }], { crawlJobId: job._id });
  return job;
}

async function drainHost(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    const summary = await processHost({ host, maxPages: 10 });
    if (!summary.hasMore) return;
  }
}

/** The job-handling steps of a maintenance pass; enqueueing needs Redis. */
async function sweep() {
  await frontier.reclaimStaleLeases();
  await maintenance.finaliseCompletedJobs();
  await maintenance.skipRowsOfClosedJobs();
}

describe('the CRAWLER_SITEMAPS switch', () => {
  it('when off, a crawl makes no sitemap request and keeps no discovery record', async () => {
    config.crawler.sitemaps = false;
    await seedJob();

    await drainHost();

    expect(sitemapRequests()).toBe(0);
    expect(await SitemapDiscovery.countDocuments()).toBe(0);
    expect(await sitemapRows()).toEqual([]);
    expect(await Page.countDocuments()).toBeGreaterThan(1);
  });

  it('when on, discovers sitemaps right after the seed is indexed', async () => {
    const job = await seedJob();

    await processHost({ host, maxPages: 1 });

    const paths = site.requestLog.map(r => r.path).filter(p => p !== '/robots.txt');
    // The seed page first, then the sitemap — never the other way round.
    expect(paths).toEqual(['/', '/sitemap.xml']);
    expect(await Page.countDocuments({ url: abs('') })).toBe(1);

    const record = await SitemapDiscovery.findOne({ chainId: job._id, host }).lean();
    expect(record).toMatchObject({ status: 'done', attempts: 1, urlsAdded: 2 });

    for (const row of await sitemapRows()) {
      expect(row).toMatchObject({ status: 'pending', depth: 1, priority: -1 });
      expect(String(row.crawlJobId)).toBe(String(job._id));
      expect(row.referrerUrl).toBe(abs('/sitemap.xml'));
    }
  });

  it('does not discover before a page is indexed', async () => {
    // The seed is a 404: nothing indexed, so no host context yet.
    await seedJob({ path: '/missing' });

    await processHost({ host, maxPages: 1 });

    expect(sitemapRequests()).toBe(0);
    expect(await SitemapDiscovery.countDocuments()).toBe(0);
  });

  it('crawls the sitemap pages through the ordinary frontier', async () => {
    await seedJob({ maxPages: 20 });

    await drainHost();

    expect(await Page.countDocuments({ url: { $in: SITEMAP_ONLY.map(abs) } })).toBe(2);
    expect(sitemapRequests()).toBe(1);
  });
});

describe('with Continuous Crawl', () => {
  it('A. without it, a whole crawl over many slices discovers once', async () => {
    await seedJob({ maxPages: 20 });

    for (let i = 0; i < 6; i += 1) await processHost({ host, maxPages: 1 });

    expect(sitemapRequests()).toBe(1);
    expect(await SitemapDiscovery.countDocuments()).toBe(1);
  });

  it('B-D. the continuation shares the chain, does not rediscover, and inherits the sitemap URLs', async () => {
    config.crawler.continuous = true;
    const root = await seedJob({ maxPages: 1 });

    await processHost({ host, maxPages: 10 });
    expect(sitemapRequests()).toBe(1);

    // F. Discovery creates no job: only the sweep continues a crawl.
    expect(await CrawlJob.countDocuments()).toBe(1);

    await sweep();
    const child = await CrawlJob.findOne({ chainId: root._id }).lean();
    expect(child).toBeTruthy();
    for (const row of await sitemapRows()) {
      expect(String(row.crawlJobId)).toBe(String(child._id));
      expect(row.referrerUrl).toBe(abs('/sitemap.xml'));
    }

    await processHost({ host, maxPages: 10 });

    expect(sitemapRequests()).toBe(1);
    const records = await SitemapDiscovery.find().lean();
    expect(records).toHaveLength(1);
    expect(String(records[0].chainId)).toBe(String(root._id));
  });

  it('E. keeps every job inside its page budget; the sitemap fetch costs none', async () => {
    config.crawler.continuous = true;
    const root = await seedJob({ maxPages: 1 });

    await processHost({ host, maxPages: 10 });
    expect((await CrawlJob.findById(root._id).lean()).pagesCrawled).toBe(1);

    for (let i = 0; i < 6; i += 1) {
      await sweep();
      await drainHost();
    }

    const chain = await CrawlJob.find({ $or: [{ _id: root._id }, { chainId: root._id }] }).lean();
    for (const job of chain) expect(job.pagesCrawled).toBeLessThanOrEqual(1);
  });

  it('G. never crawls a sitemap URL of a closed job', async () => {
    const job = await seedJob({ maxPages: 1 });
    await processHost({ host, maxPages: 10 });
    // Without Continuous Crawl the budget skip takes the sitemap rows with
    // the rest of the job's pending work, exactly as it takes links.
    // One row: a 1-page job without continuations can crawl one URL, so
    // discovery adds no more than that.
    const rows = await sitemapRows();
    expect(rows).toHaveLength(1);
    expect(
      rows.every(r => r.status === 'skipped' && r.lastError === 'job_page_limit_reached')
    ).toBe(true);

    await sweep();
    expect((await CrawlJob.findById(job._id).lean()).status).toBe('completed');
    await drainHost();

    expect(site.requestLog.some(r => SITEMAP_ONLY.includes(r.path))).toBe(false);
    for (const row of await sitemapRows()) expect(row.status).toBe('skipped');
  });

  it('H. a job-less re-crawl neither discovers nor changes', async () => {
    const job = await seedJob({ maxPages: 1 });
    await processHost({ host, maxPages: 10 });
    await sweep();
    expect((await CrawlJob.findById(job._id).lean()).status).toBe('completed');
    const recordsBefore = await SitemapDiscovery.countDocuments();

    await CrawlFrontier.updateOne(
      { url: abs('') },
      { $set: { nextCrawlAt: new Date(Date.now() - 1000) } }
    );
    expect(await frontier.requeueDueForRecrawl()).toBe(1);
    site.requestLog.length = 0;

    const summary = await processHost({ host, maxPages: 10 });

    expect(summary.indexed).toBe(1);
    expect(sitemapRequests()).toBe(0);
    expect(await SitemapDiscovery.countDocuments()).toBe(recordsBefore);
    expect((await CrawlFrontier.findOne({ url: abs('') }).lean()).crawlJobId).toBeNull();
  });

  it('I. a failed discovery does not fail the crawl', async () => {
    site.files['/sitemap.xml'] = { status: 500, type: 'text/plain', body: 'Oops' };
    const job = await seedJob({ maxPages: 20 });

    await drainHost();

    expect((await CrawlJob.findById(job._id).lean()).status).toBe('running');
    expect(await Page.countDocuments()).toBeGreaterThan(1);
    expect(await SitemapDiscovery.findOne().lean()).toMatchObject({ status: 'failed' });
  });
});

describe('stale running discoveries', () => {
  async function runningRecord(job, { ageMs, attempts = 1 }) {
    const startedAt = new Date(Date.now() - ageMs);
    await SitemapDiscovery.init();
    return SitemapDiscovery.create({
      chainId: job._id,
      host,
      status: 'running',
      attempts,
      startedAt,
      lastAttemptAt: startedAt
    });
  }

  it('A. leaves a fresh running discovery alone', async () => {
    const job = await seedJob();
    await runningRecord(job, { ageMs: 60 * 1000 });

    const result = await sitemapDiscovery.discover({ job, host });

    expect(result).toMatchObject({ status: 'skipped', reason: 'already_running' });
    expect(sitemapRequests()).toBe(0);
  });

  it('B. takes over a running discovery whose lease has expired', async () => {
    const job = await seedJob();
    await runningRecord(job, { ageMs: config.crawler.sitemapDiscoveryLeaseMs + 60 * 1000 });

    const result = await sitemapDiscovery.discover({ job, host });

    expect(result).toMatchObject({ status: 'done', attempt: 2, urlsAdded: 2 });
    expect(sitemapRequests()).toBe(1);
    expect(await SitemapDiscovery.findOne().lean()).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('C. lets only one of several workers take over a stale discovery', async () => {
    const job = await seedJob();
    await runningRecord(job, { ageMs: config.crawler.sitemapDiscoveryLeaseMs + 60 * 1000 });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => sitemapDiscovery.discover({ job, host }))
    );

    expect(results.filter(r => r.status === 'done')).toHaveLength(1);
    expect(sitemapRequests()).toBe(1);
    expect((await SitemapDiscovery.findOne().lean()).attempts).toBe(2);
  });

  it('D. closes a stale discovery that has used every attempt instead of retrying it', async () => {
    const job = await seedJob();
    await runningRecord(job, {
      ageMs: config.crawler.sitemapDiscoveryLeaseMs + 60 * 1000,
      attempts: config.crawler.sitemapDiscoveryMaxAttempts
    });

    const result = await sitemapDiscovery.discover({ job, host });

    expect(result.status).toBe('skipped');
    expect(sitemapRequests()).toBe(0);
    const record = await SitemapDiscovery.findOne().lean();
    expect(record.status).toBe('failed');
    expect(record.errors).toContain('abandoned: lease expired');
  });
});

describe('retrying a failed discovery', () => {
  it('retries a temporary failure, and succeeds', async () => {
    const job = await seedJob();
    site.files['/sitemap.xml'] = { status: 503, type: 'text/plain', body: 'Busy' };

    expect(await sitemapDiscovery.discover({ job, host })).toMatchObject({
      status: 'failed',
      retryable: true
    });

    site.files['/sitemap.xml'] = { body: urlsetXml(SITEMAP_ONLY.map(abs)) };
    const second = await sitemapDiscovery.discover({ job, host });

    expect(second).toMatchObject({ status: 'done', attempt: 2, urlsAdded: 2 });
    expect(await SitemapDiscovery.findOne().lean()).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('gives up after the last attempt, with no third', async () => {
    const job = await seedJob();
    site.files['/sitemap.xml'] = { status: 500, type: 'text/plain', body: 'Oops' };

    expect((await sitemapDiscovery.discover({ job, host })).status).toBe('failed');
    expect((await sitemapDiscovery.discover({ job, host })).status).toBe('failed');
    const third = await sitemapDiscovery.discover({ job, host });

    expect(third).toMatchObject({ status: 'skipped', reason: 'already_failed' });
    expect(sitemapRequests()).toBe(2);
    expect((await SitemapDiscovery.findOne().lean()).attempts).toBe(2);
  });

  it('does not retry a failure that would not improve', async () => {
    const job = await seedJob();
    site.files['/sitemap.xml'] = {
      type: 'text/html',
      body: '<html><body>Not a sitemap</body></html>'
    };

    expect(await sitemapDiscovery.discover({ job, host })).toMatchObject({
      status: 'failed',
      retryable: false
    });
    expect((await sitemapDiscovery.discover({ job, host })).status).toBe('skipped');
    expect(sitemapRequests()).toBe(1);
  });

  it('does not count filtered URLs as a failure', async () => {
    const job = await seedJob();
    site.files['/sitemap.xml'] = {
      body: urlsetXml(['https://elsewhere.test/', abs('/report.pdf'), abs('/private/x')])
    };

    const result = await sitemapDiscovery.discover({ job, host });

    expect(result).toMatchObject({ status: 'done', urlsAdded: 0, urlsRejected: 3 });
  });
});

describe('when discovery breaks', () => {
  it('keeps crawling when the discovery service throws', async () => {
    jest.spyOn(sitemapDiscovery, 'discover').mockRejectedValue(new Error('boom'));
    const job = await seedJob({ maxPages: 20 });

    await drainHost();

    expect(sitemapDiscovery.discover).toHaveBeenCalled();
    expect((await CrawlJob.findById(job._id).lean()).status).toBe('running');
    expect(await Page.countDocuments()).toBeGreaterThan(1);
    expect(await CrawlFrontier.countDocuments({ status: 'fetching' })).toBe(0);
  });

  it('records an unexpected failure part way through, and the crawl goes on', async () => {
    const addUrls = frontier.addUrls;
    jest.spyOn(frontier, 'addUrls').mockImplementation((entries, options) => {
      if (entries.some(e => e.referrerUrl === abs('/sitemap.xml'))) {
        return Promise.reject(new Error('database unavailable'));
      }
      return addUrls(entries, options);
    });
    const job = await seedJob({ maxPages: 20 });

    await drainHost();

    const record = await SitemapDiscovery.findOne().lean();
    expect(record).toMatchObject({ status: 'failed', retryable: true });
    expect(record.errors).toEqual(['unexpected: database unavailable']);
    expect((await CrawlJob.findById(job._id).lean()).status).toBe('running');
    expect(await Page.countDocuments()).toBeGreaterThan(1);
    expect(await CrawlFrontier.countDocuments({ status: 'fetching' })).toBe(0);
    expect(await sitemapRows()).toEqual([]);
  });
});
