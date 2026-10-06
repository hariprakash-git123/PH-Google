const crypto = require('crypto');
const CrawlJob = require('../models/CrawlJob');
const CrawlFrontier = require('../models/CrawlFrontier');
const frontier = require('./frontierService');
const crawlQueue = require('./queue/crawlQueue');
const { config } = require('../config/env');
const { ApiError } = require('../utils/apiResponse');
const { normalizeUrl, canonicalKey } = require('../utils/urlNormalizer');
const { resolveSeeds } = require('../config/crawlSeeds');
const logger = require('../utils/logger');

/**
 * Crawl job management, as seen from the API.
 *
 * This module used to own an in-process runner: starting a job began a crawl
 * inside the Express process and a module-level Map tracked it. That had
 * three problems — a long crawl competed with search requests for the event
 * loop, deploying the API killed every crawl in flight, and the work could
 * not be scaled or paused independently.
 *
 * Now the API only ever writes things down:
 *
 *   start → persist a CrawlJob, seed the frontier, enqueue the seed's host
 *   stop  → set `stopRequested`; the worker reads it between pages
 *
 * Nothing here fetches a page. The endpoints and their response shapes are
 * unchanged, so the admin dashboard needed no rewrite.
 */

/**
 * How many crawls may be open at once.
 *
 * Counted in the database rather than in memory: the jobs are not running in
 * this process any more, and "running" now means "a worker somewhere is
 * working on it".
 */
async function activeJobCount() {
  return CrawlJob.countDocuments({ status: { $in: ['queued', 'running'] } });
}

/**
 * How many *crawls* are open, which is what the concurrency limit counts.
 *
 * A topic crawl is one job per seed so that every seed keeps its own budget
 * and domain scope, but it is one crawl as far as an operator is concerned:
 * all its jobs share a `batchId` and count once.
 */
async function activeCrawlCount() {
  const rows = await CrawlJob.aggregate([
    { $match: { status: { $in: ['queued', 'running'] } } },
    { $group: { _id: { $ifNull: ['$batchId', '$_id'] } } },
    { $count: 'crawls' }
  ]);
  return rows.length > 0 ? rows[0].crawls : 0;
}

async function assertCrawlSlotFree() {
  const active = await activeCrawlCount();
  if (active >= config.crawler.maxConcurrentJobs) {
    throw ApiError.conflict(
      `Too many crawls already running (${active}/${config.crawler.maxConcurrentJobs}). Stop one before starting another.`
    );
  }
}

/**
 * Creates a crawl job and queues its first host.
 *
 * Returns as soon as the job is persisted. Crawling happens in the worker,
 * so this is fast whether the crawl is ten pages or ten thousand.
 *
 * @returns {Promise<{job: CrawlJob, queued: boolean}>} `queued` is false when
 *   Redis was unreachable — the crawl is saved and will start on its own once
 *   the worker's next maintenance sweep runs.
 */
async function startJob(params) {
  await assertCrawlSlotFree();
  return createJob(params);
}

/**
 * Starts a crawl of every seed in the chosen catalog topics.
 *
 * One job per seed, sharing a batch id. Nothing about how a page is crawled
 * differs from a single-URL crawl: each job goes through the same frontier,
 * queue, worker and indexing pipeline, and simply carries its seed's domain
 * policy with it.
 *
 * @param {Object} params
 * @param {string[]|'all'} params.topics
 * @param {number} [params.maxPagesPerSeed]
 * @returns {Promise<{batchId: string, topics: string[], jobs: CrawlJob[],
 *                    maxPagesPerSeed: number, totalPageBudget: number, queued: boolean}>}
 */
