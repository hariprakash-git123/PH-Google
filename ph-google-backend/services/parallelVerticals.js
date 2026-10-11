const { config } = require('../config/env');
const logger = require('../utils/logger');
const externalSearch = require('./externalSearch');
const verticalSearchService = require('./verticalSearchService');
const parallelClient = require('./external/parallelClient');
const pageImages = require('./external/pageImages');
const videoPlatforms = require('./external/videoPlatforms');
const pagePlaces = require('./external/pagePlaces');
const placeTrust = require('./external/placeTrust');
const nominatimClient = require('./external/nominatimClient');
const { parseQuery } = require('./opensearch/queryParser');
const { buildParallelRequest } = require('./external/parallelQuery');
const { meaningfulTerms, requiredMentions, mentionedTerms } = require('./external/resultRelevance');
const { DOWNLOAD_PURPOSE } = require('./external/serpApiImageMapper');
const { signUrl } = require('../utils/urlSigner');
const { canonicalKey } = require('../utils/urlNormalizer');
const { sha1 } = require('./opensearch/documentMapper');
const { text, httpUrl, positiveInt, domainOf } = require('./external/fields');

/**
 * The Images, Videos and Maps tabs without an image, video or places provider.
 *
 * Parallel is a web search: it answers with pages — an address, a title, a
 * date and excerpts of text. It has no picture or video search, and its
 * answers carry no image address and no video metadata. So it is used for
 * what it is, discovery, and nothing it returns is shown until it has been
 * checked against the thing itself:
 *
 *   Videos  the search is restricted to video platforms; a result is kept
 *           only if its address is one video's page and the platform's own
 *           oEmbed endpoint confirms the video (external/videoPlatforms.js).
 *           Title, channel and thumbnail are the platform's.
 *   Images  the pages found are read, and a picture is kept only if its own
 *           words are about the subject and its address really serves an
 *           image of a useful size (external/pageImages.js).
 *   Maps    the pages found are read for the structured description of a
 *           place that they publish themselves (schema.org; see
 *           external/pagePlaces.js). Name, address, phone, rating and
 *           coordinates are what the page states — nothing is read out of
 *           its prose. A page's coordinates and its address need not agree,
 *           so a place is pinned only when something independent places it
 *           in the town its address names (external/placeTrust.js);
 *           otherwise it is listed with its details and its source, and no
 *           pin. With MAPS_OSM_ENABLED, OpenStreetMap is that independent
 *           check, and places it knows itself are added
 *           (external/nominatimClient.js).
 *
 * The crawler's own images and videos for the query come first, in the same
 * result shape; what Parallel adds follows, without repeats. With nothing
 * genuine from either, the tab is empty and says so — a page that merely
 * mentions the words is never offered as a picture or a video.
 *
 * Used only while SerpApi cannot serve these tabs and
 * PARALLEL_VERTICALS_ENABLED is on (see externalVerticals.js).
 *
 * Parallel returns at most 20 pages a request, so a tab asks the question a
 * few ways at once (three requests for Videos, two for Images and Maps) and merges the
 * answers. They go through the same cache, daily limit and failure pauses as
 * web search (externalSearch.fetchCached), each request counted; what is
 * cached is the verified list, so paging and repeats cost nothing.
 */

const CATEGORIES = ['images', 'videos', 'maps'];

/** Words that ask for the medium, not the subject: not required of a result. */
const MEDIA_WORDS = {
  images: new Set(['image', 'photo', 'picture', 'pic', 'pics']),
  videos: new Set(['video', 'clip']),
  maps: new Set(['map', 'location', 'direction', 'nearby'])
};

/** What the keyword query is given so the search leans towards the medium. */
const MEDIA_HINT = { images: 'photos', videos: 'video' };

/** Pages read for pictures, and pictures checked, per search. */
/** The most pages Parallel returns for one request. */
const RESULTS_PER_REQUEST = 20;

/**
 * Parallel's Search API has no page, offset or cursor: one request returns at
 * most 20 pages, and asking the same thing again returns the same pages. So
 * "Load more" on Images and Videos, once the verified list has been shown,
 * asks again in other words — a further round of requests — and adds only
 * what the earlier rounds did not find. These are those other words, per
 * round after the first (whose words are in buildRequest). The list is
 * finite: after the last round, or a round that adds nothing new, there is
 * no more.
 */
