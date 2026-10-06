const UrlQueue = require('./urlQueue');
const { crawlOne } = require('./crawlWorker');
const { resolveDelayMs } = require('./hostPolicy');
const { filterLinks } = require('./crawlScope');
const { config } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Single-process crawler.
 *
 *   URL queue -> robots.txt -> fetch -> extract links -> extract content
 *             -> text processing -> MongoDB -> OpenSearch
 *
 * This is no longer how the application crawls. Crawl jobs started from the
 * admin API go through the durable frontier and the queue worker, which
 * survives restarts, spreads work across hosts and keeps the API responsive.
 *
 * What this still is: the crawler for scripts that want a self-contained,
 * bounded run with no Redis and no worker — `npm run seed-index`,
 * `npm run reindex`, and the developer scripts in `scripts/dev/`. For those,
 * a frontier that outlives the process would be a liability rather than a
 * feature: seeding a fixed list of pages should not leave a queue behind.
 *
 * The per-page work is shared with the worker through `crawlOne`, so robots
 * handling, redirect resolution, content-type rules and indexing cannot
 * drift between the two paths. Only the queue differs: in memory here,
 * in MongoDB there.
 */

const sleep = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * @param {string} seedUrl                Starting URL
 * @param {number} [maxPages]             Safety limit on pages crawled
 * @param {Object} [options]
 * @param {boolean} [options.sameDomainOnly=true]  Stay on the seed's host
 * @param {string[]} [options.allowedDomains]      Explicit domain allow-list; replaces sameDomainOnly
 * @param {string[]} [options.excludePatterns]     URL regexes never to follow
 * @param {number}  [options.maxDepth]             Link depth from the seed
 * @param {number}  [options.crawlDelayMs]         Politeness delay between requests
 * @param {boolean} [options.respectRobots=true]   Honour robots.txt
 * @param {Function} [options.shouldStop]          () => boolean|Promise<boolean>
 * @param {Function} [options.onProgress]          (stats) => void|Promise<void>
 * @returns {Promise<Object>} crawl statistics
 */
