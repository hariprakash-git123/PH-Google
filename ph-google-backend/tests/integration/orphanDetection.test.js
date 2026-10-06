const testDb = require('../helpers/testDb');
const { startFixtureSite } = require('../helpers/fixtureSite');
const { crawlerRunningFor } = require('../helpers/factories');
const { clearRobotsCache } = require('../../crawler/robotsChecker');
const { clearHostPolicyCache } = require('../../crawler/hostPolicy');
const { processHost } = require('../../crawler/crawlWorker');
const frontier = require('../../services/frontierService');
const maintenance = require('../../services/crawlMaintenanceService');
const CrawlFrontier = require('../../models/CrawlFrontier');
const CrawlJob = require('../../models/CrawlJob');
const CrawlMaintenanceState = require('../../models/CrawlMaintenanceState');
const { config } = require('../../config/env');
const { normalizeUrl } = require('../../utils/urlNormalizer');

/**
 * Regression tests for false "abandoned crawl" failures.
 *
 * Topic crawls were failed with "No worker has reported progress on this
 * crawl" after crawling and indexing their seed, while other jobs of the
 * same crawl went on to complete. The worker had been frozen — the machine
 * slept — and its first sweep on waking judged every job by the wall clock:
 * every heartbeat and every host looked twenty minutes silent, so every
 * crawl in flight was failed seconds before the worker resumed it.
 */

const MINUTE = 60 * 1000;
const TIMEOUT = config.crawler.orphanTimeoutMs;

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
});

/** A running job with its seed in the frontier, as startJob leaves it. */
async function seedJob({ maxPages = 10, heartbeatAgoMs = 0 } = {}) {
  const seedUrl = normalizeUrl(site.url);
  const job = await CrawlJob.create({
    seedUrl,
    maxPages,
    maxDepth: 3,
    crawlDelayMs: 0,
    status: 'running',
    startedAt: new Date(),
    lastHeartbeatAt: new Date(Date.now() - heartbeatAgoMs)
  });
  await frontier.addUrls([{ url: seedUrl, depth: 0, priority: 1000 }], { crawlJobId: job._id });
  return job;
}

/** Pushes every frontier timestamp back, as if nothing had run since. */
async function ageFrontier(agoMs) {
  const then = new Date(Date.now() - agoMs);
  await CrawlFrontier.updateMany(
    { lastCrawledAt: { $ne: null } },
    { $set: { lastCrawledAt: then } }
  );
  await CrawlFrontier.updateMany({ leasedAt: { $ne: null } }, { $set: { leasedAt: then } });
}

const statusOf = async job => (await CrawlJob.findById(job._id).lean()).status;

describe('orphan detection leaves healthy crawls running', () => {
  beforeEach(async () => {
    await crawlerRunningFor(2 * 60 * MINUTE);
  });

  it('keeps an active job with a recent heartbeat running', async () => {
    const job = await seedJob();

    expect(await maintenance.failOrphanedJobs()).toBe(0);
    expect(await statusOf(job)).toBe('running');
  });

  it('keeps a job running when its pages are being crawled, whatever its heartbeat says', async () => {
    const job = await seedJob();
    await processHost({ host, maxPages: 1 });

    const crawled = await CrawlJob.findById(job._id).lean();
    expect(crawled.pagesCrawled).toBe(1);
    expect(crawled.pagesIndexed).toBe(1);

    // The heartbeat went stale — a missed write, a clock step — but the
    // frontier shows this job's page was fetched moments ago.
    await CrawlJob.updateOne(
      { _id: job._id },
      { $set: { lastHeartbeatAt: new Date(Date.now() - 2 * TIMEOUT) } }
    );

    expect(await maintenance.failOrphanedJobs()).toBe(0);
    const after = await CrawlJob.findById(job._id).lean();
    expect(after.status).toBe('running');
    expect(after.error).toBe('');
    expect(
      await CrawlFrontier.countDocuments({ crawlJobId: job._id, status: 'pending' })
    ).toBeGreaterThan(0);
  });

  it('keeps a job running while one of its URLs is being fetched', async () => {
    const job = await seedJob({ heartbeatAgoMs: 2 * TIMEOUT });
    // A slow fetch in flight: claimed, not yet finished.
    expect(await frontier.claimNext(host)).toBeTruthy();

    expect(await maintenance.failOrphanedJobs()).toBe(0);
    expect(await statusOf(job)).toBe('running');
  });

  it('keeps a job running through a stale heartbeat still inside the grace period', async () => {
    // Ten minutes: past the old five-minute cutoff that failed real crawls
    // waiting their turn on a shared host, well inside the grace period.
    const job = await seedJob({ heartbeatAgoMs: 10 * MINUTE });
    await ageFrontier(10 * MINUTE);

    expect(await maintenance.failOrphanedJobs()).toBe(0);
    expect(await statusOf(job)).toBe('running');
  });

  it('uses a grace period long enough for a topic crawl on one busy host', () => {
    // Measured: ~3.5s per Wikipedia page, so 38 seeds x 7 pages keeps the
    // last seeds waiting ~15 minutes for their turn. The grace period must
    // clear that with room to spare.
    expect(TIMEOUT).toBeGreaterThanOrEqual(30 * MINUTE);
  });
});

