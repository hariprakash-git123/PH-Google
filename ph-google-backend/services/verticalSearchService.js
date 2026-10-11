const Media = require('../models/Media');
const Place = require('../models/Place');
const Page = require('../models/Page');
const Term = require('../models/Term');
const { tokenizeText } = require('../utils/textProcessor');
const { dateWindowToCutoff } = require('../utils/validators');
const { escapeRegex } = require('./searchService');

/**
 * Search for the non-web verticals: images, videos, news and maps.
 *
 * Retrieval model, mirroring the web vertical:
 *   images/videos/maps — query tokens matched against the item's `terms`
 *                        array (a multikey index, i.e. an inverted index)
 *   news               — the same Term inverted index as web search, then
 *                        narrowed to pages carrying article markup
 *
 * Ranking is computed in process, the same way `rankingService` scores web
 * results, so the ordering is explainable rather than opaque.
 */

const MAX_CANDIDATES = 600;

/** Domain filter that also matches a "www." variant. */
function domainClause(domain) {
  return { $in: [domain, `www.${domain}`] };
}

/**
 * Scores one media/place row.
 *
 * Signals: how many query terms it matches, whether the whole phrase appears
 * in its title, pixel area (bigger images are usually the content image),
 * and how recently it was crawled.
 */
function scoreMediaItem(item, searchTerms, query) {
  const terms = new Set(item.terms || []);
  let matched = 0;
  for (const term of searchTerms) if (terms.has(term)) matched += 1;

  // Coverage dominates: matching every word beats matching one word twice.
  let score = (matched / Math.max(1, searchTerms.length)) * 100;

  const title = String(item.title || '').toLowerCase();
  const phrase = String(query || '')
    .trim()
    .toLowerCase();
  if (phrase && title.includes(phrase)) score += 25;

  // A descriptive alt/caption is a better result than a filename-only match.
  if (item.alt) score += 6;
  if (item.caption) score += 4;

  // Prefer the large content image over a thumbnail of the same subject.
  if (item.width && item.height) {
    const megapixels = (item.width * item.height) / 1_000_000;
    score += Math.min(megapixels * 6, 12);
  }

  // Videos with a real thumbnail present far better in a grid.
  if (item.type === 'video' && item.thumbnailUrl) score += 5;

  if (item.lastCrawledAt) {
    const ageDays = (Date.now() - new Date(item.lastCrawledAt).getTime()) / 86400000;
    if (ageDays < 7) score += 3;
    else if (ageDays < 30) score += 1;
  }

  return { score, matched };
}

function paginate(rows, page, limit, offset) {
  // An explicit offset ("Load more": the results after those already shown)
  // wins over the page number.
  const start = Number.isInteger(offset) && offset >= 0 ? offset : (page - 1) * limit;
  return rows.slice(start, start + limit);
}

// ---------------------------------------------------------------------
// Images and videos
// ---------------------------------------------------------------------

/**
 * @param {'image'|'video'} type
 * @returns {Promise<{results, totalResults, responseTimeMs, searchTerms}>}
 */
async function searchMedia(
  type,
  {
    query,
    page = 1,
    limit = 20,
    offset,
    sort = 'relevance',
    domain = '',
    dateWindow = 'any',
    language = ''
  }
) {
  const startedAt = Date.now();
  const searchTerms = tokenizeText(query);

  const empty = () => ({
    results: [],
    totalResults: 0,
    searchTerms,
    responseTimeMs: Date.now() - startedAt
  });

  if (searchTerms.length === 0) return empty();
  // A picture or video carries no publication date — only when it was
  // crawled, which is not when it was published — so none is inside a date
  // window.
  if (dateWindowToCutoff(dateWindow)) return empty();

  const filter = { type, terms: { $in: searchTerms } };
  if (domain) filter.domain = domainClause(domain);
  if (language) filter.language = language;

  // Fetch a bounded candidate set; ranking happens in process.
  const candidates = await Media.find(filter)
    .select(
      'type url pageId pageUrl pageTitle domain title alt caption terms width height format provider providerId thumbnailUrl durationSeconds lastCrawledAt'
    )
    .limit(MAX_CANDIDATES)
    .lean();

  if (candidates.length === 0) return empty();

  const ranked = candidates.map(item => {
    const { score, matched } = scoreMediaItem(item, searchTerms, query);
    return { item, score, matched };
  });

  if (sort === 'newest' || sort === 'oldest') {
    const direction = sort === 'newest' ? -1 : 1;
    ranked.sort((a, b) => {
      const at = new Date(a.item.lastCrawledAt || 0).getTime();
      const bt = new Date(b.item.lastCrawledAt || 0).getTime();
      if (at === bt) return b.score - a.score;
      return (at - bt) * direction;
    });
  } else {
    ranked.sort(
      (a, b) => b.score - a.score || String(a.item.url).localeCompare(String(b.item.url))
    );
  }

  const slice = paginate(ranked, page, limit, offset);

  return {
    results: slice.map(({ item, score }) => formatMedia(item, score)),
    totalResults: ranked.length,
    searchTerms,
    responseTimeMs: Date.now() - startedAt
  };
}

