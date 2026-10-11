const { resolvePublicAddress } = require('../utils/publicAddress');
const { requestOnce, parseImageUrl } = require('./imageDownloadService');

/**
 * Can a page be shown inside a frame on another site?
 *
 * The in-app browser tabs show a website in an <iframe>. A site may refuse
 * that (X-Frame-Options, or Content-Security-Policy `frame-ancestors`), and
 * a page cannot find out from inside the browser: a refused frame looks the
 * same to script as a loaded one. So the server reads the site's response
 * headers and says which it is; the tab then shows the page, or a notice
 * with a link to open it normally.
 *
 * This is not a proxy. Only the response headers are read — the body is
 * discarded unread — and nothing of the site reaches the caller except the
 * verdict. It follows the same rules as the image download: http(s) on the
 * default ports, public addresses only, the address checked is the address
 * connected to, and every redirect is checked again.
 */

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

const cache = new Map(); // "origin url" -> { at, verdict }

/** Whether one `frame-ancestors` source allows the page that is asking. */
function sourceAllows(source, origin) {
  const value = source.toLowerCase();
  if (value === '*') return true;
  if (!origin) return false;
  let asking;
  try {
    asking = new URL(origin);
  } catch {
    return false;
  }
  // A bare scheme: "https:".
  if (/^[a-z][a-z0-9+.-]*:$/.test(value)) return value === asking.protocol;
  // An exact origin. Wildcard hosts and paths are treated as not matching:
  // saying "blocked" for a page that would have loaded costs one click.
  return value.replace(/\/+$/, '') === asking.origin;
}

/**
 * Reads the two headers the way a browser does: `frame-ancestors` decides
 * when it is present (every policy that has one must allow), otherwise
 * X-Frame-Options does.
 *
 * @param {Object} headers  lower-cased response headers
 * @param {string} [origin]  the origin of the page that wants to frame it
 * @returns {{embeddable: boolean, reason?: string}}
 */
function readFramePolicy(headers, origin) {
  const csp = [].concat(headers['content-security-policy'] || []).join(',');
  const policies = csp
    .split(',')
    .map(policy =>
      policy
        .split(';')
        .map(d => d.trim().split(/\s+/))
        .find(d => d[0] && d[0].toLowerCase() === 'frame-ancestors')
    )
    .filter(Boolean);

  if (policies.length > 0) {
    const allowed = policies.every(directive =>
      directive.slice(1).some(source => sourceAllows(source, origin))
    );
    return allowed ? { embeddable: true } : { embeddable: false, reason: 'frame_ancestors' };
  }

  const xfo = [].concat(headers['x-frame-options'] || []).join(',');
  const values = xfo.split(',').map(v => v.trim().toLowerCase());
  if (values.includes('deny') || values.includes('sameorigin')) {
    return { embeddable: false, reason: 'x_frame_options' };
  }
  return { embeddable: true };
}

/**
 * @param {string} rawUrl
 * @param {Object} [options]
 * @param {string} [options.origin]    the asking page's origin
 * @param {Function} [options.lookup]   DNS lookup (tests)
 * @param {Function} [options.connect]  (url) => {host, port, protocol} (tests)
 * @returns {Promise<{embeddable: boolean|null, reason?: string}>}
 *          `null` when it could not be found out: the caller should just try.
 */
async function check(rawUrl, options = {}) {
  let url;
  try {
    url = parseImageUrl(rawUrl);
  } catch {
    return { embeddable: false, reason: 'invalid_url' };
  }

  const key = `${options.origin || ''} ${url.toString()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.verdict;

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let verdict = { embeddable: null, reason: 'unreachable' };

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const target = await resolvePublicAddress(url.hostname, options.lookup);
      if (!target) {
        verdict = { embeddable: false, reason: 'blocked_address' };
        break;
      }

      const response = await requestOnce(url, target, {
        signal: controller.signal,
        connect: options.connect ? options.connect(url) : null,
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8'
      });
      // Headers are all that is wanted: the body is never read.
      response.destroy();

      if (REDIRECTS.has(response.statusCode) && response.headers.location) {
        url = parseImageUrl(new URL(response.headers.location, url).toString());
        continue;
      }

      const policy = readFramePolicy(response.headers, options.origin);
      if (!policy.embeddable) verdict = policy;
      // A site may answer this server with an error and a browser with the
      // page, so an error status without a refusal is "don't know".
      else if (response.statusCode >= 400) verdict = { embeddable: null, reason: 'http_error' };
      else verdict = policy;
      break;
    }
  } catch {
    verdict = controller.signal.aborted
      ? { embeddable: null, reason: 'timeout' }
      : { embeddable: null, reason: 'unreachable' };
  } finally {
    clearTimeout(deadline);
  }

  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), verdict });
  return verdict;
}

/** Tests: forget every verdict. */
function reset() {
  cache.clear();
}

module.exports = { check, readFramePolicy, reset };
