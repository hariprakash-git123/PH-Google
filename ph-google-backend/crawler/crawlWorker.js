const CrawlJob = require('../models/CrawlJob');
const frontier = require('../services/frontierService');
const { resolveDelayMs, fetchAccess } = require('./hostPolicy');
const { fetchPageDetailed } = require('./pageFetcher');
const { extractLinks, extractMetadata, isSameDomain, isAssetUrl } = require('./linkExtractor');
const { readRobotsDirectives, extractCanonical } = require('./pageDirectives');
const { filterLinks, isOnDomain, isInScope } = require('./crawlScope');
const { indexPage } = require('./indexer');
const { normalizeUrl, canonicalKey } = require('../utils/urlNormalizer');
const sitemapDiscovery = require('../services/sitemapDiscoveryService');
const { config } = require('../config/env');
const logger = require('../utils/logger');

/**
 * The crawl worker's unit of work: one host, for one slice.
 *
 * Why a host and not a URL, and not a whole crawl:
 *
 *   - A queue job per *crawl* gives no parallelism across sites; one slow
 *     host stalls everything behind it.
 *   - A queue job per *URL* needs a distributed lock to keep two workers off
 *     the same site at once, and creates a Redis job per link discovered.
 *   - A queue job per *host*, with the hostname as the job id, gets both for
 *     free. BullMQ refuses a second job with an id already in the queue, so
 *     "one request at a time per host" is a property of the design rather
 *     than something enforced at runtime — and it holds across crawl jobs
 *     too, which matters, because a site does not care which of our crawls
 *     is hitting it.
 *
 * A lease handles at most `hostSlicePages` pages and then yields, re-queuing
 * itself if work remains. Without that, one site with 50,000 pages would hold
 * a worker slot until it finished and every other host would wait behind it.
 */

const sleep = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Reserves one page against a crawl job's budget.
 *
 * The check and the increment are one atomic update, because several hosts
 * belonging to the same job run concurrently. Read-then-write would let two
 * workers both see `pagesCrawled = 99` against a limit of 100 and both
 * proceed, so a job asked for 100 pages would quietly fetch 104.
 *
 * @returns {Promise<boolean>} false when the budget is spent
 */
async function reserveBudget(crawlJobId, maxPages) {
  if (!crawlJobId) return true; // a re-crawl outside any job has no budget

  const updated = await CrawlJob.findOneAndUpdate(
    { _id: crawlJobId, pagesCrawled: { $lt: maxPages } },
    { $inc: { pagesCrawled: 1 }, $set: { lastHeartbeatAt: new Date() } },
    { new: true, projection: { _id: 1 } }
  ).lean();

  return Boolean(updated);
}

/**
 * Hands a reserved page back when the fetch did not produce one.
 *
 * Still a heartbeat: a skipped or failed page is the worker making progress
 * on the job, and a job whose pages keep failing must not look abandoned.
 */
async function releaseBudget(crawlJobId, { failed = false } = {}) {
  if (!crawlJobId) return;
  const update = { $inc: { pagesCrawled: -1 }, $set: { lastHeartbeatAt: new Date() } };
  if (failed) update.$inc.failedPages = 1;
  await CrawlJob.updateOne({ _id: crawlJobId }, update);
}

/** The domain rules of a crawl job, as crawlScope reads them. */
function scopeOf(job) {
  return {
    seedUrl: job.seedUrl,
    sameDomainOnly: job.sameDomainOnly,
    allowedDomains: job.allowedDomains,
    excludePatterns: job.excludePatterns
  };
}

/**
 * Decides which discovered links belong in the frontier.
 *
 * @returns {Array<{url: string, depth: number, priority: number, referrerUrl: string}>}
 */
function linksInScope(links, { job, sourceUrl, depth }) {
  if (!job || depth >= job.maxDepth) return [];

  const scoped = filterLinks(links, scopeOf(job));

  const entries = [];
  for (const link of scoped) {
    entries.push({
      url: link,
      depth: depth + 1,
      // Shallower pages matter more, so priority falls with depth and the
      // frontier's sort keeps the crawl breadth-first.
      priority: -(depth + 1),
      referrerUrl: sourceUrl
    });
  }
  return entries;
}