async function startSeedCrawl({ topics, maxPagesPerSeed, startedBy = null }) {
  let seeds;
  try {
    seeds = resolveSeeds(topics);
  } catch (error) {
    if (error.unknownTopics) throw ApiError.badRequest(error.message);
    // A broken catalog file is a server misconfiguration, not a bad request.
    throw error;
  }
  if (seeds.length === 0) throw ApiError.badRequest('No seeds found for the requested topics.');

  const perSeed = Math.max(
    1,
    Math.min(
      Number(maxPagesPerSeed) || config.crawler.seedPagesPerSeed,
      config.crawler.maxPagesHardLimit
    )
  );

  const totalPageBudget = seeds.length * perSeed;
  if (totalPageBudget > config.crawler.maxPagesPerCrawl) {
    const fits = Math.floor(config.crawler.maxPagesPerCrawl / seeds.length);
    throw ApiError.badRequest(
      `${seeds.length} seeds x ${perSeed} pages = ${totalPageBudget} pages, over the ${config.crawler.maxPagesPerCrawl}-page limit per crawl. ` +
        (fits >= 1
          ? `Use at most ${fits} pages per seed, or choose fewer topics.`
          : 'Choose fewer topics.')
    );
  }

  await assertCrawlSlotFree();

  const batchId = crypto.randomUUID();
  const jobs = [];
  let queued = true;

  for (const seed of seeds) {
    const created = await createJob({
      seedUrl: seed.url,
      maxPages: perSeed,
      maxDepth: seed.maxDepth !== null ? seed.maxDepth : config.crawler.seedMaxDepth,
      sameDomainOnly: true,
      allowedDomains: seed.allowedDomains,
      excludePatterns: seed.excludePatterns,
      topic: seed.topic,
      sitemaps: seed.sitemaps === true,
      batchId,
      startedBy
    });
    jobs.push(created.job);
    queued = queued && created.queued;
  }

  const topicIds = [...new Set(seeds.map(s => s.topic))];
  logger.info('Topic crawl started', {
    batchId,
    topics: topicIds,
    seeds: seeds.length,
    maxPagesPerSeed: perSeed,
    totalPageBudget
  });

  return { batchId, topics: topicIds, jobs, maxPagesPerSeed: perSeed, totalPageBudget, queued };
}

async function createJob({
  seedUrl,
  maxPages,
  sameDomainOnly = true,
  allowedDomains = [],
  excludePatterns = [],
  maxDepth,
  crawlDelayMs,
  force = false,
  topic = '',
  sitemaps = false,
  batchId = null,
  startedBy = null
}) {
  const normalizedSeed = normalizeUrl(seedUrl);
  if (!normalizedSeed) {
    throw ApiError.badRequest('"seedUrl" is not a valid, crawlable URL.');
  }

  const host = frontier.hostOf(normalizedSeed);
  if (!host) {
    throw ApiError.badRequest('"seedUrl" has no host to crawl.');
  }

  const boundedMaxPages = Math.max(
    1,
    Math.min(Number(maxPages) || config.crawler.defaultMaxPages, config.crawler.maxPagesHardLimit)
  );

  const boundedMaxDepth = Math.max(
    0,
    Math.min(
      Number.isFinite(Number(maxDepth)) ? Number(maxDepth) : config.crawler.defaultMaxDepth,
      config.crawler.maxDepthLimit
    )
  );

  const job = await CrawlJob.create({
    seedUrl: normalizedSeed,
    maxPages: boundedMaxPages,
    maxDepth: boundedMaxDepth,
    sameDomainOnly,
    allowedDomains,
    excludePatterns,
    crawlDelayMs: Number.isFinite(Number(crawlDelayMs))
      ? Number(crawlDelayMs)
      : config.crawler.defaultDelayMs,
    topic,
    // Opted in only by a seed that asks for it; never by the global switch.
    sitemaps: sitemaps === true,
    batchId,
    status: 'queued',
    startedBy
  });

  // The seed outranks everything it discovers, so the crawl starts where the
  // operator pointed it rather than wherever the frontier happens to sort.
  await frontier.addUrls([{ url: normalizedSeed, depth: 0, priority: 1000 }], {
    crawlJobId: job._id
  });

  // A seed already crawled recently sits in the frontier as `done` and the
  // insert above is a no-op, which would leave the job with nothing to do.
  // Force it back to pending so an explicitly requested crawl always runs.
  await CrawlFrontier.updateOne(
    // Keyed the same way the frontier keys every row — by canonical key, not
    // by URL — or a seed written with a tracking parameter would not match
    // the row that was just inserted for it.
    { canonicalKey: canonicalKey(normalizedSeed) },
    {
      $set: {
        status: 'pending',
        nextCrawlAt: new Date(),
        attempts: 0,
        leasedAt: null,
        crawlJobId: job._id,
        depth: 0,
        priority: 1000
      }
    }
  );

  // The frontier is shared and durable, so a site crawled an hour ago is
  // already `done` and will not be fetched again until its re-crawl falls
  // due. That is the point of it — but an administrator who explicitly asks
  // for a crawl sometimes means "now", not "when it is stale". `force` says
  // so, and is scoped to the seed's own host so it cannot reset the world.
  if (force) {
    const reset = await CrawlFrontier.updateMany(
      { host, status: { $in: ['done', 'failed', 'skipped'] } },
      {
        $set: {
          status: 'pending',
          nextCrawlAt: new Date(),
          attempts: 0,
          leasedAt: null,
          // Re-attribute to this job. Left pointing at the finished job that
          // first found them, they would be charged against a budget that is
          // already spent and skipped immediately.
          crawlJobId: job._id
        }
      }
    );
    logger.info('Forced re-crawl', { host, rowsReset: reset.modifiedCount });
  }

  await CrawlJob.updateOne(
    { _id: job._id },
    { $set: { status: 'running', startedAt: new Date(), lastHeartbeatAt: new Date() } }
  );

  // A failure here delays the crawl; it does not lose it. The job and its
  // frontier rows are already in MongoDB, and the worker's maintenance sweep
  // enqueues every host with pending work — so the crawl starts by itself
  // once Redis is back. That is precisely why the frontier is durable, and
  // rejecting the request with a 503 would throw away the resilience.
  //
  // The caller is told which of the two happened rather than being left to
  // guess why nothing is moving.
  let queued = true;
  try {
    await crawlQueue.enqueueHost(host);
  } catch (error) {
    queued = false;
    logger.error('Crawl saved but not queued; it will start when Redis is reachable', {
      jobId: String(job._id),
      host,
      message: error.message
    });
  }

  logger.info('Crawl job created', {
    jobId: String(job._id),
    seedUrl: normalizedSeed,
    host,
    maxPages: boundedMaxPages,
    maxDepth: boundedMaxDepth,
    sameDomainOnly,
    allowedDomains,
    topic: topic || undefined,
    queued
  });

  // `queued` describes this request rather than the job, so it is returned
  // alongside the document instead of being written to it.
  return { job: await CrawlJob.findById(job._id), queued };
}