const MORE_WAYS = {
  images: [
    keywords => [`${keywords} pictures`, `${keywords} photography`],
    keywords => [`${keywords} photo gallery`, `free ${keywords} photos`],
    keywords => [`${keywords} hd pictures`, `${keywords} stock photos`],
    keywords => [`${keywords} pics`, `${keywords} image collection`],
    keywords => [`best ${keywords} photos`, `${keywords} high resolution images`]
  ],
  videos: [
    keywords => [`${keywords} videos`, `${keywords} youtube`, `watch ${keywords}`],
    keywords => [`${keywords} clip`, `${keywords} full video`, `new ${keywords} videos`]
  ]
};

/** How many rounds a vertical's list can be made of. */
function maxRounds(category) {
  return 1 + (MORE_WAYS[category] || []).length;
}

/**
 * Images fill each page — the first one included — from as many rounds as it
 * takes, up to the last; Videos add at most one round per Load more. Rounds
 * are sent at most two at a time (PARALLEL_MAX_CONCURRENT's default), and only
 * as many as the shortfall looks to need, judged by what the last round added.
 */
const FILLS_PAGE = new Set(['images']);
const ROUNDS_AT_ONCE = 2;
const MAX_PAGES = 24;
const MAX_IMAGES_CHECKED = 120;
const MAX_IMAGES = 80;
const CHECKS_AT_ONCE = 24;
/** Pictures not checked within this long of the search starting are left out. */
const IMAGE_BUDGET_MS = 9000;
/** These tabs wait longer for Parallel than web search does: here it is the result. */
const MIN_TIMEOUT_MS = 8000;
/** How much of what Parallel quoted from a page is read to judge its subject. */
const EVIDENCE_CHARS = 3000;
/** The crawler's results are merged from its first page of this size. */
const CRAWLER_RESULTS = 50;
/** Places shown for one search. */
const MAX_PLACES = 60;
/** Two entries of one name this close together are one place. */
const SAME_PLACE_METRES = 300;
/** Closer than this, "Third Wave Coffee" and "Third Wave Coffee Roasters" are one. */
const SAME_SPOT_METRES = 150;

/**
 * Hosts that name themselves as adult sites. A web search for an ordinary
 * subject can still return one, and a picture grid is not the place to find
 * that out: their pages are not read and their pictures are not shown.
 */
const ADULT_ANYWHERE = /xxx|porn|xvideos|xnxx|xhamster|hentai|nsfw|erotic/;
/** Only at the start of a name: "essex" and "middlesex" are places. */
const ADULT_AT_START = /^(sex|adult|nude)/;

function isAdultHost(url) {
  try {
    return new URL(url).hostname
      .toLowerCase()
      .split('.')
      .some(label => ADULT_ANYWHERE.test(label) || ADULT_AT_START.test(label));
  } catch {
    return true;
  }
}

function handles(category) {
  return CATEGORIES.includes(category);
}

/** Whether these tabs may use Parallel at all, and if not, why. */
function available() {
  if (!config.parallel.verticals) return { ok: false, status: 'disabled', reason: 'disabled' };
  return externalSearch.parallelAvailability();
}

/** The subject of the query: its meaningful terms without the medium words. */
function subjectTerms(parsed, category) {
  return meaningfulTerms(parsed).filter(term => !MEDIA_WORDS[category].has(term));
}

/** Whether a piece of text is about the subject, to the usual standard. */
function covers(value, terms) {
  return terms.length === 0 || mentionedTerms(value, terms) >= requiredMentions(terms.length);
}

/**
 * The Parallel request for a tab, or the reason there is none.
 * Operators and filters are handled exactly as for web search.
 */
function buildRequest(parsed, category, params, round = 0) {
  const web = buildParallelRequest(parsed, {
    page: 1,
    sort: params.sort,
    domain: params.domain,
    dateWindow: params.dateWindow,
    language: params.language
  });
  if (web.skip) return web;

  const sourcePolicy = { ...web.sourcePolicy };
  if (category === 'videos') {
    // Only platforms whose videos can be confirmed. A site: filter naming
    // one of them narrows to it; one naming anything else cannot be served.
    const asked = sourcePolicy.include_domains;
    const allowed = asked
      ? asked.filter(domain => videoPlatforms.DOMAINS.includes(String(domain).toLowerCase()))
      : videoPlatforms.DOMAINS;
    if (allowed.length === 0) return { skip: true, reason: 'unsupported_filter' };
    sourcePolicy.include_domains = allowed;
  }

  const keywords = web.searchQueries[0];
  if (category === 'maps') {
    return {
      skip: false,
      objective: `places: ${web.objective}, with their addresses and locations`,
      searchQueries: [...new Set([keywords, `${keywords} address`])],
      sourcePolicy
    };
  }
  const hint = MEDIA_HINT[category];
  const hinted = new RegExp(`\\b${hint}s?\\b`, 'i').test(keywords)
    ? keywords
    : `${keywords} ${hint}`;
  // The same question asked a few ways: each is its own request, and each
  // finds pages the others do not.
  const first =
    category === 'videos'
      ? [hinted, keywords, /^best\b/i.test(keywords) ? `top ${keywords}` : `best ${keywords}`]
      : [hinted, `${keywords} images`];
  // Each round asks only what no earlier round asked.
  const asked = new Set();
  const rounds = [first, ...(MORE_WAYS[category] || []).map(more => more(keywords))]
    .map(ways => [...new Set(ways)].filter(way => !asked.has(way.toLowerCase())))
    .map(ways => {
      ways.forEach(way => asked.add(way.toLowerCase()));
      return ways;
    });
  if (round >= rounds.length || rounds[round].length === 0) {
    return { skip: true, reason: 'no_more_rounds' };
  }
  return {
    skip: false,
    objective:
      category === 'videos'
        ? `videos about ${web.objective}`
        : `photos and pictures of ${web.objective}`,
    searchQueries: rounds[round],
    sourcePolicy
  };
}