/**
 * Whether a job's crawl may read this host's sitemaps: the host must be one
 * the job's own domain policy names — an allowed domain or subdomain, or the
 * seed's host. A crawl with `sameDomainOnly: false` follows links anywhere,
 * but does not read every visited site's sitemap.
 */
function sitemapHostAllowed(job, host) {
  const url = `http://${host}/`;
  if (Array.isArray(job.allowedDomains) && job.allowedDomains.length > 0) {
    return job.allowedDomains.some(domain => isOnDomain(url, domain));
  }
  return isSameDomain(url, job.seedUrl);
}

/**
 * Sitemap discovery for one host, inside its slice. Runs only while
 * CRAWLER_SITEMAPS is on AND the job opted in (`job.sitemaps`, from its seed).
 *
 * Runs here, after a page of the job has been indexed on this host, because
 * the slice holds the host's queue slot: sitemap requests are made one at a
 * time, after the page request and the host's delay, never beside another
 * request to the same site. The service makes it once per crawl chain and
 * host, so later slices and continuation jobs skip it.
 *
 * Never fails the slice: discovery only adds frontier rows, and a crawl
 * without them is still a correct crawl.
 */
async function discoverSitemaps(job, host, delayMs) {
  try {
    await sitemapDiscovery.discover({ job, host, delayBeforeFirstMs: delayMs });
  } catch (error) {
    logger.warn('Sitemap discovery failed', {
      jobId: String(job._id),
      chainId: String(job.chainId || job._id),
      host,
      message: error.message
    });
  }
}

// How long a host is left alone after it says it is overloaded (429, 503) or
// its robots.txt cannot be read, when it names no Retry-After of its own.
const HOST_BACKOFF_MS = 60 * 1000;

/**
 * Crawls one page: robots, fetch, page directives, extract, index.
 *
 * Shared by the queue worker and by `startCrawler`, so the two cannot drift
 * apart on what "crawl a page" means — particularly on which failures are
 * worth retrying.
 *
 * It returns the links it found rather than storing them, because the two
 * callers put them in different places: the worker writes them to the
 * durable frontier, while `startCrawler` keeps its own in-memory queue for
 * the length of one script run.
 *
 * Outcomes:
 *   indexed   fetched and indexed
 *   noindex   fetched, but the page asks not to be indexed; its links are
 *             still returned unless it also says nofollow
 *   redirect  the URL redirects to another host (`redirectTo`); nothing was
 *             fetched from that host
 *   skipped   deliberately not crawled — robots.txt, not an HTML page, a
 *             redirect to somewhere the crawl may not go
 *   failed    tried and could not; `retryable` says whether to try again
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {boolean} [options.respectRobots=true]
 * @param {Object} [options.scope] the crawl's domain rules. Decides whether
 *   a redirect's destination and a page's canonical URL are acceptable;
 *   without one, a canonical is only accepted on the page's own domain.
 * @param {(url: string) => Promise<boolean>} [options.alreadyCrawled] asked
 *   about each redirect hop before it is made; true means the destination
 *   has been fetched and is not due again, so the redirect is not followed.
 * @returns {Promise<{outcome: string, reason?: string, statusCode?: number,
 *   url: string, links: string[], canonicalUrl?: string|null,
 *   redirectTo?: string, retryable?: boolean, retryAfterMs?: number|null,
 *   hostBackoffMs?: number}>}
 */
