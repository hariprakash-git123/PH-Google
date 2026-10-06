const Page = require('../models/Page');
const Website = require('../models/Website');
const Term = require('../models/Term');
const User = require('../models/User');
const SearchLog = require('../models/SearchLog');
const CrawlJob = require('../models/CrawlJob');
const crawlerJobService = require('../services/crawlerJobService');
const verticalSearchService = require('../services/verticalSearchService');
const analyticsService = require('../services/analyticsService');
const { sendSuccess, asyncHandler, ApiError } = require('../utils/apiResponse');
const {
  parsePage,
  parseLimit,
  parseEnum,
  parseSeedUrl,
  parseObjectId,
  parseDomain,
  sanitizeString
} = require('../utils/validators');
const { config } = require('../config/env');
const { getSeedCatalog } = require('../config/crawlSeeds');

/**
 * Admin dashboard APIs.
 *
 * Every number returned here is computed from MongoDB. Nothing is hardcoded.
 * All routes in this controller sit behind protect + adminOnly.
 */

/** Counts that several endpoints share. */
async function collectCoreMetrics() {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [
    totalPages,
    totalWebsites,
    totalTerms,
    totalUsers,
    adminUsers,
    totalSearches,
    searchesToday,
    indexedPages,
    errorPages,
    pagesCrawledLast24h,
    crawlerStatus,
    failedCrawlJobs,
    timing,
    verticalCounts
  ] = await Promise.all([
    Page.estimatedDocumentCount(),
    Website.estimatedDocumentCount(),
    Term.estimatedDocumentCount(),
    User.estimatedDocumentCount(),
    User.countDocuments({ role: 'admin' }),
    SearchLog.estimatedDocumentCount(),
    SearchLog.countDocuments({ createdAt: { $gte: todayStart } }),
    Page.countDocuments({ status: 'indexed' }),
    Page.countDocuments({ status: 'error' }),
    Page.countDocuments({ lastCrawledAt: { $gte: dayAgo } }),
    crawlerJobService.getStatus(),
    CrawlJob.countDocuments({ status: 'failed' }),
    SearchLog.aggregate([
      { $match: { createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } } },
      { $group: { _id: null, avg: { $avg: '$responseTimeMs' }, max: { $max: '$responseTimeMs' } } }
    ]),
    verticalSearchService.getVerticalCounts()
  ]);

  const t = timing[0] || {};

  return {
    totalPages,
    totalWebsites,
    totalTerms,
    totalUsers,
    adminUsers,
    totalSearches,
    searchesToday,
    indexedPages,
    errorPages,
    pagesCrawledLast24h,
    activeCrawlerJobs: crawlerStatus.activeJobs,
    failedCrawls: failedCrawlJobs + crawlerStatus.lifetime.failedPages,
    failedCrawlJobs,
    failedCrawlPages: crawlerStatus.lifetime.failedPages,
    avgResponseTimeMs: Math.round(t.avg || 0),
    maxResponseTimeMs: Math.round(t.max || 0),
    crawlerStatus,
    verticals: verticalCounts
  };
}

/**
 * GET /api/admin/metrics
 * Raw numeric metrics, all derived from the database.
 */
const getMetrics = asyncHandler(async (req, res) => {
  const m = await collectCoreMetrics();

  return sendSuccess(res, {
    totalPages: m.totalPages,
    totalWebsites: m.totalWebsites,
    totalTerms: m.totalTerms,
    totalSearches: m.totalSearches,
    totalUsers: m.totalUsers,
    adminUsers: m.adminUsers,
    searchesToday: m.searchesToday,
    indexedPages: m.indexedPages,
    errorPages: m.errorPages,
    pagesCrawledLast24h: m.pagesCrawledLast24h,
    activeCrawlerJobs: m.activeCrawlerJobs,
    failedCrawls: m.failedCrawls,
    failedCrawlJobs: m.failedCrawlJobs,
    failedCrawlPages: m.failedCrawlPages,
    avgResponseTimeMs: m.avgResponseTimeMs,
    maxResponseTimeMs: m.maxResponseTimeMs,
    // Vertical index sizes (images/videos/news/maps).
    totalImages: m.verticals.images,
    totalVideos: m.verticals.videos,
    totalArticles: m.verticals.news,
    totalPlaces: m.verticals.maps,
    generatedAt: new Date()
  });
});

