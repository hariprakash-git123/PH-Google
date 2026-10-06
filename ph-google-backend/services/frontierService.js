const CrawlFrontier = require('../models/CrawlFrontier');
const { normalizeUrl, canonicalKey } = require('../utils/urlNormalizer');
const { config } = require('../config/env');
const logger = require('../utils/logger');

/**
 * The crawl frontier, as operations rather than documents.
 *
 * Everything that decides *which URL is fetched next* lives here, so the
 * worker's drain loop stays readable and the ordering rules are testable
 * without a queue, a network or a worker process.
 *
 * The important property is that `claimNext` is atomic. Several workers may
 * be draining different hosts at the same time, and after a restart a second
 * worker can appear while the first is still finishing — a claim implemented
 * as find-then-update would hand the same URL to both and fetch it twice.
 */

/** Pulls the lowercased hostname out of a URL, or null if it has none. */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The query that finds the row for a URL.
 *
 * Rows are keyed by `canonicalKey`, not by `url`, so that `/article` and
 * `/article?utm_source=twitter` are one page rather than two crawls. Every
 * lookup has to go through the same identity function the insert used, or a
 * row written under one spelling would be invisible to the other.
 */
function byUrl(url) {
  return { canonicalKey: canonicalKey(url) };
}

/**
 * Adds URLs to the frontier.
 *
 * Insertion is unordered bulk with duplicates ignored: discovering a URL that
 * is already known is the normal case, not an error, and must not cost a
 * round trip per link. A URL already in the frontier keeps its original
 * depth and status — re-discovering a page from deeper in the graph should
 * not push it further away or resurrect a finished row.
 *
 * @param {Array<{url: string, depth?: number, priority?: number, referrerUrl?: string}>} entries
 * @param {Object} [context]
 * @param {import('mongoose').Types.ObjectId} [context.crawlJobId]
 * @returns {Promise<{added: number, skipped: number}>}
 */
async function addUrls(entries, { crawlJobId = null } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return { added: 0, skipped: 0 };

  const now = new Date();
  const seen = new Set();
  const operations = [];

  for (const entry of entries) {
    const url = normalizeUrl(entry && entry.url);
    if (!url) continue;

    const key = canonicalKey(url);
    if (!key) continue;

    // Guard against the same page appearing twice in one batch, which an
    // unordered bulk write would otherwise report as a duplicate-key error.
    // Keyed the same way the index is, so two spellings of one page count
    // as one here too.
    if (seen.has(key)) continue;
    seen.add(key);

    const host = hostOf(url);
    if (!host) continue;

    operations.push({
      insertOne: {
        document: {
          url,
          canonicalKey: key,
          host,
          crawlJobId,
          depth: Math.max(0, Number(entry.depth) || 0),
          priority: Number(entry.priority) || 0,
          status: 'pending',
          nextCrawlAt: now,
          discoveredAt: now,
          referrerUrl: String(entry.referrerUrl || '').slice(0, 500)
        }
      }
    });
  }

  if (operations.length === 0) return { added: 0, skipped: 0 };

  let added;
  try {
    const result = await CrawlFrontier.bulkWrite(operations, { ordered: false });
    added = result.insertedCount || 0;
  } catch (error) {
    // A duplicate key here means the URL was already known, which is the
    // expected outcome for most links on most pages. Everything else is a
    // real failure.
    if (!(error && error.code === 11000)) {
      logger.error('Frontier insert failed', { message: error.message });
      throw error;
    }
    added = (error.result && error.result.insertedCount) || 0;
  }

  if (crawlJobId && added < operations.length) {
    added += await reviveBudgetSkipped(operations, crawlJobId, now);
  }

  return { added, skipped: operations.length - added };
}

/**
 * Skip reasons that say nothing about the URL itself — only that the crawl
 * which found it ran out of budget or was stopped. A later crawl that
 * discovers the same URL is entitled to fetch it.
 */
const REVIVABLE_SKIP_REASONS = [
  'job_page_limit_reached',
  'crawl_stopped',
  'crawl_failed',
  'crawl_closed'
];

