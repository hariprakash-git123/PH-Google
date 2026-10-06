const zlib = require('zlib');
const { promisify } = require('util');
const axios = require('axios');
const { config } = require('../config/env');
const logger = require('../utils/logger');

const gunzip = promisify(zlib.gunzip);

/**
 * Downloads one sitemap file.
 *
 * Separate from pageFetcher rather than an option on it: a page fetch wants
 * HTML and refuses everything else, a sitemap fetch wants XML — possibly
 * gzipped — and must refuse HTML. Politeness settings are shared: the same
 * user agent, timeout and redirect limit.
 *
 * Bounded in every direction, because a sitemap is a document a site hands
 * us in the hope that we will do a lot of work:
 *
 *   - size: CRAWLER_SITEMAP_MAX_BYTES as downloaded (Content-Encoding is
 *     decoded while streaming, so this also bounds a compressed transfer)
 *     and again after gunzipping a .xml.gz file, so a small file cannot
 *     expand into a large one;
 *   - time: CRAWLER_TIMEOUT_MS for the whole request, not just between
 *     packets, so a server dripping a byte a second cannot hold a slot;
 *   - place: a redirect to another host is refused *before* it is followed.
 *     A sitemap is fetched for one host, inside that host's crawl slot; a
 *     redirect elsewhere would be a request to a site we hold no slot for —
 *     or, from a hostile robots.txt, to an internal address.
 *
 * Returns a result object rather than throwing, like fetchPageDetailed.
 *
 * @returns {Promise<{ok: boolean, body?: string, status?: number,
 *                    finalUrl?: string, contentType?: string,
 *                    compressed?: boolean, reason?: string, error?: string}>}
 */

const MAX_REDIRECTS = 5; // the same limit pageFetcher follows

const XML_TYPE = /(^|[/+])xml\b/i; // application/xml, text/xml, application/rss+xml
const TEXT_TYPE = /^text\/plain\b/i;
const GZIP_TYPE = /^application\/(x-)?(gzip|gunzip|gzip-compressed)\b/i;
const OCTET_TYPE = /^application\/octet-stream\b/i;
const HTML_TYPE = /^(text\/html|application\/xhtml\+xml)\b/i;

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isGzip(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

async function fetchSitemap(url) {
  const host = hostnameOf(url);
  if (!host) return { ok: false, reason: 'invalid_url', error: 'Not a valid URL' };

  const maxBytes = config.crawler.sitemapMaxBytes;
  const timeoutMs = config.crawler.requestTimeoutMs;
  // Set by the redirect hook. The error it throws reaches us wrapped by
  // follow-redirects, so the refusal is recorded here rather than read back
  // out of the error.
  let refusedRedirect = null;

  let response;
  try {
    response = await axios.get(url, {
      timeout: timeoutMs,
      // Whole-request deadline; `timeout` alone resets on every packet.
      signal: AbortSignal.timeout(timeoutMs),
      maxRedirects: MAX_REDIRECTS,
      // Runs before each redirect is followed; throwing aborts it.
      beforeRedirect: options => {
        const target = String(options.hostname || '').toLowerCase();
        if (target !== host) {
          refusedRedirect = options.href || target;
          throw new Error(`Redirect to another host refused: ${refusedRedirect}`);
        }
      },
      maxContentLength: maxBytes,
      responseType: 'arraybuffer',
      decompress: true,
      headers: {
        'User-Agent': config.crawler.userAgent,
        Accept: 'application/xml, text/xml;q=0.9, application/x-gzip;q=0.8, */*;q=0.1'
      },
      validateStatus: () => true
    });
  } catch (error) {
    if (refusedRedirect) {
      logger.debug('Sitemap redirect to another host refused', { url, target: refusedRedirect });
      return {
        ok: false,
        finalUrl: refusedRedirect,
        reason: 'cross_host_redirect',
        error: 'Redirect to another host refused'
      };
    }
    return failure(url, error);
  }

  const status = response.status;
  const finalUrl =
    (response.request && response.request.res && response.request.res.responseUrl) || url;
  const contentType = String(response.headers['content-type'] || '');

  // Belt and braces: the redirect hook should already have refused this.
  if (hostnameOf(finalUrl) !== host) {
    return { ok: false, status, finalUrl, reason: 'cross_host_redirect' };
  }

  if (status >= 400) {
    return { ok: false, status, finalUrl, reason: 'http_error', error: `HTTP ${status}` };
  }

  let raw = Buffer.from(response.data || []);
  if (raw.length === 0) {
    return { ok: false, status, finalUrl, contentType, reason: 'empty_body' };
  }

  // A .xml.gz file arrives as gzip bytes under whatever Content-Type the
  // server picks, so the bytes decide that case. Otherwise the type must be
  // XML or plain text — or, for servers that label everything generically,
  // untyped, octet-stream or gzip with a body that is already XML (a gzip
  // Content-Encoding is decoded in transit). HTML is never a sitemap.
  const compressed = isGzip(raw);
  // Skip a UTF-8 byte-order mark (EF BB BF) before looking for the first tag.
  const start = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;
  const looksLikeXml = raw.toString('utf8', start, start + 64).trimStart()[0] === '<';
  const acceptable =
    !HTML_TYPE.test(contentType) &&
    (compressed ||
      XML_TYPE.test(contentType) ||
      TEXT_TYPE.test(contentType) ||
      ((contentType === '' || OCTET_TYPE.test(contentType) || GZIP_TYPE.test(contentType)) &&
        looksLikeXml));
  if (!acceptable) {
    return { ok: false, status, finalUrl, contentType, reason: 'unsupported_content_type' };
  }

  if (compressed) {
    try {
      // maxOutputLength stops a small file expanding into a huge one: zlib
      // gives up at the limit instead of allocating the whole result.
      raw = await gunzip(raw, { maxOutputLength: maxBytes });
    } catch (error) {
      const tooLarge = error.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError;
      return {
        ok: false,
        status,
        finalUrl,
        contentType,
        reason: tooLarge ? 'too_large' : 'invalid_gzip',
        error: error.message
      };
    }
  }

  return { ok: true, body: raw.toString('utf8'), status, finalUrl, contentType, compressed };
}

/** Maps a thrown request error to a recorded reason. */
function failure(url, error) {
  let reason;
  if (
    error.code === 'ECONNABORTED' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'ERR_CANCELED' ||
    error.name === 'CanceledError' ||
    error.name === 'TimeoutError'
  ) {
    reason = 'timeout';
  } else if (/maxContentLength/i.test(String(error.message))) {
    reason = 'too_large';
  } else if (error.code === 'ERR_FR_TOO_MANY_REDIRECTS') {
    reason = 'too_many_redirects';
  } else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
    reason = 'dns_error';
  } else {
    reason = 'network_error';
  }

  logger.debug('Sitemap fetch failed', { url, reason, message: error.message });
  return { ok: false, reason, error: String(error.message).slice(0, 200) };
}

module.exports = { fetchSitemap };
