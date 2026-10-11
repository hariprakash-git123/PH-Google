const cheerio = require('cheerio');
const safeFetch = require('./safeFetch');
const { sniffImage } = require('../imageDownloadService');
const { sha1 } = require('../opensearch/documentMapper');
const { canonicalKey } = require('../../utils/urlNormalizer');
const { text, httpUrl } = require('./fields');
const { mentionedTerms } = require('./resultRelevance');

/**
 * Images found on a web page, for image search without an image provider.
 *
 * A web-search provider returns pages, not pictures. To offer a picture as a
 * result this module reads the page itself and keeps only what stands up:
 *
 *   - the image's own words — its alt text, title, caption or file name —
 *     mention the subject searched for. A page about the subject also carries
 *     logos, avatars, adverts and pictures of other things; being on the page
 *     is not enough. The page's declared lead image (og:image) is the one
 *     exception: it is taken on the strength of the page's title;
 *   - anything that names itself a logo, icon, sprite, avatar or tracker is
 *     left out, as is anything the markup sizes like one;
 *   - the address is then fetched, and it must answer with the bytes of a
 *     real image of a useful size. What the server calls it is not trusted.
 *
 * Nothing is stored. Every fetch goes through safeFetch (public hosts only).
 */

const PAGE_TIMEOUT_MS = 4000;
const PAGE_MAX_BYTES = 1536 * 1024;
const IMAGE_TIMEOUT_MS = 3500;
/** Enough of a file to recognise it and read its size from the header. */
const IMAGE_PROBE_BYTES = 64 * 1024;
const MAX_CANDIDATES_PER_PAGE = 8;

/** Smaller than this on either side is an icon or a thumbnail strip. */
const MIN_SIDE = 160;
/** Wider or taller than this many times the other side is a banner or a rule. */
const MAX_ASPECT = 4;
/** When the size cannot be read from the header, a file this small is not a picture. */
const MIN_BYTES_WHEN_SIZE_UNKNOWN = 15 * 1024;

/** Formats a browser shows in an <img>, recognised from the bytes. */
const SHOWABLE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);

/** Page furniture, by what it calls itself. */
const FURNITURE =
  /(^|[^a-z])(logo|logos|icon|icons|sprite|favicon|avatar|gravatar|emoji|badge|pixel|tracking|tracker|placeholder|spinner|loader|loading|blank|spacer|button|btn|advert|ads)([^a-z]|$)/i;

/** Words from a file name: ".../tesla-model-3_front.jpg" → "tesla model 3 front". */
function fileWords(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return name
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[-_+.]+/g, ' ')
      .replace(/\b[a-f0-9]{8,}\b/gi, ' ')
      .trim();
  } catch {
    return '';
  }
}

/**
 * What makes two addresses the same picture: the same file at another size.
 * Image hosts resize by query string (photo.jpg?w=400), so for an address
 * ending in an image file the query is left out; and Google's image host
 * resizes by a suffix (…=w800-h600). Anything else is compared whole — an
 * address like /image?id=7 is told apart only by its query.
 */
function imageIdentity(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let path = parsed.pathname;
    if (/\.googleusercontent\.com$/.test(host)) path = path.replace(/=[a-z0-9-]+$/i, '');
    if (/\.(jpe?g|png|gif|webp|avif)$/i.test(path)) return `${host}${path}`.toLowerCase();
    if (path !== parsed.pathname) return `${host}${path}${parsed.search}`;
  } catch {
    /* not an address: compared as given */
  }
  return canonicalKey(url) || String(url);
}

/** The largest candidate of a srcset, or null. */
function largestOfSrcset(srcset) {
  let best = null;
  for (const part of String(srcset || '').split(',')) {
    const [url, size] = part.trim().split(/\s+/);
    if (!url) continue;
    const weight = parseFloat(size) || 1;
    if (!best || weight > best.weight) best = { url, weight };
  }
  return best ? best.url : null;
}

/** An absolute http(s) address for something a page referred to, or null. */
function resolve(reference, pageUrl) {
  if (typeof reference !== 'string' || !reference.trim() || /^data:/i.test(reference.trim())) {
    return null;
  }
  try {
    return httpUrl(new URL(reference.trim(), pageUrl).toString());
  } catch {
    return null;
  }
}

/**
 * The images on one page that are about the subject, best first.
 *
 * @param {string} html
 * @param {string} pageUrl   where the page was fetched from
 * @param {string[]} terms   the query's meaningful terms (resultRelevance)
 * @returns {Array<{imageUrl: string, title: string, lead: boolean, matched: number}>}
 */