/**
 * Hands URLs that an earlier crawl skipped for budget reasons to a new one.
 *
 * Without this, re-running a topic crawl could never grow the index: the
 * first run's seed pages would be fetched again, but every link they lead
 * to was already marked skipped by the first run's budget, so the second
 * run would find nothing new to crawl.
 *
 * Rows skipped for a reason about the URL — robots.txt, a PDF — stay skipped.
 *
 * @returns {Promise<number>} rows revived
 */
async function reviveBudgetSkipped(operations, crawlJobId, now) {
  const byKey = new Map(operations.map(op => [op.insertOne.document.canonicalKey, op]));

  const revivable = await CrawlFrontier.find({
    canonicalKey: { $in: Array.from(byKey.keys()) },
    status: 'skipped',
    lastError: { $in: REVIVABLE_SKIP_REASONS },
    crawlJobId: { $ne: crawlJobId }
  })
    .select('canonicalKey')
    .lean();

  if (revivable.length === 0) return 0;

  const result = await CrawlFrontier.bulkWrite(
    revivable.map(row => {
      const doc = byKey.get(row.canonicalKey).insertOne.document;
      return {
        updateOne: {
          // Status repeated in the filter so a row claimed in between is left alone.
          filter: { _id: row._id, status: 'skipped' },
          update: {
            $set: {
              status: 'pending',
              crawlJobId,
              depth: doc.depth,
              priority: doc.priority,
              nextCrawlAt: now,
              attempts: 0,
              leasedAt: null,
              lastError: ''
            }
          }
        }
      };
    }),
    { ordered: false }
  );

  return result.modifiedCount || 0;
}

/**
 * Marks every URL still waiting for one crawl job as skipped.
 *
 * Called when the job's page budget is spent and when the job is closed.
 * Left pending, those rows would outlive the job and be fetched later by a
 * worker that no longer knows which budget they belonged to.
 *
 * @returns {Promise<number>} rows skipped
 */
async function skipPendingForJob(crawlJobId, reason = 'job_page_limit_reached') {
  if (!crawlJobId) return 0;
  const result = await CrawlFrontier.updateMany(
    { crawlJobId, status: 'pending' },
    { $set: { status: 'skipped', lastError: reason, leasedAt: null, lastCrawledAt: new Date() } }
  );
  return result.modifiedCount || 0;
}

/**
 * Atomically claims the next URL due for one host.
 *
 * findOneAndUpdate is a single document operation, so of two workers racing
 * for the same row exactly one wins and the other moves to the next URL.
 *
 * @param {string} host
 * @param {Object} [options]
 * @param {Date} [options.now]
 * @returns {Promise<Object|null>} the claimed row, or null when nothing is due
 */
async function claimNext(host, { now = new Date(), excludeJobIds = [] } = {}) {
  const filter = { host, status: 'pending', nextCrawlAt: { $lte: now } };
  // Continuous crawl: a job whose budget ran out mid-slice keeps its rows
  // pending for the next slice, so this slice must stop claiming them.
  if (excludeJobIds.length > 0) filter.crawlJobId = { $nin: excludeJobIds };

  return CrawlFrontier.findOneAndUpdate(
    filter,
    {
      $set: { status: 'fetching', leasedAt: now },
      $inc: { attempts: 1 }
    },
    {
      // Seeds first, then shallowest, then oldest discovery. Breadth-first,
      // so a crawl covers a site rather than tunnelling into one branch.
      sort: { priority: -1, depth: 1, discoveredAt: 1 },
      // The claimed row as it now stands, so the caller sees the incremented
      // attempt count. (`new: true` is the deprecated spelling of this.)
      returnDocument: 'after'
    }
  ).lean();
}

/**
 * Hands a claimed URL back exactly as it was before the claim.
 *
 * Used by continuous crawl when the URL's job has no budget left: the URL
 * was not fetched, so the attempt the claim counted is given back and its
 * `nextCrawlAt` — which may be a retry backoff — is left as it was.
 */
async function releaseClaim(id) {
  await CrawlFrontier.updateOne(
    { _id: id, status: 'fetching' },
    { $set: { status: 'pending', leasedAt: null }, $inc: { attempts: -1 } }
  );
}

