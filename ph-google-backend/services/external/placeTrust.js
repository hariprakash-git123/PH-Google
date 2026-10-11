const nominatimClient = require('./nominatimClient');
const { domainOf } = require('./fields');

/**
 * Whether a place's coordinates can be trusted enough to draw a pin.
 *
 * A page states its coordinates and its address separately, and nothing
 * makes them agree: a listing can give a precise position that is forty
 * kilometres from the street it names. Precision is therefore necessary and
 * not sufficient. A pin is drawn only when something independent of the page
 * agrees with it:
 *
 *   'openstreetmap'  the coordinates fall inside the town or suburb the
 *                    address names, as OpenStreetMap places it (one lookup
 *                    per distinct town, cached — not one per place);
 *   'sources'        with no map to ask, another website describes a place
 *                    in the same town within a few kilometres. Two sites
 *                    wrong in the same way is possible, so this is the
 *                    weaker of the two and only the fallback.
 *
 * Anything else is not a judgement that the page is wrong — only that it
 * could not be checked. The place keeps every detail and its source link,
 * and loses its pin: `locationStatus: 'unverified'`, coordinates withheld.
 * The page's coordinates are never corrected, moved or replaced.
 */

/** Distinct towns looked up for one search; the rest go unchecked (no pin). */
const MAX_LOCALITY_LOOKUPS = 3;
/** A suburb is a small box; allow this much around its middle (degrees, ~5.5 km). */
const MIN_HALF_EXTENT = 0.05;
/** How near another site's place must be to corroborate (same town). */
const CORROBORATION_KM = 15;

const norm = value =>
  String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const hasCoordinates = place =>
  typeof place.latitude === 'number' && typeof place.longitude === 'number';

function kilometres(a, b) {
  const rad = degrees => (degrees * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The town a place says it is in: its address's own locality field, or —
 * for an address given as one line — a town named by the other places that
 * appears in that line as a whole word.
 */
function claimedLocality(place, knownLocalities) {
  if (norm(place.locality)) return norm(place.locality);
  const line = ` ${norm(place.address)} `;
  return knownLocalities.find(name => name.length >= 3 && line.includes(` ${name} `)) || '';
}

function inside(place, area) {
  const midLat = (area.south + area.north) / 2;
  const midLon = (area.west + area.east) / 2;
  const halfLat = Math.max((area.north - area.south) / 2, MIN_HALF_EXTENT);
  const halfLon = Math.max((area.east - area.west) / 2, MIN_HALF_EXTENT);
  return (
    Math.abs(place.latitude - midLat) <= halfLat && Math.abs(place.longitude - midLon) <= halfLon
  );
}

/**
 * Decides, for each place that states coordinates, whether they are shown.
 *
 * @param {Array<Object>} places  each with title, address, locality, region,
 *        country, latitude, longitude, sourceUrl
 * @returns {Promise<{places: Array<Object>, stats: Object}>} the same places,
 *          each with `locationStatus` ('verified' | 'unverified' | 'missing')
 *          and, when verified, `locationEvidence`; an unverified place has
 *          `latitude` and `longitude` set to null and a `locationReason`
 */
async function assessLocations(places) {
  const stats = { verified: 0, unverified: 0, missing: 0, lookups: 0, lookupsFailed: 0 };
  const known = [...new Set(places.map(place => norm(place.locality)).filter(Boolean))];
  const claims = places.map(place => (hasCoordinates(place) ? claimedLocality(place, known) : ''));

  // One question per distinct town, the most named first.
  const counts = new Map();
  places.forEach((place, i) => {
    if (!claims[i]) return;
    const key = JSON.stringify([claims[i], norm(place.region), norm(place.country)]);
    const entry = counts.get(key) || {
      locality: claims[i],
      region: norm(place.region),
      country: norm(place.country),
      n: 0
    };
    entry.n += 1;
    counts.set(key, entry);
  });
  const areas = new Map(); // locality -> lookup outcome
  if (nominatimClient.available().ok) {
    const asked = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, MAX_LOCALITY_LOOKUPS);
    for (const town of asked) {
      if (areas.has(town.locality)) continue;
      const outcome = await nominatimClient.lookupLocality({
        locality: town.locality,
        region: town.region,
        country: town.country
      });
      stats.lookups += 1;
      if (!outcome.ok) stats.lookupsFailed += 1;
      areas.set(town.locality, outcome);
    }
  }

  const assessed = places.map((place, i) => {
    if (!hasCoordinates(place)) {
      stats.missing += 1;
      return { ...place, locationStatus: 'missing' };
    }
    const verified = evidence => {
      stats.verified += 1;
      return { ...place, locationStatus: 'verified', locationEvidence: evidence };
    };
    const unverified = reason => {
      stats.unverified += 1;
      return {
        ...place,
        latitude: null,
        longitude: null,
        locationStatus: 'unverified',
        locationReason: reason
      };
    };

    const locality = claims[i];
    if (!locality) return unverified('no_locality');

    const area = areas.get(locality);
    if (area && area.ok && area.found) {
      return inside(place, area) ? verified('openstreetmap') : unverified('outside_locality');
    }

    // No map to ask (off, failing, over its limit, or it does not know the
    // town): another website placing something in the same town nearby.
    const site = domainOf(place.sourceUrl);
    const corroborated = places.some(
      (other, j) =>
        j !== i &&
        hasCoordinates(other) &&
        claims[j] === locality &&
        domainOf(other.sourceUrl) !== site &&
        kilometres(place, other) <= CORROBORATION_KM
    );
    return corroborated ? verified('sources') : unverified('unconfirmed');
  });

  return { places: assessed, stats };
}

module.exports = { assessLocations, claimedLocality, kilometres, MAX_LOCALITY_LOOKUPS };
