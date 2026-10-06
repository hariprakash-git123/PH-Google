const { isAllowed, checkAccess, getCrawlDelayMs, ROBOTS_CACHE_TTL_MS } = require('./robotsChecker');
const { config } = require('../config/env');

/**
 * What a given host will tolerate: may we fetch this URL, and how long must
 * we wait between requests.
 *
 * Both answers were previously worked out inline in the crawl loop. They are
 * here instead because two callers now need them — the single-process
 * `startCrawler` used by scripts, and the queue worker — and politeness rules
 * that disagree between two code paths are worse than no rules at all.
 *
 * Delays are cached per host. A crawl of 50 pages on one site should cost one
 * robots.txt fetch, not fifty. A cached delay lasts as long as the robots.txt
 * it was read from, so a changed Crawl-delay is picked up with it.
 */

/** host -> { declared: the host's Crawl-delay in ms or null, expiresAt } */
const delayCache = new Map();

/**
 * The delay to leave between two requests to this host.
 *
 * A site's Crawl-delay is a floor, never something a crawl may go under:
 *
 *   - with a per-job delay, the longer of that and the host's Crawl-delay —
 *     a job may ask to be slower than a site requires, not faster;
 *   - without one, the host's Crawl-delay, or our default when it has none.
 *
 * Everything is clamped to `CRAWLER_MAX_DELAY_MS` so one site declaring
 * `Crawl-delay: 86400` cannot park a worker for a day.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {number} [options.overrideMs]      explicit per-job delay
 * @param {boolean} [options.respectRobots=true]
 * @returns {Promise<number>} milliseconds
 */
async function resolveDelayMs(url, { overrideMs, respectRobots = true } = {}) {
  const override = Number(overrideMs);
  const hasOverride = Number.isFinite(override) && override >= 0;
  const clamp = ms => Math.min(Math.max(0, ms), config.crawler.maxDelayMs);

  const declared = respectRobots ? await declaredDelayMs(url) : null;

  if (hasOverride) return clamp(declared === null ? override : Math.max(override, declared));
  return clamp(declared === null ? config.crawler.defaultDelayMs : declared);
}

/**
 * The Crawl-delay a URL's host declares, in ms, or null when it declares
 * none (or the URL has no host). Cached per host.
 */
async function declaredDelayMs(url) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }

  const cached = delayCache.get(host);
  if (cached && cached.expiresAt > Date.now()) return cached.declared;

  const declared = await getCrawlDelayMs(url);
  delayCache.set(host, { declared, expiresAt: Date.now() + ROBOTS_CACHE_TTL_MS });
  return declared;
}

/**
 * @returns {Promise<boolean>} whether robots.txt permits fetching this URL
 */
async function mayFetch(url, { respectRobots = true } = {}) {
  if (!respectRobots) return true;
  return isAllowed(url);
}

/**
 * robots.txt's answer for a URL, keeping "refused" apart from "robots.txt
 * could not be read": the first is final, the second is worth asking again.
 *
 * @returns {Promise<'allowed'|'disallowed'|'unavailable'>}
 */
async function fetchAccess(url, { respectRobots = true } = {}) {
  if (!respectRobots) return 'allowed';
  return checkAccess(url);
}

/** Clears the delay cache. Used between test cases. */
function clearHostPolicyCache() {
  delayCache.clear();
}

module.exports = { resolveDelayMs, mayFetch, fetchAccess, clearHostPolicyCache };