/**
 * Moves one job's pending URLs to another job.
 *
 * How a continuous crawl carries its frontier into the next bounded job. It
 * moves every pending row of the job — exactly the rows `skipPendingForJob`
 * would otherwise skip. Scheduled re-crawls are not among them: they belong
 * to no job (see requeueDueForRecrawl).
 *
 * @returns {Promise<number>} rows moved
 */
async function adoptPendingRows(fromJobId, toJobId) {
  if (!fromJobId || !toJobId) return 0;
  const result = await CrawlFrontier.updateMany(
    { crawlJobId: fromJobId, status: 'pending' },
    { $set: { crawlJobId: toJobId } }
  );
  return result.modifiedCount || 0;
}

/**
 * Marks a claimed URL as successfully crawled and schedules its re-crawl.
 *
 * @param {string} url
 * @param {Object} [result]
 * @param {number} [result.statusCode]
 * @param {number} [result.recrawlAfterDays]
 * @param {string} [result.note] why a fetched page was not indexed — `noindex`
 */
async function markDone(url, { statusCode = 200, recrawlAfterDays, note = '' } = {}) {
  const days = Number.isFinite(recrawlAfterDays)
    ? recrawlAfterDays
    : config.crawler.recrawlAfterDays;
  const now = new Date();

  await CrawlFrontier.updateOne(byUrl(url), {
    $set: {
      status: 'done',
      lastStatusCode: statusCode,
      lastError: String(note).slice(0, 200),
      lastCrawledAt: now,
      leasedAt: null,
      nextCrawlAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
    }
  });
}

/**
 * Records a failed fetch.
 *
 * Retries back off exponentially and stop after `maxAttemptsPerUrl`. A URL
 * that keeps timing out should not be retried forever at the cost of URLs
 * that would succeed.
 *
 * A failure that will not improve — a 404, a redirect loop — is not retried
 * at all: `retryable: false` abandons the URL on the spot, so a missing page
 * costs its site one request rather than three.
 *
 * @param {string} url
 * @param {Object} [failure]
 * @param {string} [failure.reason]
 * @param {number} [failure.statusCode]
 * @param {boolean} [failure.retryable=true]
 * @param {number} [failure.retryAfterMs] the wait the host asked for, when
 *   longer than the backoff
 * @returns {Promise<{retrying: boolean}>}
 */
async function markFailed(
  url,
  { reason = 'error', statusCode = null, retryable = true, retryAfterMs = 0 } = {}
) {
  const row = await CrawlFrontier.findOne(byUrl(url)).lean();
  if (!row) return { retrying: false };

  const exhausted = !retryable || row.attempts >= config.crawler.maxAttemptsPerUrl;
  const now = new Date();

  if (exhausted) {
    await CrawlFrontier.updateOne(byUrl(url), {
      $set: {
        status: 'failed',
        lastError: String(reason).slice(0, 200),
        lastStatusCode: statusCode,
        leasedAt: null,
        lastCrawledAt: now
      }
    });
    return { retrying: false };
  }

  // 1 min, 4 min, 9 min — enough for a transient outage to clear without
  // holding a slot open. A host's own Retry-After extends it, within the cap.
  const backoffMs = Math.min(
    Math.max(row.attempts ** 2 * 60_000, Number(retryAfterMs) || 0),
    60 * 60 * 1000
  );

  await CrawlFrontier.updateOne(byUrl(url), {
    $set: {
      status: 'pending',
      lastError: String(reason).slice(0, 200),
      lastStatusCode: statusCode,
      leasedAt: null,
      nextCrawlAt: new Date(now.getTime() + backoffMs)
    }
  });
  return { retrying: true };
}

/**
 * Marks a URL as deliberately not crawled — robots.txt, a content type we do
 * not index, out of scope. Distinct from `failed`, which means we tried and
 * could not; a skipped URL is not retried and is not a sign of trouble.
 */
async function markSkipped(url, reason) {
  await CrawlFrontier.updateOne(byUrl(url), {
    $set: {
      status: 'skipped',
      lastError: String(reason).slice(0, 200),
      leasedAt: null,
      lastCrawledAt: new Date()
    }
  });
}

