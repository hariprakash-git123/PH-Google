const { config } = require('../../config/env');
const logger = require('../../utils/logger');
const { sha1 } = require('../opensearch/documentMapper');
const { text, httpUrl, number } = require('./fields');

/**
 * OpenStreetMap's Nominatim, used for two things on the Maps tab:
 *
 *   - to check a pin: where OpenStreetMap says a named town or suburb is, so
 *     coordinates a page gives for "…, Coimbatore" can be compared with where
 *     Coimbatore actually is;
 *   - to find places: one search for the query as typed, whose results are
 *     OpenStreetMap's own, with OpenStreetMap's own positions.
 *
 * Written to the public service's usage policy
 * (https://operations.osmfoundation.org/policies/nominatim/), so that it is
 * safe to point at nominatim.openstreetmap.org for a small deployment:
 *
 *   - never more than one request at a time, and never two within a second:
 *     every request waits its turn in one queue (the policy's absolute limit
 *     is one a second);
 *   - every answer is cached, and an identical question is not asked twice;
 *   - the application names itself in User-Agent (a library's default is not
 *     accepted);
 *   - the address is configuration (NOMINATIM_BASE_URL), so the service can
 *     be switched without a new build, as the policy requires;
 *   - it is asked once per search a person makes and once per town named by
 *     the results — not per keystroke (no auto-complete), not per result, and
 *     never to enumerate an area;
 *   - a daily ceiling stops a fault from turning into a flood.
 *
 * Never throws: a request that cannot be made, or fails, is `{ ok: false,
 * reason }`, and the caller carries on without it.
 */

const cache = new Map(); // key -> { at, value }
const inFlight = new Map(); // key -> Promise
let queue = Promise.resolve();
let lastRequestAt = 0;
let waiting = 0;
const usage = { day: '', sent: 0 };

const settings = () => config.maps.osm;
const today = () => new Date().toISOString().slice(0, 10);
const sleep = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

function available() {
  const s = settings();
  if (!s.enabled) return { ok: false, reason: 'disabled' };
  if (!s.userAgent) return { ok: false, reason: 'not_configured' };
  return { ok: true };
}

function readCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > settings().cacheTtlMs) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key, value) {
  if (settings().cacheTtlMs <= 0) return;
  if (cache.size >= settings().cacheMaxEntries) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
}

