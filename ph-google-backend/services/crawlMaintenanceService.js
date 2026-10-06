const CrawlJob = require('../models/CrawlJob');
const CrawlFrontier = require('../models/CrawlFrontier');
const CrawlMaintenanceState = require('../models/CrawlMaintenanceState');
const frontier = require('./frontierService');
const continuousCrawl = require('./continuousCrawlService');
const crawlQueue = require('./queue/crawlQueue');
const { config } = require('../config/env');
const logger = require('../utils/logger');

/**
 * The periodic sweep that keeps the crawl honest.
 *
 * Everything here exists because work is now spread across processes that can
 * die independently. A single-process crawler could hold all of this in
 * memory; a worker that is killed mid-fetch cannot, and the state it leaves
 * behind has to be reconciled by someone.
 *
 *   1. Reclaim leases from workers that died holding a URL.
 *   2. Re-queue pages whose re-crawl time has come.
 *   3. Close out crawl jobs with no work left.
 *   4. Enqueue hosts that have URLs waiting.
 *
 * Step 4 is also the recovery path for a lost queue: if Redis is wiped, the
 * frontier in MongoDB still knows what is outstanding and the next sweep
 * rebuilds the queue from it.
 */

/**
 * Marks crawl jobs finished when nothing is left to do.
 *
 * A job is done when its frontier holds no `pending` or `fetching` rows — or
 * when it has spent its page budget, which is the same thing once the
 * remaining URLs have been skipped.
 *
 * @returns {Promise<number>} jobs closed
 */
async function finaliseCompletedJobs() {
  const active = await CrawlJob.find({ status: { $in: ['queued', 'running'] } }).lean();
  if (active.length === 0) return 0;

  let closed = 0;

  for (const job of active) {
    const outstanding = await CrawlFrontier.countDocuments({
      crawlJobId: job._id,
      status: { $in: ['pending', 'fetching'] }
    });

    const budgetSpent = job.pagesCrawled >= job.maxPages;
    if (outstanding > 0 && !budgetSpent) continue;

    // Continuous crawl hands the unfetched URLs to a continuation job before
    // this one closes, so they never belong to a closed job. When the chain
    // may not continue, they are skipped below exactly as without it.
    const handedOn =
      outstanding > 0 && config.crawler.continuous && !job.stopRequested
        ? await handOnPendingRows(job, { handover: true })
        : null;

    // Whatever this job queued and never fetched is out of scope now. Left
    // pending, a worker would pick those rows up after the job closed, find
    // no open job to charge them to, and crawl them with no budget at all.
    if (outstanding > 0 && handedOn === null) {
      await frontier.skipPendingForJob(
        job._id,
        job.stopRequested ? 'crawl_stopped' : 'job_page_limit_reached'
      );
    }

    const counts = await frontier.countsForJob(job._id);

    await CrawlJob.updateOne(
      { _id: job._id, status: { $in: ['queued', 'running'] } },
      {
        $set: {
          status: job.stopRequested ? 'stopped' : 'completed',
          completedAt: new Date(),
          currentUrl: '',
          pagesDiscovered: counts.total,
          failedPages: counts.failed,
          skippedByRobots: job.skippedByRobots
        }
      }
    );

    closed += 1;
    logger.info('Crawl job finished', {
      jobId: String(job._id),
      status: job.stopRequested ? 'stopped' : 'completed',
      pagesIndexed: job.pagesIndexed,
      reason: budgetSpent && outstanding > 0 ? 'page_budget_spent' : 'frontier_drained',
      ...(handedOn !== null ? { continuedWith: handedOn } : {})
    });
  }

  return closed;
}

/**
 * Continuous crawl: moves a job's pending URLs to its chain's open
 * continuation, creating one if needed.
 *
 * @param {Object} job CrawlJob (lean)
 * @param {Object} [options]
 * @param {boolean} [options.handover] the job is still open and about to be
 *   closed, rather than already closed
 * @returns {Promise<number|null>} rows moved, or null when the chain may not
 *   continue and the caller should skip them as it always has
 */
async function handOnPendingRows(job, { handover = false } = {}) {
  const next = await continuousCrawl.continueCrawl(job, { handover });
  if (!next) return null;

  const adopted = await frontier.adoptPendingRows(job._id, next._id);
  if (adopted > 0) {
    logger.info('Continuous crawl carried pending URLs forward', {
      fromJobId: String(job._id),
      toJobId: String(next._id),
      pending: adopted,
      remainingForChain: await continuousCrawl.countContinuableRows(next._id)
    });
  }
  return adopted;
}

const OBSERVER_ID = 'orphan-detection';

/**
 * How long a job may show no progress before it counts as abandoned.
 *
 * Never shorter than several lease timeouts, so a slow host or a long
 * politeness delay is not mistaken for a dead worker whatever the setting.
 */
function orphanTimeoutMs() {
  return Math.max(config.crawler.orphanTimeoutMs, config.crawler.leaseTimeoutMs * 3, 5 * 60 * 1000);
}