/**
 * Moves a claimed row to the address its URL redirected to on another host.
 *
 * For the one case where a cross-host redirect is the *same page*: the
 * target has the row's own canonical key — `example.com/a` answering with a
 * redirect to `www.example.com/a`, or http to https on a renamed host. A new
 * row cannot be added for it, because the key is already taken by this one,
 * so this row takes the new URL and host and returns to pending, to be
 * fetched in the new host's own slot under that host's rules.
 *
 * The attempt the claim counted stays counted, which is what ends two hosts
 * that redirect to each other: the caller stops moving a row that has used
 * its attempts.
 *
 * @returns {Promise<boolean>} whether the row was moved
 */
async function rehome(id, url, { now = new Date() } = {}) {
  const normalized = normalizeUrl(url);
  const host = normalized && hostOf(normalized);
  if (!host) return false;

  const result = await CrawlFrontier.updateOne(
    { _id: id, status: 'fetching', canonicalKey: canonicalKey(normalized) },
    {
      $set: {
        url: normalized,
        host,
        status: 'pending',
        leasedAt: null,
        nextCrawlAt: now,
        lastError: 'redirect'
      }
    }
  );
  return result.modifiedCount > 0;
}

/**
 * Records that a page was fetched under another address than the one
 * claimed — where a same-host redirect ended up.
 *
 * Without it the final URL has no row, and the first link to it would fetch
 * the page a second time. An existing row is marked done; otherwise one is
 * created, already done, on the same re-crawl schedule as any fetched page.
 */
async function markFetchedAs(
  url,
  { crawlJobId = null, depth = 0, referrerUrl = '', statusCode = 200, note = '' } = {}
) {
  const normalized = normalizeUrl(url);
  const key = normalized && canonicalKey(normalized);
  const host = normalized && hostOf(normalized);
  if (!key || !host) return;

  const now = new Date();
  const days = config.crawler.recrawlAfterDays;
  try {
    await CrawlFrontier.updateOne(
      { canonicalKey: key },
      {
        $set: {
          status: 'done',
          lastStatusCode: statusCode,
          lastError: String(note).slice(0, 200),
          lastCrawledAt: now,
          leasedAt: null,
          nextCrawlAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
        },
        $setOnInsert: {
          url: normalized,
          canonicalKey: key,
          host,
          crawlJobId,
          depth: Math.max(0, Number(depth) || 0),
          priority: 0,
          discoveredAt: now,
          referrerUrl: String(referrerUrl || '').slice(0, 500)
        }
      },
      { upsert: true }
    );
  } catch (error) {
    // Two writers creating the same row: the other one's row will do.
    if (!(error && error.code === 11000)) throw error;
  }
}

/**
 * Returns claims abandoned by a worker that died mid-fetch back to the
 * frontier.
 *
 * Without this, killing a worker at the wrong moment would leave URLs stuck
 * in `fetching` forever and the crawl would quietly stall short of its
 * target with no error anywhere.
 *
 * @returns {Promise<number>} rows reclaimed
 */
async function reclaimStaleLeases({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - config.crawler.leaseTimeoutMs);

  const result = await CrawlFrontier.updateMany(
    { status: 'fetching', leasedAt: { $lt: cutoff } },
    { $set: { status: 'pending', leasedAt: null, nextCrawlAt: now } }
  );

  if (result.modifiedCount > 0) {
    logger.warn('Reclaimed stale frontier leases', { count: result.modifiedCount });
  }
  return result.modifiedCount;
}

/**
 * Re-queues pages whose re-crawl time has arrived.
 *
 * This is what makes the index stay current instead of being a snapshot of
 * whenever each page was first seen.
 *
 * @returns {Promise<number>} rows returned to pending
 */
async function requeueDueForRecrawl({ now = new Date(), limit = 500 } = {}) {
  const due = await CrawlFrontier.find({ status: 'done', nextCrawlAt: { $lte: now } })
    .select('_id')
    .limit(limit)
    .lean();

  if (due.length === 0) return 0;

  const result = await CrawlFrontier.updateMany(
    { _id: { $in: due.map(d => d._id) } },
    // attempts resets: a page that failed twice months ago should get a
    // fair run at its scheduled re-crawl.
    //
    // crawlJobId clears: a re-crawl is outside any job's budget, and saying
    // so on the row is what lets the worker refuse every *other* pending row
    // of a closed job instead of guessing which ones are re-crawls.
    {
      $set: { status: 'pending', nextCrawlAt: now, attempts: 0, leasedAt: null, crawlJobId: null }
    }
  );

  if (result.modifiedCount > 0) {
    logger.info('Re-queued pages due for re-crawl', { count: result.modifiedCount });
  }
  return result.modifiedCount;
}

