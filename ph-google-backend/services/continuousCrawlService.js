const mongoose = require('mongoose');
const CrawlJob = require('../models/CrawlJob');
const CrawlFrontier = require('../models/CrawlFrontier');
const { activeCrawlCount } = require('./crawlerJobService');
const { config } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Continuous crawl (CRAWLER_CONTINUOUS=true).
 *
 * A crawl job is still one bounded slice of work: it stops when its page
 * budget is spent, exactly as before. What changes is what happens to the
 * URLs it discovered and never reached. With continuous crawl off they are
 * skipped. With it on, the maintenance sweep creates a continuation — a new
 * job with the parent's seed, scope, depth limit, delay and page budget —
 * and moves those URLs to it, still `pending`. The worker then crawls them
 * against the continuation's own budget, and links they lead to enter the
 * frontier under the same scope rules as ever.
 *
 * Nothing here enqueues work itself or runs on a timer of its own: the
 * sweep calls it at most once per chain per pass, and the sweep's existing
 * host-enqueue step turns the moved rows into queue jobs. So a chain grows
 * one job per sweep at most, and never recursively.
 *
 * Bounds:
 *   - each job keeps its own `maxPages`;
 *   - a chain takes over its parent's concurrency slot rather than a new
 *     one, and does not continue if the limit no longer has room for it;
 *   - a chain stops after `continuousMaxContinuations` continuations;
 *   - a stopped or failed job is never continued.
 */

const OPEN = ['queued', 'running'];

function chainFilter(chainId) {
  return { $or: [{ _id: chainId }, { chainId }] };
}

/** Pending URLs a job holds, for the log lines below. */
function countContinuableRows(jobId) {
  return CrawlFrontier.countDocuments({ crawlJobId: jobId, status: 'pending' });
}

/**
 * Whether the chain may take a crawl slot: either another job of its batch
 * is still open (the batch already holds the slot), or a slot is free.
 */
async function slotAvailable(groupKey) {
  if (await CrawlJob.exists({ batchId: groupKey, status: { $in: OPEN } })) return true;
  return (await activeCrawlCount()) < config.crawler.maxConcurrentJobs;
}

/**
 * Whether a job still holding its slot may hand it to a continuation.
 *
 * The continuation replaces the job rather than joining it, so the number of
 * open crawls does not grow. Refused only when the other open crawls already
 * fill the limit — the limit was lowered, or a crawl was let in beside this
 * one — so a chain never keeps a slot the limit no longer allows.
 */
async function slotInheritable() {
  return (await activeCrawlCount()) - 1 < config.crawler.maxConcurrentJobs;
}

/**
 * The open job that should take over `job`'s pending URLs, creating a
 * continuation if the chain has none.
 *
 * @param {Object} job the CrawlJob (lean) whose URLs are to be carried on
 * @param {Object} [options]
 * @param {boolean} [options.handover] `job` is still open, has spent its
 *   budget and is about to be closed by the caller. Moving its URLs before it
 *   closes means there is never a moment when they belong to a closed job —
 *   which the worker would crawl with no budget at all.
 * @returns {Promise<Object|null>} the job to move the URLs to, or null when
 *   the URLs should be skipped as they would be without continuous crawl
 */
async function continueCrawl(job, { handover = false } = {}) {
  if (!config.crawler.continuous) return null;
  if (!job || job.stopRequested) return null;
  if (handover ? !OPEN.includes(job.status) : job.status !== 'completed') return null;

  const chainId = job.chainId || job._id;

  // A continuation already open for this chain takes the rows.
  const open = await CrawlJob.findOne({
    ...chainFilter(chainId),
    _id: { $ne: job._id },
    status: { $in: OPEN }
  }).lean();
  if (open) return open;

  // The newest job of the chain is the template; any older job's leftovers
  // go to the same continuation.
  const latest = await CrawlJob.findOne({ ...chainFilter(chainId), continuedAs: null })
    .sort({ continuationIndex: -1 })
    .lean();
  if (!latest || latest.stopRequested) return null;
  if (handover ? String(latest._id) !== String(job._id) : latest.status !== 'completed') {
    return null;
  }

  const index = (latest.continuationIndex || 0) + 1;
  if (index > config.crawler.continuousMaxContinuations) {
    logger.info('Continuous crawl reached its continuation limit', {
      chainId: String(chainId),
      continuations: latest.continuationIndex || 0,
      limit: config.crawler.continuousMaxContinuations
    });
    return null;
  }

  // Topic crawls count once per batch; a single-seed chain is grouped by its
  // first job, so every continuation of it occupies the same one slot.
  const groupKey = latest.batchId || String(chainId);
  const allowed = handover ? await slotInheritable() : await slotAvailable(groupKey);
  if (!allowed) {
    logger.warn('Continuous crawl deferred: no crawl slot free', {
      chainId: String(chainId),
      maxConcurrentJobs: config.crawler.maxConcurrentJobs
    });
    return null;
  }

  const now = new Date();
  const child = await CrawlJob.create({
    _id: new mongoose.Types.ObjectId(),
    seedUrl: latest.seedUrl,
    maxPages: latest.maxPages,
    maxDepth: latest.maxDepth,
    sameDomainOnly: latest.sameDomainOnly,
    allowedDomains: latest.allowedDomains || [],
    excludePatterns: latest.excludePatterns || [],
    crawlDelayMs: latest.crawlDelayMs,
    topic: latest.topic || '',
    // The chain keeps the sitemap choice its first job was made with.
    sitemaps: latest.sitemaps === true,
    batchId: groupKey,
    startedBy: latest.startedBy || null,
    status: 'running',
    startedAt: now,
    lastHeartbeatAt: now,
    chainId,
    continuationOf: latest._id,
    continuationIndex: index
  });

  // Only one continuation per parent: the claim is a single atomic update,
  // so of two sweeps racing here exactly one wins and the other discards the
  // job it made. Created first and claimed second, so a crash in between
  // leaves an empty open job — closed as drained by the next sweep — rather
  // than a parent pointing at a continuation that does not exist.
  const claimed = await CrawlJob.updateOne(
    { _id: latest._id, continuedAs: null },
    { $set: { continuedAs: child._id } }
  );
  if (claimed.modifiedCount === 0) {
    await CrawlJob.deleteOne({ _id: child._id });
    return CrawlJob.findOne({ ...chainFilter(chainId), status: { $in: OPEN } }).lean();
  }

  logger.info('Continuous crawl slice scheduled', {
    chainId: String(chainId),
    parentJobId: String(latest._id),
    jobId: String(child._id),
    continuationIndex: index,
    maxPages: child.maxPages,
    pendingFromParent: await countContinuableRows(job._id)
  });

  return child.toObject();
}

module.exports = { continueCrawl, countContinuableRows };
