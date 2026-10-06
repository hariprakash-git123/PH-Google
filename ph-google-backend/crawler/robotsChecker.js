const robotsParser = require('robots-parser');
const axios = require('axios');
const { config } = require('../config/env');
const { readCapped, discard } = require('./httpBody');
const logger = require('../utils/logger');

/**
 * robots.txt gatekeeper.
 *
 * One robots.txt is fetched per host and cached, so a crawl of 50 pages on
 * one domain costs a single extra request. The rules follow RFC 9309:
 *
 *   - a robots.txt that was read is obeyed, and kept for a day — a worker
 *     that runs for weeks must notice when a site changes its mind;
 *   - no robots.txt (any 4xx) means there are no rules: everything is allowed;
 *   - a robots.txt that could not be reached — a 5xx, a 429, a timeout, a
 *     failed connection — means we do not know the rules, and must not guess
 *     that there are none. The host is `unavailable`: nothing is fetched, and
 *     the question is asked again a few minutes later.
 */

// How long a robots.txt that was read (or found absent) is trusted.
const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// How long "could not be reached" is remembered before asking again.
const ROBOTS_UNAVAILABLE_TTL_MS = 5 * 60 * 1000;
// RFC 9309 asks a crawler to read at least 500 KiB; the rest is ignored.
const ROBOTS_MAX_BYTES = 500 * 1024;

/** robots.txt URL -> { robots, available, expiresAt } */
const cache = new Map();

/** Fetches (or returns the cached) robots.txt entry for a URL's host. */
async function getEntry(url) {
  const parsed = new URL(url);
  const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;

  const cached = cache.get(robotsUrl);
  if (cached && cached.expiresAt > Date.now()) return cached;

  let body = '';
  let available = true;
  try {
    const response = await axios.get(robotsUrl, {
      timeout: 5000,
      maxRedirects: 3,
      responseType: 'stream',
      headers: { 'User-Agent': config.crawler.userAgent },
      // Statuses are sorted out below rather than thrown.
      validateStatus: () => true
    });

    const status = response.status;
    if (status >= 200 && status < 300) {
      const read = await readCapped(response.data, ROBOTS_MAX_BYTES, {
        truncate: true,
        timeoutMs: 5000
      });
      body = read.buffer.toString('utf8');
    } else {
      discard(response.data);
      // 5xx and 429: the site has rules and cannot tell us them right now.
      // Everything else — 404, 403, an unfollowed redirect — is "no rules".
      if (status >= 500 || status === 429) available = false;
    }
  } catch (err) {
    // Timeout, DNS failure, refused connection: unknown, not "allowed".
    logger.debug('robots.txt unreachable', { robotsUrl, reason: err.message });
    available = false;
  }

  const entry = {
    robots: robotsParser(robotsUrl, body),
    available,
    expiresAt: Date.now() + (available ? ROBOTS_CACHE_TTL_MS : ROBOTS_UNAVAILABLE_TTL_MS)
  };
  cache.set(robotsUrl, entry);
  return entry;
}

/**
 * What robots.txt says about fetching a URL.
 *
 * @returns {Promise<'allowed'|'disallowed'|'unavailable'>} `unavailable`
 *   when the host's robots.txt could not be read, so the answer is not known
 */
async function checkAccess(url, userAgent = config.crawler.userAgent) {
  try {
    const entry = await getEntry(url);
    if (!entry.available) return 'unavailable';
    // robots-parser returns undefined when no rule applies, meaning allowed.
    return entry.robots.isAllowed(url, userAgent) === false ? 'disallowed' : 'allowed';
  } catch (err) {
    logger.warn('robots.txt check failed', { url, reason: err.message });
    // An unparseable URL is not safe to crawl.
    return 'disallowed';
  }
}

/**
 * @returns {Promise<boolean>} true when our user agent may fetch this URL.
 *   False both when robots.txt refuses it and when robots.txt is unavailable;
 *   callers that must tell those apart use checkAccess.
 */
async function isAllowed(url, userAgent = config.crawler.userAgent) {
  return (await checkAccess(url, userAgent)) === 'allowed';
}

/**
 * Reads the Crawl-delay directive, in milliseconds, clamped to a sane range.
 * @returns {Promise<number|null>} null when the host declares no delay
 */
async function getCrawlDelayMs(url, userAgent = config.crawler.userAgent) {
  try {
    const { robots } = await getEntry(url);
    const seconds = robots.getCrawlDelay(userAgent);
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.min(seconds * 1000, config.crawler.maxDelayMs);
  } catch {
    return null;
  }
}

/**
 * The `Sitemap:` URLs a host's robots.txt lists, from the same cached parse
 * isAllowed uses — no extra request once the host's robots.txt is known.
 * Returned as written; the caller decides which it will fetch.
 *
 * @returns {Promise<string[]>} empty when there are none or robots.txt is unavailable
 */
async function getSitemapUrls(url) {
  try {
    const { robots } = await getEntry(url);
    return robots.getSitemaps() || [];
  } catch (err) {
    logger.debug('robots.txt sitemaps unavailable', { url, reason: err.message });
    return [];
  }
}

/** Clears the cache — used between test cases. */
function clearRobotsCache() {
  cache.clear();
}

module.exports = {
  isAllowed,
  checkAccess,
  getCrawlDelayMs,
  getSitemapUrls,
  clearRobotsCache,
  ROBOTS_CACHE_TTL_MS,
  ROBOTS_UNAVAILABLE_TTL_MS,
  ROBOTS_MAX_BYTES
};
