const SitemapDiscovery = require('../models/SitemapDiscovery');
const frontier = require('./frontierService');
const { fetchSitemap } = require('../crawler/sitemapFetcher');
const { parseSitemap } = require('../crawler/sitemapParser');
const { getSitemapUrls, isAllowed } = require('../crawler/robotsChecker');
const { resolveDelayMs } = require('../crawler/hostPolicy');
const { isInScope } = require('../crawler/crawlScope');
const { isAssetUrl } = require('../crawler/linkExtractor');
const { normalizeUrl, canonicalKey } = require('../utils/urlNormalizer');
const { config } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Sitemap discovery: robots.txt -> sitemap files -> page URLs -> frontier.
 *
 * Runs once per crawl chain and host, and only adds work: every URL it finds
 * becomes an ordinary pending frontier row of the job, at depth 1, crawled —
 * or not — under that job's budget like any link. Nothing here fetches a page.
 *
 * Bounded at every step:
 *
 *   - files: at most CRAWLER_SITEMAP_MAX_FILES per run, fetched one at a time
 *     with the host's crawl delay between them, and only from the crawl host
 *     itself (the fetcher also refuses redirects off it);
 *   - nesting: sitemap indexes followed CRAWLER_SITEMAP_MAX_DEPTH levels deep,
 *     with a visited set, so A -> B -> A ends after two files;
 *   - URLs: each file read up to CRAWLER_SITEMAP_MAX_URLS_PER_FILE entries,
 *     and at most min(CRAWLER_SITEMAP_MAX_URLS, what the chain could ever
 *     crawl) added — a 3-page job gets at most 3 rows, not thousands;
 *   - scope: each URL passes the same rules as a discovered link — normalised,
 *     not an asset, inside the job's domain scope and exclude patterns, and
 *     allowed by robots.txt — then is deduplicated by canonical key.
 *
 * `<lastmod>` only orders candidates before the cap (newest first, then
 * document order). It never changes priority, budget or re-crawl timing.
 *
 * Called by the crawl worker (crawler/crawlWorker.js) when CRAWLER_SITEMAPS
 * is on, from inside the host's slice.
 */

const MAX_ERRORS = 5;

const sleep = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The most URLs worth adding: more than the chain could ever crawl is waste. */
function urlCap(job) {
  const continuations = config.crawler.continuous ? config.crawler.continuousMaxContinuations : 0;
  const capacity = Math.max(0, Number(job.maxPages) || 0) * (1 + continuations);
  return Math.min(config.crawler.sitemapMaxUrls, capacity);
}

/** The origin to try /sitemap.xml on: the seed's, when the seed is on this host. */
function fallbackSitemapUrl(job, host) {
  try {
    const seed = new URL(job.seedUrl);
    if (seed.hostname.toLowerCase() === host) return `${seed.origin}/sitemap.xml`;
  } catch {
    /* fall through */
  }
  return `https://${host}/sitemap.xml`;
}

/**
 * Claims the (chain, host) run. Resolves to null when it is already claimed —
 * running, done or failed — by this or any other worker.
 */
async function claim(chainId, host) {
  // The unique index is the lock. On a fresh database it may still be
  // building, and a claim made before it exists would not be exclusive.
  await SitemapDiscovery.init();
  const now = new Date();
  try {
    const run = await SitemapDiscovery.create({
      chainId,
      host,
      status: 'running',
      attempts: 1,
      startedAt: now,
      lastAttemptAt: now
    });
    return { run, previous: null };
  } catch (error) {
    if (!(error && error.code === 11000)) throw error;
  }

  // Already exists. Take it over only if it is a run whose worker died (still
  // "running" past its lease) or one that failed for a temporary reason —
  // and only while attempts remain. One atomic update: of several workers
  // trying at once, exactly one matches.
  const staleBefore = new Date(now.getTime() - config.crawler.sitemapDiscoveryLeaseMs);
  const maxAttempts = config.crawler.sitemapDiscoveryMaxAttempts;
  const previous = await SitemapDiscovery.findOneAndUpdate(
    {
      chainId,
      host,
      attempts: { $lt: maxAttempts },
      $or: [
        { status: 'running', startedAt: { $lt: staleBefore } },
        { status: 'failed', retryable: true }
      ]
    },
    {
      $set: {
        status: 'running',
        startedAt: now,
        lastAttemptAt: now,
        completedAt: null,
        retryable: false
      },
      $inc: { attempts: 1 }
    },
    { returnDocument: 'before' }
  ).lean();
  if (previous) return { run: previous, previous };

  // A dead run with no attempts left is closed, not left "running" forever.
  await SitemapDiscovery.updateOne(
    {
      chainId,
      host,
      status: 'running',
      startedAt: { $lt: staleBefore },
      attempts: { $gte: maxAttempts }
    },
    {
      $set: { status: 'failed', retryable: false, completedAt: now },
      $push: { errors: { $each: ['abandoned: lease expired'], $slice: -MAX_ERRORS } }
    }
  );
  return null;
}

