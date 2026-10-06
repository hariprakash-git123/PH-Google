const axios = require('axios');
const { config } = require('../config/env');
const { readCapped, discard, decodeHtml } = require('./httpBody');
const logger = require('../utils/logger');

// Refuse to buffer pages larger than this (CRAWLER_MAX_PAGE_BYTES, 5 MB default).
const MAX_BYTES = config.crawler.maxPageBytes;

// Redirect hops followed for one page, all on the host it was asked of.
const MAX_REDIRECTS = 5;

// The longest a host can ask us to stay away through Retry-After.
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)$/i;

/** The media type of a Content-Type header, without its parameters. */
function mediaType(contentType) {
  return String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

/**
 * Whether an HTTP error status is worth another attempt later.
 *
 * A server that is overloaded or briefly broken (408, 425, 429, 5xx) may
 * answer next time. A 404, a 403 or any other 4xx is the site's answer about
 * this URL, and asking again only costs it requests.
 */
function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Retry-After as milliseconds — the header is either a number of seconds or
 * an HTTP date. Null when absent or unreadable; capped at an hour.
 */
function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  let ms;
  if (/^\d+$/.test(text)) {
    ms = Number(text) * 1000;
  } else {
    const at = Date.parse(text);
    if (Number.isNaN(at)) return null;
    ms = at - now;
  }
  return Math.min(Math.max(0, ms), MAX_RETRY_AFTER_MS);
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The response headers a page's own directives are read from.
 *
 * Node joins repeated headers into one comma-separated string, and a
 * crawler-specific `X-Robots-Tag: otherbot: noindex` is only recognisable
 * while it is still a value of its own — so that header is taken from the
 * raw header list, one entry per header as the server sent it.
 */
function pageHeaders(response) {
  const headers = { ...(response.headers || {}) };
  const raw = response.request && response.request.res && response.request.res.rawHeaders;
  if (Array.isArray(raw)) {
    const tags = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (String(raw[i]).toLowerCase() === 'x-robots-tag') tags.push(String(raw[i + 1]));
    }
    if (tags.length > 0) headers['x-robots-tag'] = tags;
  }
  return headers;
}

/**
 * Downloads one page.
 *
 * Returns a result object rather than throwing, so the crawl loop can record
 * *why* a URL failed (timeout, HTTP error, wrong content type, too large)
 * instead of treating every failure identically. Every failure says whether
 * it is `retryable`.
 *
 * Redirects are followed here, one hop at a time, rather than by the HTTP
 * client, because each hop is a decision:
 *
 *   - a hop to another host is not followed. That would be a request to a
 *     site whose queue slot, crawl delay and robots.txt this fetch does not
 *     hold; it is reported as `cross_host_redirect` with the target, and the
 *     caller decides whether that URL belongs in the frontier;
 *   - a hop on the same host is followed only if `allowHop` permits it, which
 *     is how robots.txt and the crawl's scope apply to where a redirect leads;
 *   - the chain ends after MAX_REDIRECTS hops, or as soon as it revisits a
 *     URL.
 *
 * The body is read only once the status and Content-Type say it is an HTML
 * page, so a PDF or a video costs its headers and nothing more.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {(url: string) => Promise<true|string>} [options.allowHop] resolves
 *   to true to follow a same-host hop, or to the name of what refused it
 * @returns {Promise<{ok: boolean, html?: string, status?: number,
 *   finalUrl?: string, contentType?: string, headers?: Object,
 *   redirects?: string[], reason?: string, error?: string,
 *   retryable?: boolean, retryAfterMs?: number|null, redirectTo?: string}>}
 */