async function crawlOne(url, { respectRobots = true, scope = null, alreadyCrawled = null } = {}) {
  const access = await fetchAccess(url, { respectRobots });
  if (access === 'disallowed') {
    return { outcome: 'skipped', reason: 'robots_txt', url, links: [] };
  }
  if (access === 'unavailable') {
    // The rules are unknown, so the page is not fetched — but they may be
    // readable in a few minutes, so this is a failure to retry, not a skip.
    return {
      outcome: 'failed',
      reason: 'robots_unavailable',
      url,
      links: [],
      retryable: true,
      hostBackoffMs: HOST_BACKOFF_MS
    };
  }

  const fetched = await fetchPageDetailed(url, {
    // The crawl's scope and robots.txt apply to where a redirect leads, not
    // only to where it starts. A redirect stays on its host, but a host is
    // not a scope: the target may be a path the crawl excludes.
    allowHop: async next => {
      if (scope && !isInScope(next, scope)) return 'scope';
      if ((await fetchAccess(next, { respectRobots })) !== 'allowed') return 'robots';
      // A destination already in hand is not fetched a second time just
      // because another URL redirects to it.
      if (alreadyCrawled && (await alreadyCrawled(next))) return 'already_crawled';
      return true;
    }
  });

  if (!fetched.ok) {
    const failure = { reason: fetched.reason, statusCode: fetched.status, url, links: [] };

    if (fetched.reason === 'cross_host_redirect') {
      return {
        ...failure,
        outcome: 'redirect',
        reason: 'redirect',
        redirectTo: fetched.redirectTo
      };
    }
    // Deliberate skips, not failures: retrying a PDF three times will not
    // turn it into HTML, and an oversized page will not shrink.
    if (fetched.reason === 'unsupported_content_type' || fetched.reason === 'too_large') {
      return { ...failure, outcome: 'skipped' };
    }
    if (fetched.reason === 'redirect_disallowed') {
      const reason =
        {
          scope: 'redirect_out_of_scope',
          already_crawled: 'redirect_duplicate'
        }[fetched.blockedBy] || 'redirect_robots_txt';
      return { ...failure, outcome: 'skipped', reason };
    }

    const result = {
      ...failure,
      outcome: 'failed',
      retryable: fetched.retryable !== false,
      retryAfterMs: fetched.retryAfterMs || null
    };
    // "Slow down" and "unavailable" are about the host, not this URL.
    if (fetched.status === 429 || fetched.status === 503) {
      result.hostBackoffMs = fetched.retryAfterMs || HOST_BACKOFF_MS;
    }
    return result;
  }

  // A redirect means the content really lives at finalUrl.
  const contentUrl = fetched.finalUrl || url;
  const redirected = canonicalKey(contentUrl) !== canonicalKey(url);

  // Already refused hop by hop above; checked again on where it ended.
  if (redirected && scope && !isInScope(contentUrl, scope)) {
    return {
      outcome: 'skipped',
      reason: 'redirect_out_of_scope',
      statusCode: fetched.status,
      url: contentUrl,
      links: []
    };
  }

  const directives = readRobotsDirectives(fetched.html, fetched.headers);
  const links = directives.follow ? extractLinks(fetched.html, contentUrl) : [];

  // The canonical is the page's own claim and is only believed where the
  // crawl could have gone anyway.
  let canonicalUrl = extractCanonical(fetched.html, contentUrl, fetched.headers);
  if (canonicalUrl) {
    const acceptable = scope
      ? isInScope(canonicalUrl, scope)
      : isSameDomain(canonicalUrl, contentUrl);
    if (!acceptable || isAssetUrl(canonicalUrl)) canonicalUrl = null;
  }

  if (!directives.index) {
    return {
      outcome: 'noindex',
      reason: 'noindex',
      statusCode: fetched.status,
      url: contentUrl,
      links,
      canonicalUrl
    };
  }

  const metadata = extractMetadata(fetched.html);
  if (canonicalUrl) metadata.canonicalUrl = canonicalUrl;

  const indexed = await indexPage(contentUrl, fetched.html, metadata);
  if (!indexed.ok) {
    return { outcome: 'failed', reason: 'index_error', url: contentUrl, links, retryable: true };
  }

  return { outcome: 'indexed', statusCode: fetched.status, url: contentUrl, links, canonicalUrl };
}

/**
 * What to do with a URL that redirects to another host.
 *
 * The target was not fetched: it belongs to another host's queue slot, crawl
 * delay and robots.txt. So it is treated as a discovery —
 *
 *   rehome   the target is this same page at another host (`example.com/a`
 *            -> `www.example.com/a`): the row itself moves there;
 *   enqueue  the target is another page: it enters the frontier as a link
 *            would, one level deeper, under the job's scope and depth limit;
 *   skip     the target is somewhere the crawl may not go, or there is no
 *            open job to discover it for;
 *   fail     the row has already been moved as often as a URL may be tried,
 *            which is what two hosts redirecting to each other looks like.
 *
 * @returns {{action: 'rehome'|'enqueue'|'skip'|'fail', url?: string, reason: string,
 *            entries?: Array}}
 */
