const { Worker } = require('bullmq');

const testDb = require('../helpers/testDb');
const { startFixtureSite } = require('../helpers/fixtureSite');
const { clearRobotsCache } = require('../../crawler/robotsChecker');
const { clearHostPolicyCache } = require('../../crawler/hostPolicy');
const { processHost } = require('../../crawler/crawlWorker');
const frontier = require('../../services/frontierService');
const maintenance = require('../../services/crawlMaintenanceService');
const {
  getConnection,
  closeConnection,
  resetConnection
} = require('../../services/queue/connection');
const crawlQueue = require('../../services/queue/crawlQueue');
const CrawlFrontier = require('../../models/CrawlFrontier');
const CrawlJob = require('../../models/CrawlJob');
const { normalizeUrl } = require('../../utils/urlNormalizer');
const { config } = require('../../config/env');

/**
 * Continuous crawl through the real queue.
 *
 * tests/integration/crawlWorker.test.js covers the continuation logic
 * without Redis. This covers what only BullMQ can show: that a host slice
 * which fails after doing its work is retried by the queue without fetching
 * anything twice, and that the continuation the sweep creates is carried to
 * the worker by the ordinary host enqueue.
 *
 * Skipped (not passed) without Redis, like the rest of tests/queue/.
 */

const available = process.env.REDIS_AVAILABLE === 'true';
const describeLive = available ? describe : describe.skip;

const TEST_PREFIX = `ph-google-test-continuous-${process.pid}`;

describeLive('continuous crawl through BullMQ (live Redis)', () => {
  let site;
  let host;
  let worker;
  const saved = {};
  const attempts = [];

  beforeAll(async () => {
    saved.prefix = config.redis.queuePrefix;
    saved.continuous = config.crawler.continuous;
    config.redis.queuePrefix = TEST_PREFIX;
    config.crawler.continuous = true;
    resetConnection();
    crawlQueue.resetQueue();

    await testDb.connect();
    site = await startFixtureSite();
    host = frontier.hostOf(site.url);
    clearRobotsCache();
    clearHostPolicyCache();

    worker = new Worker(
      crawlQueue.QUEUE_NAME,
      async job => {
        const summary = await processHost({ host: job.data.host, maxPages: 5 });
        attempts.push({ host: job.data.host, attempt: job.attemptsMade, summary });
        // The first slice dies after its work is done, before the queue
        // hears about it — the case a retry has to survive.
        if (attempts.length === 1) throw new Error('simulated crash after the slice');
        return summary;
      },
      {
        connection: getConnection('worker'),
        prefix: TEST_PREFIX,
        concurrency: 4
      }
    );
  });

  afterAll(async () => {
    if (worker) await worker.close();
    for (const q of [crawlQueue.getQueue(), crawlQueue.getMaintenanceQueue()]) {
      try {
        await q.obliterate({ force: true });
      } catch {
        // Nothing to remove.
      }
    }
    await crawlQueue.closeQueue();
    await closeConnection();
    config.redis.queuePrefix = saved.prefix;
    config.crawler.continuous = saved.continuous;
    if (site) await site.close();
    await testDb.disconnect();
  });

  async function until(predicate, { timeoutMs = 20000, everyMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise(resolve => {
        setTimeout(resolve, everyMs);
      });
    }
    return false;
  }

  it('retries a crashed slice without duplicate fetches, then continues the crawl', async () => {
    const seedUrl = normalizeUrl(site.url);
    const root = await CrawlJob.create({
      seedUrl,
      maxPages: 2,
      maxDepth: 3,
      sameDomainOnly: true,
      crawlDelayMs: 0,
      status: 'running',
      lastHeartbeatAt: new Date()
    });
    await frontier.addUrls([{ url: seedUrl, depth: 0, priority: 1000 }], {
      crawlJobId: root._id
    });

    await crawlQueue.enqueueHost(host);

    // The crash, then BullMQ's retry of the same job.
    expect(await until(() => attempts.length >= 2)).toBe(true);
    expect(attempts[1].attempt).toBeGreaterThan(attempts[0].attempt);
    expect((await CrawlJob.findById(root._id).lean()).pagesCrawled).toBe(2);

    // What the maintenance sweep does next: continue the crawl and enqueue
    // the host again for the rows it carried forward.
    await maintenance.finaliseCompletedJobs();
    await maintenance.skipRowsOfClosedJobs();
    const child = await CrawlJob.findOne({ chainId: root._id }).lean();
    expect(child).toBeTruthy();
    expect(await maintenance.enqueuePendingHosts()).toBe(1);

    expect(
      await until(async () => (await CrawlJob.findById(child._id).lean()).pagesCrawled > 0)
    ).toBe(true);
    await until(async () => (await crawlQueue.getQueueCounts()).active === 0);

    const paths = site.requestLog.filter(r => r.path !== '/robots.txt').map(r => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(await CrawlFrontier.countDocuments({ status: 'fetching' })).toBe(0);
    expect((await CrawlJob.findById(child._id).lean()).pagesCrawled).toBeLessThanOrEqual(2);
  });
});
