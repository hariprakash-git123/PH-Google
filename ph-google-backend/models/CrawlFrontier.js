const mongoose = require('mongoose');

/**
 * The crawl frontier: every URL the crawler knows about and has not finished
 * with, plus every URL it has finished with and may revisit.
 *
 * This replaces the in-memory `UrlQueue`, which lived for the length of one
 * crawl run. Two consequences of that design are what this model exists to
 * fix:
 *
 *   - a crawl that was interrupted lost everything it had discovered but not
 *     yet fetched, so a restart began again from the seed;
 *   - two crawls could not share knowledge, so the same URL was re-fetched
 *     once per job.
 *
 * Here the frontier is durable and global. It accumulates across jobs, and a
 * URL already crawled last week is skipped rather than fetched again — until
 * `nextCrawlAt` says it is stale.
 *
 * Statuses
 *   pending   waiting to be fetched, once `nextCrawlAt` has passed
 *   fetching  claimed by a worker; `leasedAt` guards against a dead worker
 *   done      fetched and indexed; `nextCrawlAt` is when it goes stale
 *   failed    gave up after `maxAttemptsPerUrl`
 *   skipped   robots.txt, wrong content type, out of scope — not retried
 */
const crawlFrontierSchema = new mongoose.Schema(
  {
    // The URL to fetch. Normalised, and the same form stored in `Page.url`,
    // so the frontier and the index can never disagree about what was
    // crawled.
    url: {
      type: String,
      required: true,
      trim: true
    },

    // What makes a row unique, and it is not the URL.
    //
    // `normalizeUrl` strips the fragment but keeps query parameters, because
    // `?page=2` is a genuinely different page. That leaves tracking
    // parameters: `/article` and `/article?utm_source=twitter` normalise to
    // two different URLs and would be fetched twice, which on a site whose
    // share links carry campaign tags means crawling everything twice.
    //
    // `canonicalKey` is the same identity function OpenSearch uses for its
    // document ids — scheme, `www.` and tracking parameters removed, query
    // parameters sorted. Keying on it means the frontier reaches the same
    // conclusion about "same page" that the index does.
    canonicalKey: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },

    // Politeness and work distribution are both per host, so it is stored
    // rather than parsed out of the URL on every query.
    host: {
      type: String,
      required: true,
      index: true,
      lowercase: true,
      trim: true
    },

    // The job that discovered this URL. Kept for attribution and per-job
    // budgets; the row outlives the job.
    crawlJobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CrawlJob',
      default: null,
      index: true
    },

    // Link distance from the seed that discovered it.
    depth: { type: Number, default: 0, min: 0 },

    // Higher is fetched first. A seed outranks what it discovers, so a crawl
    // makes visible progress from the start instead of wandering.
    priority: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ['pending', 'fetching', 'done', 'failed', 'skipped'],
      default: 'pending',
      index: true
    },

    // Earliest time this URL may be fetched. Used for three things: the
    // politeness delay, retry backoff, and the re-crawl interval.
    nextCrawlAt: { type: Date, default: () => new Date(), index: true },

    // When a worker claimed it. A claim older than the lease timeout is
    // treated as abandoned and the row returns to `pending`.
    leasedAt: { type: Date, default: null },

    attempts: { type: Number, default: 0 },
    lastStatusCode: { type: Number, default: null },
    // Short reason only — never a stack trace.
    lastError: { type: String, default: '' },

    discoveredAt: { type: Date, default: () => new Date() },
    lastCrawledAt: { type: Date, default: null },

    // Where this URL was found. Useful when working out why the crawler
    // reached somewhere unexpected.
    referrerUrl: { type: String, default: '' }
  },
  { timestamps: true }
);

/**
 * The claim query: the next URL a worker should fetch for one host.
 * Ordered so seeds and shallow pages come first, then oldest discovery,
 * which keeps a crawl breadth-first rather than diving down one branch.
 */
crawlFrontierSchema.index({ host: 1, status: 1, nextCrawlAt: 1, priority: -1, depth: 1 });

// "Which hosts have work waiting?" — drives what the scheduler enqueues.
crawlFrontierSchema.index({ status: 1, nextCrawlAt: 1 });

// Reclaiming leases left behind by a worker that died mid-fetch.
crawlFrontierSchema.index({ status: 1, leasedAt: 1 });

// Per-job progress counts on the dashboard.
crawlFrontierSchema.index({ crawlJobId: 1, status: 1 });

// Looking a row up by the URL as stored. Not unique — `canonicalKey` is what
// enforces one row per page — but admin views and debugging search by URL.
crawlFrontierSchema.index({ url: 1 });

module.exports = mongoose.model('CrawlFrontier', crawlFrontierSchema);
