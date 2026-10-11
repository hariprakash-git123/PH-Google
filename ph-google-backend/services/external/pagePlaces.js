const cheerio = require('cheerio');
const safeFetch = require('./safeFetch');
const { text, httpUrl, number, positiveInt } = require('./fields');

/**
 * Places a web page describes about itself, for map search without a places
 * provider.
 *
 * A web-search provider returns pages, and a page's text is not a place: an
 * address read out of a paragraph, or a pin put where a town happens to be,
 * would be a guess. What a page can state exactly is its structured data —
 * the schema.org description (JSON-LD) that restaurant, hotel, shop and
 * directory pages publish for search engines:
 *
 *   { "@type": "Restaurant", "name": …, "address": {…},
 *     "geo": { "latitude": …, "longitude": … }, "telephone": …, … }
 *
 * Only that is read here, and only what it says is kept. A field the page
 * does not state is null — never inferred from the page's text, and never
 * looked up. Coordinates are kept only when they are real numbers inside
 * the globe; a place without them is still a place, shown without a pin.
 *
 * Nothing is stored. The fetch goes through safeFetch (public hosts only).
 */

const PAGE_TIMEOUT_MS = 5000;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_PLACES_PER_PAGE = 12;
/** Largest structured-data block parsed: a guard, not a limit pages reach. */
const MAX_JSON_CHARS = 600000;
const MAX_DEPTH = 8;
/** Decimal places both coordinates need before a place is pinned (~110 m). */
const MIN_DECIMALS = 3;

/**
 * schema.org types that are somewhere a person can go. An Organization or a
 * WebSite with an address is a publisher's letterhead, not a search result.
 */
const PLACE_TYPE =
  /^(Place|LocalBusiness|.*(Restaurant|Cafe|CoffeeShop|Bakery|Bar|Pub|Brewery|Winery|FoodEstablishment|IceCreamShop|Hotel|Hostel|Motel|Resort|Lodging|BedAndBreakfast|Campground|Store|Shop|Mall|Market|Hospital|Clinic|Pharmacy|Dentist|Physician|Medical|Attraction|Museum|Park|Zoo|Aquarium|Beach|Landmark|Monument|Temple|Church|Mosque|Synagogue|PlaceOfWorship|Library|School|University|College|Stadium|Theater|Cinema|Gym|Salon|Spa|Airport|Station|Bank|Garage|Dealer|Agency|Office).*)$/i;
const TOO_GENERAL = new Set(['place', 'localbusiness', 'thing']);

/** A phone number as displayed: digits and the usual separators only. */
const PHONE = /^[+()\d][\d\s().+-]{4,30}$/;