/**
 * Requests cancellation.
 *
 * The API cannot cancel the crawl directly any more — it is running in
 * another process — so the request is written to the job and the worker
 * reads it between pages. That is also why this no longer marks a job
 * `stopped` just because this process has no runner for it: with the worker
 * split out, the API *never* has one, and doing so would report a stop that
 * never happened while the crawl carried on.
 *
 * @returns {Promise<CrawlJob>}
 */
async function stopJob(jobId) {
  const job = await CrawlJob.findById(jobId);
  if (!job) throw ApiError.notFound('Crawl job not found.');

  if (job.status !== 'queued' && job.status !== 'running') {
    throw ApiError.badRequest(`Crawl job is already "${job.status}" and cannot be stopped.`);
  }

  job.stopRequested = true;
  await job.save();

  // Drop any queued slice for this job's host so the queue stops feeding it.
  // A slice already in flight is left alone; it notices the flag between
  // pages and unwinds cleanly.
  const host = frontier.hostOf(job.seedUrl);
  if (host) await crawlQueue.removeHost(host);

  logger.info('Crawl job stop requested', { jobId: String(job._id) });
  return job;
}

/**
 * Requests a stop for every open job of one topic crawl.
 *
 * @returns {Promise<string[]>} ids of the jobs asked to stop
 */
async function stopBatch(batchId) {
  const open = await CrawlJob.find({ batchId, status: { $in: ['queued', 'running'] } })
    .select('_id')
    .lean();

  if (open.length === 0) {
    const exists = await CrawlJob.exists({ batchId });
    if (!exists) throw ApiError.notFound('Crawl batch not found.');
    throw ApiError.badRequest('Every job in this crawl batch has already finished.');
  }

  for (const { _id } of open) await stopJob(_id);
  return open.map(j => String(j._id));
}

/**
 * Requests a stop for every open crawl.
 *
 * Called on API shutdown, where it is now deliberately a no-op: crawls run
 * in the worker and must survive an API deploy. The worker has its own
 * SIGTERM handling, which finishes the page in flight and releases the lease.
 *
 * @returns {number} always 0
 */
function cancelAllRunners() {
  return 0;
}

/** One job, with live frontier counts folded in. */
async function getJob(jobId) {
  const job = await CrawlJob.findById(jobId).lean();
  if (!job) throw ApiError.notFound('Crawl job not found.');

  const counts = await frontier.countsForJob(job._id);
  return decorate(job, counts);
}

/** Paginated job list, newest first. */
async function listJobs({ page = 1, limit = 20, status = '' } = {}) {
  const filter = {};
  if (status) filter.status = status;

  const [jobs, total] = await Promise.all([
    CrawlJob.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CrawlJob.countDocuments(filter)
  ]);

  return { jobs: jobs.map(job => decorate(job)), total };
}

/**
 * Aggregate crawler status for the dashboard.
 *
 * Reports the queue and the frontier as well as the jobs, because with the
 * worker split out "is the crawler busy?" is no longer answerable from this
 * process alone.
 */