/**
 * Sends one Parallel request per way of asking, together, and merges the
 * answers: the first of each, then the second of each, so the best of every
 * request leads. One that fails is left out; if all fail, the first failure
 * is the outcome.
 *
 * @returns {Promise<Array<Object>>} Parallel results, without repeats
 * @throws {ExternalSearchError}
 */
async function askEveryWay({ objective, searchQueries, sourcePolicy }) {
  const settings = { timeoutMs: Math.max(config.parallel.timeoutMs, MIN_TIMEOUT_MS) };
  // fetchCached has counted one request; the others are counted here.
  externalSearch.recordExtraRequests('parallel', searchQueries.length - 1);
  const answers = await Promise.allSettled(
    searchQueries.map(query =>
      parallelClient.search(
        { objective, searchQueries: [query], sourcePolicy, maxResults: RESULTS_PER_REQUEST },
        { settings }
      )
    )
  );
  const lists = answers
    .filter(answer => answer.status === 'fulfilled')
    .map(answer => (Array.isArray(answer.value.results) ? answer.value.results : []));
  if (lists.length === 0) throw answers[0].reason;

  const seen = new Set();
  const merged = [];
  const longest = Math.max(0, ...lists.map(list => list.length));
  for (let i = 0; i < longest; i += 1) {
    for (const list of lists) {
      const entry = list[i];
      if (entry === undefined) continue;
      const key = entry && typeof entry === 'object' ? String(entry.url) : null;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      merged.push(entry);
    }
  }
  return merged;
}