/**
 * The longest gap between two sweeps that still means the crawler ran
 * throughout. Sweeps are queue jobs and wait for a free worker slot behind
 * host slices, so a few missed intervals is normal; a gap beyond this means
 * the worker was stopped, crashed, or its machine was asleep.
 */
function maxSweepGapMs() {
  return Math.max(
    config.crawler.maintenanceIntervalMs * 5,
    config.crawler.leaseTimeoutMs * 2,
    5 * 60 * 1000
  );
}

/**
 * Records this sweep and returns since when the crawler has been running
 * without a break.
 *
 * @returns {Promise<Date>}
 */
async function recordSweep(now) {
  const previous = await CrawlMaintenanceState.findOneAndUpdate(
    { _id: OBSERVER_ID },
    { $set: { lastSweepAt: now } },
    { upsert: true, returnDocument: 'before' }
  ).lean();

  const continuous =
    previous &&
    previous.lastSweepAt &&
    previous.observingSince &&
    now.getTime() - previous.lastSweepAt.getTime() <= maxSweepGapMs();
  if (continuous) return previous.observingSince;

  await CrawlMaintenanceState.updateOne({ _id: OBSERVER_ID }, { $set: { observingSince: now } });
  return now;
}

/**
 * Whether anything has happened on a job's behalf since `cutoff`, apart
 * from its heartbeat.
 *
 * Two signals, both taken from the frontier rather than the job document:
 *
 *   - one of the job's own URLs was fetched, skipped or claimed — which
 *     covers failed and skipped pages as well as indexed ones;
 *   - a host the job is still waiting on was worked on for anyone. Jobs
 *     sharing a host take turns, one request at a time per site, so in a
 *     topic crawl with thirty seeds on one encyclopedia the last seeds wait
 *     a long time while the worker is plainly busy on their site.
 */
async function hasRecentActivity(jobId, cutoff) {
  const recent = [
    { lastCrawledAt: { $gte: cutoff } },
    { status: 'fetching', leasedAt: { $gte: cutoff } }
  ];

  if (await CrawlFrontier.exists({ crawlJobId: jobId, $or: recent })) return true;

  const waitingOn = await CrawlFrontier.distinct('host', {
    crawlJobId: jobId,
    status: { $in: ['pending', 'fetching'] }
  });
  if (waitingOn.length === 0) return false;

  return Boolean(await CrawlFrontier.exists({ host: { $in: waitingOn }, $or: recent }));
}

/**
 * Fails crawl jobs whose worker vanished without finishing.
 *
 * Deliberately based on a silent heartbeat rather than on process startup.
 * The previous implementation failed every running job whenever the API
 * booted, which was correct when the API *was* the crawler and is actively
 * wrong now: restarting the API would kill crawls a worker is still running
 * perfectly well.
 *
 * Silence alone proves nothing, for two reasons:
 *
 *   - A job's heartbeat moves only when one of *its* pages is crawled, so
 *     a job waiting its turn on a shared host is silent while healthy.
 *     `hasRecentActivity` looks past the heartbeat for that.
 *   - Silence is measured on the wall clock, and the crawler is not always
 *     running. A worker that was stopped, restarted, or frozen by a sleeping
 *     laptop comes back to find every heartbeat stale — and used to fail
 *     every crawl in flight on its first sweep, seconds before resuming them.
 *     So a job is only judged once the sweep has run without a break for the
 *     whole timeout: silence counts only while the crawler could have made
 *     progress and did not.
 *
 * The frontier is durable, so a crawl interrupted by a crash is resumed, not
 * lost, once a worker is back. What this catches is a job that still makes
 * no progress after the crawler has been running for a full timeout.
 *
 * @returns {Promise<number>}
 */
async function failOrphanedJobs({ now = new Date() } = {}) {
  const observingSince = await recordSweep(now);
  const timeoutMs = orphanTimeoutMs();
  if (now.getTime() - observingSince.getTime() < timeoutMs) return 0;

  const cutoff = new Date(now.getTime() - timeoutMs);
  const silent = {
    status: { $in: ['queued', 'running'] },
    $or: [
      { lastHeartbeatAt: { $lt: cutoff } },
      // A job that never got a heartbeat: the process that created it died
      // before marking it running.
      { lastHeartbeatAt: null, createdAt: { $lt: cutoff } }
    ]
  };
  const candidates = await CrawlJob.find(silent).select('_id').lean();
  if (candidates.length === 0) return 0;

  const orphaned = [];
  for (const job of candidates) {
    if (!(await hasRecentActivity(job._id, cutoff))) orphaned.push(job);
  }
  if (orphaned.length === 0) return 0;

  // `silent` is repeated in the filter, so a job that finished, or whose
  // worker reported in, since it was read above is left alone.
  const result = await CrawlJob.updateMany(
    { _id: { $in: orphaned.map(j => j._id) }, ...silent },
    {
      $set: {
        status: 'failed',
        error: 'No worker has reported progress on this crawl; it was abandoned.',
        completedAt: now,
        currentUrl: ''
      }
    }
  );

  // Same reasoning as finaliseCompletedJobs: a failed job's unfetched URLs
  // must not outlive it as budget-less work. Only for the jobs actually
  // failed here — one that reported in meanwhile still needs its URLs.
  const failed = await CrawlJob.find({
    _id: { $in: orphaned.map(j => j._id) },
    status: 'failed',
    completedAt: now
  })
    .select('_id')
    .lean();
  for (const { _id } of failed) {
    await frontier.skipPendingForJob(_id, 'crawl_failed');
  }

  if (result.modifiedCount > 0) {
    logger.warn('Failed orphaned crawl jobs', { count: result.modifiedCount });
  }
  return result.modifiedCount;
}

