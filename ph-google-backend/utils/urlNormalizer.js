/**
 * Canonical URL form used everywhere a URL identifies a page: the crawl
 * frontier's duplicate check and the `url` stored on a Page.
 *
 * Both must agree, otherwise the same page can be stored twice — once as
 * "https://site.com" and once as "https://site.com/".
 *
 * Rules:
 *  - http/https only
 *  - lowercase hostname
 *  - drop the fragment
 *  - drop a default port (:80 for http, :443 for https)
 *  - drop a trailing slash, including on the root path
 *  - keep the query string, which identifies a distinct page
 */
function normalizeUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;

  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();

  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = '';
  }

  let clean = parsed.toString();
  // "https://site.com/about/", "https://site.com/about" and
  // "https://site.com/" all canonicalise without the trailing slash.
  if (clean.endsWith('/') && !parsed.search) {
    clean = clean.slice(0, -1);
  }
  return clean;
}

/** The hostname of a URL in lowercase, or '' when it cannot be parsed. */
function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Query parameters that identify a marketing campaign or a click, never a
 * distinct page. Two URLs differing only by these are the same document.
 */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_source_platform',
  'utm_creative_format',
  'utm_marketing_tactic',
  'gclid',
  'gclsrc',
  'dclid',
  'fbclid',
  'msclkid',
  'twclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'yclid',
  '_ga',
  '_gl',
  'ref',
  'referrer',
  'source',
  'campaign',
  'cmpid',
  'cid',
  'ncid',
  'spm',
  'scm',
  'share',
  'share_id',
  'feature',
  'at_medium',
  'at_campaign',
  'sr_share',
  'wtmc'
]);

/**
 * The deduplication key for a page.
 *
 * Collapses the variants a crawler inevitably discovers for one document:
 *
 *   http://example.com/page          }
 *   https://example.com/page         }  all the same
 *   https://www.example.com/page/    }  document
 *   https://example.com/page?utm_source=x
 *
 * Scheme is dropped (http and https serve the same page), "www." is dropped,
 * the host is lowercased, tracking parameters are removed, the remaining
 * parameters are sorted so order does not matter, and the trailing slash and
 * fragment go.
 *
 * This is a *key*, not a displayable URL — use normalizeUrl for that.
 *
 * @returns {string|null} e.g. "example.com/page?q=1", or null when invalid
 */
function canonicalKey(url) {
  if (typeof url !== 'string' || !url.trim()) return null;

  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

  // Keep only meaningful query parameters, in a stable order.
  const params = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) continue;
    params.push([key, value]);
  }
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const query = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';

  let path = parsed.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '/') path = '';

  return `${host}${path}${query}`;
}

/**
 * The registrable-ish root domain: "blog.example.co.uk" -> "example.co.uk".
 *
 * Uses a small list of multi-part public suffixes rather than bundling the
 * full Public Suffix List, which would be disproportionate here. Getting an
 * unusual suffix slightly wrong only affects site-level grouping.
 */
const MULTI_PART_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'net.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'co.in',
  'net.in',
  'org.in',
  'gov.in',
  'ac.in',
  'edu.in',
  'co.jp',
  'or.jp',
  'ne.jp',
  'ac.jp',
  'go.jp',
  'com.br',
  'com.cn',
  'com.mx',
  'com.tr',
  'com.sg',
  'com.hk',
  'co.nz',
  'co.za',
  'co.kr',
  'com.ar',
  'com.pk'
]);

function rootDomainOf(url) {
  const host = hostnameOf(url);
  if (!host) return '';

  // An IP address has no registrable domain.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return host;

  const parts = host.replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');

  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

/** The path portion of a URL, or '' when it cannot be parsed. */
function pathOf(url) {
  try {
    return new URL(url).pathname || '';
  } catch {
    return '';
  }
}

module.exports = {
  normalizeUrl,
  hostnameOf,
  canonicalKey,
  rootDomainOf,
  pathOf,
  TRACKING_PARAMS
};
