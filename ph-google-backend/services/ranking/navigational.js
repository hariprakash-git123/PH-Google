const OFFICIAL_SITES = require('../../config/officialSites');

/**
 * Navigational searches: a person who types "youtube" wants youtube.com.
 *
 * Relevance scoring cannot know that. A store page titled "YouTube - Apps on
 * Google Play" matches the word as well as the site itself does — better,
 * often — and a provider may well list it first. So when a search is
 * clearly the name of a site, and only then, the site's own pages are moved
 * to the top of the results already found. Nothing is added: if no official
 * page is among them, the order is left as it was.
 *
 * "Clearly" is deliberately narrow. The search must be one of a site's known
 * names (config/officialSites.js) and nothing else, apart from words that
 * only say "take me there" (official, website, login …), or a bare domain
 * the person typed ("github.com"). "youtube app download", "youtube premium
 * pricing" and "youtube tutorial" ask for something else and are untouched.
 *
 * A page is official by its address, never by its title: a page whose title
 * says "YouTube" on another site is not YouTube.
 */

/** Words that only ask to go to the site, and so keep a search navigational. */
const GO_THERE = new Set([
  'official',
  'site',
  'website',
  'web',
  'homepage',
  'home',
  'page',
  'login',
  'log',
  'in',
  'signin',
  'sign',
  'open',
  'com'
]);

/** A bare domain as typed: "github.com", "www.youtube.com". */
const DOMAIN =
  /^(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]{1,63})*\.[a-z]{2,24})$/;

const normalise = query =>
  String(query || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Whether a search is a clear request for one site, and which.
 *
 * @param {string} query  as typed
 * @returns {{name: string, sites: Array<{host: string, subdomains?: boolean,
 *            path?: string}>}|null}
 */
function detect(query) {
  const text = normalise(query);
  if (!text || text.length > 60) return null;

  // A domain typed on its own: its own pages are what is wanted.
  const typed = DOMAIN.exec(text);
  if (typed) {
    const host = typed[1];
    const listed = OFFICIAL_SITES.find(entry =>
      entry.sites.some(site => site.host === host && !site.path)
    );
    return listed
      ? { name: listed.names[0], sites: listed.sites }
      : { name: host, sites: [{ host }] };
  }

  // Otherwise the words, without punctuation and without "take me there" words.
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = words.filter(word => !GO_THERE.has(word)).join(' ');
  if (!meaningful) return null;
  const entry = OFFICIAL_SITES.find(site => site.names.includes(meaningful));
  return entry ? { name: entry.names[0], sites: entry.sites } : null;
}

/** The host of an http(s) address, lower case, without "www.". Null if not one. */
function hostOf(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Whether an address is one of the official sites. Decided by the host (and,
 * where a site is only part of a host, the path) — never by the title.
 */
function isOfficial(url, sites) {
  const host = hostOf(url);
  if (!host) return false;
  const path = new URL(String(url)).pathname.toLowerCase();
  return sites.some(site => {
    const onHost = host === site.host || (site.subdomains && host.endsWith(`.${site.host}`));
    if (!onHost) return false;
    if (!site.path) return true;
    return path === site.path || path.startsWith(`${site.path}/`);
  });
}

/** How far into a site a page is: the home page is 0. */
function depthOf(url) {
  try {
    return new URL(String(url)).pathname.split('/').filter(segment => /[\p{L}\p{N}]/u.test(segment))
      .length;
  } catch {
    return Infinity;
  }
}

/**
 * Moves the official site's pages to the top of results already found,
 * nearest its home page first; every other result keeps its order after
 * them. Nothing is added, removed or changed.
 *
 * @param {Array<{url: string}>} results
 * @param {{sites: Array}|null} intent  from detect
 * @returns {{results: Array, promoted: number}}
 */
function promoteOfficial(results, intent) {
  const list = Array.isArray(results) ? results : [];
  if (!intent) return { results: list, promoted: 0 };
  const official = [];
  const others = [];
  list.forEach((result, order) => {
    if (result && isOfficial(result.url, intent.sites)) official.push({ result, order });
    else others.push(result);
  });
  if (official.length === 0) return { results: list, promoted: 0 };
  official.sort((a, b) => depthOf(a.result.url) - depthOf(b.result.url) || a.order - b.order);
  return {
    results: [...official.map(entry => entry.result), ...others],
    promoted: official.length
  };
}

module.exports = { detect, isOfficial, promoteOfficial, depthOf, GO_THERE };