const typesOf = node =>
  []
    .concat(node['@type'] || [])
    .filter(type => typeof type === 'string')
    .map(type => type.replace(/^https?:\/\/schema\.org\//i, ''));

/** "CafeOrCoffeeShop" → "Cafe or coffee shop". Null for "Place" itself. */
function categoryOf(types) {
  const specific = types.find(
    type => PLACE_TYPE.test(type) && !TOO_GENERAL.has(type.toLowerCase())
  );
  if (!specific) return null;
  const words = specific.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return text(words.charAt(0).toUpperCase() + words.slice(1), 80) || null;
}

/** A postal address as one line, from a string or a schema.org PostalAddress. */
function addressOf(value) {
  if (typeof value === 'string') return text(value, 300) || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parts = [];
  for (const key of ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode']) {
    const part = text(value[key], 200);
    // Street lines often already end with the town and the postcode.
    if (part && !parts.some(have => have.toLowerCase().includes(part.toLowerCase()))) {
      parts.push(part);
    }
  }
  const country =
    value.addressCountry && typeof value.addressCountry === 'object'
      ? value.addressCountry.name
      : value.addressCountry;
  const countryText = text(country, 60);
  if (
    countryText.length > 2 &&
    !parts.some(p => p.toLowerCase().includes(countryText.toLowerCase()))
  ) {
    parts.push(countryText);
  }
  return text(parts.join(', '), 300) || null;
}

/** The town, region and country an address names in its own fields ('' when it does not). */
function localityOf(value) {
  const none = { locality: '', region: '', country: '', postalCode: '' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return none;
  const country =
    value.addressCountry && typeof value.addressCountry === 'object'
      ? value.addressCountry.name || value.addressCountry.identifier
      : value.addressCountry;
  return {
    locality: text(value.addressLocality, 120),
    region: text(value.addressRegion, 120),
    country: text(country, 60),
    postalCode: text(value.postalCode, 20)
  };
}

/**
 * Coordinates as the page states them, or none. Both must be finite numbers
 * inside the globe, and precise enough to be a building rather than a
 * region; 0,0 is a placeholder.
 */
function coordinatesOf(geo) {
  const none = { latitude: null, longitude: null };
  const source = Array.isArray(geo) ? geo[0] : geo;
  if (!source || typeof source !== 'object') return none;
  const latitude = number(source.latitude, { min: -90, max: 90 });
  const longitude = number(source.longitude, { min: -180, max: 180 });
  if (latitude === null || longitude === null) return none;
  if (latitude === 0 && longitude === 0) return none;
  // A position good enough for a pin is given to about a hundred metres:
  // three decimal places. "11, 77" or "10.79, 77.14" is a district.
  const decimals = value => (String(value).split('.')[1] || '').length;
  if (decimals(latitude) < MIN_DECIMALS || decimals(longitude) < MIN_DECIMALS) return none;
  return { latitude, longitude };
}

function ratingOf(aggregate) {
  if (!aggregate || typeof aggregate !== 'object') return { rating: null, reviews: null };
  const best = aggregate.bestRating === undefined ? 5 : number(aggregate.bestRating);
  // Only a rating out of five can be shown as stars out of five.
  const rating = best === 5 ? number(aggregate.ratingValue, { min: 0, max: 5 }) : null;
  return {
    rating,
    reviews: rating === null ? null : positiveInt(aggregate.reviewCount ?? aggregate.ratingCount)
  };
}

/** Opening hours exactly as the page writes them ("Mo-Su 11:00-23:00"). */
function hoursOf(value) {
  const lines = [].concat(value || []).filter(line => typeof line === 'string');
  return text(lines.join('; '), 120) || null;
}

function imageOf(value) {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === 'string') return httpUrl(first);
  if (first && typeof first === 'object') return httpUrl(first.url || first.contentUrl);
  return null;
}

/** One schema.org node → a place, or null when it is not one. */
function toPlace(node, pageUrl) {
  const types = typesOf(node);
  if (!types.some(type => PLACE_TYPE.test(type))) return null;
  const title = text(node.name, 200);
  if (!title) return null;

  const address = addressOf(node.address);
  const coordinates = coordinatesOf(node.geo);
  // A name alone says nothing about where: it needs an address or a position.
  if (!address && coordinates.latitude === null) return null;

  const phone = text(Array.isArray(node.telephone) ? node.telephone[0] : node.telephone, 40);
  let website = null;
  try {
    const own =
      typeof node.url === 'string' ? httpUrl(new URL(node.url, pageUrl).toString()) : null;
    website = own && own !== pageUrl ? own : null;
  } catch {
    website = null;
  }

  return {
    title,
    address,
    ...localityOf(node.address),
    ...ratingOf(node.aggregateRating),
    phone: PHONE.test(phone) ? phone : null,
    website,
    category: categoryOf(types),
    ...coordinates,
    hours: hoursOf(node.openingHours),
    thumbnailUrl: imageOf(node.image),
    // What the place says it is, for judging whether it answers a search.
    about: text(
      [
        types.map(type => type.replace(/([a-z])([A-Z])/g, '$1 $2')).join(' '),
        [].concat(node.servesCuisine || []).join(' '),
        typeof node.description === 'string' ? node.description : ''
      ].join(' '),
      600
    )
  };
}

/**
 * Every place the page's structured data describes, in page order.
 *
 * @param {string} html
 * @param {string} pageUrl  where the page was fetched from
 * @returns {Array<Object>} places (see toPlace), each with `sourceUrl`
 */
function extractPlaces(html, pageUrl) {
  let $;
  try {
    $ = cheerio.load(String(html || ''));
  } catch {
    return [];
  }

  const nodes = [];
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return;
    if (Array.isArray(value)) {
      value.slice(0, 200).forEach(item => walk(item, depth + 1));
      return;
    }
    if (value['@type']) nodes.push(value);
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') walk(child, depth + 1);
    }
  };
  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).contents().text();
    if (!raw || raw.length > MAX_JSON_CHARS) return;
    try {
      walk(JSON.parse(raw), 0);
    } catch {
      /* structured data that does not parse says nothing */
    }
  });

  const out = [];
  for (const node of nodes) {
    const place = toPlace(node, pageUrl);
    if (place) out.push({ ...place, sourceUrl: pageUrl });
    if (out.length >= MAX_PLACES_PER_PAGE) break;
  }
  return out;
}

/**
 * Reads one page and returns the places it describes. A page that cannot be
 * fetched, or is not HTML, has none.
 *
 * @returns {Promise<{pageUrl: string, places: Array, reason?: string}>}
 */
async function placesFromPage(pageUrl, options = {}) {
  const response = await safeFetch.get(pageUrl, {
    timeoutMs: PAGE_TIMEOUT_MS,
    maxBytes: PAGE_MAX_BYTES,
    accept: 'text/html,application/xhtml+xml',
    ...options
  });
  if (!response.ok) return { pageUrl, places: [], reason: response.reason };
  const type = String(response.headers['content-type'] || '').toLowerCase();
  if (type && !/html|xml/.test(type)) return { pageUrl, places: [], reason: 'not_html' };

  const finalUrl = response.finalUrl || pageUrl;
  return { pageUrl: finalUrl, places: extractPlaces(response.buffer.toString('utf8'), finalUrl) };
}

/** Metres between two points (haversine). */
function distanceMetres(a, b) {
  const rad = degrees => (degrees * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

module.exports = {
  extractPlaces,
  placesFromPage,
  toPlace,
  addressOf,
  localityOf,
  coordinatesOf,
  categoryOf,
  distanceMetres
};
