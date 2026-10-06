const cheerio = require('cheerio');

const SKIPPED_SCHEMES = /^(mailto:|tel:|javascript:|data:|ftp:|file:|sms:)/i;
// Binary/asset extensions that are never HTML pages.
const ASSET_EXTENSION =
  /\.(pdf|zip|gz|tar|rar|7z|exe|dmg|pkg|msi|png|jpe?g|gif|webp|svg|ico|bmp|tiff?|mp3|mp4|avi|mov|wmv|flv|webm|ogg|wav|css|js|json|xml|rss|atom|woff2?|ttf|eot|csv|xlsx?|docx?|pptx?)(\?|#|$)/i;

// Where a page's own content usually lives. The first match in document
// order is used; on a page with none of these, every link keeps its order.
const MAIN_CONTENT = '#mw-content-text, main, [role="main"], article, #content, #main-content';

/**
 * Extracts crawlable absolute URLs from a page.
 *
 * Relative hrefs are resolved against baseUrl (honouring <base href> when
 * present). Fragments, non-web schemes, rel="nofollow" links and obvious
 * asset URLs are dropped.
 *
 * @param {string} html
 * @param {string} baseUrl  URL of the page the HTML came from
 * @returns {Array<string>} de-duplicated absolute http(s) URLs
 */
function extractLinks(html, baseUrl) {
  if (!html || !baseUrl) return [];

  const found = new Set();

  try {
    const $ = cheerio.load(html);

    // A <base href> changes how every relative link resolves.
    let resolveBase = baseUrl;
    const declaredBase = $('base[href]').first().attr('href');
    if (declaredBase) {
      try {
        resolveBase = new URL(declaredBase, baseUrl).toString();
      } catch {
        /* malformed <base>; fall back to the page URL */
      }
    }

    // Links in the page's main content come first, then the rest (header,
    // navigation, footer). The set is the same; only the order changes. It
    // matters because the frontier is breadth-first in discovery order and
    // a page's links are capped, so a small crawl budget should go to the
    // articles a page is about rather than to its "About us" and "Donate".
    const main = $(MAIN_CONTENT).first();
    const anchors = main.length
      ? [...main.find('a[href]').toArray(), ...$('a[href]').not(main.find('a[href]')).toArray()]
      : $('a[href]').toArray();

    anchors.forEach(element => {
      const href = $(element).attr('href');
      if (!href) return;

      const trimmed = href.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      if (SKIPPED_SCHEMES.test(trimmed)) return;

      // Respect the page author's crawling preference.
      const rel = String($(element).attr('rel') || '').toLowerCase();
      if (rel.split(/\s+/).includes('nofollow')) return;

      let absolute;
      try {
        absolute = new URL(trimmed, resolveBase);
      } catch {
        return; // unparseable href
      }

      if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return;
      if (ASSET_EXTENSION.test(absolute.pathname)) return;

      absolute.hash = '';
      found.add(absolute.toString());
    });
  } catch {
    // A page we cannot parse simply yields no links.
    return [];
  }

  return Array.from(found);
}

/**
 * Extracts the indexable metadata for a page.
 * @returns {{title: string, description: string, keywords: string, language: string}}
 */
function extractMetadata(html) {
  const blank = { title: '', description: '', keywords: '', language: '' };
  if (!html) return blank;

  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return blank;
  }

  const title = collapse($('title').first().text());

  let description =
    $('meta[name="description"]').attr('content') ||
    $('meta[property="og:description"]').attr('content') ||
    '';

  if (!description) {
    // Fall back to the first paragraph with real prose in it.
    $('p').each((_, el) => {
      if (description) return;
      const text = collapse($(el).text());
      if (text.length >= 40) description = text.slice(0, 300);
    });
  }

  const keywords = collapse($('meta[name="keywords"]').attr('content') || '');
  const language = extractLanguage($);

  return {
    title,
    description: collapse(description).slice(0, 300),
    keywords: keywords.slice(0, 300),
    language
  };
}

/**
 * Reads the document language from <html lang>, falling back to the
 * og:locale / content-language meta tags. Returns a 2-3 letter code or ''.
 */
function extractLanguage($) {
  const candidates = [
    $('html').attr('lang'),
    $('meta[http-equiv="content-language"]').attr('content'),
    $('meta[name="language"]').attr('content'),
    $('meta[property="og:locale"]').attr('content')
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const code = String(candidate)
      .trim()
      .toLowerCase()
      .split(/[-_,;\s]/)[0];
    if (/^[a-z]{2,3}$/.test(code)) return code;
  }
  return '';
}

function collapse(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when a URL points at a file extractLinks would not follow — a PDF,
 * an image, an archive. Lets sitemap discovery apply the same filter.
 */
function isAssetUrl(url) {
  try {
    return ASSET_EXTENSION.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** True when both URLs share the same registrable host (ignoring "www."). */
function isSameDomain(urlA, urlB) {
  try {
    const a = new URL(urlA).hostname.toLowerCase().replace(/^www\./, '');
    const b = new URL(urlB).hostname.toLowerCase().replace(/^www\./, '');
    return a === b;
  } catch {
    return false;
  }
}

module.exports = { extractLinks, extractMetadata, extractLanguage, isSameDomain, isAssetUrl };