function planRedirect({ claimed, job, redirectTo }) {
  const target = normalizeUrl(redirectTo);
  if (!target || isAssetUrl(target)) return { action: 'skip', reason: 'redirect' };

  const inScope = !job || isInScope(target, scopeOf(job));

  if (canonicalKey(target) === canonicalKey(claimed.url)) {
    if (!inScope) return { action: 'skip', reason: 'redirect_out_of_scope' };
    if (claimed.attempts >= config.crawler.maxAttemptsPerUrl) {
      return { action: 'fail', reason: 'redirect_loop' };
    }
    return { action: 'rehome', url: target, reason: 'redirect' };
  }

  if (!inScope) return { action: 'skip', reason: 'redirect_out_of_scope' };

  const entries = linksInScope([target], { job, sourceUrl: claimed.url, depth: claimed.depth });
  if (entries.length === 0) return { action: 'skip', reason: 'redirect' };
  return { action: 'enqueue', url: target, reason: 'redirect', entries };
}

/**
 * Drains one host's frontier for a bounded slice.
 *
 * Exported and callable directly, which is how the tests exercise it: the
 * whole crawl path can be driven on an in-memory MongoDB with no Redis and
 * no worker process. There is deliberately no "run the crawl inside the API"
 * switch — that is the arrangement this phase exists to remove.
 *
 * @param {Object} params
 * @param {string} params.host
 * @param {number} [params.maxPages]  slice size; defaults to config
 * @returns {Promise<{host: string, processed: number, indexed: number,
 *                    failed: number, skipped: number, hasMore: boolean,
 *                    delayMs: number}>}
 */