/**
 * GET /api/admin/dashboard
 *
 * The same numbers shaped for the existing dashboard UI: stat cards,
 * index-health bars and the 24-hour crawl activity chart.
 */
const getDashboard = asyncHandler(async (req, res) => {
  const m = await collectCoreMetrics();
  const [crawlActivity, recentJobs, topDomains, analyticsOverview] = await Promise.all([
    getCrawlActivityByHour(),
    CrawlJob.find().sort({ createdAt: -1 }).limit(5).lean(),
    getTopDomains(5),
    analyticsService.getOverview()
  ]);

  const overview = [
    {
      id: 'm1',
      label: 'Indexed pages',
      value: formatCount(m.totalPages),
      change: `${formatCount(m.pagesCrawledLast24h)} in 24h`,
      status: m.pagesCrawledLast24h > 0 ? 'positive' : 'neutral',
      subtext: `${formatCount(m.indexedPages)} fully indexed`
    },
    {
      id: 'm2',
      label: 'Domains',
      value: formatCount(m.totalWebsites),
      change: m.totalWebsites > 0 ? 'Tracked' : 'None yet',
      status: 'neutral',
      subtext: 'Crawled hosts'
    },
    {
      id: 'm3',
      label: 'Searches today',
      value: formatCount(m.searchesToday),
      change: `${formatCount(m.totalSearches)} all time`,
      status: m.searchesToday > 0 ? 'positive' : 'neutral',
      subtext: `${formatCount(analyticsOverview.uniqueQueries)} unique queries (30d)`
    },
    {
      id: 'm4',
      label: 'Avg response',
      value: m.avgResponseTimeMs > 0 ? `${m.avgResponseTimeMs}ms` : 'No data',
      change: m.maxResponseTimeMs > 0 ? `peak ${m.maxResponseTimeMs}ms` : '—',
      status:
        m.avgResponseTimeMs === 0 ? 'neutral' : m.avgResponseTimeMs < 500 ? 'positive' : 'warning',
      subtext: 'Search API, last 30 days'
    },
    {
      id: 'm5',
      label: 'Active crawlers',
      value: String(m.activeCrawlerJobs),
      change: m.activeCrawlerJobs > 0 ? 'Running' : 'Idle',
      status: 'neutral',
      subtext: `${m.crawlerStatus.totalJobs} jobs total`
    },
    {
      id: 'm6',
      label: 'Failed crawls',
      value: formatCount(m.failedCrawls),
      change: m.failedCrawls > 0 ? 'Review' : 'Clean',
      status: m.failedCrawls > 0 ? 'warning' : 'positive',
      subtext: `${m.failedCrawlJobs} jobs / ${m.failedCrawlPages} pages`
    }
  ];

  // Index health, measured rather than asserted.
  const [withTitle, withDescription, withLanguage] = await Promise.all([
    Page.countDocuments({ title: { $nin: ['', null] } }),
    Page.countDocuments({ description: { $nin: ['', null] } }),
    Page.countDocuments({ language: { $nin: ['', null] } })
  ]);

  const pct = (part, whole) => (whole > 0 ? Number(((part / whole) * 100).toFixed(1)) : 0);
  const jobsFinished =
    m.crawlerStatus.byStatus.completed +
    m.crawlerStatus.byStatus.failed +
    m.crawlerStatus.byStatus.stopped;

  const indexHealth = [
    healthRow('Pages fully indexed', pct(m.indexedPages, m.totalPages)),
    healthRow('Pages with a title', pct(withTitle, m.totalPages)),
    healthRow('Pages with a description', pct(withDescription, m.totalPages)),
    healthRow('Pages with a language tag', pct(withLanguage, m.totalPages)),
    healthRow('Crawl jobs succeeded', pct(m.crawlerStatus.byStatus.completed, jobsFinished))
  ];

  return sendSuccess(res, {
    overview,
    indexHealth,
    // Real pages-per-hour over the last 24h, from Page.lastCrawledAt.
    crawlerActivity24h: crawlActivity,
    topDomains,
    recentJobs: recentJobs.map(j => ({
      id: j._id.toString(),
      seedUrl: j.seedUrl,
      status: j.status,
      pagesCrawled: j.pagesCrawled,
      pagesIndexed: j.pagesIndexed,
      failedPages: j.failedPages,
      startedAt: j.startedAt,
      completedAt: j.completedAt
    })),
    crawler: {
      activeJobs: m.crawlerStatus.activeJobs,
      isIdle: m.crawlerStatus.isIdle,
      byStatus: m.crawlerStatus.byStatus
    },
    raw: {
      totalPages: m.totalPages,
      totalWebsites: m.totalWebsites,
      totalTerms: m.totalTerms,
      totalSearches: m.totalSearches,
      totalUsers: m.totalUsers,
      activeCrawlerJobs: m.activeCrawlerJobs,
      failedCrawls: m.failedCrawls,
      verticals: m.verticals
    },
    generatedAt: new Date()
  });
});