// Fetch outcomes worth trying again later: the site may simply have been
// slow or briefly down. A 404, an HTML page or bad XML will not improve.
function isTemporary(fetched) {
  if (['timeout', 'network_error', 'dns_error'].includes(fetched.reason)) return true;
  return fetched.reason === 'http_error' && (fetched.status >= 500 || fetched.status === 429);
}

/**
 * Discovers a host's sitemap URLs for one job's crawl chain.
 *
 * Never throws for anything a site can do; a failure is recorded on the run
 * and reported in the result.
 *
 * @param {Object} params
 * @param {Object} params.job  the CrawlJob (lean) the URLs will belong to
 * @param {string} params.host the crawl host, as the frontier stores it
 * @returns {Promise<{status: 'done'|'failed'|'skipped', reason?: string,
 *   filesFetched: number, filesFailed: number, urlsFound: number,
 *   urlsAdded: number, urlsRejected: number}>}
 */
async function discover({ job, host, delayBeforeFirstMs = 0 } = {}) {
  const empty = { filesFetched: 0, filesFailed: 0, urlsFound: 0, urlsAdded: 0, urlsRejected: 0 };
  const crawlHost = String(host || '').toLowerCase();
  if (!job || !job._id || !crawlHost) {
    return { status: 'skipped', reason: 'invalid_arguments', ...empty };
  }

  const chainId = job.chainId || job._id;
  const context = { jobId: String(job._id), chainId: String(chainId), host: crawlHost };

  const claimed = await claim(chainId, crawlHost);
  if (!claimed) {
    const existing = await SitemapDiscovery.findOne({ chainId, host: crawlHost }).lean();
    const reason = `already_${existing ? existing.status : 'claimed'}`;
    logger.debug('Sitemap discovery skipped', { ...context, reason });
    return { status: 'skipped', reason, ...empty };
  }

  const { run, previous } = claimed;
  const attempt = previous ? previous.attempts + 1 : 1;
  if (previous && previous.status === 'running') {
    logger.warn('Sitemap discovery reclaimed stale lease', { ...context, attempt });
  }
  logger.info('Sitemap discovery started', { ...context, attempt });

  const stats = { ...empty };
  const errors = [];
  const note = message => {
    if (errors.length < MAX_ERRORS) errors.push(String(message).slice(0, 200));
  };
  const failures = { temporary: 0 };

  let status = 'done';
  let retryable = false;
  try {
    await collectAndAdd({ job, host: crawlHost, stats, note, failures, delayBeforeFirstMs });
    // Every file failed: there was something to read and none of it worked.
    if (stats.filesFetched === 0 && stats.filesFailed > 0) {
      status = 'failed';
      retryable = failures.temporary > 0;
    }
  } catch (error) {
    // A database error, say. What was already added stays: it is ordinary,
    // valid frontier work.
    status = 'failed';
    retryable = true;
    note(`unexpected: ${error.message}`);
  }

  await SitemapDiscovery.updateOne(
    { _id: run._id },
    { $set: { status, retryable, completedAt: new Date(), ...stats, errors } }
  ).catch(error => {
    logger.warn('Could not record sitemap discovery result', { message: error.message });
  });

  const log = status === 'done' ? logger.info : logger.warn;
  log.call(logger, status === 'done' ? 'Sitemap discovery completed' : 'Sitemap discovery failed', {
    ...context,
    status,
    attempt,
    ...(status === 'failed' ? { retryable } : {}),
    ...stats
  });
  return { status, attempt, ...(status === 'failed' ? { retryable } : {}), ...stats };
}