async function processHost({ host, maxPages } = {}) {
  const slice = Math.max(1, Number(maxPages) || config.crawler.hostSlicePages);
  const summary = {
    host,
    processed: 0,
    indexed: 0,
    failed: 0,
    skipped: 0,
    // Continuous crawl only: URLs handed back unfetched because their job's
    // budget ran out, kept pending for the job that continues it.
    deferred: 0,
    hasMore: false,
    delayMs: 0,
    // Why URLs were skipped or failed in this slice, counted by reason.
    reasons: {}
  };
  const note = reason => {
    const key = String(reason || 'unknown');
    summary.reasons[key] = (summary.reasons[key] || 0) + 1;
  };

  if (!host) return summary;

  // Continuous crawl: jobs whose budget ran out during this slice. Their
  // rows stay pending, so they are excluded from further claims here and
  // from `hasMore` — the maintenance sweep hands them to a continuation.
  const exhaustedJobs = new Map();
  // Crawl chains this slice has already run sitemap discovery for.
  const sitemapTried = new Set();
  const excluded = () => Array.from(exhaustedJobs.values());

  // Cache job documents: every URL of a host usually belongs to the same
  // crawl, and re-reading it per page would be one query per fetch.
  const jobCache = new Map();

  /**
   * The job a URL belongs to, but only while that job is still open.
   *
   * A row with no job is a scheduled re-crawl (requeueDueForRecrawl detaches
   * it) and is crawled outside any budget. A row that names a job which has
   * ended is refused below: it is that job's work, and the job has no budget
   * left to charge it to.
   */
  async function loadActiveJob(id) {
    if (!id) return null;
    const key = String(id);
    if (!jobCache.has(key)) {
      const found = await CrawlJob.findById(id).lean();
      const open = found && (found.status === 'running' || found.status === 'queued');
      jobCache.set(key, open ? found : null);
    }
    return jobCache.get(key);
  }

  for (let i = 0; i < slice; i += 1) {
    const claimed = await frontier.claimNext(host, { excludeJobIds: excluded() });
    if (!claimed) break;

    const job = await loadActiveJob(claimed.crawlJobId);

    // Its job has closed — typically a URL that was in flight when the job
    // spent its budget and closed, then failed or lost its lease and came
    // back to pending. Never crawl it without a budget.
    if (claimed.crawlJobId && !job) {
      if (config.crawler.continuous) {
        // Leave it pending, unfetched; the sweep hands it to the chain's
        // continuation, or skips it if the chain cannot continue.
        await frontier.releaseClaim(claimed._id);
        summary.deferred += 1;
        exhaustedJobs.set(String(claimed.crawlJobId), claimed.crawlJobId);
      } else {
        // Exactly what the sweep does with a closed job's leftovers.
        await frontier.markSkipped(claimed.url, 'crawl_closed');
        summary.skipped += 1;
      }
      continue;
    }

    // The stop request travels through the database, because the API that
    // received it runs in a different process from this worker.
    if (job && job.stopRequested) {
      await frontier.markSkipped(claimed.url, 'crawl_stopped');
      summary.skipped += 1;
      continue;
    }

    if (job && !(await reserveBudget(job._id, job.maxPages))) {
      if (config.crawler.continuous) {
        // The job stops here, as it always has; its unfetched URLs do not.
        // Hand this one back unfetched and leave the rest pending for the
        // continuation the maintenance sweep creates.
        await frontier.releaseClaim(claimed._id);
        summary.deferred += 1;
        if (!exhaustedJobs.has(String(job._id))) {
          exhaustedJobs.set(String(job._id), job._id);
          logger.info('Job page budget reached; pending URLs kept for continuous crawl', {
            jobId: String(job._id),
            host,
            maxPages: job.maxPages
          });
        }
        continue;
      }

      // Budget spent. Put the URL back untouched so a later job, or a
      // re-crawl, can still pick it up.
      await frontier.markSkipped(claimed.url, 'job_page_limit_reached');
      summary.skipped += 1;
      // Everything else this job queued is now out of budget too. Skipping
      // it in one write saves claiming and skipping each row in turn, which
      // on a host shared by many seeds would be hundreds of wasted claims.
      await frontier.skipPendingForJob(job._id, 'job_page_limit_reached');
      continue;
    }

    const delayMs = await resolveDelayMs(claimed.url, {
      overrideMs: job ? job.crawlDelayMs : undefined
    });
    summary.delayMs = delayMs;

    let result;
    try {
      result = await crawlOne(claimed.url, {
        scope: job ? scopeOf(job) : null,
        // Nothing was fetched for a skipped duplicate, so it costs the job
        // no page: the budget reserved above is handed back with the skip.
        alreadyCrawled: next => frontier.isFreshlyCrawled(next)
      });
    } catch (error) {
      logger.error('Unexpected crawl failure', { url: claimed.url, message: error.message });
      result = { outcome: 'failed', reason: 'unexpected_error', url: claimed.url, links: [] };
    }

    summary.processed += 1;
    // Set when the host itself asked for a pause; ends the slice below.
    let hostBackoffMs = 0;

    if (result.outcome === 'indexed' || result.outcome === 'noindex') {
      const wasIndexed = result.outcome === 'indexed';
      if (wasIndexed) summary.indexed += 1;
      else {
        summary.skipped += 1;
        note('noindex');
      }

      // Feed the frontier with what this page linked to, within the job's
      // scope and depth limit. A canonical that names another page is a
      // discovery like any link, and goes first so the link cap keeps it.
      const candidates =
        result.canonicalUrl && canonicalKey(result.canonicalUrl) !== canonicalKey(result.url)
          ? [result.canonicalUrl, ...result.links]
          : result.links;
      const scoped = linksInScope(candidates, {
        job,
        sourceUrl: result.url,
        depth: claimed.depth
      });
      if (scoped.length > 0) {
        const { added } = await frontier.addUrls(scoped, { crawlJobId: job ? job._id : null });
        if (job && added > 0) {
          await CrawlJob.updateOne({ _id: job._id }, { $inc: { pagesDiscovered: added } });
        }
      }

      const doneNote = wasIndexed ? '' : 'noindex';
      await frontier.markDone(claimed.url, { statusCode: result.statusCode, note: doneNote });
      // A same-host redirect: the page was fetched under another address,
      // which must not be fetched again when a link to it turns up.
      if (canonicalKey(result.url) !== canonicalKey(claimed.url)) {
        await frontier.markFetchedAs(result.url, {
          crawlJobId: job ? job._id : null,
          depth: claimed.depth,
          referrerUrl: claimed.url,
          statusCode: result.statusCode,
          note: doneNote
        });
      }
      if (job) {
        await CrawlJob.updateOne(
          { _id: job._id },
          {
            $inc: { pagesIndexed: wasIndexed ? 1 : 0 },
            $set: { currentUrl: result.url, lastHeartbeatAt: new Date() }
          }
        );
      }

      // Once the chain has a page indexed on this host, its sitemaps — if
      // both the global switch and the job's own seed allow it. The memo
      // keeps it to one attempt per chain per slice; the service keeps it to
      // one discovery per chain and host overall.
      const chainKey = job && String(job.chainId || job._id);
      if (
        wasIndexed &&
        config.crawler.sitemaps &&
        job &&
        job.sitemaps === true &&
        !sitemapTried.has(chainKey) &&
        sitemapHostAllowed(job, host)
      ) {
        sitemapTried.add(chainKey);
        await discoverSitemaps(job, host, delayMs);
      }
    } else if (result.outcome === 'redirect') {
      // Redirected to another host: nothing was fetched there. The target is
      // handled as a discovery, and this URL cost the job no page.
      summary.skipped += 1;
      const plan = planRedirect({ claimed, job, redirectTo: result.redirectTo });
      note(plan.reason);
      // Set when the URL is given up on here, so the job counts it as a
      // failed page now rather than only when it closes.
      let abandoned = false;

      if (plan.action === 'rehome' && (await frontier.rehome(claimed._id, plan.url))) {
        logger.debug('Frontier row moved to its redirect target', {
          from: claimed.url,
          to: plan.url
        });
      } else if (plan.action === 'fail') {
        await frontier.markFailed(claimed.url, {
          reason: plan.reason,
          statusCode: result.statusCode,
          retryable: false
        });
        abandoned = true;
      } else {
        await frontier.markSkipped(claimed.url, plan.reason);
        if (plan.action === 'enqueue') {
          const { added } = await frontier.addUrls(plan.entries, { crawlJobId: job._id });
          if (added > 0) {
            await CrawlJob.updateOne({ _id: job._id }, { $inc: { pagesDiscovered: added } });
          }
        }
      }
      await releaseBudget(job && job._id, { failed: abandoned });
    } else if (result.outcome === 'skipped') {
      summary.skipped += 1;
      note(result.reason);
      await frontier.markSkipped(claimed.url, result.reason);
      await releaseBudget(job && job._id);
      if (job && result.reason === 'robots_txt') {
        await CrawlJob.updateOne({ _id: job._id }, { $inc: { skippedByRobots: 1 } });
      }
    } else {
      summary.failed += 1;
      note(result.reason);
      const { retrying } = await frontier.markFailed(claimed.url, {
        reason: result.reason,
        statusCode: result.statusCode,
        retryable: result.retryable !== false,
        retryAfterMs: result.retryAfterMs
      });
      // A URL counts as a failed page once, when it is given up on — not
      // once per attempt.
      await releaseBudget(job && job._id, { failed: !retrying });
      hostBackoffMs = Number(result.hostBackoffMs) || 0;
    }

    // The host said it is overloaded, or its robots.txt cannot be read. The
    // slice ends here; what is left waits for the next one, which the queue
    // starts no sooner than the host asked.
    if (hostBackoffMs > 0) {
      summary.delayMs = Math.max(summary.delayMs, hostBackoffMs);
      summary.hostBackoff = result.reason;
      logger.warn('Host asked for a pause; slice ended early', {
        host,
        reason: result.reason,
        statusCode: result.statusCode,
        backoffMs: summary.delayMs
      });
      break;
    }

    // Politeness. A URL robots.txt refused cost no request, so it needs no
    // delay — but anything that reached the host does, a failed fetch
    // included: a host that is timing out should not be hammered.
    const requested = !(result.outcome === 'skipped' && result.reason === 'robots_txt');
    if (delayMs > 0 && requested && i < slice - 1) {
      await sleep(delayMs);
    }
  }

  // Is there more for this host? Decides whether the queue job re-enqueues
  // itself. A read, not a claim — claiming here would burn an attempt on a
  // URL this slice is not going to fetch.
  summary.hasMore = await frontier.hasPendingWork(host, { excludeJobIds: excluded() });

  if (summary.processed > 0 || summary.deferred > 0) {
    logger.info('Host slice finished', {
      host,
      processed: summary.processed,
      indexed: summary.indexed,
      failed: summary.failed,
      skipped: summary.skipped,
      ...(summary.deferred > 0 ? { deferred: summary.deferred } : {}),
      ...(Object.keys(summary.reasons).length > 0 ? { reasons: summary.reasons } : {}),
      hasMore: summary.hasMore
    });
  }

  return summary;
}

module.exports = {
  processHost,
  crawlOne,
  linksInScope,
  planRedirect,
  reserveBudget,
  releaseBudget
};