function healthRow(label, percentage) {
  return {
    label,
    percentage,
    status:
      percentage >= 95
        ? 'Optimal'
        : percentage >= 70
          ? 'Healthy'
          : percentage > 0
            ? 'Degraded'
            : 'No data'
  };
}

/** Pages crawled per hour over the last 24 hours. */
async function getCrawlActivityByHour() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await Page.aggregate([
    { $match: { lastCrawledAt: { $gte: since } } },
    { $group: { _id: { $hour: '$lastCrawledAt' }, pages: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]);

  const byHour = new Map(rows.map(r => [r._id, r.pages]));

  // Emit a complete 24-hour series ending at the current hour so the chart
  // has no gaps.
  const series = [];
  const nowHour = new Date().getHours();
  for (let i = 23; i >= 0; i -= 1) {
    const hour = (nowHour - i + 24) % 24;
    series.push({
      hour: `${String(hour).padStart(2, '0')}:00`,
      pages: byHour.get(hour) || 0
    });
  }
  return series;
}

async function getTopDomains(limit = 10) {
  const rows = await Page.aggregate([
    { $group: { _id: '$domain', pages: { $sum: 1 }, lastCrawledAt: { $max: '$lastCrawledAt' } } },
    { $sort: { pages: -1 } },
    { $limit: limit }
  ]);
  return rows.map(r => ({
    domain: r._id || '(unknown)',
    pages: r.pages,
    lastCrawledAt: r.lastCrawledAt
  }));
}

/** Compact display form: 1234 -> "1.2K". */
function formatCount(n) {
  const value = Number(n) || 0;
  if (value < 1000) return String(value);
  if (value < 1000000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}K`;
  return `${(value / 1000000).toFixed(1)}M`;
}

/**
 * GET /api/admin/pages?page=&limit=&domain=&status=&q=
 * Paginated index browser. Never returns page bodies.
 */
const listPages = asyncHandler(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, { def: 20, max: 100 });
  const domain = parseDomain(req.query.domain);
  const status = parseEnum(
    req.query.status,
    ['discovered', 'crawled', 'indexed', 'error'],
    '',
    'status'
  );
  const q = sanitizeString(req.query.q, 200);

  const filter = {};
  if (domain) filter.domain = { $in: [domain, `www.${domain}`] };
  if (status) filter.status = status;
  if (q) {
    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { title: { $regex: safe, $options: 'i' } },
      { url: { $regex: safe, $options: 'i' } }
    ];
  }

  const [pages, total] = await Promise.all([
    Page.find(filter)
      .sort({ lastCrawledAt: -1, _id: -1 })
      // Projection excludes `content`: the index browser must never pull bodies.
      .select('_id url domain title description language status lastCrawledAt createdAt')
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Page.countDocuments(filter)
  ]);

  return sendSuccess(res, {
    pages: pages.map(p => ({
      id: p._id.toString(),
      url: p.url,
      domain: p.domain || '',
      title: p.title || '',
      description: p.description || '',
      language: p.language || '',
      status: p.status,
      lastCrawledAt: p.lastCrawledAt,
      createdAt: p.createdAt
    })),
    pagination: {
      page,
      limit,
      totalResults: total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPreviousPage: page > 1
    }
  });
});

/**
 * GET /api/admin/websites?page=&limit=
 * Domains, with their live page counts.
 */
const listWebsites = asyncHandler(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, { def: 20, max: 100 });

  const [websites, total] = await Promise.all([
    Website.find()
      .sort({ lastCrawledAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Website.countDocuments()
  ]);

  // One grouped query for the page counts instead of one per website.
  const counts = await Page.aggregate([
    { $match: { websiteId: { $in: websites.map(w => w._id) } } },
    {
      $group: {
        _id: '$websiteId',
        pages: { $sum: 1 },
        indexed: { $sum: { $cond: [{ $eq: ['$status', 'indexed'] }, 1, 0] } }
      }
    }
  ]);
  const countById = new Map(counts.map(c => [c._id.toString(), c]));

  return sendSuccess(res, {
    websites: websites.map(w => {
      const c = countById.get(w._id.toString()) || { pages: 0, indexed: 0 };
      return {
        id: w._id.toString(),
        domain: w.domain,
        status: w.status,
        pages: c.pages,
        indexedPages: c.indexed,
        lastCrawledAt: w.lastCrawledAt,
        createdAt: w.createdAt
      };
    }),
    pagination: {
      page,
      limit,
      totalResults: total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPreviousPage: page > 1
    }
  });
});

/** GET /api/admin/crawler/status */
const getCrawlerStatus = asyncHandler(async (req, res) => {
  return sendSuccess(res, await crawlerJobService.getStatus());
});

/** GET /api/admin/crawler/jobs?page=&limit=&status= */
const listCrawlerJobs = asyncHandler(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, { def: 20, max: 100 });
  const status = parseEnum(
    req.query.status,
    ['queued', 'running', 'completed', 'failed', 'stopped'],
    '',
    'status'
  );

  const { jobs, total } = await crawlerJobService.listJobs({ page, limit, status });

  return sendSuccess(res, {
    jobs,
    pagination: {
      page,
      limit,
      totalResults: total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPreviousPage: page > 1
    }
  });
});

/** GET /api/admin/crawler/jobs/:id */
const getCrawlerJob = asyncHandler(async (req, res) => {
  const id = parseObjectId(req.params.id, 'jobId');
  return sendSuccess(res, await crawlerJobService.getJob(id));
});

/**
 * GET /api/admin/crawler/seeds
 * The seed catalog topic crawls start from, with the limits that apply.
 */
const listSeedTopics = asyncHandler(async (req, res) => {
  const catalog = getSeedCatalog();
  return sendSuccess(res, {
    topics: catalog.topics.map(topic => ({
      id: topic.id,
      label: topic.label,
      description: topic.description,
      seedCount: topic.seeds.length,
      seeds: topic.seeds.map(seed => ({
        url: seed.url,
        source: seed.source,
        allowedDomains: seed.allowedDomains,
        maxDepth: seed.maxDepth !== null ? seed.maxDepth : config.crawler.seedMaxDepth
      }))
    })),
    totalSeeds: catalog.topics.reduce((n, t) => n + t.seeds.length, 0),
    limits: {
      defaultPagesPerSeed: config.crawler.seedPagesPerSeed,
      maxPagesPerSeed: config.crawler.maxPagesHardLimit,
      maxPagesPerCrawl: config.crawler.maxPagesPerCrawl,
      defaultMaxDepth: config.crawler.seedMaxDepth
    }
  });
});

/**
 * Validates the `topics` field of a topic crawl request.
 * @returns {string[]|'all'}
 */
function parseTopics(raw) {
  if (raw === 'all') return 'all';
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null;
  const topics = (list || [])
    .map(t => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
    .filter(Boolean);
  if (topics.length === 0 || topics.length > 100) {
    throw ApiError.badRequest('"topics" must be "all" or a non-empty list of topic ids.');
  }
  return topics;
}

/**
 * POST /api/admin/crawler/start
 *
 * Either one URL:
 *   Body: { seedUrl, maxPages?, sameDomainOnly?, maxDepth?, crawlDelayMs? }
 * or topics from the seed catalog:
 *   Body: { topics: ["science", ...] | "all", maxPagesPerSeed? }
 */
const startCrawl = asyncHandler(async (req, res) => {
  if (req.body.topics !== undefined) {
    if (req.body.seedUrl) {
      throw ApiError.badRequest('Send either "seedUrl" or "topics", not both.');
    }
    return startTopicCrawl(req, res);
  }

  const seedUrl = parseSeedUrl(req.body.seedUrl);

  // maxPages is validated against the configured hard cap.
  let maxPages = config.crawler.defaultMaxPages;
  if (req.body.maxPages !== undefined && req.body.maxPages !== '') {
    const n = Number(req.body.maxPages);
    if (!Number.isInteger(n) || n < 1) {
      throw ApiError.badRequest('"maxPages" must be an integer of 1 or greater.');
    }
    if (n > config.crawler.maxPagesHardLimit) {
      throw ApiError.badRequest(`"maxPages" cannot exceed ${config.crawler.maxPagesHardLimit}.`);
    }
    maxPages = n;
  }

  let maxDepth = config.crawler.defaultMaxDepth;
  if (req.body.maxDepth !== undefined && req.body.maxDepth !== '') {
    const n = Number(req.body.maxDepth);
    if (!Number.isInteger(n) || n < 0 || n > config.crawler.maxDepthLimit) {
      throw ApiError.badRequest(
        `"maxDepth" must be an integer between 0 and ${config.crawler.maxDepthLimit}.`
      );
    }
    maxDepth = n;
  }

  let crawlDelayMs;
  if (req.body.crawlDelayMs !== undefined && req.body.crawlDelayMs !== '') {
    const n = Number(req.body.crawlDelayMs);
    if (!Number.isFinite(n) || n < 0 || n > config.crawler.maxDelayMs) {
      throw ApiError.badRequest(
        `"crawlDelayMs" must be between 0 and ${config.crawler.maxDelayMs}.`
      );
    }
    crawlDelayMs = n;
  }

  const sameDomainOnly =
    req.body.sameDomainOnly === undefined
      ? true
      : Boolean(req.body.sameDomainOnly) && req.body.sameDomainOnly !== 'false';

  // Re-fetch pages this host has already been crawled for, instead of
  // waiting for their re-crawl to fall due.
  const force = Boolean(req.body.force) && req.body.force !== 'false';

  const { job, queued } = await crawlerJobService.startJob({
    seedUrl,
    maxPages,
    sameDomainOnly,
    maxDepth,
    crawlDelayMs,
    force,
    startedBy: req.user ? req.user._id : null
  });

  return sendSuccess(
    res,
    {
      jobId: job._id.toString(),
      status: job.status,
      seedUrl: job.seedUrl,
      maxPages: job.maxPages,
      maxDepth: job.maxDepth,
      sameDomainOnly: job.sameDomainOnly,
      crawlDelayMs: job.crawlDelayMs,
      queued,
      message: queued
        ? 'Crawl queued. A worker picks it up; poll /api/admin/crawler/jobs for progress.'
        : 'Crawl saved, but the queue is unreachable. It will start automatically once Redis is back.'
    },
    202
  );
});

/** The topic branch of POST /api/admin/crawler/start. */
async function startTopicCrawl(req, res) {
  const topics = parseTopics(req.body.topics);

  let maxPagesPerSeed;
  if (req.body.maxPagesPerSeed !== undefined && req.body.maxPagesPerSeed !== '') {
    const n = Number(req.body.maxPagesPerSeed);
    if (!Number.isInteger(n) || n < 1 || n > config.crawler.maxPagesHardLimit) {
      throw ApiError.badRequest(
        `"maxPagesPerSeed" must be an integer between 1 and ${config.crawler.maxPagesHardLimit}.`
      );
    }
    maxPagesPerSeed = n;
  }

  const result = await crawlerJobService.startSeedCrawl({
    topics,
    maxPagesPerSeed,
    startedBy: req.user ? req.user._id : null
  });

  return sendSuccess(
    res,
    {
      batchId: result.batchId,
      topics: result.topics,
      seeds: result.jobs.length,
      maxPagesPerSeed: result.maxPagesPerSeed,
      totalPageBudget: result.totalPageBudget,
      jobIds: result.jobs.map(j => j._id.toString()),
      queued: result.queued,
      message: result.queued
        ? `Topic crawl queued: ${result.jobs.length} seeds, up to ${result.totalPageBudget} pages.`
        : 'Topic crawl saved, but the queue is unreachable. It will start automatically once Redis is back.'
    },
    202
  );
}

/**
 * POST /api/admin/crawler/stop
 * Body: { jobId } or { batchId } — or neither to stop every running job.
 */
const stopCrawl = asyncHandler(async (req, res) => {
  if (req.body.batchId) {
    const batchId = String(req.body.batchId).trim().slice(0, 64);
    const jobIds = await crawlerJobService.stopBatch(batchId);
    return sendSuccess(res, {
      batchId,
      stopped: jobIds.length,
      jobIds,
      message: `Stop requested for ${jobIds.length} crawl job(s) in this topic crawl.`
    });
  }

  if (req.body.jobId) {
    const id = parseObjectId(req.body.jobId, 'jobId');
    const job = await crawlerJobService.stopJob(id);
    return sendSuccess(res, {
      jobId: id,
      status: job.status === 'stopped' ? 'stopped' : 'stopping',
      message: 'Stop requested. The crawl ends after the page currently in flight.'
    });
  }

  // No jobId: stop every open crawl, wherever a worker happens to be
  // running it. "This process" stopped being the right scope when the
  // crawler moved out of the API. Queried directly rather than from the
  // newest page of the job list: one topic crawl alone can be dozens of jobs.
  const active = (
    await CrawlJob.find({ status: { $in: ['queued', 'running'] } })
      .select('_id')
      .lean()
  ).map(j => ({ id: String(j._id) }));

  if (active.length === 0) {
    return sendSuccess(res, { stopped: 0, message: 'No crawl jobs are currently running.' });
  }

  for (const job of active) {
    await crawlerJobService.stopJob(job.id);
  }

  return sendSuccess(res, {
    stopped: active.length,
    jobIds: active.map(j => j.id),
    message: `Stop requested for ${active.length} crawl job(s).`
  });
});

/** GET /api/admin/users?page=&limit= — never returns password hashes. */
const listUsers = asyncHandler(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, { def: 20, max: 100 });

  const [users, total] = await Promise.all([
    User.find()
      .select('-password')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    User.countDocuments()
  ]);

  return sendSuccess(res, {
    users: users.map(u => ({
      id: u._id.toString(),
      name: u.name,
      email: u.email,
      role: u.role,
      createdAt: u.createdAt
    })),
    pagination: {
      page,
      limit,
      totalResults: total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPreviousPage: page > 1
    }
  });
});

module.exports = {
  getMetrics,
  getDashboard,
  listPages,
  listWebsites,
  listUsers,
  getCrawlerStatus,
  listCrawlerJobs,
  getCrawlerJob,
  listSeedTopics,
  startCrawl,
  stopCrawl,
  collectCoreMetrics,
  formatCount
};