describe('orphan detection after the crawler was not running', () => {
  it('does not fail anything on the first sweep after the worker was frozen', async () => {
    // The incident: the last sweep ran 16 minutes ago, then the machine
    // slept. Every heartbeat and every host is now older than the timeout.
    const now = new Date();
    await CrawlMaintenanceState.create({
      _id: 'orphan-detection',
      observingSince: new Date(now.getTime() - 3 * TIMEOUT),
      lastSweepAt: new Date(now.getTime() - TIMEOUT - 16 * MINUTE)
    });
    const job = await seedJob({ heartbeatAgoMs: TIMEOUT + 16 * MINUTE });
    await processHost({ host, maxPages: 1 });
    await CrawlJob.updateOne(
      { _id: job._id },
      { $set: { lastHeartbeatAt: new Date(now.getTime() - TIMEOUT - 16 * MINUTE) } }
    );
    await ageFrontier(TIMEOUT + 16 * MINUTE);

    expect(await maintenance.failOrphanedJobs({ now })).toBe(0);
    expect(await statusOf(job)).toBe('running');

    // And the clock restarts: silence only counts from when the crawler was
    // back, so the next sweeps inside the grace period leave it alone too.
    const soon = new Date(now.getTime() + 5 * MINUTE);
    expect(await maintenance.failOrphanedJobs({ now: soon })).toBe(0);
    expect(await statusOf(job)).toBe('running');
  });

  it('does not fail anything on the first sweep of a freshly started worker', async () => {
    // No record of any earlier sweep: the crawler may have been down for
    // hours, which says nothing about whether the job was abandoned.
    const job = await seedJob({ heartbeatAgoMs: 5 * TIMEOUT });
    await ageFrontier(5 * TIMEOUT);

    expect(await maintenance.failOrphanedJobs()).toBe(0);
    expect(await statusOf(job)).toBe('running');
  });
});

describe('orphan detection still catches abandoned crawls', () => {
  it('fails a job with an old heartbeat and no activity while the crawler ran', async () => {
    const job = await seedJob();
    await processHost({ host, maxPages: 1 });
    await CrawlJob.updateOne(
      { _id: job._id },
      { $set: { lastHeartbeatAt: new Date(Date.now() - 2 * TIMEOUT) } }
    );
    await ageFrontier(2 * TIMEOUT);
    await crawlerRunningFor(3 * TIMEOUT);

    expect(await maintenance.failOrphanedJobs()).toBe(1);

    const failed = await CrawlJob.findById(job._id).lean();
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/abandoned/i);
    // Its unfetched URLs do not outlive it as budget-less work.
    expect(await CrawlFrontier.countDocuments({ crawlJobId: job._id, status: 'pending' })).toBe(0);
  });

  it('fails a crawl that stayed silent for a full grace period after the worker came back', async () => {
    // Worker restarts; the job never moves again.
    const start = new Date();
    const job = await seedJob({ heartbeatAgoMs: 3 * TIMEOUT });
    await ageFrontier(3 * TIMEOUT);

    expect(await maintenance.failOrphanedJobs({ now: start })).toBe(0);

    // Sweeps every minute, no gap, until a full grace period has passed.
    let failed = 0;
    for (let t = MINUTE; t <= TIMEOUT; t += MINUTE) {
      failed += await maintenance.failOrphanedJobs({ now: new Date(start.getTime() + t) });
    }
    expect(failed).toBe(1);
    expect(await statusOf(job)).toBe('failed');
  });

  it('fails a job left queued by a process that died before starting it', async () => {
    await crawlerRunningFor(3 * TIMEOUT);
    const job = await CrawlJob.create({
      seedUrl: normalizeUrl(site.url),
      maxPages: 10,
      status: 'queued',
      createdAt: new Date(Date.now() - 2 * TIMEOUT)
    });
    // `timestamps` would otherwise overwrite createdAt with now.
    await CrawlJob.collection.updateOne(
      { _id: job._id },
      { $set: { createdAt: new Date(Date.now() - 2 * TIMEOUT) } }
    );

    expect(await maintenance.failOrphanedJobs()).toBe(1);
    expect(await statusOf(job)).toBe('failed');
  });
});

describe('orphan detection never touches finished jobs', () => {
  beforeEach(async () => {
    await crawlerRunningFor(3 * TIMEOUT);
  });

  it.each(['completed', 'stopped', 'failed'])('leaves a %s job exactly as it was', async status => {
    const job = await seedJob({ heartbeatAgoMs: 2 * TIMEOUT });
    await CrawlJob.updateOne(
      { _id: job._id },
      { $set: { status, completedAt: new Date(Date.now() - TIMEOUT), error: '' } }
    );
    await ageFrontier(2 * TIMEOUT);
    const before = await CrawlJob.findById(job._id).lean();

    expect(await maintenance.failOrphanedJobs()).toBe(0);
    await maintenance.runMaintenance();

    const after = await CrawlJob.findById(job._id).lean();
    expect(after.status).toBe(status);
    expect(after.error).toBe(before.error);
    expect(after.completedAt).toEqual(before.completedAt);
  });

  it('completes, rather than fails, a silent job whose work is all done', async () => {
    // Before, the orphan check ran first in the sweep, so a job whose last
    // page finished long ago was failed before it could be closed.
    const job = await seedJob({ maxPages: 1 });
    await processHost({ host, maxPages: 5 });
    expect(await CrawlFrontier.countDocuments({ crawlJobId: job._id, status: 'pending' })).toBe(0);
    await CrawlJob.updateOne(
      { _id: job._id },
      { $set: { lastHeartbeatAt: new Date(Date.now() - 2 * TIMEOUT) } }
    );
    await ageFrontier(2 * TIMEOUT);

    const summary = await maintenance.runMaintenance();

    expect(summary.jobsClosed).toBe(1);
    expect(summary.jobsOrphaned).toBe(0);
    const closed = await CrawlJob.findById(job._id).lean();
    expect(closed.status).toBe('completed');
    expect(closed.error).toBe('');
  });
});
