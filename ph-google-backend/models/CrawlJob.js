const mongoose = require('mongoose');

/**
 * A single controlled crawl run, started from the admin dashboard.
 * Progress is persisted so status survives a page refresh, and the
 * `status` field is what the stop endpoint transitions to 'stopped'.
 */
const crawlJobSchema = new mongoose.Schema(
  {
    seedUrl: {
      type: String,
      required: true,
      trim: true
    },
    maxPages: {
      type: Number,
      required: true,
      min: 1
    },
    // Keeps crawls bounded to the seed's own host unless explicitly widened.
    sameDomainOnly: {
      type: Boolean,
      default: true
    },
    // Explicit domain allow-list from the seed catalog. When non-empty it is
    // the whole domain policy and `sameDomainOnly` is not consulted.
    allowedDomains: {
      type: [String],
      default: []
    },
    // URL regexes (from the seed catalog, never from a request body) whose
    // matches are not followed — talk pages, edit links, login screens.
    excludePatterns: {
      type: [String],
      default: []
    },
    // Set on jobs started from the seed catalog: the topic the seed belongs
    // to, and the id shared by every job of one topic crawl. A batch counts
    // as a single crawl against the concurrency limit.
    topic: {
      type: String,
      default: ''
    },
    batchId: {
      type: String,
      default: null,
      index: true
    },
    // Link distance from the seed. Persisted rather than held in memory: the
    // worker that resumes this job after a restart is not the process that
    // started it, and it has to know where to stop following links.
    maxDepth: {
      type: Number,
      default: 3,
      min: 0
    },
    // Whether this crawl may read its hosts' sitemaps. Set from the seed the
    // job was made for (crawlSeeds.json "sitemaps"), copied to every
    // continuation, and used only while CRAWLER_SITEMAPS is on. A job with
    // no seed, or stored before the field existed, is opted out.
    sitemaps: {
      type: Boolean,
      default: false
    },

    crawlDelayMs: {
      type: Number,
      default: 1000
    },
    // Set by the stop endpoint and read by the worker between pages. The API
    // cannot cancel the crawl directly any more — it runs in another process
    // — so the request has to travel through the database.
    stopRequested: {
      type: Boolean,
      default: false
    },
    // Written by the worker each time it finishes a page. A running job whose
    // heartbeat has gone quiet was orphaned by a worker that died, which is
    // how the maintenance sweep tells the two apart.
    lastHeartbeatAt: {
      type: Date,
      default: null
    },
    status: {
      type: String,
      enum: ['queued', 'running', 'completed', 'failed', 'stopped'],
      default: 'queued',
      index: true
    },
    pagesDiscovered: { type: Number, default: 0 },
    pagesCrawled: { type: Number, default: 0 },
    pagesIndexed: { type: Number, default: 0 },
    failedPages: { type: Number, default: 0 },
    skippedByRobots: { type: Number, default: 0 },

    currentUrl: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    // Short, human-readable failure reason (never a raw stack trace).
    error: { type: String, default: '' },

    startedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },

    // --- Continuous crawl (CRAWLER_CONTINUOUS) --------------------------
    // A job that spent its budget with URLs still pending is followed by a
    // continuation: a new job with the same scope and budget. Every job of
    // one such chain shares `chainId`, the id of the job that started it.
    // All null/0 on a job that is not part of a chain.
    chainId: { type: mongoose.Schema.Types.ObjectId, ref: 'CrawlJob', default: null },
    continuationOf: { type: mongoose.Schema.Types.ObjectId, ref: 'CrawlJob', default: null },
    continuationIndex: { type: Number, default: 0 },
    // Set on the parent when its continuation is created. Claimed with an
    // atomic update, so two sweeps can never both continue the same job.
    continuedAs: { type: mongoose.Schema.Types.ObjectId, ref: 'CrawlJob', default: null }
  },
  { timestamps: true }
);

// Dashboard lists newest-first; the status index serves "active jobs" counts.
crawlJobSchema.index({ createdAt: -1 });
crawlJobSchema.index({ status: 1, createdAt: -1 });

/** True while the job is still occupying a crawler slot. */
crawlJobSchema.virtual('isActive').get(function () {
  return this.status === 'queued' || this.status === 'running';
});

module.exports = mongoose.model('CrawlJob', crawlJobSchema);