async function getStatus() {
  const [counts, recent, frontierCounts, queueCounts, activeCrawls] = await Promise.all([
    CrawlJob.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    CrawlJob.find().sort({ createdAt: -1 }).limit(5).lean(),
    frontier.globalCounts().catch(() => null),
    crawlQueue.getQueueCounts(),
    activeCrawlCount()
  ]);

  const byStatus = { queued: 0, running: 0, completed: 0, failed: 0, stopped: 0 };
  for (const row of counts) {
    if (row._id in byStatus) byStatus[row._id] = row.count;
  }

  const totals = await CrawlJob.aggregate([
    {
      $group: {
        _id: null,
        pagesCrawled: { $sum: '$pagesCrawled' },
        pagesIndexed: { $sum: '$pagesIndexed' },
        failedPages: { $sum: '$failedPages' }
      }
    }
  ]);
  const t = totals[0] || {};

  const activeJobs = byStatus.queued + byStatus.running;

  return {
    activeJobs,
    // What the concurrency limit counts: a topic crawl's jobs count once.
    activeCrawls,
    maxConcurrentJobs: config.crawler.maxConcurrentJobs,
    isIdle: activeJobs === 0 && (queueCounts.active || 0) === 0,
    byStatus,
    totalJobs: Object.values(byStatus).reduce((a, b) => a + b, 0),
    lifetime: {
      pagesCrawled: t.pagesCrawled || 0,
      pagesIndexed: t.pagesIndexed || 0,
      failedPages: t.failedPages || 0
    },
    // The durable work list. Survives both a queue flush and a restart.
    frontier: frontierCounts || {
      pending: 0,
      fetching: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      hosts: 0
    },
    // `available: false` means Redis is unreachable — worth surfacing,
    // because nothing will be crawled until it comes back.
    queue: queueCounts,
    limits: {
      maxPagesPerJob: config.crawler.maxPagesHardLimit,
      defaultMaxPages: config.crawler.defaultMaxPages,
      defaultMaxDepth: config.crawler.defaultMaxDepth,
      maxDepth: config.crawler.maxDepthLimit,
      defaultDelayMs: config.crawler.defaultDelayMs,
      workerConcurrency: config.crawler.workerConcurrency,
      hostSlicePages: config.crawler.hostSlicePages,
      recrawlAfterDays: config.crawler.recrawlAfterDays,
      maxLinksPerPage: config.crawler.maxLinksPerPage,
      maxPageBytes: config.crawler.maxPageBytes,
      seedPagesPerSeed: config.crawler.seedPagesPerSeed,
      seedMaxDepth: config.crawler.seedMaxDepth,
      maxPagesPerCrawl: config.crawler.maxPagesPerCrawl,
      continuous: config.crawler.continuous,
      continuousMaxContinuations: config.crawler.continuousMaxContinuations,
      userAgent: config.crawler.userAgent
    },
    recentJobs: recent.map(job => decorate(job))
  };
}

/** Adds derived fields to a stored job row. */
function decorate(job, frontierCounts = null) {
  const id = job._id.toString();
  const progress =
    job.maxPages > 0 ? Math.min(100, Math.round((job.pagesCrawled / job.maxPages) * 100)) : 0;

  const decorated = {
    id,
    jobId: id,
    seedUrl: job.seedUrl,
    maxPages: job.maxPages,
    maxDepth: job.maxDepth,
    sameDomainOnly: job.sameDomainOnly,
    allowedDomains: job.allowedDomains || [],
    topic: job.topic || '',
    batchId: job.batchId || null,
    crawlDelayMs: job.crawlDelayMs,
    status: job.status,
    stopRequested: Boolean(job.stopRequested),
    // "A worker is on it", rather than the old "this process is running it".
    isLive: job.status === 'running' && !job.stopRequested,
    progressPercent: progress,
    pagesDiscovered: job.pagesDiscovered,
    pagesCrawled: job.pagesCrawled,
    pagesIndexed: job.pagesIndexed,
    failedPages: job.failedPages,
    skippedByRobots: job.skippedByRobots,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    lastHeartbeatAt: job.lastHeartbeatAt || null,
    error: job.error || '',
    createdAt: job.createdAt
  };

  if (frontierCounts) decorated.frontier = frontierCounts;
  return decorated;
}

module.exports = {
  startJob,
  startSeedCrawl,
  stopJob,
  stopBatch,
  activeCrawlCount,
  getJob,
  listJobs,
  getStatus,
  activeJobCount,
  cancelAllRunners,
  decorate
};
