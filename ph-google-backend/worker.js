const { Worker } = require('bullmq');

const { config, assertValidConfig, configWarnings } = require('./config/env');
const logger = require('./utils/logger');
const { connectDatabase, disconnectDatabase } = require('./config/db');
const { getConnection, closeConnection, checkHealth } = require('./services/queue/connection');
const crawlQueue = require('./services/queue/crawlQueue');
const { processHost } = require('./crawler/crawlWorker');
const { runMaintenance } = require('./services/crawlMaintenanceService');
const openSearchClient = require('./services/opensearch/client');

/**
 * The crawl worker.
 *
 * A separate process from the API, and the only place a page is ever
 * fetched. The API validates a crawl request, writes it down and enqueues
 * it; everything after that happens here.
 *
 * The split matters for three reasons. A crawl no longer competes with
 * search requests for the event loop. Deploying the API no longer kills
 * crawls in flight. And the worker can be scaled — or stopped entirely —
 * without touching the thing users talk to.
 *
 *   npm run worker           start it
 *   docker compose up -d     starts it alongside the API
 */

async function start() {
  try {
    assertValidConfig();
  } catch (error) {
    console.error(`\n[WORKER STARTUP FAILED] ${error.message}\n`);
    process.exit(1);
  }

  for (const warning of configWarnings()) {
    logger.warn(warning);
  }

  logger.info('Starting PH-Google crawl worker', {
    environment: config.nodeEnv,
    concurrency: config.crawler.workerConcurrency,
    hostSlicePages: config.crawler.hostSlicePages,
    continuousCrawl: config.crawler.continuous,
    ...(config.crawler.continuous
      ? { maxContinuations: config.crawler.continuousMaxContinuations }
      : {}),
    userAgent: config.crawler.userAgent
  });

  // MongoDB holds the frontier and every job record. Without it the worker
  // has nothing to crawl and no way to record what it did.
  try {
    await connectDatabase();
  } catch (error) {
    logger.error('Worker could not connect to MongoDB', { message: error.message });
    console.error('\n[WORKER STARTUP FAILED] MongoDB connection failed. Check MONGO_URI.\n');
    process.exit(1);
  }

  // Redis carries the queue. Unlike MongoDB this is checked rather than
  // required up front — ioredis reconnects on its own, so a worker started
  // while Redis is still booting should wait rather than die.
  const redis = await checkHealth();
  if (!redis.ok) {
    logger.warn('Redis is not reachable yet; the worker will keep retrying', {
      url: redis.url,
      error: redis.error
    });
  }

  // Not fatal either: a page that cannot be indexed is recorded as a failed
  // frontier row and retried, and the cluster may still be starting.
  const search = await openSearchClient.checkHealth();
  if (!search.ok) {
    logger.warn('OpenSearch is not reachable; crawled pages will fail to index', {
      error: search.error
    });
  }

  const worker = new Worker(
    crawlQueue.QUEUE_NAME,
    async job => {
      // Sweeps run on their own queue now (below). One can still arrive here
      // if it was already queued by a worker from before that change; it is
      // harmless to run, and the schedule that made it is removed at startup.
      if (job.name === crawlQueue.MAINTENANCE_JOB) {
        return runMaintenance();
      }

      if (job.name === crawlQueue.HOST_JOB) {
        const { host } = job.data || {};
        // Re-queueing for the next slice happens in the 'completed' handler
        // below, not here: while this job is running its id is taken, so an
        // enqueue from inside it is silently ignored and the host would get
        // one slice and no more.
        return processHost({ host });
      }

      logger.warn('Unknown job type on the crawl queue', { name: job.name });
      return null;
    },
    {
      // Its own connection: BullMQ's worker blocks on a connection while
      // polling, which would stall every enqueue sharing it.
      connection: getConnection('worker'),
      prefix: config.redis.queuePrefix,
      // Concurrency here is *hosts in parallel*, not requests per host. One
      // host is one job and BullMQ will not run two jobs with the same id,
      // so per-site politeness holds however high this goes.
      concurrency: config.crawler.workerConcurrency
    }
  );

  // Re-queue a host for another slice if work remains. By the time this
  // fires the finished job has been removed, so its id is free again. The
  // delay is the host's own politeness interval, so the next slice cannot
  // start sooner than the site allows.
  worker.on('completed', (job, summary) => {
    if (!job || job.name !== crawlQueue.HOST_JOB || !summary || !summary.hasMore) return;
    crawlQueue.enqueueHost(summary.host, { delayMs: Math.max(summary.delayMs, 250) }).catch(() => {
      // Logged by enqueueHost; the maintenance sweep re-queues it anyway.
    });
  });

  worker.on('failed', (job, error) => {
    logger.error('Crawl job failed', {
      jobId: job && job.id,
      name: job && job.name,
      attempts: job && job.attemptsMade,
      message: error.message
    });
  });

  worker.on('error', error => {
    // Connection-level problems; ioredis retries underneath.
    logger.error('Crawl worker error', { message: error.message });
  });

  // The maintenance sweep, on a queue and worker of its own: one sweep at a
  // time, never occupying a slot the crawl needs, never retried.
  const maintenanceWorker = crawlQueue.createMaintenanceWorker(() => runMaintenance());

  maintenanceWorker.on('failed', (job, error) => {
    // Not retried; the next scheduled sweep repeats the same work.
    logger.warn('Maintenance sweep failed', { jobId: job && job.id, message: error.message });
  });

  maintenanceWorker.on('error', error => {
    logger.error('Maintenance worker error', { message: error.message });
  });

  try {
    await crawlQueue.scheduleMaintenance();
  } catch (error) {
    logger.warn('Could not schedule maintenance job yet', { message: error.message });
  }

  logger.info('Crawl worker ready', { queue: crawlQueue.QUEUE_NAME });
  console.log(`PH-Google crawl worker ready (concurrency ${config.crawler.workerConcurrency})`);

  // --- Graceful shutdown ---------------------------------------------
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Worker shutting down', { signal });

    try {
      // `false` lets the slices in flight finish their current page, so a
      // deploy does not abandon a lease and leave a URL stuck in `fetching`
      // until the next sweep reclaims it.
      await Promise.all([worker.close(false), maintenanceWorker.close(false)]);
      await crawlQueue.closeQueue();
      await closeConnection();
      await openSearchClient.closeClient();
      await disconnectDatabase();
      logger.info('Worker shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('Worker shutdown failed', { message: error.message });
      process.exit(1);
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', reason => {
    logger.error('Unhandled promise rejection in worker', {
      message: reason instanceof Error ? reason.message : String(reason)
    });
  });

  process.on('uncaughtException', error => {
    logger.error('Uncaught exception in worker', { error });
    shutdown('uncaughtException');
  });

  // Don't wait up to a whole interval for the first sweep: a worker starting
  // after a crash should reclaim abandoned leases immediately.
  runMaintenance().catch(error =>
    logger.warn('Initial maintenance pass failed', { message: error.message })
  );

  return worker;
}

if (require.main === module) {
  start();
}

module.exports = { start };
