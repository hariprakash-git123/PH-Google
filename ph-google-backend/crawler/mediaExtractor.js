const cheerio = require('cheerio');

/**
 * Vertical content extraction.
 *
 * The crawler already fetches and parses every page; this module pulls the
 * non-web-page verticals out of that same HTML:
 *
 *   images  <img>, <picture>/<source>, og:image
 *   videos  <video>, YouTube/Vimeo/Dailymotion embeds, og:video
 *   news    article metadata (published date, author, section, hero image)
 *   places  geo coordinates and postal addresses
 *
 * Everything returned here came from a real crawled document — nothing is
 * generated or assumed.
 */

// Images that are almost certainly chrome rather than content.
const NON_CONTENT_IMAGE =
  /(sprite|spacer|pixel|tracking|1x1|blank|transparent|icon[-_.]|[-_.]icon|favicon|logo[-_.]?\d*\.|avatar|placeholder|loading|spinner|ads?[-_.]|banner[-_.]|button[-_.]|arrow[-_.]|bullet[-_.]|divider)/i;

const IMAGE_EXTENSION = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|svg)(\?|#|$)/i;
const VIDEO_EXTENSION = /\.(mp4|webm|ogv|ogg|mov|m4v|avi)(\?|#|$)/i;

// Below this, an image is a bullet/icon rather than content.
const MIN_IMAGE_DIMENSION = 100;

/** Resolves a possibly-relative URL, returning '' when it is unusable. */
function absolute(src, baseUrl) {
  if (!src) return '';
  const trimmed = String(src).trim();
  // Inline data and blob URIs are not addressable content.
  if (!trimmed || /^(data:|blob:|about:|javascript:)/i.test(trimmed)) return '';

  try {
    const url = new URL(trimmed, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function collapse(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toInt(value) {
  const n = parseInt(String(value || '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "sunset-over-lake_01.jpg" -> "sunset over lake 01" */
function wordsFromFilename(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return collapse(
      name
        .replace(/\.[a-z0-9]{2,5}$/i, '')
        .replace(/[-_+.]/g, ' ')
        .replace(/\d{2,}px/gi, ' ')
    );
  } catch {
    return '';
  }
}

/**
 * Picks the largest candidate out of a srcset attribute.
 * "a.jpg 480w, b.jpg 1024w" -> "b.jpg"
 */
function largestFromSrcset(srcset) {
  if (!srcset) return '';
  let best = '';
  let bestWidth = -1;

  for (const part of String(srcset).split(',')) {
    const [candidate, descriptor] = part.trim().split(/\s+/);
    if (!candidate) continue;
    const width = descriptor ? parseInt(descriptor, 10) || 0 : 0;
    if (width >= bestWidth) {
      bestWidth = width;
      best = candidate;
    }
  }
  return best;
}

/** Parses every JSON-LD block on the page; malformed blocks are skipped. */
function parseJsonLd($) {
  const blocks = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw || raw.length > 200000) return;
    try {
      const parsed = JSON.parse(raw);
      // A block may be a single object, an array, or an @graph wrapper.
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (Array.isArray(item['@graph'])) blocks.push(...item['@graph'].filter(Boolean));
        else blocks.push(item);
      }
    } catch {
      // Invalid JSON-LD is common in the wild; ignore it.
    }
  });

  return blocks;
}

function typesOf(node) {
  const t = node && node['@type'];
  if (!t) return [];
  return (Array.isArray(t) ? t : [t]).map(x => String(x).toLowerCase());
}

// ---------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------

/**
 * @returns {Array<{url,alt,caption,width,height,format,sourceType}>}
 */
function extractImages($, baseUrl, pageTitle) {
  const byUrl = new Map();

  const add = (rawSrc, meta = {}) => {
    const url = absolute(rawSrc, baseUrl);
    if (!url) return;

    // Keep the richest record when the same image appears twice.
    const existing = byUrl.get(url);
    const record = {
      url,
      alt: collapse(meta.alt || (existing && existing.alt) || ''),
      caption: collapse(meta.caption || (existing && existing.caption) || ''),
      width: meta.width || (existing && existing.width) || null,
      height: meta.height || (existing && existing.height) || null,
      format: formatOf(url),
      sourceType: meta.sourceType || (existing && existing.sourceType) || 'img'
    };
    byUrl.set(url, record);
  };

  $('img').each((_, el) => {
    const $el = $(el);

    // Lazy-loaded images keep the real URL in a data attribute.
    const src =
      $el.attr('src') ||
      $el.attr('data-src') ||
      $el.attr('data-original') ||
      $el.attr('data-lazy-src') ||
      largestFromSrcset($el.attr('srcset') || $el.attr('data-srcset'));

    if (!src) return;

    const width = toInt($el.attr('width'));
    const height = toInt($el.attr('height'));

    // A figure's caption describes the image better than alt text often does.
    const $figure = $el.closest('figure');
    const caption = $figure.length ? collapse($figure.find('figcaption').first().text()) : '';

    add(src, {
      alt: $el.attr('alt') || $el.attr('title') || '',
      caption,
      width,
      height,
      sourceType: 'img'
    });
  });

  // <picture><source srcset="..."> gives higher-resolution variants.
  $('picture source[srcset]').each((_, el) => {
    const best = largestFromSrcset($(el).attr('srcset'));
    if (best) add(best, { sourceType: 'picture' });
  });

  // The page's own social preview image is a reliable, content-bearing image.
  const ogImage =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content');
  if (ogImage) {
    add(ogImage, {
      alt: $('meta[property="og:image:alt"]').attr('content') || pageTitle || '',
      width: toInt($('meta[property="og:image:width"]').attr('content')),
      height: toInt($('meta[property="og:image:height"]').attr('content')),
      sourceType: 'og'
    });
  }

  return Array.from(byUrl.values()).filter(isContentImage);
}

/**
 * Filters out chrome: icons, spacers, tracking pixels and tiny graphics.
 * When dimensions are unknown the filename is the only signal available.
 */
function isContentImage(image) {
  if (!IMAGE_EXTENSION.test(image.url) && image.sourceType !== 'og') {
    // Some CDNs serve extensionless images; allow them only when the markup
    // says they are reasonably large.
    if (!image.width || image.width < MIN_IMAGE_DIMENSION) return false;
  }

  if (image.width !== null && image.width < MIN_IMAGE_DIMENSION) return false;
  if (image.height !== null && image.height < MIN_IMAGE_DIMENSION) return false;

  if (NON_CONTENT_IMAGE.test(image.url)) return false;

  // An SVG with no dimensions is almost always an icon.
  if (/\.svg(\?|#|$)/i.test(image.url) && !image.width) return false;

  return true;
}

function formatOf(url) {
  const match = /\.([a-z0-9]{2,5})(\?|#|$)/i.exec(url);
  if (!match) return '';
  const ext = match[1].toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

/**
 * Collects the page's headings, which carry far more topical signal per word
 * than body text and are therefore weighted heavily by the search ranking.
 *
 * @returns {{h1: string[], h2: string[], h3: string[]}}
 */
function extractHeadings(html) {
  const empty = { h1: [], h2: [], h3: [] };
  if (!html) return empty;

  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return empty;
  }

  // Navigation and boilerplate headings add noise, not topic.
  $('nav, header, footer, aside, script, style').remove();

  const read = selector => {
    const out = [];
    $(selector).each((_, el) => {
      const text = collapse($(el).text());
      // Skip empty and absurdly long headings (usually a parsing artefact).
      if (text && text.length <= 300) out.push(text);
    });
    // A page with 200 h3s is a list index; cap what reaches the index.
    return out.slice(0, 40);
  };

  return { h1: read('h1'), h2: read('h2'), h3: read('h3') };
}

// ---------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------

const VIDEO_EMBEDS = [
  {
    provider: 'youtube',
    pattern: /(?:youtube\.com\/(?:embed\/|watch\?v=|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/,
    watchUrl: id => `https://www.youtube.com/watch?v=${id}`,
    thumbnail: id => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
  },
  {
    provider: 'vimeo',
    pattern: /vimeo\.com\/(?:video\/)?(\d{6,})/,
    watchUrl: id => `https://vimeo.com/${id}`,
    thumbnail: () => ''
  },
  {
    provider: 'dailymotion',
    pattern: /dailymotion\.com\/(?:embed\/)?video\/([A-Za-z0-9]+)/,
    watchUrl: id => `https://www.dailymotion.com/video/${id}`,
    thumbnail: id => `https://www.dailymotion.com/thumbnail/video/${id}`
  }
];

/** Recognises a third-party video URL and returns its normalised form. */
function matchEmbed(url) {
  for (const spec of VIDEO_EMBEDS) {
    const match = spec.pattern.exec(url);
    if (match) {
      return {
        provider: spec.provider,
        providerId: match[1],
        url: spec.watchUrl(match[1]),
        thumbnailUrl: spec.thumbnail(match[1])
      };
    }
  }
  return null;
}

/**
 * @returns {Array<{url,title,thumbnailUrl,provider,providerId,format,durationSeconds}>}
 */
function extractVideos($, baseUrl, pageTitle) {
  const byUrl = new Map();

  const add = record => {
    if (!record.url || byUrl.has(record.url)) return;
    byUrl.set(record.url, record);
  };

  // 1. Native <video> elements.
  $('video').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src') || $el.find('source[src]').first().attr('src');
    const url = absolute(src, baseUrl);
    if (!url) return;

    add({
      url,
      title: collapse(
        $el.attr('title') ||
          $el.closest('figure').find('figcaption').first().text() ||
          pageTitle ||
          ''
      ),
      thumbnailUrl: absolute($el.attr('poster'), baseUrl),
      provider: 'native',
      providerId: '',
      format: (VIDEO_EXTENSION.exec(url)?.[1] || '').toLowerCase(),
      durationSeconds: toInt($el.attr('data-duration'))
    });
  });

  // 2. Embedded players (iframe / embed).
  $('iframe[src], embed[src], iframe[data-src]').each((_, el) => {
    const $el = $(el);
    const raw = $el.attr('src') || $el.attr('data-src');
    const url = absolute(raw, baseUrl);
    if (!url) return;

    const embed = matchEmbed(url);
    if (!embed) return;

    add({
      ...embed,
      title: collapse($el.attr('title') || pageTitle || ''),
      format: '',
      durationSeconds: null
    });
  });

  // 3. Links straight to a known video host.
  $('a[href]').each((_, el) => {
    const url = absolute($(el).attr('href'), baseUrl);
    if (!url) return;
    const embed = matchEmbed(url);
    if (!embed) return;

    add({
      ...embed,
      title: collapse($(el).text() || pageTitle || ''),
      format: '',
      durationSeconds: null
    });
  });

  // 4. og:video declared by the page itself.
  const ogVideo =
    $('meta[property="og:video:url"]').attr('content') ||
    $('meta[property="og:video:secure_url"]').attr('content') ||
    $('meta[property="og:video"]').attr('content');

  if (ogVideo) {
    const url = absolute(ogVideo, baseUrl);
    if (url) {
      const embed = matchEmbed(url);
      add({
        url: embed ? embed.url : url,
        provider: embed ? embed.provider : 'native',
        providerId: embed ? embed.providerId : '',
        thumbnailUrl:
          (embed && embed.thumbnailUrl) ||
          absolute($('meta[property="og:image"]').attr('content'), baseUrl),
        title: collapse($('meta[property="og:title"]').attr('content') || pageTitle || ''),
        format: (VIDEO_EXTENSION.exec(url)?.[1] || '').toLowerCase(),
        durationSeconds: toInt($('meta[property="video:duration"]').attr('content'))
      });
    }
  }

  // 5. JSON-LD VideoObject carries the richest metadata when present.
  for (const node of parseJsonLd($)) {
    if (!typesOf(node).includes('videoobject')) continue;

    const contentUrl = absolute(node.contentUrl || node.embedUrl || node.url, baseUrl);
    if (!contentUrl) continue;
    const embed = matchEmbed(contentUrl);

    add({
      url: embed ? embed.url : contentUrl,
      provider: embed ? embed.provider : 'native',
      providerId: embed ? embed.providerId : '',
      title: collapse(node.name || pageTitle || ''),
      thumbnailUrl:
        (embed && embed.thumbnailUrl) ||
        absolute(
          typeof node.thumbnailUrl === 'string' ? node.thumbnailUrl : (node.thumbnailUrl || [])[0],
          baseUrl
        ),
      format: '',
      durationSeconds: parseIsoDuration(node.duration)
    });
  }

  return Array.from(byUrl.values());
}

/** ISO-8601 duration ("PT1H2M30S") -> seconds. */
function parseIsoDuration(value) {
  if (!value || typeof value !== 'string') return null;
  const m = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(value.trim());
  if (!m) return null;
  const seconds =
    (parseInt(m[1], 10) || 0) * 3600 +
    (parseInt(m[2], 10) || 0) * 60 +
    Math.round(parseFloat(m[3]) || 0);
  return seconds > 0 ? seconds : null;
}

// ---------------------------------------------------------------------
// News / articles
// ---------------------------------------------------------------------

/**
 * Detects whether a page is an article and pulls its publishing metadata.
 * @returns {{isArticle, publishedAt, author, section, siteName, imageUrl}}
 */
function extractArticle($, baseUrl, pageTitle) {
  const result = {
    isArticle: false,
    articleType: '',
    publishedAt: null,
    author: '',
    section: '',
    siteName: collapse($('meta[property="og:site_name"]').attr('content') || ''),
    imageUrl: absolute(
      $('meta[property="og:image"]').attr('content') ||
        $('meta[name="twitter:image"]').attr('content'),
      baseUrl
    )
  };

  const ogType = String($('meta[property="og:type"]').attr('content') || '').toLowerCase();
  // og:type=article is the publisher explicitly saying "this is a story".
  if (ogType === 'article' || ogType === 'news' || ogType.endsWith(':article')) {
    result.isArticle = true;
    result.articleType = 'article';
  }

  // Standard article meta tags.
  const publishedRaw =
    $('meta[property="article:published_time"]').attr('content') ||
    $('meta[name="article:published_time"]').attr('content') ||
    $('meta[name="publish-date"]').attr('content') ||
    $('meta[name="pubdate"]').attr('content') ||
    $('meta[itemprop="datePublished"]').attr('content') ||
    $('meta[name="date"]').attr('content') ||
    $('time[datetime]').first().attr('datetime');

  // A date alone does not make a page news — plenty of pages carry one.
  const published = toDate(publishedRaw);
  if (published) result.publishedAt = published;

  result.author = collapse(
    $('meta[name="author"]').attr('content') ||
      $('meta[property="article:author"]').attr('content') ||
      $('[rel="author"]').first().text() ||
      ''
  ).slice(0, 120);

  result.section = collapse($('meta[property="article:section"]').attr('content') || '').slice(
    0,
    80
  );

  // JSON-LD is the most reliable source when a publisher provides it.
  for (const node of parseJsonLd($)) {
    const types = typesOf(node);

    // A story type is unambiguous news. A bare "Article" is not: reference
    // sites (Wikipedia, documentation) use it for evergreen pages, and those
    // do not belong in a news vertical. Such a page only counts when the
    // publisher has not also declared og:type=website.
    const isStoryType = types.some(
      t =>
        t === 'newsarticle' ||
        t === 'reportagenewsarticle' ||
        t === 'blogposting' ||
        t === 'liveblogposting' ||
        t === 'opinionnewsarticle' ||
        t === 'analysisnewsarticle'
    );
    const isGenericArticle = types.includes('article');
    if (!isStoryType && !isGenericArticle) continue;

    if (isStoryType) {
      result.isArticle = true;
      result.articleType =
        types.find(t => t.includes('article') || t.includes('posting')) || 'newsarticle';
    } else if (ogType !== 'website') {
      result.isArticle = true;
      result.articleType = 'article';
    }

    const jsonDate = toDate(node.datePublished || node.dateCreated);
    if (jsonDate && (!result.publishedAt || jsonDate > result.publishedAt))
      result.publishedAt = jsonDate;

    if (!result.author && node.author) {
      const author = Array.isArray(node.author) ? node.author[0] : node.author;
      result.author = collapse(typeof author === 'string' ? author : author && author.name).slice(
        0,
        120
      );
    }
    if (!result.section && node.articleSection) {
      result.section = collapse(String(node.articleSection)).slice(0, 80);
    }
    if (!result.siteName && node.publisher && node.publisher.name) {
      result.siteName = collapse(node.publisher.name);
    }
  }

  // A bare <article> element alone is not enough; a date makes it news.
  if (!result.isArticle && $('article').length > 0 && result.publishedAt) {
    result.isArticle = true;
  }

  if (!result.siteName) {
    try {
      result.siteName = new URL(baseUrl).hostname.replace(/^www\./, '');
    } catch {
      result.siteName = '';
    }
  }

  // Guard against nonsense dates from malformed markup.
  if (result.publishedAt) {
    const year = result.publishedAt.getFullYear();
    if (year < 1995 || result.publishedAt.getTime() > Date.now() + 86400000) {
      result.publishedAt = null;
    }
  }

  void pageTitle;
  return result;
}

function toDate(value) {
  if (!value) return null;
  const date = new Date(String(value).trim());
  return Number.isFinite(date.getTime()) ? date : null;
}

// ---------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------

/**
 * Extracts geographic places: JSON-LD Place/LocalBusiness, geo meta tags and
 * the widely-used `.geo` microformat (Wikipedia and others).
 *
 * @returns {Array<{name,latitude,longitude,address,category}>}
 */
function extractPlaces($, baseUrl, pageTitle) {
  const byKey = new Map();
  const cleanTitle = cleanPageTitle(pageTitle);

  const add = place => {
    if (!isValidCoordinate(place.latitude, place.longitude)) return;

    const name = collapse(cleanPageTitle(place.name || cleanTitle || '')).slice(0, 200);

    // Group by name where there is one: a page quoting the same subject at
    // two precisions ("19.07611,72.8775" and "19,72") is one place, while a
    // directory page listing different named places still yields several.
    const key = name
      ? `n:${name.toLowerCase()}`
      : `c:${place.latitude.toFixed(3)},${place.longitude.toFixed(3)}`;
    const existing = byKey.get(key);

    const record = {
      name,
      latitude: place.latitude,
      longitude: place.longitude,
      address: collapse(place.address || '').slice(0, 300),
      category: collapse(place.category || '').slice(0, 80)
    };

    if (existing) {
      // Keep whichever reading carries more decimal places.
      if (precisionOf(existing.latitude) >= precisionOf(record.latitude)) {
        // Existing is at least as precise; only fill in missing detail.
        existing.address = existing.address || record.address;
        existing.category = existing.category || record.category;
        return;
      }
      record.address = record.address || existing.address;
      record.category = record.category || existing.category;
    }

    byKey.set(key, record);
  };

  // 1. JSON-LD.
  for (const node of parseJsonLd($)) {
    const types = typesOf(node);
    const isPlaceType = types.some(
      t =>
        t === 'place' ||
        t === 'localbusiness' ||
        t === 'organization' ||
        t === 'restaurant' ||
        t === 'hotel' ||
        t === 'store' ||
        t === 'touristattraction' ||
        t === 'city' ||
        t === 'country' ||
        t === 'administrativearea' ||
        t === 'landmarksorhistoricalbuildings'
    );
    if (!isPlaceType) continue;

    const geo = node.geo || {};
    add({
      name: node.name,
      latitude: parseFloat(geo.latitude ?? node.latitude),
      longitude: parseFloat(geo.longitude ?? node.longitude),
      address: formatAddress(node.address),
      category: types[0]
    });
  }

  // 2. geo meta tags.
  const geoPosition =
    $('meta[name="geo.position"]').attr('content') || $('meta[name="ICBM"]').attr('content');
  if (geoPosition) {
    const [lat, lon] = String(geoPosition)
      .split(/[;,]/)
      .map(v => parseFloat(v));
    add({
      name: $('meta[name="geo.placename"]').attr('content') || pageTitle,
      latitude: lat,
      longitude: lon,
      address: $('meta[name="geo.region"]').attr('content') || ''
    });
  }

  // 3. og:latitude / og:longitude.
  const ogLat = parseFloat($('meta[property="og:latitude"]').attr('content'));
  const ogLon = parseFloat($('meta[property="og:longitude"]').attr('content'));
  if (Number.isFinite(ogLat) && Number.isFinite(ogLon)) {
    add({
      name: $('meta[property="og:title"]').attr('content') || pageTitle,
      latitude: ogLat,
      longitude: ogLon,
      address: $('meta[property="og:street-address"]').attr('content') || ''
    });
  }

  // 4. The `.geo` microformat: "50.083333; 14.416667".
  $('.geo').each((_, el) => {
    const text = collapse($(el).text());
    const match = /^(-?\d+(?:\.\d+)?)\s*[;,]\s*(-?\d+(?:\.\d+)?)$/.exec(text);
    if (!match) return;
    add({
      name: pageTitle,
      latitude: parseFloat(match[1]),
      longitude: parseFloat(match[2])
    });
  });

  // 5. Separate latitude/longitude microformat spans.
  const microLat = parseFloat(collapse($('.latitude').first().text()));
  const microLon = parseFloat(collapse($('.longitude').first().text()));
  if (Number.isFinite(microLat) && Number.isFinite(microLon)) {
    add({ name: pageTitle, latitude: microLat, longitude: microLon });
  }

  void baseUrl;
  return Array.from(byKey.values());
}

/** Number of decimal places in a coordinate, as a precision proxy. */
function precisionOf(value) {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * Strips the site suffix publishers append to page titles, so a place is
 * named "Mumbai" rather than "Mumbai - Wikipedia".
 */
function cleanPageTitle(title) {
  return (
    collapse(title)
      .replace(/\s*[-|–—·]\s*[^-|–—·]{2,40}$/, '')
      .trim() || collapse(title)
  );
}

function isValidCoordinate(lat, lon) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    // 0,0 is in the Atlantic and is almost always a parsing artefact.
    !(lat === 0 && lon === 0)
  );
}

function formatAddress(address) {
  if (!address) return '';
  if (typeof address === 'string') return address;

  return [
    address.streetAddress,
    address.addressLocality,
    address.addressRegion,
    address.postalCode,
    address.addressCountry && (address.addressCountry.name || address.addressCountry)
  ]
    .filter(Boolean)
    .join(', ');
}

// ---------------------------------------------------------------------

/**
 * Runs every vertical extractor over one page in a single parse.
 *
 * @param {string} html
 * @param {string} baseUrl
 * @param {string} pageTitle
 * @returns {{images, videos, article, places}}
 */
function extractVerticalContent(html, baseUrl, pageTitle = '') {
  const empty = { images: [], videos: [], article: { isArticle: false }, places: [] };
  if (!html) return empty;

  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return empty;
  }

  return {
    images: extractImages($, baseUrl, pageTitle),
    videos: extractVideos($, baseUrl, pageTitle),
    article: extractArticle($, baseUrl, pageTitle),
    places: extractPlaces($, baseUrl, pageTitle)
  };
}

module.exports = {
  extractVerticalContent,
  extractImages,
  extractVideos,
  extractHeadings,
  extractArticle,
  extractPlaces,
  matchEmbed,
  cleanPageTitle,
  isContentImage,
  parseIsoDuration,
  wordsFromFilename,
  largestFromSrcset,
  absolute
};