function formatMedia(item, score) {
  const base = {
    id: item._id.toString(),
    type: item.type,
    url: item.url,
    title: item.title || item.alt || item.pageTitle || item.url,
    // Every media result links back to the page it was found on, so a user
    // can always see it in context.
    sourcePage: item.pageUrl,
    sourceTitle: item.pageTitle || '',
    source: item.domain || '',
    domain: item.domain || '',
    score: Number(score.toFixed(2)),
    crawledAt: item.lastCrawledAt || null
  };

  if (item.type === 'image') {
    return {
      ...base,
      alt: item.alt || '',
      caption: item.caption || '',
      width: item.width || null,
      height: item.height || null,
      dimensions: item.width && item.height ? `${item.width}×${item.height}` : '',
      format: (item.format || '').toUpperCase()
    };
  }

  return {
    ...base,
    provider: item.provider || 'native',
    providerId: item.providerId || '',
    thumbnailUrl: item.thumbnailUrl || '',
    // A YouTube/Vimeo id gives the frontend a privacy-friendly embed URL.
    embedUrl: embedUrlFor(item),
    durationSeconds: item.durationSeconds || null,
    duration: formatDuration(item.durationSeconds)
  };
}

function embedUrlFor(item) {
  if (item.provider === 'youtube' && item.providerId) {
    // youtube-nocookie avoids setting tracking cookies until playback.
    return `https://www.youtube-nocookie.com/embed/${item.providerId}`;
  }
  if (item.provider === 'vimeo' && item.providerId) {
    return `https://player.vimeo.com/video/${item.providerId}`;
  }
  return '';
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ---------------------------------------------------------------------
// News
// ---------------------------------------------------------------------

/**
 * News is the web index narrowed to pages with article markup, ranked by a
 * blend of relevance and recency and defaulting to newest-first — which is
 * what a news vertical is.
 */
async function searchNews({
  query,
  page = 1,
  limit = 10,
  offset,
  sort = 'newest',
  domain = '',
  dateWindow = 'any',
  language = ''
}) {
  const startedAt = Date.now();
  const searchTerms = tokenizeText(query);

  const empty = () => ({
    results: [],
    totalResults: 0,
    searchTerms,
    responseTimeMs: Date.now() - startedAt
  });

  if (searchTerms.length === 0) return empty();

  // Reuse the web inverted index to find candidate pages.
  const termDocs = await Term.find({ word: { $in: searchTerms } })
    .select('documents')
    .lean();
  if (termDocs.length === 0) return empty();

  const stats = new Map();
  for (const doc of termDocs) {
    for (const posting of doc.documents || []) {
      if (!posting || !posting.pageId) continue;
      const key = posting.pageId.toString();
      const existing = stats.get(key);
      if (existing) {
        existing.frequency += posting.frequency || 0;
        existing.matched += 1;
      } else {
        stats.set(key, { pageId: posting.pageId, frequency: posting.frequency || 0, matched: 1 });
      }
    }
  }

  const filter = {
    _id: { $in: Array.from(stats.values()).map(s => s.pageId) },
    isArticle: true
  };
  if (domain) filter.domain = domainClause(domain);
  if (language) filter.language = language;

  const cutoff = dateWindowToCutoff(dateWindow);
  // Published inside the window; an undated article is in no window.
  if (cutoff) filter.publishedAt = { $gte: cutoff };

  const pages = await Page.find(filter)
    .select(
      '_id url domain title description language publishedAt author section siteName imageUrl lastCrawledAt'
    )
    .lean();

  if (pages.length === 0) return empty();

  const ranked = pages.map(p => {
    const s = stats.get(p._id.toString()) || { frequency: 0, matched: 0 };
    const coverage = (s.matched / Math.max(1, searchTerms.length)) * 60;
    const titleHit =
      searchTerms.filter(t =>
        String(p.title || '')
          .toLowerCase()
          .includes(t)
      ).length * 12;
    const freq = Math.min(s.frequency, 40);

    // Recency matters far more in news than in general web search.
    const when = p.publishedAt || p.lastCrawledAt;
    let recency = 0;
    if (when) {
      const ageDays = (Date.now() - new Date(when).getTime()) / 86400000;
      if (ageDays < 1) recency = 30;
      else if (ageDays < 7) recency = 20;
      else if (ageDays < 30) recency = 10;
      else if (ageDays < 365) recency = 3;
    }

    return { page: p, score: coverage + titleHit + freq + recency };
  });

  if (sort === 'relevance') {
    ranked.sort(
      (a, b) => b.score - a.score || String(a.page.url).localeCompare(String(b.page.url))
    );
  } else {
    // By publication date; undated articles after every dated one, either way.
    const direction = sort === 'oldest' ? 1 : -1;
    const dateOf = p => (p.publishedAt ? new Date(p.publishedAt).getTime() : null);
    ranked.sort((a, b) => {
      const at = dateOf(a.page);
      const bt = dateOf(b.page);
      if (at === null || bt === null) {
        if (at !== bt) return at === null ? 1 : -1;
        return b.score - a.score;
      }
      if (at === bt) return b.score - a.score;
      return (at - bt) * direction;
    });
  }

  const slice = paginate(ranked, page, limit, offset);

  return {
    results: slice.map(({ page: p, score }) => ({
      id: p._id.toString(),
      title: p.title || p.url,
      url: p.url,
      domain: p.domain || '',
      source: p.siteName || p.domain || '',
      snippet: p.description || '',
      author: p.author || '',
      section: p.section || '',
      imageUrl: p.imageUrl || '',
      publishedAt: p.publishedAt || null,
      time: relativeTime(p.publishedAt || p.lastCrawledAt),
      score: Number(score.toFixed(2))
    })),
    totalResults: ranked.length,
    searchTerms,
    responseTimeMs: Date.now() - startedAt
  };
}

function relativeTime(date) {
  if (!date) return '';
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 0) return 'Just now';
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  const days = Math.floor(seconds / 86400);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

// ---------------------------------------------------------------------
// Maps / places
// ---------------------------------------------------------------------

async function searchPlaces({ query, page = 1, limit = 10, offset, domain = '' }) {
  const startedAt = Date.now();
  const searchTerms = tokenizeText(query);

  const empty = () => ({
    results: [],
    totalResults: 0,
    searchTerms,
    responseTimeMs: Date.now() - startedAt
  });

  if (searchTerms.length === 0) return empty();

  const filter = { terms: { $in: searchTerms } };
  if (domain) filter.domain = domainClause(domain);

  const candidates = await Place.find(filter).limit(MAX_CANDIDATES).lean();
  if (candidates.length === 0) return empty();

  const phrase = String(query || '')
    .trim()
    .toLowerCase();

  const ranked = candidates.map(place => {
    const terms = new Set(place.terms || []);
    let matched = 0;
    for (const term of searchTerms) if (terms.has(term)) matched += 1;

    let score = (matched / Math.max(1, searchTerms.length)) * 100;
    const name = String(place.name || '').toLowerCase();
    if (phrase && name === phrase)
      score += 40; // exact place name
    else if (phrase && name.includes(phrase)) score += 20;
    if (place.address) score += 6;

    return { place, score };
  });

  ranked.sort(
    (a, b) => b.score - a.score || String(a.place.name).localeCompare(String(b.place.name))
  );

  // One row per place name keeps the list readable when several pages
  // describe the same location.
  const seen = new Set();
  const deduped = [];
  for (const row of ranked) {
    const key = row.place.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  const slice = paginate(deduped, page, limit, offset);

  return {
    results: slice.map(({ place, score }) => ({
      id: place._id.toString(),
      name: place.name,
      latitude: place.latitude,
      longitude: place.longitude,
      address: place.address || '',
      category: place.category || '',
      sourcePage: place.pageUrl,
      sourceTitle: place.pageTitle || '',
      domain: place.domain || '',
      // Ready-to-use links for the frontend; no API key required.
      mapUrl: `https://www.openstreetmap.org/?mlat=${place.latitude}&mlon=${place.longitude}#map=13/${place.latitude}/${place.longitude}`,
      embedUrl: osmEmbedUrl(place.latitude, place.longitude),
      score: Number(score.toFixed(2))
    })),
    totalResults: deduped.length,
    searchTerms,
    responseTimeMs: Date.now() - startedAt
  };
}

/** A key-free OpenStreetMap embed centred on the point. */
function osmEmbedUrl(lat, lon, spread = 0.03) {
  const bbox = [lon - spread, lat - spread / 2, lon + spread, lat + spread / 2]
    .map(n => n.toFixed(5))
    .join('%2C');
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat}%2C${lon}`;
}

// ---------------------------------------------------------------------

/** How much content each vertical actually holds — used by /api/search/config. */
async function getVerticalCounts() {
  const [images, videos, articles, places] = await Promise.all([
    Media.countDocuments({ type: 'image' }),
    Media.countDocuments({ type: 'video' }),
    Page.countDocuments({ isArticle: true }),
    Place.countDocuments()
  ]);
  return { images, videos, news: articles, maps: places };
}

/** Escapes a value for use in a regular expression (re-exported for callers). */
const escape = escapeRegex;

module.exports = {
  searchMedia,
  searchNews,
  searchPlaces,
  getVerticalCounts,
  formatDuration,
  relativeTime,
  scoreMediaItem,
  osmEmbedUrl,
  escape
};