function extractCandidates(html, pageUrl, terms) {
  let $;
  try {
    $ = cheerio.load(String(html || ''));
  } catch {
    return [];
  }
  const meta = name =>
    $(`meta[property="${name}"]`).attr('content') || $(`meta[name="${name}"]`).attr('content');
  const pageTitle = text(meta('og:title') || $('title').first().text(), 200);

  // Someone searching for logos or icons is asking for exactly those.
  const wantsFurniture = terms.some(term => FURNITURE.test(term));
  const isFurniture = value => !wantsFurniture && FURNITURE.test(value);

  const seen = new Set();
  const out = [];
  const add = (reference, words, { lead = false, title = '' } = {}) => {
    const imageUrl = resolve(reference, pageUrl);
    if (!imageUrl || /\.svg(\?|#|$)/i.test(imageUrl)) return;
    const key = imageIdentity(imageUrl);
    if (seen.has(key)) return;
    if (isFurniture(fileWords(imageUrl)) || isFurniture(words)) return;
    // With nothing to look for, any picture on the page qualifies.
    const matched = mentionedTerms(`${words} ${fileWords(imageUrl)}`, terms);
    if (terms.length > 0 && matched === 0) return;
    seen.add(key);
    out.push({
      imageUrl,
      title: text(title || words, 200) || pageTitle || text(fileWords(imageUrl), 200),
      lead,
      matched
    });
  };

  // The image the page itself puts forward, judged by the page's title.
  const lead = meta('og:image:secure_url') || meta('og:image') || meta('twitter:image');
  if (lead) {
    add(lead, `${meta('og:image:alt') || ''} ${pageTitle}`, { lead: true, title: pageTitle });
  }

  $('img').each((_, element) => {
    const img = $(element);
    const declared = side => parseInt(img.attr(side), 10);
    if (declared('width') < MIN_SIDE || declared('height') < MIN_SIDE) return;
    const reference =
      largestOfSrcset(img.attr('srcset') || img.attr('data-srcset')) ||
      img.attr('data-src') ||
      img.attr('data-lazy-src') ||
      img.attr('data-original') ||
      img.attr('src');
    const caption = img.closest('figure').find('figcaption').first().text();
    const alt = img.attr('alt') || '';
    add(reference, `${alt} ${img.attr('title') || ''} ${caption}`, { title: alt || caption });
  });

  // The lead image, then the ones whose own words say most about the subject.
  return out
    .map((candidate, order) => ({ candidate, order }))
    .sort(
      (a, b) =>
        Number(b.candidate.lead) - Number(a.candidate.lead) ||
        b.candidate.matched - a.candidate.matched ||
        a.order - b.order
    )
    .slice(0, MAX_CANDIDATES_PER_PAGE)
    .map(({ candidate }) => candidate);
}

/** Width and height from an image's header, or null when it cannot be read. */
function imageSize(buffer, type) {
  try {
    if (type === 'image/png' && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (type === 'image/gif' && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (type === 'image/webp' && buffer.length >= 30) {
      const format = buffer.toString('latin1', 12, 16);
      if (format === 'VP8X') {
        return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
      }
      if (format === 'VP8 ') {
        return {
          width: buffer.readUInt16LE(26) & 0x3fff,
          height: buffer.readUInt16LE(28) & 0x3fff
        };
      }
      if (format === 'VP8L') {
        const bits = buffer.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
    }
    if (type === 'image/jpeg') {
      // Walk the segments to the frame header, which holds the size.
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) return null;
        const marker = buffer[offset + 1];
        if (marker === 0xff) {
          offset += 1;
          continue;
        }
        const isFrame =
          marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) {
          return {
            width: buffer.readUInt16BE(offset + 7),
            height: buffer.readUInt16BE(offset + 5)
          };
        }
        offset += 2 + buffer.readUInt16BE(offset + 2);
      }
    }
  } catch {
    /* a truncated or malformed header has no readable size */
  }
  return null;
}

/**
 * Fetches the start of an image and says whether it is one worth showing.
 *
 * @returns {Promise<{ok: true, imageUrl: string, width: number|null,
 *                    height: number|null, fingerprint: string}
 *                  | {ok: false, reason: string}>}
 */
async function verifyImage(imageUrl, options = {}) {
  const response = await safeFetch.get(imageUrl, {
    timeoutMs: IMAGE_TIMEOUT_MS,
    maxBytes: IMAGE_PROBE_BYTES,
    // Formats whose size can be read from the header are asked for first.
    accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5',
    ...options
  });
  if (!response.ok) return { ok: false, reason: response.reason };

  const image = sniffImage(response.buffer);
  if (!image || !SHOWABLE.has(image.type)) return { ok: false, reason: 'not_image' };

  const size = imageSize(response.buffer, image.type);
  if (size && size.width > 0 && size.height > 0) {
    const short = Math.min(size.width, size.height);
    const long = Math.max(size.width, size.height);
    if (short < MIN_SIDE) return { ok: false, reason: 'too_small' };
    if (long / short > MAX_ASPECT) return { ok: false, reason: 'not_a_picture' };
  } else {
    const declared = Number(response.headers['content-length']);
    const bytes = Number.isFinite(declared) ? declared : response.buffer.length;
    if (!response.truncated && bytes < MIN_BYTES_WHEN_SIZE_UNKNOWN) {
      return { ok: false, reason: 'too_small' };
    }
  }

  return {
    ok: true,
    // After redirects: the address the picture is really at.
    imageUrl: httpUrl(response.finalUrl) || imageUrl,
    width: size && size.width > 0 ? size.width : null,
    height: size && size.height > 0 ? size.height : null,
    // The same file under two addresses is one picture.
    fingerprint: sha1(response.buffer.toString('latin1'))
  };
}

/**
 * Reads one page and returns the candidate images on it about the subject.
 * A page that cannot be fetched, or is not HTML, has none.
 *
 * @returns {Promise<{pageUrl: string, candidates: Array, reason?: string}>}
 */
async function candidatesFromPage(pageUrl, terms, options = {}) {
  const response = await safeFetch.get(pageUrl, {
    timeoutMs: PAGE_TIMEOUT_MS,
    maxBytes: PAGE_MAX_BYTES,
    accept: 'text/html,application/xhtml+xml',
    ...options
  });
  if (!response.ok) return { pageUrl, candidates: [], reason: response.reason };
  const type = String(response.headers['content-type'] || '').toLowerCase();
  if (type && !/html|xml/.test(type)) return { pageUrl, candidates: [], reason: 'not_html' };

  const finalUrl = response.finalUrl || pageUrl;
  return {
    pageUrl: finalUrl,
    candidates: extractCandidates(response.buffer.toString('utf8'), finalUrl, terms)
  };
}

module.exports = {
  extractCandidates,
  candidatesFromPage,
  verifyImage,
  imageSize,
  imageIdentity,
  fileWords,
  MIN_SIDE,
  MAX_ASPECT
};