/**
 * Hosts with work waiting right now, most-backed-up first.
 * This is what the scheduler turns into queue jobs.
 *
 * @returns {Promise<Array<{host: string, pending: number}>>}
 */
async function hostsWithPendingWork({ now = new Date(), limit = 100 } = {}) {
  const rows = await CrawlFrontier.aggregate([
    { $match: { status: 'pending', nextCrawlAt: { $lte: now } } },
    { $group: { _id: '$host', pending: { $sum: 1 } } },
    { $sort: { pending: -1 } },
    { $limit: limit }
  ]);

  return rows.map(r => ({ host: r._id, pending: r.pending }));
}

/**
 * Whether a host still has URLs waiting.
 *
 * `lookaheadMs` widens the window past "due right now", because a host whose
 * next URL is held back by a one-second politeness delay does have more work
 * — it just is not due this instant, and treating that as "finished" would
 * end the crawl a page in.
 *
 * @returns {Promise<boolean>}
 */
async function hasPendingWork(
  host,
  { now = new Date(), lookaheadMs = 60_000, excludeJobIds = [] } = {}
) {
  const horizon = new Date(now.getTime() + lookaheadMs);
  const filter = { host, status: 'pending', nextCrawlAt: { $lte: horizon } };
  if (excludeJobIds.length > 0) filter.crawlJobId = { $nin: excludeJobIds };
  const row = await CrawlFrontier.exists(filter);
  return Boolean(row);
}

/**
 * True when a URL has been fetched successfully and is not yet due again.
 *
 * Narrower than `isAlreadyCrawled` on purpose. It is asked before a redirect
 * is followed, and only "this page is in hand and current" is a reason not
 * to fetch a redirect's destination: a destination that is pending, failed,
 * skipped or due for its re-crawl is still fetched.
 */
async function isFreshlyCrawled(url, { now = new Date() } = {}) {
  const key = canonicalKey(url);
  if (!key) return false;
  const row = await CrawlFrontier.findOne({ canonicalKey: key })
    .select('status nextCrawlAt')
    .lean();
  return Boolean(row && row.status === 'done' && row.nextCrawlAt && row.nextCrawlAt > now);
}

/** Frontier counts for one crawl job, for the dashboard. */
async function countsForJob(crawlJobId) {
  const rows = await CrawlFrontier.aggregate([
    { $match: { crawlJobId } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);

  const counts = { pending: 0, fetching: 0, done: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    if (row._id in counts) counts[row._id] = row.count;
  }
  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  return counts;
}

/** Frontier counts across everything, for the crawler status endpoint. */
async function globalCounts() {
  const rows = await CrawlFrontier.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);

  const counts = { pending: 0, fetching: 0, done: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    if (row._id in counts) counts[row._id] = row.count;
  }
  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);

  counts.hosts = (await CrawlFrontier.distinct('host')).length;
  return counts;
}

/**
 * True when a URL is already known and not due for another look.
 * Lets a new crawl skip work a previous one already did.
 */
async function isAlreadyCrawled(url, { now = new Date() } = {}) {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;

  const row = await CrawlFrontier.findOne(byUrl(normalized)).select('status nextCrawlAt').lean();

  if (!row) return false;
  if (row.status === 'done') return !row.nextCrawlAt || row.nextCrawlAt > now;
  return row.status === 'skipped' || row.status === 'failed';
}

module.exports = {
  addUrls,
  claimNext,
  markDone,
  markFailed,
  markSkipped,
  rehome,
  markFetchedAs,
  releaseClaim,
  adoptPendingRows,
  skipPendingForJob,
  reclaimStaleLeases,
  requeueDueForRecrawl,
  hostsWithPendingWork,
  hasPendingWork,
  countsForJob,
  globalCounts,
  isAlreadyCrawled,
  isFreshlyCrawled,
  hostOf
};
