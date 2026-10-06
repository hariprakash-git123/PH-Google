const mongoose = require('mongoose');

/**
 * One sitemap discovery run: for one crawl chain, on one host.
 *
 * The unique (chainId, host) index is what makes discovery happen once.
 * Claiming a run is inserting this document; a second attempt for the same
 * chain and host — a retried slice, a continuation, a second worker — hits
 * the index and does nothing.
 *
 * Only counts and short reasons are kept. Sitemap contents and URL lists are
 * not: the URLs found are in the frontier, which is where they belong.
 */
const sitemapDiscoverySchema = new mongoose.Schema(
  {
    // The first job of the crawl chain (CrawlJob.chainId, or the job's own
    // id when it is not a continuation).
    chainId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrawlJob', required: true },
    host: { type: String, required: true, lowercase: true, trim: true },

    status: {
      type: String,
      enum: ['running', 'done', 'failed'],
      default: 'running'
    },
    startedAt: { type: Date, default: () => new Date() },
    completedAt: { type: Date, default: null },

    // Attempts made, the first included, and when the latest began. A run
    // that failed for a temporary reason (`retryable`) is tried again until
    // CRAWLER_SITEMAP_DISCOVERY_MAX_ATTEMPTS; so is one left "running" by a
    // worker that died, once its lease has expired.
    attempts: { type: Number, default: 1 },
    lastAttemptAt: { type: Date, default: () => new Date() },
    retryable: { type: Boolean, default: false },

    filesFetched: { type: Number, default: 0 },
    filesFailed: { type: Number, default: 0 },
    urlsFound: { type: Number, default: 0 },
    urlsAdded: { type: Number, default: 0 },
    urlsRejected: { type: Number, default: 0 },

    // Short reasons, at most a handful — never a stack trace.
    errors: { type: [String], default: [] }
  },
  { timestamps: true }
);

sitemapDiscoverySchema.index({ chainId: 1, host: 1 }, { unique: true });

module.exports = mongoose.model('SitemapDiscovery', sitemapDiscoverySchema);