async function startCrawler(seedUrl, maxPages = config.crawler.defaultMaxPages, options = {}) {
  const {
    sameDomainOnly = true,
    allowedDomains = [],
    excludePatterns = [],
    maxDepth = config.crawler.defaultMaxDepth,
    respectRobots = true,
    shouldStop = null,
    onProgress = null
  } = options;

  // Never let a caller exceed the configured hard limit.
  const pageLimit = Math.max(1, Math.min(Number(maxPages) || 1, config.crawler.maxPagesHardLimit));

  // A queue per run — sharing one across runs would make a second crawl
  // skip every URL the first had already visited.
  const queue = new UrlQueue();

  const stats = {
    seedUrl,
    maxPages: pageLimit,
    pagesDiscovered: 0,
    pagesCrawled: 0,
    pagesIndexed: 0,
    failedPages: 0,
    skippedByRobots: 0,
    // Deliberately skipped for a reason other than robots.txt — a PDF, an
    // image, anything we do not index. Not a failure: retrying will not
    // turn it into HTML.
    skippedOther: 0,
    stopped: false,
    startedAt: new Date(),
    completedAt: null,
    failures: []
  };

  if (!queue.enqueue(seedUrl, 0)) {
    stats.completedAt = new Date();
    stats.failedPages = 1;
    stats.failures.push({ url: seedUrl, reason: 'invalid_seed_url' });
    logger.warn('Crawl aborted: invalid seed URL', { seedUrl });
    return stats;
  }
  stats.pagesDiscovered = queue.discoveredCount();

  // Honour the host's own Crawl-delay when it declares one.
  const delayMs = await resolveDelayMs(seedUrl, {
    overrideMs: options.crawlDelayMs,
    respectRobots
  });

  logger.info('Crawl started', { seedUrl, maxPages: pageLimit, sameDomainOnly, delayMs, maxDepth });

  const report = async () => {
    if (onProgress) {
      try {
        await onProgress({ ...stats, queueSize: queue.size() });
      } catch (err) {
        logger.warn('Crawl progress callback failed', { message: err.message });
      }
    }
  };

  const stopRequested = async () => {
    if (!shouldStop) return false;
    try {
      return Boolean(await shouldStop());
    } catch (err) {
      logger.warn('Crawl stop check failed', { message: err.message });
      return false;
    }
  };

  const recordFailure = (url, reason, status) => {
    stats.failedPages += 1;
    if (stats.failures.length < 50) stats.failures.push({ url, reason, status });
  };

  while (!queue.isEmpty() && stats.pagesCrawled < pageLimit) {
    if (await stopRequested()) {
      stats.stopped = true;
      logger.info('Crawl stop requested', { seedUrl, pagesCrawled: stats.pagesCrawled });
      break;
    }

    const item = queue.dequeue();
    if (!item) break;
    const { url: currentUrl, depth } = item;

    const scope = { seedUrl, sameDomainOnly, allowedDomains, excludePatterns };
    const result = await crawlOne(currentUrl, { respectRobots, scope });

    // Redirected to another host: nothing was fetched there. The target
    // joins the queue as a link would, if the crawl may go there at all.
    if (result.outcome === 'redirect') {
      stats.skippedOther += 1;
      if (depth < maxDepth) {
        for (const link of filterLinks([result.redirectTo], scope)) {
          queue.enqueue(link, depth + 1);
        }
        stats.pagesDiscovered = queue.discoveredCount();
      }
      await report();
      if (delayMs > 0 && !queue.isEmpty()) await sleep(delayMs);
      continue;
    }

    if (result.outcome === 'skipped') {
      if (result.reason === 'robots_txt') {
        stats.skippedByRobots += 1;
        logger.debug('Skipped by robots.txt', { url: currentUrl });
      } else {
        stats.skippedOther += 1;
      }
      await report();
      // robots.txt costs no request to the host, so no politeness delay is
      // owed; a rejected content type already cost one, so it is.
      if (result.reason !== 'robots_txt' && delayMs > 0 && !queue.isEmpty()) {
        await sleep(delayMs);
      }
      continue;
    }

    if (result.outcome === 'failed' && result.reason !== 'index_error') {
      recordFailure(currentUrl, result.reason, result.statusCode);
      logger.debug('Crawl fetch failed', { url: currentUrl, reason: result.reason });
      await report();
      // Still pause: a failing host should not be hammered.
      if (delayMs > 0 && !queue.isEmpty()) await sleep(delayMs);
      continue;
    }

    // The page was fetched. A redirect means the content lives at result.url.
    stats.pagesCrawled += 1;

    if (depth < maxDepth) {
      for (const link of filterLinks(result.links, scope)) {
        queue.enqueue(link, depth + 1);
      }
      stats.pagesDiscovered = queue.discoveredCount();
    }

    if (result.outcome === 'indexed') {
      stats.pagesIndexed += 1;
    } else if (result.outcome === 'noindex') {
      // Fetched, and its links followed, but the page asked not to be indexed.
      stats.skippedOther += 1;
    } else {
      recordFailure(result.url, 'index_error');
    }

    logger.debug('Page crawled', {
      url: result.url,
      progress: `${stats.pagesCrawled}/${pageLimit}`,
      links: result.links.length
    });
    await report();

    // Politeness delay before the next request.
    if (delayMs > 0 && !queue.isEmpty() && stats.pagesCrawled < pageLimit) {
      await sleep(delayMs);
    }
  }

  stats.completedAt = new Date();
  stats.queueRemaining = queue.size();

  logger.info('Crawl finished', {
    seedUrl,
    pagesCrawled: stats.pagesCrawled,
    pagesIndexed: stats.pagesIndexed,
    failedPages: stats.failedPages,
    skippedByRobots: stats.skippedByRobots,
    stopped: stats.stopped
  });

  await report();
  return stats;
}

module.exports = { startCrawler };