/** Runs `task` over `items`, `size` at a time, keeping the order of results. */
async function inBatches(items, size, task) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/** Parallel's first excerpt as plain text. */
function excerptOf(raw, max = 240) {
  const all = (Array.isArray(raw.excerpts) ? raw.excerpts : [])
    .filter(excerpt => typeof excerpt === 'string')
    .join(' ');
  return text(all.replace(/[*_#>`[\]]/g, ' '), max);
}

/**
 * Parallel's pages → confirmed videos, in Parallel's order.
 *
 * @param {Array<Object>} raw  Parallel results: { url, title, publish_date, excerpts }
 * @param {string[]} terms
 * @returns {Promise<{results: Array<Object>, stats: Object}>}
 */
async function confirmVideos(raw, terms) {
  const stats = { found: raw.length, notAVideoPage: 0, notConfirmed: 0, offSubject: 0 };
  const seen = new Set();
  const candidates = [];
  for (const entry of raw) {
    const video =
      entry && typeof entry === 'object' ? videoPlatforms.parseVideoUrl(entry.url) : null;
    if (!video) {
      stats.notAVideoPage += 1;
      continue;
    }
    if (seen.has(video.key)) continue;
    seen.add(video.key);
    candidates.push({ video, entry });
  }

  const checked = await inBatches(candidates, CHECKS_AT_ONCE, async ({ video, entry }) => {
    const confirmed = await videoPlatforms.lookup(video);
    if (!confirmed.ok) {
      stats.notConfirmed += 1;
      return null;
    }
    const snippet = excerptOf(entry);
    // Judged on the platform's own title and the text found with the video
    // (its description, as Parallel quotes it).
    // A video's title names the dish, not "cooking": the platform's title or
    // channel must touch the subject, and title and description together
    // must mention at least half of its words.
    const named = `${confirmed.title} ${confirmed.channel}`;
    const evidence = `${named} ${excerptOf(entry, EVIDENCE_CHARS)}`;
    const onSubject =
      terms.length === 0 ||
      (mentionedTerms(named, terms) > 0 &&
        mentionedTerms(evidence, terms) >= Math.ceil(terms.length / 2));
    if (!onSubject) {
      stats.offSubject += 1;
      return null;
    }
    const published = Date.parse(String(entry.publish_date || '').slice(0, 10));
    return {
      id: `parallel-video:${sha1(video.key)}`,
      title: confirmed.title,
      thumbnailUrl: confirmed.thumbnailUrl,
      videoUrl: video.videoUrl,
      sourceUrl: video.videoUrl,
      sourceDomain: domainOf(video.videoUrl),
      sourceName: video.label,
      channel: confirmed.channel || null,
      duration: null,
      publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
      publishedAgo: null,
      snippet,
      dedupeKey: video.key,
      source: 'parallel'
    };
  });

  return { results: checked.filter(Boolean), stats };
}

/**
 * Parallel's pages → verified pictures found on them.
 *
 * @param {Array<Object>} raw  Parallel results
 * @param {string[]} terms
 * @returns {Promise<{results: Array<Object>, stats: Object}>}
 */
async function findImages(raw, terms) {
  const startedAt = Date.now();
  const stats = { found: raw.length, pagesRead: 0, pagesUnreadable: 0, candidates: 0, rejected: 0 };

  // Only pages that are themselves about the subject are worth reading.
  const pages = raw
    .filter(entry => entry && typeof entry === 'object' && httpUrl(entry.url))
    .filter(entry => !isAdultHost(entry.url))
    .filter(entry =>
      covers(`${entry.title || ''} ${excerptOf(entry, EVIDENCE_CHARS)} ${entry.url}`, terms)
    )
    .slice(0, MAX_PAGES);

  const read = await Promise.all(
    pages.map(entry => pageImages.candidatesFromPage(httpUrl(entry.url), terms))
  );

  // One picture from each page in turn, so no single page fills the tab.
  const queue = [];
  const seenUrl = new Set();
  const depth = Math.max(0, ...read.map(page => page.candidates.length));
  read.forEach(page => {
    if (page.reason) stats.pagesUnreadable += 1;
    else stats.pagesRead += 1;
  });
  for (let i = 0; i < depth; i += 1) {
    read.forEach((page, p) => {
      const candidate = page.candidates[i];
      if (!candidate) return;
      const key = pageImages.imageIdentity(candidate.imageUrl);
      if (seenUrl.has(key) || isAdultHost(candidate.imageUrl)) return;
      seenUrl.add(key);
      queue.push({ ...candidate, pageUrl: page.pageUrl, pageTitle: text(pages[p].title, 200) });
    });
  }
  const toCheck = queue.slice(0, MAX_IMAGES_CHECKED);
  stats.candidates = toCheck.length;

  const checked = await inBatches(toCheck, CHECKS_AT_ONCE, async candidate => {
    // A search page cannot wait on the slowest site: what has not been
    // checked in time is left out, never shown unchecked.
    if (Date.now() - startedAt > IMAGE_BUDGET_MS) return null;
    const verified = await pageImages.verifyImage(candidate.imageUrl);
    return verified.ok ? { candidate, verified } : null;
  });

  const seenFile = new Set();
  const results = [];
  for (const item of checked) {
    if (!item) {
      stats.rejected += 1;
      continue;
    }
    const { candidate, verified } = item;
    const urlKey = pageImages.imageIdentity(verified.imageUrl);
    if (seenFile.has(verified.fingerprint) || seenFile.has(urlKey)) continue;
    seenFile.add(verified.fingerprint);
    seenFile.add(urlKey);
    if (results.length >= MAX_IMAGES) break;
    results.push({
      id: `parallel-image:${sha1(verified.imageUrl)}`,
      title: candidate.title || candidate.pageTitle,
      imageUrl: verified.imageUrl,
      // There is no separate thumbnail: the picture itself is shown small.
      thumbnailUrl: verified.imageUrl,
      sourceUrl: candidate.pageUrl,
      sourceDomain: domainOf(candidate.pageUrl),
      sourceName: '',
      width: verified.width,
      height: verified.height,
      downloadToken: signUrl(DOWNLOAD_PURPOSE, verified.imageUrl),
      dedupeKey: urlKey,
      source: 'parallel'
    });
  }
  return { results, stats };
}

/** A name for comparing: lower case, no punctuation, no accents. */
function nameKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function hasCoordinates(place) {
  return typeof place.latitude === 'number' && typeof place.longitude === 'number';
}

/** A link that shows the place on a map: at its coordinates, or a search for it. */
function mapLinkFor(place) {
  if (hasCoordinates(place)) {
    const { latitude, longitude } = place;
    return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`;
  }
  const query = [place.title, place.address].filter(Boolean).join(', ');
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`;
}

/** A phone number, a rating, or a website that is not the listing's own. */
function hasCheckableDetail(place) {
  if (place.phone || place.rating !== null) return true;
  return Boolean(place.website) && domainOf(place.website) !== domainOf(place.sourceUrl);
}

/**
 * Whether two entries are the same place: the same name, and close together
 * — or, when one has no position, the same phone number or address. A chain
 * has many branches of one name; those are different places.
 */
function samePlace(a, b) {
  const nameA = nameKey(a.title);
  const nameB = nameKey(b.title);
  if (nameA !== nameB) {
    // A longer form of the same name, at the same spot.
    const contained =
      Math.min(nameA.length, nameB.length) >= 5 && (nameA.includes(nameB) || nameB.includes(nameA));
    return (
      contained &&
      hasCoordinates(a) &&
      hasCoordinates(b) &&
      pagePlaces.distanceMetres(a, b) <= SAME_SPOT_METRES
    );
  }
  if (hasCoordinates(a) && hasCoordinates(b)) {
    return pagePlaces.distanceMetres(a, b) <= SAME_PLACE_METRES;
  }
  const digits = value =>
    String(value || '')
      .replace(/\D/g, '')
      .slice(-9);
  if (a.phone && b.phone && digits(a.phone) === digits(b.phone)) return true;
  const addressA = nameKey(a.address);
  const addressB = nameKey(b.address);
  if (!addressA || !addressB) return a.sourceUrl === b.sourceUrl;
  return addressA === addressB || addressA.includes(addressB) || addressB.includes(addressA);
}

/**
 * Parallel's pages → the places those pages describe.
 *
 * @param {Array<Object>} raw  Parallel results
 * @param {string[]} terms
 * @returns {Promise<{results: Array<Object>, stats: Object}>}
 */
async function findPlaces(raw, terms, { query = '', siteRestricted = false } = {}) {
  // OpenStreetMap is asked once, alongside the pages being read (when it is
  // on). Not under a site filter: its places are from no page on that site.
  const fromMap =
    nominatimClient.available().ok && !siteRestricted
      ? nominatimClient.searchPlaces(query)
      : Promise.resolve({ ok: false, reason: siteRestricted ? 'site_filter' : 'disabled' });

  const stats = {
    found: raw.length,
    pagesRead: 0,
    pagesUnreadable: 0,
    described: 0,
    offSubject: 0,
    unsupported: 0,
    pinned: 0
  };

  // Only pages that are themselves about the subject are worth reading.
  const pages = raw
    .filter(entry => entry && typeof entry === 'object' && httpUrl(entry.url))
    .filter(entry => !isAdultHost(entry.url))
    .filter(entry =>
      covers(`${entry.title || ''} ${excerptOf(entry, EVIDENCE_CHARS)} ${entry.url}`, terms)
    )
    .slice(0, MAX_PAGES);

  const read = await Promise.all(pages.map(entry => pagePlaces.placesFromPage(httpUrl(entry.url))));

  const kept = [];
  read.forEach(page => {
    if (page.reason) stats.pagesUnreadable += 1;
    else stats.pagesRead += 1;
    stats.described += page.places.length;
    // A page about one place vouches for it: Parallel found that page for
    // this search. On a page listing many, each must speak for itself.
    const vouched = page.places.length === 1;
    for (const place of page.places) {
      const own = `${place.title} ${place.address || ''} ${place.category || ''} ${place.about}`;
      const needed = vouched ? 0 : Math.ceil(terms.length / 2);
      if (terms.length > 0 && mentionedTerms(own, terms) < needed) {
        stats.offSubject += 1;
        continue;
      }
      // A list of bare names and addresses is the easiest thing to make up,
      // and some sites do. From a page listing many, a place is taken only
      // with something that can be checked: a phone number, a rating, or a
      // site of its own.
      if (!vouched && !hasCheckableDetail(place)) {
        stats.unsupported += 1;
        continue;
      }
      // The same place described twice — on one page or on two — is kept
      // once, with whatever either description states.
      const twin = kept.find(other => samePlace(other, place));
      if (twin) {
        for (const [field, value] of Object.entries(place)) {
          if ((twin[field] === null || twin[field] === undefined) && value !== null) {
            twin[field] = value;
          }
        }
        continue;
      }
      kept.push({ ...place });
    }
  });

  // Ids are settled before any pin is withheld, so a place keeps its id
  // whether or not its position could be checked.
  const described = kept.map(place => ({
    id: `parallel-place:${sha1(`${nameKey(place.title)}|${place.sourceUrl}|${place.latitude},${place.longitude}`)}`,
    ...place,
    sourceDomain: domainOf(place.sourceUrl),
    source: 'parallel'
  }));

  // A page's coordinates are shown only if something independent agrees.
  const trust = await placeTrust.assessLocations(described);
  Object.assign(stats, {
    locationsVerified: trust.stats.verified,
    locationsUnverified: trust.stats.unverified,
    localityLookups: trust.stats.lookups
  });

  // What OpenStreetMap itself knows: its own places at its own positions.
  const map = await fromMap;
  const mapPlaces = (map.ok ? map.places : [])
    .filter(place => {
      const own = `${place.title} ${place.address || ''} ${place.category || ''} ${place.about}`;
      return terms.length === 0 || mentionedTerms(own, terms) >= Math.ceil(terms.length / 2);
    })
    .map(place => ({ ...place, locationStatus: 'verified', locationEvidence: 'map' }));
  stats.fromOpenStreetMap = mapPlaces.length;
  if (!map.ok && map.reason !== 'disabled') stats.openStreetMap = map.reason;

  // One place once. A page's description is the richer one and is kept when
  // its position checked out; where it did not, OpenStreetMap's entry for
  // the same place stands in its stead — as its own result, with its own
  // source, never as a correction of the page's.
  const pinned = trust.places.filter(hasCoordinates);
  const unpinned = trust.places.filter(place => !hasCoordinates(place));
  const added = [];
  for (const place of mapPlaces) {
    if ([...pinned, ...added].some(other => samePlace(other, place))) continue;
    added.push(place);
  }
  const leftUnpinned = unpinned.filter(place => !added.some(other => samePlace(other, place)));

  // Places that can be pinned lead, so the map's numbers start at the top.
  const results = [...pinned, ...added, ...leftUnpinned]
    .slice(0, MAX_PLACES)
    .map(({ about: _about, locality: _l, region: _r, country: _c, postalCode: _p, ...place }) => ({
      ...place,
      mapsUrl: mapLinkFor(place)
    }));
  stats.pinned = results.filter(hasCoordinates).length;
  return { results, stats };
}

/** A crawler place in the shape the Maps tab renders. Null when unusable. */
function fromCrawlerPlace(item) {
  const title = text(item && item.name, 200);
  const latitude = Number(item && item.latitude);
  const longitude = Number(item && item.longitude);
  if (!title || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const sourceUrl = httpUrl(item.sourcePage);
  const place = {
    id: `index-place:${item.id}`,
    title,
    address: text(item.address, 300) || null,
    rating: null,
    reviews: null,
    phone: null,
    website: null,
    category: text(item.category, 80) || null,
    latitude,
    longitude,
    hours: null,
    thumbnailUrl: null,
    sourceUrl,
    sourceDomain: item.domain || domainOf(sourceUrl),
    relevanceText: `${item.name || ''} ${item.address || ''} ${item.category || ''} ${item.sourceTitle || ''}`,
    source: 'index'
  };
  return { ...place, mapsUrl: mapLinkFor(place) };
}

/** A crawler image in the shape the Images tab renders. Null when unusable. */
function fromCrawlerImage(item) {
  const imageUrl = httpUrl(item && item.url);
  if (!imageUrl) return null;
  const sourceUrl = httpUrl(item.sourcePage);
  return {
    id: `index-image:${item.id}`,
    title: text(item.title, 200),
    imageUrl,
    thumbnailUrl: imageUrl,
    sourceUrl,
    sourceDomain: item.domain || domainOf(sourceUrl || imageUrl),
    sourceName: '',
    width: positiveInt(item.width),
    height: positiveInt(item.height),
    downloadToken: signUrl(DOWNLOAD_PURPOSE, imageUrl),
    dedupeKey: pageImages.imageIdentity(imageUrl),
    relevanceText: `${item.title || ''} ${item.alt || ''} ${item.caption || ''} ${item.sourceTitle || ''}`,
    source: 'index'
  };
}

/** A crawler video in the shape the Videos tab renders. Null when unusable. */
function fromCrawlerVideo(item) {
  const pageUrl = httpUrl(item && item.sourcePage);
  const known =
    videoPlatforms.parseVideoUrl(item && item.url) || videoPlatforms.parseVideoUrl(pageUrl);
  const videoUrl = known ? known.videoUrl : pageUrl || httpUrl(item && item.url);
  if (!videoUrl) return null;
  return {
    id: `index-video:${item.id}`,
    title: text(item.title, 200) || domainOf(videoUrl),
    thumbnailUrl: httpUrl(item.thumbnailUrl),
    videoUrl,
    sourceUrl: pageUrl || videoUrl,
    sourceDomain: domainOf(pageUrl || videoUrl),
    sourceName: known ? known.label : '',
    channel: null,
    duration: item.duration || null,
    publishedAt: null,
    publishedAgo: null,
    snippet: '',
    dedupeKey: known ? known.key : canonicalKey(videoUrl) || videoUrl,
    relevanceText: `${item.title || ''} ${item.sourceTitle || ''}`,
    source: 'index'
  };
}

/** The crawler's own results for the query that are about its subject. */
async function crawlerResults(category, params, terms) {
  try {
    // The whole first part of the list, whatever batch is being shown: the
    // combined list is cut afterwards.
    const first = { ...params, page: 1, offset: 0, limit: CRAWLER_RESULTS };
    const outcome =
      category === 'maps'
        ? await verticalSearchService.searchPlaces(first)
        : await verticalSearchService.searchMedia(category === 'images' ? 'image' : 'video', first);
    const map = { images: fromCrawlerImage, videos: fromCrawlerVideo, maps: fromCrawlerPlace }[
      category
    ];
    return (outcome.results || [])
      .map(map)
      .filter(Boolean)
      .filter(result => terms.length === 0 || mentionedTerms(result.relevanceText, terms) > 0);
  } catch (error) {
    logger.warn('Crawler media search failed; continuing without it', {
      category,
      message: error.message
    });
    return [];
  }
}

/** Whether a Parallel result is dated on or after `afterDate` (YYYY-MM-DD); true without one. */
function publishedSince(entry, afterDate) {
  if (!afterDate) return true;
  const raw = entry && typeof entry === 'object' ? String(entry.publish_date || '') : '';
  const day = raw.slice(0, 10);
  return Number.isFinite(Date.parse(day)) && day >= afterDate;
}

/**
 * One round of Parallel requests for a vertical, verified, through the shared
 * cache and daily limit (each round has its own words, so its own cache entry).
 */
function fetchRound(category, request, terms) {
  const { objective, searchQueries, sourcePolicy } = request;
  const { mode } = config.parallel;
  return externalSearch.fetchCached(
    category,
    { objective, searchQueries, sourcePolicy, mode, maxResults: RESULTS_PER_REQUEST },
    async () => {
      // Parallel is asked for pages published on or after `after_date`; it is
      // checked again here, as for web results (parallelMapper.withinDate),
      // so a page with no date, or an earlier one, is not presented as inside
      // the window.
      const list = (await askEveryWay({ objective, searchQueries, sourcePolicy })).filter(entry =>
        publishedSince(entry, sourcePolicy && sourcePolicy.after_date)
      );
      const verify = { images: findImages, videos: confirmVideos, maps: findPlaces }[category];
      const { results, stats } = await verify(list, terms, {
        query: searchQueries[0],
        siteRestricted: Boolean(sourcePolicy && sourcePolicy.include_domains)
      });
      logger.debug('Parallel vertical search verified', {
        category,
        query: searchQueries[0],
        kept: results.length,
        ...stats
      });
      return { results };
    },
    'parallel'
  );
}

/**
 * The crawler's results, then each round's in turn, without repeats.
 *
 * @returns {{all: Array<Object>, addedByRound: number[]}} addedByRound: how
 *          many new results each round brought, in order
 */
function combine(category, fromIndex, outcomes) {
  const seen = new Set(fromIndex.map(result => result.dedupeKey));
  const all = [...fromIndex];
  const addedByRound = [];
  for (const outcome of outcomes) {
    const added = (outcome.status === 'ok' ? outcome.results : []).filter(result => {
      if (category === 'maps') return !all.some(place => samePlace(place, result));
      if (seen.has(result.dedupeKey)) return false;
      seen.add(result.dedupeKey);
      return true;
    });
    all.push(...added);
    addedByRound.push(added.length);
  }
  return {
    all: all.map(({ dedupeKey: _key, relevanceText: _text, ...result }, i) => ({
      ...result,
      position: i + 1
    })),
    addedByRound
  };
}

/**
 * How many new results the latest rounds brought, and per round: the last
 * round's for a vertical asking one round at a time, the last two's for one
 * asking two at once — so a list ends when a whole step finds nothing new,
 * not when one of two rounds sent together happens to.
 */
function recentYield(addedByRound, window) {
  const recent = addedByRound.slice(-Math.min(window, addedByRound.length));
  const total = recent.reduce((sum, n) => sum + n, 0);
  return { total, perRound: recent.length ? total / recent.length : 0 };
}

/**
 * @param {'images'|'videos'|'maps'} category
 * @param {Object} params  query, page, limit, sort, domain, dateWindow, language;
 *                         for "Load more": offset, and rounds (from the cursor)
 * @returns {Promise<{results, totalResults, searchTerms, responseTimeMs, external,
 *                    rounds, moreRounds, moreFailed?}>}
 *          rounds: how many rounds the list is made of now; moreRounds: whether
 *          a further round may still find more; moreFailed: the status of a
 *          further round that was needed and could not be had
 */
async function search(category, params) {
  const startedAt = Date.now();
  const parsed = parseQuery(params.query);
  const terms = subjectTerms(parsed, category);
  const most = maxRounds(category);

  const fromIndex = await crawlerResults(category, params, terms);

  const page = Math.max(1, params.page || 1);
  const limit = Math.max(1, params.limit || 10);
  const loadingMore = Number.isInteger(params.offset) && params.offset >= 0;
  // "Load more" asks for the results after those already shown.
  const start = loadingMore ? params.offset : (page - 1) * limit;

  const request = buildRequest(parsed, category, params);
  const outcomes = [];
  let rounds = 1;
  let moreFailed = null;
  if (request.skip) {
    outcomes.push({ status: 'skipped', reason: request.reason });
  } else {
    // The rounds the list was already made of: cached, so asked again only
    // if the cache has let them go.
    rounds = Math.min(most, Math.max(1, Number.isInteger(params.rounds) ? params.rounds : 1));
    for (let round = 0; round < rounds; round += 1) {
      const asked = round === 0 ? request : buildRequest(parsed, category, params, round);
      outcomes.push(
        asked.skip
          ? { status: 'skipped', reason: asked.reason }
          : await fetchRound(category, asked, terms)
      );
    }
  }

  let { all, addedByRound } = combine(category, fromIndex, outcomes);
  const firstOk = outcomes[0].status === 'ok';
  // Past the end of the list: further rounds, asked in other words.
  const fills = FILLS_PAGE.has(category);
  const window = fills ? ROUNDS_AT_ONCE : 1;
  let recent = recentYield(addedByRound, window);
  while (
    (fills || loadingMore) &&
    firstOk &&
    !moreFailed &&
    start + limit > all.length &&
    rounds < most &&
    recent.total > 0
  ) {
    const missing = start + limit - all.length;
    const count = fills
      ? Math.min(ROUNDS_AT_ONCE, most - rounds, Math.ceil(missing / Math.max(1, recent.perRound)))
      : 1;
    const asked = Array.from({ length: count }, (_, i) =>
      buildRequest(parsed, category, params, rounds + i)
    );
    const fetched = await Promise.all(
      asked.map(request => (request.skip ? null : fetchRound(category, request, terms)))
    );
    // Rounds are kept in order: one that is not had stops there, and the
    // next Load more asks for it again (those after it are in the cache).
    for (const next of fetched) {
      if (next === null) {
        rounds = most;
        break;
      }
      if (next.status !== 'ok') {
        moreFailed = { status: next.status, reason: next.reason };
        break;
      }
      outcomes.push(next);
      rounds += 1;
    }
    ({ all, addedByRound } = combine(category, fromIndex, outcomes));
    recent = recentYield(addedByRound, window);
    if (!fills) break;
  }
  const moreRounds = firstOk && rounds < most && (recent.total > 0 || Boolean(moreFailed));

  const results = all.slice(start, start + limit);
  const last = outcomes[outcomes.length - 1];

  return {
    results,
    totalResults: all.length,
    searchTerms: [],
    responseTimeMs: Date.now() - startedAt,
    rounds,
    moreRounds,
    ...(moreFailed ? { moreFailed } : {}),
    external: {
      provider: 'parallel',
      status: outcomes[0].status,
      count: results.filter(result => result.source === 'parallel').length,
      indexCount: results.filter(result => result.source === 'index').length,
      // Places OpenStreetMap supplied itself (Maps, when it is on).
      ...(results.some(result => result.source === 'osm')
        ? { osmCount: results.filter(result => result.source === 'osm').length }
        : {}),
      ...(outcomes[0].status === 'ok'
        ? { cached: outcomes.every(outcome => outcome.status !== 'ok' || outcome.cached) }
        : { reason: outcomes[0].reason }),
      ...(outcomes.length > 1 ? { rounds: outcomes.length } : {}),
      ...(last !== outcomes[0] && last.status !== 'ok' ? { lastRound: last.status } : {})
    }
  };
}

module.exports = {
  search,
  maxRounds,
  ROUNDS_AT_ONCE,
  MORE_WAYS,
  handles,
  available,
  buildRequest,
  subjectTerms,
  confirmVideos,
  findImages,
  findPlaces,
  samePlace,
  fromCrawlerPlace,
  fromCrawlerImage,
  fromCrawlerVideo,
  CATEGORIES
};