/** One GET, in its turn. */
async function send(params, fetchImpl) {
  const s = settings();
  const url = `${s.baseUrl}/search?${new URLSearchParams({ format: 'jsonv2', ...params })}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'user-agent': s.userAgent, accept: 'application/json', 'accept-language': 'en' },
      signal: AbortSignal.timeout(s.timeoutMs)
    });
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { ok: false, reason: timedOut ? 'timeout' : 'network' };
  }
  if (response.status === 429 || response.status === 403) {
    return { ok: false, reason: 'rate_limited' };
  }
  if (!response.ok) return { ok: false, reason: 'unavailable' };
  try {
    const body = await response.json();
    return Array.isArray(body)
      ? { ok: true, results: body }
      : { ok: false, reason: 'invalid_response' };
  } catch {
    return { ok: false, reason: 'invalid_response' };
  }
}

/**
 * Asks through the cache and the one-at-a-time queue.
 *
 * @param {Object} params  Nominatim /search parameters (also the cache key)
 * @returns {Promise<{ok: true, results: Array, cached: boolean}
 *                  | {ok: false, reason: string}>}
 */
async function ask(params, { fetchImpl = fetch } = {}) {
  const can = available();
  if (!can.ok) return can;
  const s = settings();
  const key = JSON.stringify(params);

  const cached = readCache(key);
  if (cached) return { ok: true, results: cached, cached: true };
  if (inFlight.has(key)) return inFlight.get(key);

  if (usage.day !== today()) Object.assign(usage, { day: today(), sent: 0 });
  if (s.dailyLimit > 0 && usage.sent >= s.dailyLimit) return { ok: false, reason: 'daily_limit' };
  // A search page cannot wait behind a long line; this one goes without.
  if (waiting * s.minIntervalMs > s.maxWaitMs) return { ok: false, reason: 'busy' };

  waiting += 1;
  usage.sent += 1;
  const turn = queue.then(async () => {
    const wait = lastRequestAt + s.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const outcome = await send(params, fetchImpl);
    // One line per request actually sent (LOG_LEVEL=debug): what was asked, never by whom.
    logger.debug('OpenStreetMap request', {
      kind: params.layer === 'poi' ? 'places' : 'locality',
      q: params.q,
      ok: outcome.ok,
      reason: outcome.ok ? undefined : outcome.reason,
      results: outcome.ok ? outcome.results.length : undefined,
      tookMs: Date.now() - lastRequestAt
    });
    lastRequestAt = Date.now();
    return outcome;
  });
  queue = turn.then(
    () => undefined,
    () => undefined
  );

  const pending = turn
    .then(outcome => {
      if (!outcome.ok) {
        logger.warn('OpenStreetMap lookup failed', { reason: outcome.reason });
        return outcome;
      }
      writeCache(key, outcome.results);
      return { ok: true, results: outcome.results, cached: false };
    })
    .catch(() => ({ ok: false, reason: 'internal_error' }))
    .finally(() => {
      waiting -= 1;
      inFlight.delete(key);
    });
  inFlight.set(key, pending);
  return pending;
}

const norm = value =>
  String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Where OpenStreetMap says a town, suburb or district is.
 *
 * @param {{locality: string, region?: string, country?: string}} place
 * @returns {Promise<{ok: true, found: true, name: string, kind: string,
 *                    south: number, north: number, west: number, east: number}
 *                  | {ok: true, found: false} | {ok: false, reason: string}>}
 */
async function lookupLocality({ locality, region = '', country = '' }, options) {
  const town = norm(locality);
  if (!town) return { ok: true, found: false };
  const params = {
    q: [town, norm(region)].filter(Boolean).join(', '),
    limit: '1',
    addressdetails: '0'
  };
  const code = norm(country);
  if (/^[a-z]{2}$/.test(code)) params.countrycodes = code;
  else if (code) params.q = `${params.q}, ${code}`;

  const outcome = await ask(params, options);
  if (!outcome.ok) return outcome;

  const hit = outcome.results[0];
  // Only a named area can vouch for an address: a shop that happens to be
  // called "Coimbatore" says nothing about where Coimbatore is.
  if (!hit || !['place', 'boundary'].includes(hit.category || hit.class)) {
    return { ok: true, found: false };
  }
  const box = (Array.isArray(hit.boundingbox) ? hit.boundingbox : []).map(Number);
  if (box.length !== 4 || box.some(value => !Number.isFinite(value)))
    return { ok: true, found: false };
  const [south, north, west, east] = box;
  return {
    ok: true,
    found: true,
    name: text(hit.name || hit.display_name, 120),
    kind: text(hit.addresstype || hit.type, 40),
    south,
    north,
    west,
    east
  };
}

/** "restaurant" → "Restaurant"; "fast_food" → "Fast food". */
function label(value) {
  const words = String(value || '')
    .replace(/_/g, ' ')
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

/** Kinds of thing in OpenStreetMap that are a place someone might search for. */
const PLACE_CLASSES = new Set([
  'amenity',
  'shop',
  'tourism',
  'leisure',
  'healthcare',
  'office',
  'craft',
  'historic'
]);
const PHONE = /^[+()\d][\d\s().+-]{4,30}$/;

/** One Nominatim result → a place in the Maps result shape, or null. */
function toPlace(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.category || raw.class;
  if (!PLACE_CLASSES.has(kind)) return null;
  const title = text(raw.name, 200);
  const latitude = number(raw.lat, { min: -90, max: 90 });
  const longitude = number(raw.lon, { min: -180, max: 180 });
  const type = { node: 'node', way: 'way', relation: 'relation' }[raw.osm_type];
  if (
    !title ||
    latitude === null ||
    longitude === null ||
    !type ||
    !/^\d+$/.test(String(raw.osm_id))
  ) {
    return null;
  }

  const a = raw.address && typeof raw.address === 'object' ? raw.address : {};
  const tags = raw.extratags && typeof raw.extratags === 'object' ? raw.extratags : {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const locality = a.city || a.town || a.village || a.municipality || '';
  const address = text(
    [street, a.suburb || a.neighbourhood, locality, a.state, a.postcode].filter(Boolean).join(', '),
    300
  );
  const phone = text(tags.phone || tags['contact:phone'], 40);

  return {
    id: `osm-place:${sha1(`${type}/${raw.osm_id}`)}`,
    title,
    address: address || null,
    // OpenStreetMap holds no ratings.
    rating: null,
    reviews: null,
    phone: PHONE.test(phone) ? phone : null,
    website: httpUrl(tags.website || tags['contact:website']),
    category: label(raw.type),
    latitude,
    longitude,
    // As tagged ("Mo-Su 07:00-22:00"): quoted, not interpreted.
    hours: text(tags.opening_hours, 120) || null,
    thumbnailUrl: null,
    sourceUrl: `https://www.openstreetmap.org/${type}/${raw.osm_id}`,
    sourceDomain: 'openstreetmap.org',
    locality: text(locality, 120),
    about: text(`${raw.type || ''} ${kind} ${tags.cuisine || ''}`.replace(/[_;]/g, ' '), 200),
    source: 'osm'
  };
}

/**
 * Places OpenStreetMap finds for a search as typed.
 *
 * @param {string} query
 * @returns {Promise<{ok: true, places: Array<Object>, cached: boolean}
 *                  | {ok: false, reason: string}>}
 */
async function searchPlaces(query, options) {
  const q = norm(query);
  if (!q) return { ok: true, places: [], cached: false };
  const outcome = await ask(
    { q, limit: '40', addressdetails: '1', extratags: '1', layer: 'poi' },
    options
  );
  if (!outcome.ok) return outcome;
  const seen = new Set();
  const places = [];
  for (const raw of outcome.results) {
    const place = toPlace(raw);
    if (!place || seen.has(place.id)) continue;
    seen.add(place.id);
    places.push(place);
  }
  return { ok: true, places, cached: outcome.cached };
}

/** For the admin dashboard and the tests. */
function describe() {
  const s = settings();
  return {
    enabled: s.enabled,
    usedToday: usage.day === today() ? usage.sent : 0,
    dailyLimit: s.dailyLimit,
    cached: cache.size
  };
}

/** Tests: forget the cache, the counter and the queue's clock. */
function reset() {
  cache.clear();
  inFlight.clear();
  queue = Promise.resolve();
  lastRequestAt = 0;
  waiting = 0;
  Object.assign(usage, { day: '', sent: 0 });
}

module.exports = { available, ask, lookupLocality, searchPlaces, toPlace, describe, reset };
