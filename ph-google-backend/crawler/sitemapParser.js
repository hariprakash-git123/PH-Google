const { Parser } = require('htmlparser2');
const { config } = require('../config/env');

/**
 * Reads a sitemap: `<urlset>` (pages) or `<sitemapindex>` (more sitemaps).
 *
 * Incremental — the document is fed to a streaming parser in chunks and no
 * DOM is built — so a large file costs only the entries kept, and reading
 * stops as soon as `maxUrls` entries are found.
 *
 * What it deliberately does not do:
 *
 *   - Expand entities. htmlparser2 decodes the five XML entities (&amp; and
 *     friends) and ignores DTDs, so neither an entity bomb nor an external
 *     entity (XXE) can be expanded or fetched. A `<loc>` still containing an
 *     entity reference is one the parser declined to expand, and is rejected.
 *   - Validate URLs. It returns each `<loc>` as written, trimmed; deciding
 *     what may enter the frontier is the caller's job.
 *   - Read extensions. Only `<url>/<loc>`, `<url>/<lastmod>` and
 *     `<sitemap>/<loc>`, `<sitemap>/<lastmod>` in the sitemap namespace are
 *     read. `<image:loc>`, `<video:*>`, `<news:*>` and anything else are
 *     ignored, because they sit in other namespaces or deeper in the tree.
 *
 * It never throws. A document that is not a sitemap — an HTML error page
 * served with a 200, say — comes back with `type: null` and no entries.
 */

// Sitemap namespaces seen in the wild: the protocol's own (over http or
// https) and Google's pre-standard ones.
const SITEMAP_NAMESPACE = /^https?:\/\/www\.(sitemaps\.org|google\.com)\/schemas\/sitemap\//i;

// The protocol caps a <loc> at 2,048 characters.
const MAX_LOC_LENGTH = 2048;

// Fed to the parser in pieces this size, so reading can stop part way.
const CHUNK_CHARS = 64 * 1024;

// W3C Datetime, the format the protocol requires for <lastmod>: a year,
// year-month, date, or date and time with a timezone.
const W3C_DATETIME = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/;

// Anything later than this is a clock error or a site claiming freshness it
// does not have; either way it is not a usable date.
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;

// An entity reference left in text after decoding: one the parser did not
// expand, such as a DTD-declared entity.
const UNEXPANDED_ENTITY = /&[A-Za-z_][\w.-]*;|&#x?[0-9a-f]+;/i;

/**
 * A <lastmod> value as a Date, or null when it is missing, malformed or
 * implausibly far in the future.
 */
function parseLastmod(value, now = Date.now()) {
  const text = String(value || '').trim();
  if (!W3C_DATETIME.test(text)) return null;
  const date = new Date(text);
  const time = date.getTime();
  if (!Number.isFinite(time) || time > now + MAX_FUTURE_MS) return null;
  return date;
}

/** Splits "prefix:local" into its parts; an unprefixed name has prefix "". */
function splitName(name) {
  const colon = name.indexOf(':');
  return colon === -1
    ? { prefix: '', local: name }
    : { prefix: name.slice(0, colon), local: name.slice(colon + 1) };
}

/**
 * @param {string|Buffer} input the sitemap document
 * @param {Object} [options]
 * @param {number} [options.maxUrls] stop after this many entries
 * @returns {{type: 'urlset'|'sitemapindex'|null,
 *            entries: Array<{loc: string, lastmod: Date|null}>,
 *            capped: boolean, truncated: boolean, rejected: number}}
 *   `capped` — reading stopped at `maxUrls`; `truncated` — the document
 *   ended before its root element closed; `rejected` — `<loc>` entries that
 *   were empty, too long or held an unexpanded entity.
 */
function parseSitemap(input, { maxUrls = config.crawler.sitemapMaxUrlsPerFile } = {}) {
  const result = { type: null, entries: [], capped: false, truncated: false, rejected: 0 };
  const limit = Math.max(1, Number(maxUrls) || 1);

  let text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input || '');
  // A byte-order mark before the XML declaration is legal but not markup.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // One frame per open element: its resolved name and the namespace
  // bindings it declared, so a prefix resolves to the nearest declaration.
  const stack = [];
  let rootClosed = false;
  let stopped = false;
  let entry = null; // the <url> or <sitemap> being read
  let field = null; // 'loc' | 'lastmod' while inside one
  let buffer = '';

  function resolve(prefix, attributes) {
    const own = attributes[prefix ? `xmlns:${prefix}` : 'xmlns'];
    if (own !== undefined) return own;
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      if (prefix in stack[i].bindings) return stack[i].bindings[prefix];
    }
    return '';
  }

  /** The element's local name when it is in the sitemap namespace, else null. */
  function sitemapName(name, attributes) {
    const { prefix, local } = splitName(name);
    const namespace = resolve(prefix, attributes);
    // Unprefixed with no namespace at all is common in hand-written sitemaps.
    if (namespace === '' ? prefix !== '' : !SITEMAP_NAMESPACE.test(namespace)) return null;
    return local.toLowerCase();
  }

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (stopped) return;
        const bindings = {};
        for (const [key, value] of Object.entries(attributes)) {
          if (key === 'xmlns') bindings[''] = value;
          else if (key.startsWith('xmlns:')) bindings[key.slice(6)] = value;
        }
        const local = sitemapName(name, attributes);
        const depth = stack.length;
        stack.push({ local, bindings });

        if (depth === 0) {
          if (local === 'urlset' || local === 'sitemapindex') result.type = local;
          else stopped = true; // not a sitemap; nothing more to read
          return;
        }

        const itemName = result.type === 'urlset' ? 'url' : 'sitemap';
        if (depth === 1 && local === itemName) {
          entry = { loc: null, lastmod: null };
        } else if (depth === 2 && entry && (local === 'loc' || local === 'lastmod')) {
          field = local;
          buffer = '';
        }
      },

      ontext(chunk) {
        if (field) buffer += chunk;
      },

      onclosetag(name, isImplied) {
        if (stopped) return;
        const frame = stack.pop();
        const depth = stack.length;

        if (depth === 2 && field && frame.local === field) {
          // Only a properly closed field counts: one cut off by the end of
          // the document is partial.
          if (!isImplied) {
            if (field === 'loc') entry.loc = buffer.trim();
            else entry.lastmod = parseLastmod(buffer);
          }
          field = null;
        } else if (depth === 1 && entry) {
          if (!isImplied && entry.loc !== null) commit(entry);
          entry = null;
        } else if (depth === 0) {
          rootClosed = !isImplied;
        }
      }
    },
    { xmlMode: true, decodeEntities: true }
  );

  function commit({ loc, lastmod }) {
    if (!loc || loc.length > MAX_LOC_LENGTH || UNEXPANDED_ENTITY.test(loc)) {
      result.rejected += 1;
      return;
    }
    result.entries.push({ loc, lastmod });
    if (result.entries.length >= limit) {
      result.capped = true;
      stopped = true;
    }
  }

  try {
    for (let offset = 0; offset < text.length && !stopped; offset += CHUNK_CHARS) {
      parser.write(text.slice(offset, offset + CHUNK_CHARS));
    }
    if (!stopped) parser.end();
  } catch {
    // htmlparser2 is forgiving and should not throw; if it does, what was
    // read cleanly is still good, and the document is incomplete.
    stopped = true;
  }

  if (result.type && !result.capped && !rootClosed) result.truncated = true;
  if (!result.type) result.entries = [];
  return result;
}

module.exports = { parseSitemap, parseLastmod };
