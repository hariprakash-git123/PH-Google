const cheerio = require('cheerio');
const { config } = require('../config/env');
const { normalizeUrl, canonicalKey } = require('../utils/urlNormalizer');

/**
 * What a fetched page says about itself: whether it may be indexed, whether
 * its links may be followed, and which URL it considers its own.
 *
 * robots.txt answers "may this URL be fetched"; these answer what may be done
 * with the page once it has been. They arrive two ways — in the markup and in
 * response headers — and both are read here.
 */

/** The product token sites address this crawler by: "ph-searchbot". */
function botToken(userAgent = config.crawler.userAgent) {
  return String(userAgent || '')
    .split(/[/\s]/)[0]
    .trim()
    .toLowerCase();
}

/** Applies one comma-separated list of robots directives to `state`. */
function applyDirectives(text, state) {
  for (const raw of String(text || '').split(',')) {
    const directive = raw.trim().toLowerCase();
    if (directive === 'noindex') state.index = false;
    else if (directive === 'nofollow') state.follow = false;
    else if (directive === 'none') {
      state.index = false;
      state.follow = false;
    }
    // index, follow, all, noarchive, nosnippet, max-snippet, ...: nothing to do.
  }
}

/**
 * The directives one X-Robots-Tag value holds for this crawler.
 *
 * A value is either plain directives ("noindex, nofollow"), which apply to
 * every crawler, or starts with a crawler's name ("googlebot: noindex"), in
 * which case the whole value applies to that crawler alone.
 */
function headerDirectivesFor(value, token) {
  const text = String(value || '').trim();
  const named = /^([a-z0-9_-]+)\s*:\s*(.*)$/i.exec(text);
  // "unavailable_after: <date>" is a directive with a colon, not a crawler.
  if (!named || named[1].toLowerCase() === 'unavailable_after') return text;
  return named[1].toLowerCase() === token ? named[2] : '';
}

/**
 * Reads the indexing and link-following policy of a page.
 *
 * Sources: every `X-Robots-Tag` response header, `<meta name="robots">`, and
 * `<meta name="<our bot token>">`. Any one of them saying no is a no — the
 * most restrictive answer wins, as it does for every major crawler.
 *
 * `index` and `follow` are independent: a `noindex` page may still have its
 * links followed, and a `nofollow` page may still be indexed.
 *
 * @param {string} html
 * @param {Object} [headers] response headers, lowercase names
 * @returns {{index: boolean, follow: boolean}}
 */
function readRobotsDirectives(html, headers = {}) {
  const state = { index: true, follow: true };
  const token = botToken();

  const header = headers && headers['x-robots-tag'];
  if (header) {
    // Several headers arrive either as an array or joined with commas; a
    // crawler-specific value is only recognisable while it is still whole.
    const values = Array.isArray(header) ? header : [header];
    for (const value of values) applyDirectives(headerDirectivesFor(value, token), state);
  }

  if (html) {
    try {
      const $ = cheerio.load(html);
      $('meta[name]').each((_, element) => {
        const name = String($(element).attr('name') || '')
          .trim()
          .toLowerCase();
        if (name === 'robots' || (token && name === token)) {
          applyDirectives($(element).attr('content'), state);
        }
      });
    } catch {
      /* unparseable markup carries no directives */
    }
  }

  return state;
}

/** The targets of `Link: <...>; rel="canonical"` response headers. */
function canonicalFromLinkHeader(header) {
  const found = [];
  const values = Array.isArray(header) ? header : [header];
  for (const value of values) {
    const pattern = /<([^>]*)>\s*((?:;\s*[^;,]+)*)/g;
    let match;
    while ((match = pattern.exec(String(value || ''))) !== null) {
      if (/;\s*rel\s*=\s*"?[^";]*\bcanonical\b/i.test(match[2])) found.push(match[1]);
    }
  }
  return found;
}

/**
 * The URL a page declares as its canonical address, or null.
 *
 * Read from `<link rel="canonical">` and the `Link` response header, resolved
 * against the page's URL (or its `<base href>`), then normalised. It is a
 * hint and is treated as one:
 *
 *   - anything that is not a usable http(s) URL is ignored;
 *   - the same address given twice counts once;
 *   - two declarations that disagree are ignored altogether, because there
 *     is no telling which the author meant.
 *
 * Nothing here decides whether the canonical is *allowed* — that is the
 * crawl scope's job, and the caller applies it.
 *
 * @param {string} html
 * @param {string} pageUrl  the URL the HTML was fetched from
 * @param {Object} [headers] response headers, lowercase names
 * @returns {string|null}
 */
function extractCanonical(html, pageUrl, headers = {}) {
  if (!pageUrl) return null;

  const hrefs = [];
  let base = pageUrl;

  if (html) {
    try {
      const $ = cheerio.load(html);
      const declaredBase = $('base[href]').first().attr('href');
      if (declaredBase) {
        try {
          base = new URL(declaredBase, pageUrl).toString();
        } catch {
          /* malformed <base>; resolve against the page URL */
        }
      }
      $('link[rel][href]').each((_, element) => {
        const rel = String($(element).attr('rel') || '')
          .toLowerCase()
          .split(/\s+/);
        if (rel.includes('canonical')) hrefs.push({ href: $(element).attr('href'), base });
      });
    } catch {
      /* unparseable markup declares no canonical */
    }
  }

  if (headers && headers.link) {
    // A header is resolved against the page URL: <base> is markup's business.
    for (const href of canonicalFromLinkHeader(headers.link)) hrefs.push({ href, base: pageUrl });
  }

  const byKey = new Map();
  for (const { href, base: resolveAgainst } of hrefs) {
    const trimmed = String(href || '').trim();
    if (!trimmed) continue;
    let absolute;
    try {
      absolute = new URL(trimmed, resolveAgainst).toString();
    } catch {
      continue;
    }
    const normalized = normalizeUrl(absolute);
    const key = normalized && canonicalKey(normalized);
    if (key && !byKey.has(key)) byKey.set(key, normalized);
  }

  return byKey.size === 1 ? byKey.values().next().value : null;
}

module.exports = { readRobotsDirectives, extractCanonical, botToken };