async function fetchPageDetailed(url, { allowHop } = {}) {
  const redirects = [];
  const visited = new Set();
  let current = url;

  try {
    for (;;) {
      // Exact URLs, not canonical keys: http -> https on one host is a real
      // hop to a different address, not a loop.
      visited.add(current);

      const response = await axios.get(current, {
        timeout: config.crawler.requestTimeoutMs,
        maxRedirects: 0,
        responseType: 'stream',
        decompress: true,
        headers: {
          'User-Agent': config.crawler.userAgent,
          Accept: 'text/html,application/xhtml+xml'
        },
        // Inspect the status ourselves so 404s are a recorded outcome.
        validateStatus: () => true
      });

      const status = response.status;
      const headers = response.headers || {};
      const contentType = String(headers['content-type'] || '');
      const base = { status, finalUrl: current, redirects };

      // --- redirect ---------------------------------------------------
      if (status >= 300 && status < 400 && status !== 304) {
        discard(response.data);

        let target;
        try {
          target = new URL(String(headers.location || ''), current);
        } catch {
          target = null;
        }
        if (!headers.location || !target || !/^https?:$/.test(target.protocol)) {
          return { ok: false, ...base, reason: 'invalid_redirect', retryable: false };
        }
        target.hash = '';
        const next = target.toString();

        if (hostnameOf(next) !== hostnameOf(current)) {
          return {
            ok: false,
            ...base,
            reason: 'cross_host_redirect',
            redirectTo: next,
            retryable: false
          };
        }
        if (visited.has(next)) {
          return { ok: false, ...base, reason: 'redirect_loop', retryable: false };
        }
        if (redirects.length >= MAX_REDIRECTS) {
          return { ok: false, ...base, reason: 'too_many_redirects', retryable: false };
        }
        // Asked before the hop is made, so a refused target is never requested.
        const verdict = allowHop ? await allowHop(next) : true;
        if (verdict !== true) {
          return {
            ok: false,
            ...base,
            reason: 'redirect_disallowed',
            blockedBy: typeof verdict === 'string' ? verdict : 'refused',
            redirectTo: next,
            retryable: false
          };
        }

        redirects.push(next);
        current = next;
        continue;
      }

      // --- error status -----------------------------------------------
      if (status >= 400 || status === 304) {
        discard(response.data);
        const retryable = isRetryableStatus(status);
        return {
          ok: false,
          ...base,
          reason: 'http_error',
          error: `HTTP ${status}`,
          retryable,
          retryAfterMs: retryable ? parseRetryAfter(headers['retry-after']) : null
        };
      }

      // --- not a page ---------------------------------------------------
      // Decided from the headers: nothing of the body has been read yet.
      if (!HTML_TYPE.test(mediaType(contentType))) {
        discard(response.data);
        return {
          ok: false,
          ...base,
          contentType,
          reason: 'unsupported_content_type',
          retryable: false
        };
      }

      const declared = Number(headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        discard(response.data);
        return { ok: false, ...base, contentType, reason: 'too_large', retryable: false };
      }

      const body = await readCapped(response.data, MAX_BYTES, {
        timeoutMs: config.crawler.requestTimeoutMs
      });
      if (body.tooLarge) {
        return { ok: false, ...base, contentType, reason: 'too_large', retryable: false };
      }

      const html = decodeHtml(body.buffer, contentType);
      if (!html.trim()) {
        return { ok: false, ...base, contentType, reason: 'empty_body', retryable: false };
      }

      return { ok: true, html, ...base, contentType, headers: pageHeaders(response) };
    }
  } catch (error) {
    const reason =
      error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'
        ? 'timeout'
        : error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN'
          ? 'dns_error'
          : 'network_error';

    logger.debug('Page fetch failed', { url: current, reason, message: error.message });
    // A timeout, a reset connection or a failed lookup may all clear.
    return {
      ok: false,
      finalUrl: current,
      redirects,
      reason,
      error: error.message,
      retryable: true
    };
  }
}

/**
 * Backwards-compatible wrapper kept for existing callers/scripts:
 * returns the HTML string, or null on any failure.
 */
async function fetchPage(url) {
  const result = await fetchPageDetailed(url);
  return result.ok ? result.html : null;
}

module.exports = {
  fetchPage,
  fetchPageDetailed,
  isRetryableStatus,
  parseRetryAfter,
  MAX_BYTES,
  MAX_REDIRECTS
};
