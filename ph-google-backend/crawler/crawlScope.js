const { isSameDomain } = require('./linkExtractor');
const { hostnameOf } = require('../utils/urlNormalizer');
const { config } = require('../config/env');

/**
 * Which discovered links a crawl may follow.
 *
 * Shared by the queue worker and the single-process `startCrawler`, so the
 * two cannot disagree about where a crawl is allowed to go.
 *
 * The rules, in order:
 *
 *   1. `allowedDomains`, when set, is the whole domain policy: a link must be
 *      on one of those domains or a subdomain of one. This is how a seed says
 *      "stay on en.wikipedia.org" explicitly instead of relying on its host.
 *   2. Otherwise `sameDomainOnly` keeps the crawl on the seed's own host —
 *      the behaviour every crawl had before seed catalogs existed.
 *   3. Otherwise any host is allowed. Only an administrator's explicit
 *      `sameDomainOnly: false` gets here.
 *   4. Whatever passed, a link matching any `excludePatterns` entry is
 *      dropped. That is how talk pages, edit links and login screens are
 *      kept out without writing site-specific code.
 */

/** Compiled patterns, keyed by source text. Patterns come from config, so the set is small. */
const patternCache = new Map();

/**
 * Compiles an exclude pattern, throwing a readable error for a bad one.
 * Patterns are matched case-insensitively against the full URL.
 */
function compilePattern(source) {
  if (patternCache.has(source)) return patternCache.get(source);
  let compiled;
  try {
    compiled = new RegExp(source, 'i');
  } catch (error) {
    throw new Error(`Invalid exclude pattern "${source}": ${error.message}`);
  }
  patternCache.set(source, compiled);
  return compiled;
}

/** Lowercase host without a leading "www.". */
function bareHost(host) {
  return String(host || '')
    .toLowerCase()
    .replace(/^www\./, '');
}

/** True when `url` is on `domain` or one of its subdomains. */
function isOnDomain(url, domain) {
  const host = bareHost(hostnameOf(url));
  const wanted = bareHost(domain);
  if (!host || !wanted) return false;
  return host === wanted || host.endsWith(`.${wanted}`);
}

/**
 * @param {string} url
 * @param {Object} scope
 * @param {string} scope.seedUrl
 * @param {boolean} [scope.sameDomainOnly=true]
 * @param {string[]} [scope.allowedDomains]
 * @param {string[]} [scope.excludePatterns]
 * @returns {boolean}
 */
function isInScope(url, scope = {}) {
  const { seedUrl, sameDomainOnly = true, allowedDomains = [], excludePatterns = [] } = scope;

  if (Array.isArray(allowedDomains) && allowedDomains.length > 0) {
    if (!allowedDomains.some(domain => isOnDomain(url, domain))) return false;
  } else if (sameDomainOnly && !isSameDomain(url, seedUrl)) {
    return false;
  }

  if (Array.isArray(excludePatterns)) {
    for (const pattern of excludePatterns) {
      if (compilePattern(pattern).test(url)) return false;
    }
  }

  return true;
}

/**
 * Filters a page's links to those the crawl may follow, capped at
 * `maxLinksPerPage` so one link-heavy page cannot flood the frontier.
 * Links keep their document order, so the cap keeps the first ones — on an
 * article, the body links rather than the footer.
 *
 * @returns {string[]}
 */
function filterLinks(links, scope, { maxLinks = config.crawler.maxLinksPerPage } = {}) {
  const limit = Math.max(0, Number(maxLinks) || 0);
  const kept = [];
  for (const link of links || []) {
    if (kept.length >= limit) break;
    if (isInScope(link, scope)) kept.push(link);
  }
  return kept;
}

module.exports = { isInScope, filterLinks, isOnDomain, compilePattern };
