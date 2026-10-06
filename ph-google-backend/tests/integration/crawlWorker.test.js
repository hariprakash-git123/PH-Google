const testDb = require('../helpers/testDb');
const { startFixtureSite } = require('../helpers/fixtureSite');
const { clearRobotsCache } = require('../../crawler/robotsChecker');
const { clearHostPolicyCache } = require('../../crawler/hostPolicy');
const { processHost, crawlOne, linksInScope } = require('../../crawler/crawlWorker');
const frontier = require('../../services/frontierService');
const maintenance = require('../../services/crawlMaintenanceService');
const CrawlFrontier = require('../../models/CrawlFrontier');
const CrawlJob = require('../../models/CrawlJob');
const Page = require('../../models/Page');
const { normalizeUrl } = require('../../utils/urlNormalizer');
const { crawlerRunningFor } = require('../helpers/factories');

/**
 * The crawl worker's drain loop.
 *
 * `processHost` is exported precisely so these tests can drive it directly:
 * the whole crawl path runs here against an in-memory MongoDB and a local
 * fixture site, with no Redis and no worker process. What is missing is only
 * the transport — that BullMQ delivers `{host}` to this function — and that
 * is covered in tests/queue/ against a live Redis.
 *
 * Nothing here ever touches a real external website.
 */

let site;
let host;

beforeAll(async () => {
  await testDb.connect();
  site = await startFixtureSite();
  host = frontier.hostOf(site.url);
});

afterAll(async () => {
  if (site) await site.close();
  await testDb.disconnect();
});

beforeEach(async () => {
  await testDb.clear();
  clearRobotsCache();
  clearHostPolicyCache();
  site.requestLog.length = 0;
});

/** Creates a running job with its seed in the frontier, as startJob does. */
async function seedJob({
  maxPages = 10,
  maxDepth = 3,
  sameDomainOnly = true,
  allowedDomains = [],
  excludePatterns = [],
  url
} = {}) {
  const seedUrl = normalizeUrl(url || site.url);
  const job = await CrawlJob.create({
    seedUrl,
    maxPages,
    maxDepth,
    sameDomainOnly,
    allowedDomains,
    excludePatterns,
    crawlDelayMs: 0,
    status: 'running',
    lastHeartbeatAt: new Date()
  });

  await frontier.addUrls([{ url: seedUrl, depth: 0, priority: 1000 }], { crawlJobId: job._id });
  return job;
}

describe('crawlOne', () => {
  it('fetches, indexes and reports the links it found', async () => {
    const result = await crawlOne(site.url);

    expect(result.outcome).toBe('indexed');
    expect(result.statusCode).toBe(200);
    expect(result.links.length).toBeGreaterThan(0);
    expect(await Page.countDocuments()).toBe(1);
  });

  it('does not store the links itself', async () => {
    // The worker writes them to the durable frontier; startCrawler keeps
    // them in memory. crawlOne must not decide for either.
    await crawlOne(site.url);
    expect(await CrawlFrontier.countDocuments()).toBe(0);
  });

  it('skips a page robots.txt disallows', async () => {
    const result = await crawlOne(`${site.url}/private/secret`);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('robots_txt');
    expect(await Page.countDocuments()).toBe(0);
  });

  it('can be told to ignore robots.txt', async () => {
    const result = await crawlOne(`${site.url}/private/secret`, { respectRobots: false });
    expect(result.outcome).not.toBe('skipped');
  });

  it('reports an HTTP error as a failure worth retrying', async () => {
    const result = await crawlOne(`${site.url}/missing`);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('http_error');
  });

  it('treats a content type it cannot index as a skip, not a failure', async () => {
    // Retrying a JSON endpoint three times will not turn it into HTML.
    const result = await crawlOne(`${site.url}/data.json`);
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('unsupported_content_type');
  });

  it('indexes a redirected page under its final URL', async () => {
    const result = await crawlOne(`${site.url}/redirect-me`);
    expect(result.url).toBe(`${site.url}/redirect-target`);
  });
});

describe('link scope', () => {
  it('keeps links on the seed host when the job is same-domain', () => {
    const job = { seedUrl: 'https://example.com/', maxDepth: 3, sameDomainOnly: true };
    const scoped = linksInScope(['https://example.com/a', 'https://other.example.org/b'], {
      job,
      sourceUrl: 'https://example.com/',
      depth: 0
    });

    expect(scoped.map(s => s.url)).toEqual(['https://example.com/a']);
  });

  it('allows other hosts when the job is cross-domain', () => {
    const job = { seedUrl: 'https://example.com/', maxDepth: 3, sameDomainOnly: false };
    const scoped = linksInScope(['https://example.com/a', 'https://other.example.org/b'], {
      job,
      sourceUrl: 'https://example.com/',
      depth: 0
    });

    expect(scoped).toHaveLength(2);
  });

  it('stops following links at the depth limit', () => {
    const job = { seedUrl: 'https://example.com/', maxDepth: 2, sameDomainOnly: true };
    expect(linksInScope(['https://example.com/a'], { job, sourceUrl: 'x', depth: 2 })).toHaveLength(
      0
    );
  });

  it('gives deeper links a lower priority, keeping the crawl breadth-first', () => {
    const job = { seedUrl: 'https://example.com/', maxDepth: 5, sameDomainOnly: true };
    const shallow = linksInScope(['https://example.com/a'], { job, sourceUrl: 'x', depth: 0 });
    const deep = linksInScope(['https://example.com/b'], { job, sourceUrl: 'x', depth: 3 });

    expect(shallow[0].priority).toBeGreaterThan(deep[0].priority);
  });

  it('discovers nothing when there is no open job', () => {
    // A scheduled re-crawl refreshes a page; it must not expand a crawl
    // whose scope no longer exists.
    expect(
      linksInScope(['https://example.com/a'], { job: null, sourceUrl: 'x', depth: 0 })
    ).toEqual([]);
  });
});