async function collectAndAdd({ job, host, stats, note, failures, delayBeforeFirstMs }) {
  const cap = urlCap(job);
  // Sitemap URLs are depth 1: with a depth limit of 0 a crawl takes nothing
  // beyond its seed, from links or from sitemaps.
  if (cap === 0 || Number(job.maxDepth) < 1) return;

  const scope = {
    seedUrl: job.seedUrl,
    sameDomainOnly: job.sameDomainOnly,
    allowedDomains: job.allowedDomains,
    excludePatterns: job.excludePatterns
  };

  // Sitemap files to read, breadth first.
  const queue = [];
  const visited = new Set();
  const enqueue = (url, depth) => {
    const normalized = normalizeUrl(url);
    if (!normalized) return note(`invalid sitemap URL: ${url}`);
    if (hostnameOf(normalized) !== host) return note(`other host: ${normalized}`);
    if (visited.has(normalized)) return undefined;
    visited.add(normalized);
    queue.push({ url: normalized, depth });
    return undefined;
  };

  const origin = fallbackSitemapUrl(job, host).replace(/\/sitemap\.xml$/, '');
  const listed = await getSitemapUrls(`${origin}/`);
  for (const url of listed) enqueue(url, 0);
  if (queue.length === 0 && config.crawler.sitemapFallback) {
    enqueue(fallbackSitemapUrl(job, host), 0);
  }

  // Candidate pages, deduplicated by canonical key, in document order.
  const candidates = new Map();
  let attempts = 0;

  while (queue.length > 0 && attempts < config.crawler.sitemapMaxFiles) {
    // Enough candidates already for the cap: further files would only cost
    // requests.
    if (candidates.size >= cap) break;

    const { url, depth } = queue.shift();
    // Politeness: the host's delay between sitemap requests, and before the
    // first one too when the caller has just made a request to this host.
    const delay =
      attempts > 0
        ? await resolveDelayMs(url, { overrideMs: job.crawlDelayMs })
        : Math.max(0, Number(delayBeforeFirstMs) || 0);
    if (delay > 0) await sleep(delay);
    attempts += 1;

    const fetched = await fetchSitemap(url);
    if (!fetched.ok) {
      stats.filesFailed += 1;
      if (isTemporary(fetched)) failures.temporary += 1;
      note(`${url}: ${fetched.reason}`);
      continue;
    }

    const parsed = parseSitemap(fetched.body);
    if (!parsed.type) {
      stats.filesFailed += 1;
      note(`${url}: not a sitemap`);
      continue;
    }
    stats.filesFetched += 1;
    stats.urlsRejected += parsed.rejected;

    if (parsed.type === 'sitemapindex') {
      if (depth >= config.crawler.sitemapMaxDepth) {
        note(`${url}: index nested deeper than ${config.crawler.sitemapMaxDepth}`);
        continue;
      }
      for (const entry of parsed.entries) enqueue(entry.loc, depth + 1);
      continue;
    }

    for (const entry of parsed.entries) {
      stats.urlsFound += 1;
      const page = await acceptPage(entry.loc, { host, scope });
      if (!page) {
        stats.urlsRejected += 1;
        continue;
      }
      const key = canonicalKey(page);
      if (candidates.has(key)) continue;
      candidates.set(key, {
        url: page,
        lastmod: entry.lastmod,
        order: candidates.size,
        sitemap: url
      });
    }
  }

  if (queue.length > 0 && attempts >= config.crawler.sitemapMaxFiles) {
    note(`file limit of ${config.crawler.sitemapMaxFiles} reached`);
  }

  // Newest <lastmod> first; undated entries after dated ones, each group in
  // document order.
  const chosen = Array.from(candidates.values())
    .sort((a, b) => {
      const at = a.lastmod ? a.lastmod.getTime() : -Infinity;
      const bt = b.lastmod ? b.lastmod.getTime() : -Infinity;
      return bt - at || a.order - b.order;
    })
    .slice(0, cap);

  if (chosen.length === 0) return;

  const { added } = await frontier.addUrls(
    // Depth 1 and priority -1: exactly what a link on the seed page gets.
    chosen.map(c => ({ url: c.url, depth: 1, priority: -1, referrerUrl: c.sitemap })),
    { crawlJobId: job._id }
  );
  stats.urlsAdded = added;
}

/**
 * The page URL to add, or null when it may not enter the frontier — the
 * same tests a discovered link must pass.
 *
 * robots.txt is checked here only for the crawl host, whose robots.txt is
 * already cached. A URL on another host the scope allows is checked when it
 * is claimed, as every URL is; fetching other sites' robots.txt here would
 * turn discovery into requests to hosts we hold no slot for.
 */
async function acceptPage(loc, { host, scope }) {
  const url = normalizeUrl(loc);
  if (!url || !canonicalKey(url)) return null;
  if (isAssetUrl(url)) return null;
  if (!isInScope(url, scope)) return null;
  if (hostnameOf(url) === host && !(await isAllowed(url))) return null;
  return url;
}

module.exports = { discover, urlCap };