/**
 * Skips pending URLs whose crawl job has already ended.
 *
 * The catch-all behind the per-job clean-ups above: any path that closes a
 * job without clearing its frontier — a URL in flight when the job closed
 * that then failed or lost its lease, links found by that page, rows left by
 * older versions of this code — would otherwise leave URLs with no budget.
 * (The worker refuses to crawl them in any case; this clears them away.)
 *
 * Scheduled re-crawls are not touched: they belong to no job. Every pending
 * row that does name a job is that job's work, whether or not it carries a
 * `lastCrawledAt` — a budget skip stamps one too, so a URL revived from an
 * earlier skip has it although it was never fetched.
 *
 * @returns {Promise<number>} rows skipped
 */
async function skipRowsOfClosedJobs() {
  const jobIds = await CrawlFrontier.distinct('crawlJobId', {
    status: 'pending',
    crawlJobId: { $ne: null }
  });
  if (jobIds.length === 0) return 0;

  const open = await CrawlJob.find({
    _id: { $in: jobIds },
    status: { $in: ['queued', 'running'] }
  })
    .select('_id')
    .lean();
  const openIds = new Set(open.map(j => String(j._id)));
  let closed = jobIds.filter(id => !openIds.has(String(id)));
  if (closed.length === 0) return 0;

  // Continuous crawl: rows a completed job still holds — reclaimed leases,
  // retries, links found by a page in flight when it closed — go to its
  // chain's continuation instead. Jobs that cannot continue fall through to
  // the skip below, unchanged.
  if (config.crawler.continuous) {
    const remaining = [];
    for (const id of closed) {
      const job = await CrawlJob.findById(id).lean();
      if ((await handOnPendingRows(job)) === null) remaining.push(id);
    }
    closed = remaining;
    if (closed.length === 0) return 0;
  }

  const result = await CrawlFrontier.updateMany(
    { crawlJobId: { $in: closed }, status: 'pending' },
    { $set: { status: 'skipped', lastError: 'crawl_closed', leasedAt: null } }
  );
  if (result.modifiedCount > 0) {
    logger.warn('Skipped frontier rows left behind by closed crawl jobs', {
      count: result.modifiedCount
    });
  }
  return result.modifiedCount;
}

/**
 * Enqueues hosts that have URLs waiting.
 *
 * Enqueueing is idempotent — the job id is the hostname — so calling this
 * every sweep costs nothing for hosts already queued.
 *
 * @returns {Promise<number>} hosts enqueued
 */
async function enqueuePendingHosts({ limit = 100 } = {}) {
  const hosts = await frontier.hostsWithPendingWork({ limit });
  if (hosts.length === 0) return 0;

  return crawlQueue.enqueueHosts(hosts.map(h => h.host));
}

/**
 * One maintenance pass.
 *
 * Each step is independent and a failure in one must not skip the rest — a
 * Redis outage should still let leases be reclaimed in MongoDB.
 *
 * @returns {Promise<Object>} what each step did
 */
async function runMaintenance() {
  const summary = {
    leasesReclaimed: 0,
    recrawlsQueued: 0,
    jobsClosed: 0,
    jobsOrphaned: 0,
    orphanRowsSkipped: 0,
    hostsEnqueued: 0,
    errors: []
  };

  const steps = [
    ['leasesReclaimed', () => frontier.reclaimStaleLeases()],
    ['recrawlsQueued', () => frontier.requeueDueForRecrawl()],
    // Close finished jobs first: a job with nothing left to do is complete,
    // however long ago its last page was, and must not be judged abandoned.
    ['jobsClosed', () => finaliseCompletedJobs()],
    ['jobsOrphaned', () => failOrphanedJobs()],
    // Before enqueueing, so no host is queued for rows about to be skipped.
    ['orphanRowsSkipped', () => skipRowsOfClosedJobs()],
    ['hostsEnqueued', () => enqueuePendingHosts()]
  ];

  for (const [key, step] of steps) {
    try {
      summary[key] = await step();
    } catch (error) {
      summary.errors.push(`${key}: ${error.message}`);
      logger.error('Crawl maintenance step failed', { step: key, message: error.message });
    }
  }

  return summary;
}

module.exports = {
  runMaintenance,
  finaliseCompletedJobs,
  failOrphanedJobs,
  skipRowsOfClosedJobs,
  enqueuePendingHosts
};