describe('processHost', () => {
  it('crawls a host and feeds discovered links back into the frontier', async () => {
    const job = await seedJob();

    const summary = await processHost({ host, maxPages: 1 });

    expect(summary.processed).toBe(1);
    expect(summary.indexed).toBe(1);
    expect(summary.hasMore).toBe(true);
    // Pages linked from the seed are now waiting.
    expect(await CrawlFrontier.countDocuments({ status: 'pending' })).toBeGreaterThan(0);
    expect((await CrawlJob.findById(job._id).lean()).pagesDiscovered).toBeGreaterThan(0);
  });

  it('stops after its slice rather than draining the whole host', async () => {
    await seedJob();

    const summary = await processHost({ host, maxPages: 2 });

    // Without a slice, one large site would hold a worker slot until it
    // finished and every other host would wait behind it.
    expect(summary.processed).toBe(2);
    expect(summary.hasMore).toBe(true);
  });

  it('reports hasMore false once the host is drained', async () => {
    await seedJob({ maxPages: 3 });

    let guard = 0;
    let summary;
    do {
      summary = await processHost({ host, maxPages: 5 });
      guard += 1;
    } while (summary.hasMore && guard < 10);

    expect(summary.hasMore).toBe(false);
  });

  it('never exceeds the job page budget, even across slices', async () => {
    const job = await seedJob({ maxPages: 2 });

    for (let i = 0; i < 5; i += 1) await processHost({ host, maxPages: 5 });

    expect((await CrawlJob.findById(job._id).lean()).pagesCrawled).toBe(2);
    expect(await Page.countDocuments()).toBe(2);
  });

  it('holds the budget against concurrent slices', async () => {
    // Several hosts of one job run in parallel; read-then-write on the page
    // count would let two slices both see "one left" and both proceed.
    const job = await seedJob({ maxPages: 3 });
    await processHost({ host, maxPages: 1 });

    await Promise.all([
      processHost({ host, maxPages: 5 }),
      processHost({ host, maxPages: 5 }),
      processHost({ host, maxPages: 5 })
    ]);

    expect((await CrawlJob.findById(job._id).lean()).pagesCrawled).toBeLessThanOrEqual(3);
  });

  it('stops when the job is asked to stop', async () => {
    const job = await seedJob({ maxPages: 20 });
    await processHost({ host, maxPages: 1 });

    // The API writes this; the worker reads it between pages.
    await CrawlJob.updateOne({ _id: job._id }, { $set: { stopRequested: true } });
    const summary = await processHost({ host, maxPages: 10 });

    expect(summary.indexed).toBe(0);
    expect((await CrawlJob.findById(job._id).lean()).pagesCrawled).toBe(1);
  });

  it('counts a robots.txt refusal against the job without failing it', async () => {
    const job = await seedJob({ maxPages: 20 });

    let guard = 0;
    let summary;
    do {
      summary = await processHost({ host, maxPages: 10 });
      guard += 1;
    } while (summary.hasMore && guard < 10);

    const finished = await CrawlJob.findById(job._id).lean();
    expect(finished.skippedByRobots).toBeGreaterThan(0);
    expect(await CrawlFrontier.countDocuments({ status: 'skipped' })).toBeGreaterThan(0);
  });

  it('records a failed fetch without abandoning the slice', async () => {
    await seedJob({ maxPages: 20 });

    let guard = 0;
    let summary;
    do {
      summary = await processHost({ host, maxPages: 10 });
      guard += 1;
    } while (summary.hasMore && guard < 10);

    // /missing is linked from the home page and returns 404.
    const failed = await CrawlFrontier.findOne({ url: `${site.url}/missing` }).lean();
    expect(failed).toBeTruthy();
    // Retried rather than abandoned on the first attempt.
    expect(['pending', 'failed']).toContain(failed.status);
    expect(await Page.countDocuments()).toBeGreaterThan(1);
  });

  it('never fetches the same URL twice in a run', async () => {
    await seedJob({ maxPages: 20 });

    let guard = 0;
    let summary;
    do {
      summary = await processHost({ host, maxPages: 10 });
      guard += 1;
    } while (summary.hasMore && guard < 10);

    const paths = site.requestLog.filter(r => r.path !== '/robots.txt').map(r => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('stays on the seed host by default', async () => {
    await seedJob({ maxPages: 20 });

    let guard = 0;
    let summary;
    do {
      summary = await processHost({ host, maxPages: 10 });
      guard += 1;
    } while (summary.hasMore && guard < 10);

    const hosts = await CrawlFrontier.distinct('host');
    expect(hosts).toEqual([host]);
  });

  it('respects the job depth limit', async () => {
    await seedJob({ maxPages: 20, maxDepth: 0 });

    await processHost({ host, maxPages: 10 });

    // Depth 0: the seed is crawled, and nothing it links to is enqueued.
    expect(await CrawlFrontier.countDocuments()).toBe(1);
    expect(await Page.countDocuments()).toBe(1);
  });

  it('does nothing for a host with no work', async () => {
    const summary = await processHost({ host: 'nothing.example.com' });
    expect(summary).toMatchObject({ processed: 0, indexed: 0, hasMore: false });
  });

  it('does nothing when called without a host', async () => {
    expect((await processHost({})).processed).toBe(0);
  });

  it('releases the claim on every page it handles', async () => {
    await seedJob({ maxPages: 3 });
    await processHost({ host, maxPages: 3 });

    // A row left in `fetching` is a leaked lease; nothing would touch it
    // again until the maintenance sweep reclaimed it.
    expect(await CrawlFrontier.countDocuments({ status: 'fetching' })).toBe(0);
  });
});

describe('maintenance', () => {
  it('closes a job once its frontier is drained', async () => {
    const job = await seedJob({ maxPages: 2 });

    let guard = 0;
    let summary;
    do {
      summary = await processHost({ host, maxPages: 5 });
      guard += 1;
    } while (summary.hasMore && guard < 10);

    expect(await maintenance.finaliseCompletedJobs()).toBe(1);
    expect((await CrawlJob.findById(job._id).lean()).status).toBe('completed');
  });

  it('closes a stopped job as stopped, not completed', async () => {
    const job = await seedJob({ maxPages: 20 });
    await processHost({ host, maxPages: 1 });
    await CrawlJob.updateOne({ _id: job._id }, { $set: { stopRequested: true } });

    let guard = 0;
    let summary;
    do {
      summary = await processHost({ host, maxPages: 10 });
      guard += 1;
    } while (summary.hasMore && guard < 10);

    await maintenance.finaliseCompletedJobs();
    expect((await CrawlJob.findById(job._id).lean()).status).toBe('stopped');
  });

  it('leaves a job open while work remains', async () => {
    await seedJob({ maxPages: 50 });
    await processHost({ host, maxPages: 1 });

    expect(await maintenance.finaliseCompletedJobs()).toBe(0);
  });

  it('runs every step even when one of them fails', async () => {
    // enqueuePendingHosts needs Redis, which the default suite has none of.
    // The other four steps must still run and be reported.
    await seedJob();
    const summary = await maintenance.runMaintenance();

    expect(summary).toMatchObject({
      leasesReclaimed: expect.any(Number),
      recrawlsQueued: expect.any(Number),
      jobsClosed: expect.any(Number),
      jobsOrphaned: expect.any(Number)
    });
  });
});

describe('surviving a restart', () => {
  it('resumes from the frontier rather than from the seed', async () => {
    const job = await seedJob({ maxPages: 10 });
    await processHost({ host, maxPages: 2 });

    const doneBefore = await CrawlFrontier.countDocuments({ status: 'done' });
    const pendingBefore = await CrawlFrontier.countDocuments({ status: 'pending' });
    expect(pendingBefore).toBeGreaterThan(0);

    // As if every process died here. Nothing is held in memory, so a fresh
    // slice simply carries on.
    const summary = await processHost({ host, maxPages: 2 });

    expect(summary.processed).toBeGreaterThan(0);
    expect(await CrawlFrontier.countDocuments({ status: 'done' })).toBeGreaterThan(doneBefore);
    expect((await CrawlJob.findById(job._id).lean()).pagesCrawled).toBeGreaterThan(2);
  });

  it('reclaims a URL abandoned by a worker that died mid-fetch', async () => {
    await seedJob();
    await frontier.claimNext(host);
    await CrawlFrontier.updateMany(
      { status: 'fetching' },
      { $set: { leasedAt: new Date(Date.now() - 10 * 60 * 1000) } }
    );

    expect(await frontier.reclaimStaleLeases()).toBe(1);
    const summary = await processHost({ host, maxPages: 1 });
    expect(summary.processed).toBe(1);
  });
});

/** Runs slices until the host has nothing left to do. */
async function drainHost() {
  let guard = 0;
  let summary;
  do {
    summary = await processHost({ host, maxPages: 10 });
    guard += 1;
  } while (summary.hasMore && guard < 20);
}

describe('seed scope (allowed domains and exclude patterns)', () => {
  it('follows only links on the allowed domains', () => {
    const job = {
      seedUrl: 'https://en.wikipedia.org/wiki/Physics',
      maxDepth: 3,
      sameDomainOnly: true,
      allowedDomains: ['en.wikipedia.org']
    };
    const scoped = linksInScope(
      [
        'https://en.wikipedia.org/wiki/Energy',
        'https://de.wikipedia.org/wiki/Physik',
        'https://www.example.org/'
      ],
      { job, sourceUrl: job.seedUrl, depth: 0 }
    );
    expect(scoped.map(s => s.url)).toEqual(['https://en.wikipedia.org/wiki/Energy']);
  });

  it('drops links matching the job exclude patterns', () => {
    const job = {
      seedUrl: 'https://example.com/',
      maxDepth: 3,
      sameDomainOnly: true,
      excludePatterns: ['/wiki/Talk:']
    };
    const scoped = linksInScope(['https://example.com/wiki/Talk:X', 'https://example.com/wiki/X'], {
      job,
      sourceUrl: 'x',
      depth: 0
    });
    expect(scoped.map(s => s.url)).toEqual(['https://example.com/wiki/X']);
  });

  it('caps the links one page adds to the frontier', () => {
    const { config } = require('../../config/env');
    const job = { seedUrl: 'https://example.com/', maxDepth: 3, sameDomainOnly: true };
    const links = Array.from(
      { length: config.crawler.maxLinksPerPage + 50 },
      (_, i) => `https://example.com/p${i}`
    );
    expect(linksInScope(links, { job, sourceUrl: 'x', depth: 0 })).toHaveLength(
      config.crawler.maxLinksPerPage
    );
  });

  it('never enqueues or fetches an excluded path in a real crawl', async () => {
    await seedJob({ maxPages: 20, excludePatterns: ['/blog/'] });
    await drainHost();

    expect(await CrawlFrontier.countDocuments({ url: `${site.url}/blog/indexing` })).toBe(0);
    expect(site.requestLog.some(r => r.path === '/blog/indexing')).toBe(false);
    expect(await Page.countDocuments({ url: `${site.url}/about` })).toBe(1);
  });
});

describe('page budget clean-up', () => {
  it('skips everything else the job queued once its budget is spent', async () => {
    const job = await seedJob({ maxPages: 1 });
    await drainHost();

    // Seed crawled; every link it found is skipped for budget, none pending.
    expect(await Page.countDocuments()).toBe(1);
    expect(await CrawlFrontier.countDocuments({ crawlJobId: job._id, status: 'pending' })).toBe(0);
    expect(
      await CrawlFrontier.countDocuments({ status: 'skipped', lastError: 'job_page_limit_reached' })
    ).toBeGreaterThan(0);
  });

  it('closing a job leaves nothing for a worker to crawl without a budget', async () => {
    // Before this, a job closed with its budget spent left its unfetched
    // links pending; the worker then fetched them all with no job — and no
    // budget — to charge them to.
    const job = await seedJob({ maxPages: 1 });
    await processHost({ host, maxPages: 1 });
    // Budget spent, links still pending: exactly what maintenance sees.
    expect(await CrawlFrontier.countDocuments({ status: 'pending' })).toBeGreaterThan(0);

    await maintenance.finaliseCompletedJobs();
    expect((await CrawlJob.findById(job._id).lean()).status).toBe('completed');
    expect(await CrawlFrontier.countDocuments({ status: 'pending' })).toBe(0);

    const summary = await processHost({ host, maxPages: 10 });
    expect(summary.processed).toBe(0);
    expect(await Page.countDocuments()).toBe(1);
  });

  it('failing an orphaned job also clears the URLs it had queued', async () => {
    const job = await seedJob({ maxPages: 10 });
    await processHost({ host, maxPages: 1 });
    expect(await CrawlFrontier.countDocuments({ status: 'pending' })).toBeGreaterThan(0);

    // The worker went silent long ago: neither this job nor its host has
    // seen any activity since.
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await CrawlJob.updateOne({ _id: job._id }, { $set: { lastHeartbeatAt: hourAgo } });
    await CrawlFrontier.updateMany(
      { lastCrawledAt: { $ne: null } },
      { $set: { lastCrawledAt: hourAgo } }
    );
    await crawlerRunningFor(2 * 60 * 60 * 1000);
    expect(await maintenance.failOrphanedJobs()).toBe(1);

    expect(await CrawlFrontier.countDocuments({ status: 'pending' })).toBe(0);
    expect((await processHost({ host, maxPages: 10 })).processed).toBe(0);
  });

  it('does not fail a silent job that is only waiting its turn on a busy host', async () => {
    // Topic crawls put many jobs on one host. A job whose own pages have not
    // come up yet is silent, but the worker is plainly alive on that host.
    const waiting = await seedJob({ maxPages: 10 });
    await CrawlJob.updateOne(
      { _id: waiting._id },
      { $set: { lastHeartbeatAt: new Date(Date.now() - 60 * 60 * 1000) } }
    );
    // Another job's page on the same host was crawled a moment ago.
    await CrawlFrontier.create({
      url: `${site.url}/recent`,
      canonicalKey: `${host}/recent-${Date.now()}`,
      host,
      status: 'done',
      lastCrawledAt: new Date()
    });
    await crawlerRunningFor(2 * 60 * 60 * 1000);

    expect(await maintenance.failOrphanedJobs()).toBe(0);
    expect((await CrawlJob.findById(waiting._id).lean()).status).toBe('running');
  });

  it('sweeps up unfetched URLs of any closed job, but keeps scheduled re-crawls', async () => {
    const job = await seedJob({ maxPages: 10 });
    await processHost({ host, maxPages: 1 });
    // Closed by some path that did not clear its frontier.
    await CrawlJob.updateOne({ _id: job._id }, { $set: { status: 'failed' } });
    // The crawled seed comes due for a re-crawl.
    await CrawlFrontier.updateOne(
      { status: 'done' },
      { $set: { nextCrawlAt: new Date(Date.now() - 1000) } }
    );
    expect(await frontier.requeueDueForRecrawl()).toBe(1);

    expect(await maintenance.skipRowsOfClosedJobs()).toBeGreaterThan(0);

    const pending = await CrawlFrontier.find({ status: 'pending' }).lean();
    expect(pending).toHaveLength(1);
    expect(pending[0].url).toBe(normalizeUrl(site.url));
  });

  it('leaves the URLs of an open job alone', async () => {
    await seedJob({ maxPages: 10 });
    await processHost({ host, maxPages: 1 });
    const before = await CrawlFrontier.countDocuments({ status: 'pending' });

    expect(await maintenance.skipRowsOfClosedJobs()).toBe(0);
    expect(await CrawlFrontier.countDocuments({ status: 'pending' })).toBe(before);
  });

  it('lets a later crawl pick up links an earlier crawl had no budget for', async () => {
    const first = await seedJob({ maxPages: 1 });
    await drainHost();
    await maintenance.finaliseCompletedJobs();
    expect((await CrawlJob.findById(first._id).lean()).status).toBe('completed');
    expect(await Page.countDocuments()).toBe(1);

    // Re-running the crawl re-fetches the seed, rediscovers the skipped links
    // and this time has budget for them — this is how a re-run grows the index.
    const second = await CrawlJob.create({
      seedUrl: normalizeUrl(site.url),
      maxPages: 3,
      maxDepth: 3,
      sameDomainOnly: true,
      crawlDelayMs: 0,
      status: 'running',
      lastHeartbeatAt: new Date()
    });
    await CrawlFrontier.updateOne(
      { url: normalizeUrl(site.url) },
      { $set: { status: 'pending', crawlJobId: second._id, nextCrawlAt: new Date(), attempts: 0 } }
    );
    await drainHost();

    expect((await CrawlJob.findById(second._id).lean()).pagesIndexed).toBeGreaterThan(1);
    expect(await Page.countDocuments()).toBeGreaterThan(1);
  });

  it('does not revive a URL skipped for robots.txt', async () => {
    const job = await seedJob({ maxPages: 20 });
    await drainHost();
    const robotsRow = await CrawlFrontier.findOne({ lastError: 'robots_txt' }).lean();
    expect(robotsRow).toBeTruthy();

    const other = await CrawlJob.create({
      seedUrl: normalizeUrl(site.url),
      maxPages: 5,
      status: 'running'
    });
    await frontier.addUrls([{ url: robotsRow.url, depth: 1 }], { crawlJobId: other._id });

    const after = await CrawlFrontier.findById(robotsRow._id).lean();
    expect(after.status).toBe('skipped');
    expect(String(after.crawlJobId)).toBe(String(job._id));
  });
});

describe('continuous crawl (CRAWLER_CONTINUOUS)', () => {
  const { config } = require('../../config/env');
  const { activeCrawlCount } = require('../../services/crawlerJobService');

  let saved;

  beforeEach(() => {
    saved = {
      continuous: config.crawler.continuous,
      maxContinuations: config.crawler.continuousMaxContinuations,
      maxConcurrentJobs: config.crawler.maxConcurrentJobs,
      maxAttemptsPerUrl: config.crawler.maxAttemptsPerUrl
    };
    config.crawler.continuous = true;
    config.crawler.continuousMaxContinuations = 10;
  });

  afterEach(() => {
    config.crawler.continuous = saved.continuous;
    config.crawler.continuousMaxContinuations = saved.maxContinuations;
    config.crawler.maxConcurrentJobs = saved.maxConcurrentJobs;
    config.crawler.maxAttemptsPerUrl = saved.maxAttemptsPerUrl;
  });

  /** The job-handling steps of one maintenance pass; the rest needs Redis. */
  async function sweep() {
    await frontier.reclaimStaleLeases();
    await maintenance.finaliseCompletedJobs();
    await maintenance.skipRowsOfClosedJobs();
  }

  const chainOf = root =>
    CrawlJob.find({ $or: [{ _id: root._id }, { chainId: root._id }] })
      .sort({ continuationIndex: 1 })
      .lean();

  const openJob = () => CrawlJob.findOne({ status: { $in: ['queued', 'running'] } }).lean();

  /** Crawls and sweeps until nothing is open, or gives up. */
  async function runChain(rounds = 12) {
    for (let i = 0; i < rounds; i += 1) {
      await drainHost();
      await sweep();
      if (!(await openJob())) return;
    }
  }

  it('is off by default', () => {
    expect(saved.continuous).toBe(false);
  });

  it('when off, still skips what a job had no budget for and starts nothing new', async () => {
    config.crawler.continuous = false;
    const job = await seedJob({ maxPages: 1 });

    await drainHost();
    await sweep();

    expect(await CrawlFrontier.countDocuments({ status: 'pending' })).toBe(0);
    expect(
      await CrawlFrontier.countDocuments({ status: 'skipped', lastError: 'job_page_limit_reached' })
    ).toBeGreaterThan(0);
    expect(await CrawlJob.countDocuments()).toBe(1);
    expect((await CrawlJob.findById(job._id).lean()).status).toBe('completed');
  });

  it('keeps unfetched URLs pending, untouched, when the budget is reached', async () => {
    const job = await seedJob({ maxPages: 1 });

    const summary = await processHost({ host, maxPages: 10 });

    expect(summary.indexed).toBe(1);
    expect(summary.deferred).toBe(1);
    // Only the job's own rows are left, so the host is not re-queued for them.
    expect(summary.hasMore).toBe(false);
    expect((await CrawlJob.findById(job._id).lean()).pagesCrawled).toBe(1);

    const pending = await CrawlFrontier.find({ crawlJobId: job._id, status: 'pending' }).lean();
    expect(pending.length).toBeGreaterThan(0);
    // The URL handed back gets its attempt back and is not skipped.
    expect(pending.every(row => row.attempts === 0 && row.leasedAt === null)).toBe(true);
    expect(await CrawlFrontier.countDocuments({ status: 'skipped' })).toBe(0);
    expect(await CrawlFrontier.countDocuments({ status: 'fetching' })).toBe(0);
    expect(await Page.countDocuments()).toBe(1);
  });

  it('hands the pending URLs to a continuation job that the next slice crawls', async () => {
    const root = await seedJob({ maxPages: 2 });
    await drainHost();
    const pendingBefore = await CrawlFrontier.countDocuments({
      crawlJobId: root._id,
      status: 'pending'
    });
    expect(pendingBefore).toBeGreaterThan(0);

    await sweep();

    const [parent, child] = await chainOf(root);
    expect(parent.status).toBe('completed');
    expect(String(parent.continuedAs)).toBe(String(child._id));
    expect(child).toMatchObject({ status: 'running', continuationIndex: 1, pagesCrawled: 0 });
    expect(String(child.chainId)).toBe(String(root._id));
    expect(await CrawlFrontier.countDocuments({ crawlJobId: child._id, status: 'pending' })).toBe(
      pendingBefore
    );

    const pagesBefore = await Page.countDocuments();
    await drainHost();

    expect(await Page.countDocuments()).toBeGreaterThan(pagesBefore);
    expect((await CrawlJob.findById(child._id).lean()).pagesCrawled).toBeGreaterThan(0);
  });

  it('keeps every job of the chain inside its own page budget', async () => {
    const root = await seedJob({ maxPages: 1 });

    await runChain();

    const chain = await chainOf(root);
    expect(chain.length).toBeGreaterThan(2);
    for (const job of chain) expect(job.pagesCrawled).toBeLessThanOrEqual(1);
    // Together they covered more of the site than one budget allows.
    expect(await Page.countDocuments()).toBeGreaterThan(2);
  });

  it('gives each continuation the scope of the crawl it continues', async () => {
    const root = await seedJob({ maxPages: 1, maxDepth: 1, excludePatterns: ['/blog/'] });

    await runChain();

    const chain = await chainOf(root);
    expect(chain.length).toBeGreaterThan(1);
    for (const job of chain.slice(1)) {
      expect(job).toMatchObject({
        seedUrl: root.seedUrl,
        maxPages: 1,
        maxDepth: 1,
        sameDomainOnly: true,
        excludePatterns: ['/blog/'],
        crawlDelayMs: 0
      });
    }
    expect(await CrawlFrontier.distinct('host')).toEqual([host]);
    expect(await CrawlFrontier.countDocuments({ depth: { $gt: 1 } })).toBe(0);
    expect(site.requestLog.some(r => r.path.startsWith('/blog/'))).toBe(false);
  });

  it('takes over its parent crawl slot instead of a new one', async () => {
    config.crawler.maxConcurrentJobs = 1;
    const root = await seedJob({ maxPages: 1 });
    await drainHost();
    expect(await activeCrawlCount()).toBe(1);

    await sweep();

    expect(await chainOf(root)).toHaveLength(2);
    expect(await activeCrawlCount()).toBe(1);
  });

  it('does not continue while another crawl holds the last slot', async () => {
    config.crawler.maxConcurrentJobs = 1;
    const root = await seedJob({ maxPages: 1 });
    await drainHost();
    // Another crawl already holds the only slot once this one closes.
    const other = await CrawlJob.create({
      seedUrl: 'https://other.example.org/',
      maxPages: 5,
      status: 'running',
      lastHeartbeatAt: new Date()
    });
    // With work of its own, so the sweep keeps it open.
    await frontier.addUrls([{ url: 'https://other.example.org/' }], { crawlJobId: other._id });

    await sweep();

    expect(await chainOf(root)).toHaveLength(1);
    expect(await activeCrawlCount()).toBe(1);
    // Exactly what happens with continuous crawl off.
    expect(await CrawlFrontier.countDocuments({ crawlJobId: root._id, status: 'pending' })).toBe(0);
    expect(
      await CrawlFrontier.countDocuments({
        crawlJobId: root._id,
        status: 'skipped',
        lastError: 'job_page_limit_reached'
      })
    ).toBeGreaterThan(0);
  });

  it('never carries a robots.txt refusal forward', async () => {
    const root = await seedJob({ maxPages: 1 });

    await runChain();

    const refused = await CrawlFrontier.findOne({ url: `${site.url}/private/secret` }).lean();
    expect(refused).toMatchObject({ status: 'skipped', lastError: 'robots_txt' });
    // Refused once by the job that claimed it, and never handed on again.
    const chainIds = (await chainOf(root)).map(j => String(j._id));
    expect(chainIds).toContain(String(refused.crawlJobId));
    expect(site.requestLog.some(r => r.path === '/private/secret')).toBe(false);
  });

  it('keeps a failed URL on its retry backoff when it moves to the continuation', async () => {
    const root = await seedJob({ maxPages: 1 });
    await drainHost();
    const missing = normalizeUrl(`${site.url}/missing`);
    // One failed attempt already, as markFailed leaves it.
    await CrawlFrontier.updateOne({ url: missing }, { $set: { status: 'fetching', attempts: 1 } });
    await frontier.markFailed(missing, { reason: 'http_404', statusCode: 404 });
    const before = await CrawlFrontier.findOne({ url: missing }).lean();
    expect(before.nextCrawlAt.getTime()).toBeGreaterThan(Date.now());

    await sweep();
    const [, child] = await chainOf(root);
    await drainHost();

    const after = await CrawlFrontier.findOne({ url: missing }).lean();
    expect(String(after.crawlJobId)).toBe(String(child._id));
    expect(after).toMatchObject({ status: 'pending', attempts: 1, lastError: 'http_404' });
    expect(after.nextCrawlAt.getTime()).toBe(before.nextCrawlAt.getTime());
    // Not due yet, so the continuation did not fetch it early.
    expect(site.requestLog.some(r => r.path === '/missing')).toBe(false);
  });

  it('carries a reclaimed lease forward instead of skipping it', async () => {
    const root = await seedJob({ maxPages: 1 });
    await drainHost();
    await sweep();
    const [, child] = await chainOf(root);

    // A URL of the finished parent whose worker died holding it.
    const stranded = await CrawlFrontier.findOneAndUpdate(
      { crawlJobId: child._id, status: 'pending' },
      {
        $set: {
          crawlJobId: root._id,
          status: 'fetching',
          leasedAt: new Date(Date.now() - 10 * 60 * 1000)
        }
      },
      { returnDocument: 'after' }
    ).lean();

    await sweep();

    const row = await CrawlFrontier.findById(stranded._id).lean();
    expect(row.status).toBe('pending');
    expect(String(row.crawlJobId)).toBe(String(child._id));
  });

  it('creates one continuation even when sweeps race', async () => {
    const root = await seedJob({ maxPages: 1 });
    await drainHost();
    // Closed, but its rows not yet handed on: what a sweep that died between
    // the two steps leaves behind.
    await CrawlJob.updateOne({ _id: root._id }, { $set: { status: 'completed' } });

    await Promise.all([
      maintenance.skipRowsOfClosedJobs(),
      maintenance.skipRowsOfClosedJobs(),
      maintenance.skipRowsOfClosedJobs()
    ]);

    expect(await CrawlJob.countDocuments({ chainId: root._id })).toBe(1);
    const [, child] = await chainOf(root);
    expect(await CrawlFrontier.countDocuments({ crawlJobId: root._id, status: 'pending' })).toBe(0);
    expect(
      await CrawlFrontier.countDocuments({ crawlJobId: child._id, status: 'pending' })
    ).toBeGreaterThan(0);
  });

  it('never fetches a URL twice when slices run concurrently or are retried', async () => {
    const root = await seedJob({ maxPages: 2 });
    await processHost({ host, maxPages: 1 });

    for (let i = 0; i < 8; i += 1) {
      // Several slices of one host at once, as a retried queue job beside a
      // fresh one would be.
      await Promise.all([
        processHost({ host, maxPages: 5 }),
        processHost({ host, maxPages: 5 }),
        processHost({ host, maxPages: 5 })
      ]);
      await sweep();
      if (!(await openJob())) break;
    }

    const paths = site.requestLog.filter(r => r.path !== '/robots.txt').map(r => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(await CrawlFrontier.countDocuments({ status: 'fetching' })).toBe(0);
    for (const job of await chainOf(root)) expect(job.pagesCrawled).toBeLessThanOrEqual(2);
  });

  it('stops chaining at the continuation limit', async () => {
    config.crawler.continuousMaxContinuations = 1;
    const root = await seedJob({ maxPages: 1 });

    await runChain();

    expect(await chainOf(root)).toHaveLength(2);
    expect(await openJob()).toBeNull();
    expect(await CrawlFrontier.countDocuments({ status: 'pending', lastCrawledAt: null })).toBe(0);
    expect(
      await CrawlFrontier.countDocuments({ status: 'skipped', lastError: 'job_page_limit_reached' })
    ).toBeGreaterThan(0);
  });

  it('does not continue a stopped crawl', async () => {
    const root = await seedJob({ maxPages: 1 });
    await drainHost();
    await sweep();
    const [, child] = await chainOf(root);

    await CrawlJob.updateOne({ _id: child._id }, { $set: { stopRequested: true } });
    await runChain();

    expect(await chainOf(root)).toHaveLength(2);
    expect((await CrawlJob.findById(child._id).lean()).status).toBe('stopped');
    expect(await CrawlFrontier.countDocuments({ status: 'pending', lastCrawledAt: null })).toBe(0);
  });

  it('ends once the frontier is drained and does not re-crawl finished pages', async () => {
    // The fixture's 404 would otherwise sit out a real minute of retry
    // backoff, holding the last continuation open.
    config.crawler.maxAttemptsPerUrl = 1;
    const root = await seedJob({ maxPages: 2 });
    await runChain();
    expect(await openJob()).toBeNull();
    const jobs = (await chainOf(root)).length;
    const done = await CrawlFrontier.countDocuments({ status: 'done' });
    const requests = site.requestLog.length;

    // Further sweeps find nothing to continue.
    for (let i = 0; i < 3; i += 1) {
      await sweep();
      await drainHost();
    }

    expect(await chainOf(root)).toHaveLength(jobs);
    expect(await CrawlFrontier.countDocuments({ status: 'done' })).toBe(done);
    expect(site.requestLog.length).toBe(requests);
  });

  it('does not restart a finished chain for a page that comes due for re-crawl', async () => {
    config.crawler.maxAttemptsPerUrl = 1;
    const root = await seedJob({ maxPages: 2 });
    await runChain();
    expect(await openJob()).toBeNull();
    const jobs = (await chainOf(root)).length;

    // Days later, the crawled seed falls due. Re-crawl scheduling handles it
    // on its own; it is not a reason to open another budgeted job.
    await CrawlFrontier.updateOne(
      { url: normalizeUrl(site.url) },
      { $set: { nextCrawlAt: new Date(Date.now() - 1000) } }
    );
    expect(await frontier.requeueDueForRecrawl()).toBe(1);
    await sweep();

    expect(await chainOf(root)).toHaveLength(jobs);
    expect(await openJob()).toBeNull();
    const seedRow = await CrawlFrontier.findOne({ url: normalizeUrl(site.url) }).lean();
    expect(seedRow.status).toBe('pending');
    // A re-crawl belongs to no job, so no chain can pick it up.
    expect(seedRow.crawlJobId).toBeNull();
  });

  it('carries URLs revived from an earlier budget skip, and crawls none without a budget', async () => {
    // Regression: a skip stamps lastCrawledAt, so a URL revived from an
    // earlier crawl's budget skip looks "crawled before" although it never
    // was. Such rows were left behind on the closed job and fetched with no
    // budget at all.
    config.crawler.continuous = false;
    const first = await seedJob({ maxPages: 1 });
    await drainHost();
    await sweep();
    const revivable = await CrawlFrontier.countDocuments({
      crawlJobId: first._id,
      status: 'skipped',
      lastError: 'job_page_limit_reached'
    });
    expect(revivable).toBeGreaterThan(0);

    config.crawler.continuous = true;
    const second = await CrawlJob.create({
      seedUrl: normalizeUrl(site.url),
      maxPages: 1,
      maxDepth: 3,
      sameDomainOnly: true,
      crawlDelayMs: 0,
      status: 'running',
      lastHeartbeatAt: new Date()
    });
    // What createJob does for a seed that is already done.
    await CrawlFrontier.updateOne(
      { url: normalizeUrl(site.url) },
      { $set: { status: 'pending', crawlJobId: second._id, nextCrawlAt: new Date(), attempts: 0 } }
    );
    await drainHost();
    const revived = await CrawlFrontier.countDocuments({
      crawlJobId: second._id,
      status: 'pending',
      lastCrawledAt: { $ne: null }
    });
    expect(revived).toBe(revivable);

    await sweep();
    const [, child] = await chainOf(second);
    expect(await CrawlFrontier.countDocuments({ crawlJobId: second._id, status: 'pending' })).toBe(
      0
    );
    expect(await CrawlFrontier.countDocuments({ crawlJobId: child._id, status: 'pending' })).toBe(
      revived
    );

    const pagesBefore = await Page.countDocuments();
    await drainHost();

    // One page: the continuation's budget, and nothing fetched outside it.
    expect(await Page.countDocuments()).toBe(pagesBefore + 1);
    expect((await CrawlJob.findById(child._id).lean()).pagesCrawled).toBe(1);
  });
});

describe('a URL in flight when its job closes', () => {
  const { config } = require('../../config/env');
  const { reserveBudget } = require('../../crawler/crawlWorker');

  let savedContinuous;
  beforeEach(() => {
    savedContinuous = config.crawler.continuous;
  });
  afterEach(() => {
    config.crawler.continuous = savedContinuous;
  });

  const aboutUrl = () => normalizeUrl(`${site.url}/about`);
  const fetchedAbout = () => site.requestLog.some(r => r.path === '/about');

  /**
   * The race: a job with a two-page budget crawls its seed, and a worker
   * claims /about — a URL revived from an earlier crawl's budget skip, so
   * it carries a lastCrawledAt — reserving the last page of budget. While
   * that fetch is in flight the sweep closes the job, its budget spent. The
   * fetch then fails, and the URL returns to pending, still on the closed job.
   */
  async function inFlightWhenJobCloses({ lease = false } = {}) {
    const job = await seedJob({ maxPages: 2 });
    await processHost({ host, maxPages: 1 });
    await CrawlFrontier.updateOne(
      { url: aboutUrl() },
      { $set: { lastCrawledAt: new Date(Date.now() - 24 * 60 * 60 * 1000), priority: 999 } }
    );

    const claimed = await frontier.claimNext(host);
    expect(claimed.url).toBe(aboutUrl());
    expect(await reserveBudget(job._id, job.maxPages)).toBe(true);

    await maintenance.finaliseCompletedJobs();
    expect((await CrawlJob.findById(job._id).lean()).status).toBe('completed');

    if (lease) {
      // The worker died mid-fetch instead, and its lease is reclaimed.
      await CrawlFrontier.updateOne(
        { _id: claimed._id },
        { $set: { leasedAt: new Date(Date.now() - 10 * 60 * 1000) } }
      );
      expect(await frontier.reclaimStaleLeases()).toBe(1);
    } else {
      await frontier.markFailed(claimed.url, { reason: 'timeout' });
      // Its retry backoff has passed.
      await CrawlFrontier.updateOne({ _id: claimed._id }, { $set: { nextCrawlAt: new Date() } });
    }

    const row = await CrawlFrontier.findById(claimed._id).lean();
    expect(row).toMatchObject({ status: 'pending' });
    expect(String(row.crawlJobId)).toBe(String(job._id));
    return { job, rowId: claimed._id };
  }

  it.each([
    ['fails its fetch', false],
    ['loses its lease', true]
  ])('is never crawled without budget when it %s at the boundary', async (_label, lease) => {
    config.crawler.continuous = false;
    const { job, rowId } = await inFlightWhenJobCloses({ lease });
    const pagesBefore = await Page.countDocuments();

    await maintenance.skipRowsOfClosedJobs();
    for (let i = 0; i < 3; i += 1) await processHost({ host, maxPages: 10 });

    expect(fetchedAbout()).toBe(false);
    expect(await Page.countDocuments()).toBe(pagesBefore);
    expect((await CrawlJob.findById(job._id).lean()).pagesCrawled).toBe(2);
    // Bounded exactly as a closed job's leftovers are: skipped, revivable.
    expect(await CrawlFrontier.findById(rowId).lean()).toMatchObject({
      status: 'skipped',
      lastError: 'crawl_closed'
    });
  });

  it('is not crawled even before the sweep has cleaned up after the job', async () => {
    config.crawler.continuous = false;
    const { job, rowId } = await inFlightWhenJobCloses();

    // A slice runs before any sweep: the worker itself must refuse.
    await processHost({ host, maxPages: 10 });

    expect(fetchedAbout()).toBe(false);
    expect((await CrawlJob.findById(job._id).lean()).pagesCrawled).toBe(2);
    expect((await CrawlFrontier.findById(rowId).lean()).status).toBe('skipped');
  });

  it('with continuous crawl, is adopted by the continuation and crawled on its budget', async () => {
    config.crawler.continuous = true;
    const { job, rowId } = await inFlightWhenJobCloses();

    // Before any sweep the worker leaves it alone: pending, not fetched.
    const early = await processHost({ host, maxPages: 10 });
    expect(early.deferred).toBeGreaterThan(0);
    expect(fetchedAbout()).toBe(false);
    expect((await CrawlFrontier.findById(rowId).lean()).status).toBe('pending');

    // The sweep hands it to a continuation, which crawls it on its own budget.
    await maintenance.finaliseCompletedJobs();
    await maintenance.skipRowsOfClosedJobs();
    // Whichever continuation is open now — the first may already have spent
    // its own budget and handed on in turn.
    const owner = await CrawlJob.findById(
      (await CrawlFrontier.findById(rowId).lean()).crawlJobId
    ).lean();
    expect(String(owner.chainId)).toBe(String(job._id));
    expect(owner.status).toBe('running');
    const ownerBefore = owner.pagesCrawled;

    for (let i = 0; i < 3; i += 1) await processHost({ host, maxPages: 10 });

    expect(fetchedAbout()).toBe(true);
    expect((await CrawlFrontier.findById(rowId).lean()).status).toBe('done');
    expect((await CrawlJob.findById(job._id).lean()).pagesCrawled).toBe(2);
    // Charged to the continuation that owns it, inside that job's budget.
    const after = await CrawlJob.findById(owner._id).lean();
    expect(after.pagesCrawled).toBeGreaterThan(ownerBefore);
    expect(after.pagesCrawled).toBeLessThanOrEqual(after.maxPages);
  });

  it('still lets a scheduled re-crawl run outside any job', async () => {
    config.crawler.continuous = false;
    const job = await seedJob({ maxPages: 1 });
    await drainHost();
    await maintenance.finaliseCompletedJobs();
    expect((await CrawlJob.findById(job._id).lean()).status).toBe('completed');

    await CrawlFrontier.updateOne(
      { url: normalizeUrl(site.url) },
      { $set: { nextCrawlAt: new Date(Date.now() - 1000) } }
    );
    expect(await frontier.requeueDueForRecrawl()).toBe(1);
    await maintenance.skipRowsOfClosedJobs();
    site.requestLog.length = 0;

    const summary = await processHost({ host, maxPages: 10 });

    expect(summary.indexed).toBe(1);
    expect(site.requestLog.some(r => r.path === '/')).toBe(true);
    expect((await CrawlJob.findById(job._id).lean()).pagesCrawled).toBe(1);
  });
});
