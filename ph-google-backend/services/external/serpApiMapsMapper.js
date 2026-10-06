const { sha1 } = require('../opensearch/documentMapper');
const { text, httpUrl, number, positiveInt } = require('./fields');

/**
 * SerpApi Google Maps (`local_results`, or `place_results` for a single
 * named place) → the place result schema:
 *
 *   { id, title, address, rating, reviews, phone, website, category,
 *     latitude, longitude, hours, thumbnailUrl, mapsUrl, position,
 *     source: 'serpapi' }
 *
 * Only what SerpApi returned: a missing field is null, never guessed.
 * `mapsUrl` is a Google Maps link built from the place's own name, address
 * and place id (the documented "Maps URLs" form — no API key involved).
 */

/** A phone number as displayed: digits and the usual separators only. */
const PHONE = /^[+()\d][\d\s().+-]{4,30}$/;

function coordinates(raw) {
  const gps =
    raw.gps_coordinates && typeof raw.gps_coordinates === 'object' ? raw.gps_coordinates : {};
  const latitude = number(gps.latitude, { min: -90, max: 90 });
  const longitude = number(gps.longitude, { min: -180, max: 180 });
  return latitude === null || longitude === null
    ? { latitude: null, longitude: null }
    : { latitude, longitude };
}

/** Today's opening state ("Open ⋅ Closes 11 PM") when SerpApi gives one. */
function hoursOf(raw) {
  if (typeof raw.open_state === 'string') return text(raw.open_state, 120) || null;
  if (typeof raw.hours === 'string') return text(raw.hours, 120) || null;
  return null;
}

function mapsUrlFor(title, address, placeId) {
  const url = new URL('https://www.google.com/maps/search/');
  url.searchParams.set('api', '1');
  url.searchParams.set('query', [title, address].filter(Boolean).join(', '));
  if (placeId) url.searchParams.set('query_place_id', placeId);
  return url.toString();
}

/**
 * @param {Object} raw  one entry of `local_results` (or `place_results`)
 * @param {number} index  its position in the list (fallback for `position`)
 * @returns {Object|null}
 */
function mapPlaceResult(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 200);
  if (!title) return null;

  const address = text(raw.address, 300) || null;
  const placeId = /^[\w-]{10,}$/.test(String(raw.place_id || '')) ? raw.place_id : null;
  const phone = text(raw.phone, 40);
  const types = Array.isArray(raw.types) ? raw.types : [];

  return {
    id: `serpapi-place:${sha1(placeId || raw.data_cid || `${title}|${address || ''}`)}`,
    title,
    address,
    rating: number(raw.rating, { min: 0, max: 5 }),
    reviews: positiveInt(raw.reviews),
    phone: PHONE.test(phone) ? phone : null,
    website: httpUrl(raw.website),
    category: text(raw.type || types[0], 80) || null,
    ...coordinates(raw),
    hours: hoursOf(raw),
    thumbnailUrl: httpUrl(raw.thumbnail),
    mapsUrl: mapsUrlFor(title, address, placeId),
    position: positiveInt(raw.position) || index + 1,
    source: 'serpapi'
  };
}

/** Maps a list, keeping SerpApi's order and the first copy of each place. */
function mapPlaceResults(rawResults) {
  const seen = new Set();
  const out = [];
  (Array.isArray(rawResults) ? rawResults : []).forEach((raw, i) => {
    const place = mapPlaceResult(raw, i);
    if (!place || seen.has(place.id)) return;
    seen.add(place.id);
    out.push(place);
  });
  return out;
}

module.exports = { mapPlaceResult, mapPlaceResults };
