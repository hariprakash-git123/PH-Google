const request = require('supertest');
const mongoose = require('mongoose');
const testDb = require('../helpers/testDb');
const { startSerpApiStandIn } = require('../helpers/serpApiStandIn');
const { config } = require('../../config/env');
const externalSearch = require('../../services/externalSearch');
const parallelClient = require('../../services/external/parallelClient');
const safeFetch = require('../../services/external/safeFetch');
const { ExternalSearchError } = require('../../services/external/externalSearchError');
const Place = require('../../models/Place');
const nominatimClient = require('../../services/external/nominatimClient');
const logger = require('../../utils/logger');

/**
 * GET /api/search?category=maps with SerpApi switched off and
 * PARALLEL_VERTICALS_ENABLED on: Parallel finds pages, and a place is shown
 * only as its own page describes it in structured data. Coordinates are the
 * page's or there are none — a place without them is listed without a pin.
 * A pin is drawn only when its position checks out against something
 * independent of the page: here OpenStreetMap's Nominatim, mocked. Nothing
 * reaches Parallel, a web page, OpenStreetMap or SerpApi.
 */

/** Where OpenStreetMap places Coimbatore (the answer of the real service, recorded). */
const COIMBATORE = {
  ok: true,
  found: true,
  name: 'Coimbatore',
  kind: 'city',
  south: 10.8418115,
  north: 11.1618115,
  west: 76.8028425,
  east: 77.1228425
};

const PARALLEL_KEY = 'parallel-maps-key-NOT-REAL-abcdef0123456789';
const SERP_KEY = 'serpapi-off-key-NOT-REAL-0123456789abcdef';
const original = {
  osm: { ...config.maps.osm },
  parallel: { ...config.parallel },
  serpapi: { ...config.serpapi },
  externalSearch: { ...config.externalSearch }
};
let app;
let serp;
let parallelSearch;
let fetched;
let web;
let lookupLocality;
let searchOsm;

const found = (url, title, excerpt = '') => ({
  url,
  title,
  publish_date: null,
  excerpts: excerpt ? [excerpt] : []
});
/** A page whose structured data describes these schema.org nodes. */
const page = (url, title, nodes, body = '') =>
  web.set(url, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
    buffer: Buffer.from(
      `<!doctype html><html><head><title>${title}</title>${[]
        .concat(nodes)
        .map(node => `<script type="application/ld+json">${JSON.stringify(node)}</script>`)
        .join('')}</head><body>${body}</body></html>`
    )
  });

const restaurant = (name, overrides = {}) => ({
  '@context': 'https://schema.org',
  '@type': 'Restaurant',
  name,
  address: {
    '@type': 'PostalAddress',
    streetAddress: '12 DB Road, RS Puram',
    addressLocality: 'Coimbatore',
    postalCode: '641002',
    addressCountry: 'IN'
  },
  geo: { '@type': 'GeoCoordinates', latitude: 11.0062, longitude: 76.9495 },
  telephone: '+91 422 254 1234',
  ...overrides
});

beforeAll(async () => {
  await testDb.connect();
  serp = await startSerpApiStandIn();
  app = require('../../app').createApp();
});
afterAll(async () => {
  Object.assign(config.parallel, original.parallel);
  Object.assign(config.serpapi, original.serpapi);
  Object.assign(config.externalSearch, original.externalSearch);
  Object.assign(config.maps.osm, original.osm);
  await serp.close();
  await testDb.disconnect();
});
beforeEach(async () => {
  await testDb.clear();
  serp.reset();
  externalSearch.reset();
  web = new Map();
  Object.assign(config.externalSearch, original.externalSearch, {
    provider: 'parallel',
    fallback: false
  });
  Object.assign(config.parallel, original.parallel, {
    enabled: true,
    verticals: true,
    apiKey: PARALLEL_KEY,
    mode: 'fast',
    timeoutMs: 1000,
    maxResults: 10,
    dailyLimit: 0,
    cacheTtlMs: 60000
  });
  Object.assign(config.serpapi, original.serpapi, {
    enabled: false,
    apiKey: SERP_KEY,
    engine: 'google',
    baseUrl: serp.baseUrl,
    dailyLimit: 0
  });
  parallelSearch = jest.spyOn(parallelClient, 'search').mockResolvedValue({ results: [] });
  fetched = jest.spyOn(safeFetch, 'get').mockImplementation(async url => {
    const entry = web.get(url);
    if (!entry) return { ok: false, reason: 'upstream', status: 404 };
    if (entry.fail) return { ok: false, reason: entry.fail };
    return { ok: true, status: 200, truncated: false, finalUrl: url, ...entry };
  });
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  // OpenStreetMap is on, knows where Coimbatore is, and has no places of its own
  // unless a test gives it some.
  nominatimClient.reset();
  Object.assign(config.maps.osm, original.osm, { enabled: true, userAgent: 'ph-test/1.0' });
  lookupLocality = jest
    .spyOn(nominatimClient, 'lookupLocality')
    .mockImplementation(async ({ locality }) =>
      locality === 'coimbatore' ? COIMBATORE : { ok: true, found: false }
    );
  searchOsm = jest
    .spyOn(nominatimClient, 'searchPlaces')
    .mockResolvedValue({ ok: true, places: [], cached: false });
});
afterEach(() => {
  const serpAsked = serp.state.requests.length;
  jest.restoreAllMocks();
  if (serpAsked > 0) throw new Error('SerpApi was asked while switched off');
});

const maps = (q, extra = {}) =>
  request(app)
    .get('/api/search')
    .query({ q, category: 'maps', ...extra });

const ANNA = 'https://annapoorna.example/rs-puram';
const HARI = 'https://haribhavanam.example/gandhipuram';

describe('places as their own pages describe them', () => {
  it('returns the place with exactly what its page states, and a pin at its coordinates', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Annapoorna, RS Puram', 'A vegetarian restaurant in Coimbatore.')]
    });
    page(
      ANNA,
      'Annapoorna, RS Puram',
      restaurant('Sree Annapoorna', {
        aggregateRating: { '@type': 'AggregateRating', ratingValue: '4.3', reviewCount: '1245' },
        openingHours: 'Mo-Su 07:00-22:00',
        url: 'https://annapoorna.example/',
        image: 'https://annapoorna.example/front.jpg'
      })
    );

    const res = await maps('Coimbatore restaurants');
    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data.results).toEqual([
      {
        id: expect.stringMatching(/^parallel-place:[0-9a-f]{40}$/),
        title: 'Sree Annapoorna',
        address: '12 DB Road, RS Puram, Coimbatore, 641002',
        rating: 4.3,
        reviews: 1245,
        phone: '+91 422 254 1234',
        website: 'https://annapoorna.example/',
        category: 'Restaurant',
        latitude: 11.0062,
        longitude: 76.9495,
        hours: 'Mo-Su 07:00-22:00',
        thumbnailUrl: 'https://annapoorna.example/front.jpg',
        sourceUrl: ANNA,
        sourceDomain: 'annapoorna.example',
        mapsUrl: 'https://www.openstreetmap.org/?mlat=11.0062&mlon=76.9495#map=17/11.0062/76.9495',
        source: 'parallel',
        locationStatus: 'verified',
        locationEvidence: 'openstreetmap',
        position: 1
      }
    ]);
    expect(data.items).toEqual(data.results);
    expect(data.total).toBe(1);
    expect(data.external).toEqual({
      provider: 'parallel',
      status: 'ok',
      count: 1,
      indexCount: 0,
      cached: false
    });
  });

  it('asks Parallel for places two ways, each its own request', async () => {
    await maps('Coimbatore restaurants');
    expect(parallelSearch.mock.calls.map(([sent]) => sent)).toEqual(
      ['Coimbatore restaurants', 'Coimbatore restaurants address'].map(query => ({
        objective: 'places: Coimbatore restaurants, with their addresses and locations',
        searchQueries: [query],
        sourcePolicy: {},
        maxResults: 20
      }))
    );
    expect(externalSearch.describe().parallel.usedToday).toBe(2);
  });

  it('a field the page does not state is null — nothing is filled in', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Annapoorna Coimbatore restaurant')]
    });
    page(ANNA, 'Annapoorna', {
      '@type': 'Restaurant',
      name: 'Sree Annapoorna',
      geo: { latitude: 11.0062, longitude: 76.9495 }
    });
    const [place] = (await maps('Coimbatore restaurants')).body.data.results;
    expect(place).toMatchObject({
      title: 'Sree Annapoorna',
      address: null,
      rating: null,
      reviews: null,
      phone: null,
      website: null,
      hours: null,
      thumbnailUrl: null,
      // Coordinates, but no address to check them against: not pinned.
      latitude: null,
      longitude: null,
      locationStatus: 'unverified',
      locationReason: 'no_locality'
    });
  });

  it('a place whose page gives no coordinates is listed with its details and source, and no position', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        found(HARI, 'Haribhavanam Coimbatore restaurant'),
        found(ANNA, 'Annapoorna Coimbatore restaurant')
      ]
    });
    page(
      HARI,
      'Haribhavanam',
      restaurant('Haribhavanam', { geo: undefined, telephone: '+91 422 249 0000' })
    );
    page(ANNA, 'Annapoorna', restaurant('Sree Annapoorna'));

    const { data } = (await maps('Coimbatore restaurants')).body;
    // The place that can be pinned leads, so the map's numbers start at the top.
    expect(data.results.map(r => [r.title, r.latitude, r.longitude])).toEqual([
      ['Sree Annapoorna', 11.0062, 76.9495],
      ['Haribhavanam', null, null]
    ]);
    expect(data.results[1]).toMatchObject({
      address: '12 DB Road, RS Puram, Coimbatore, 641002',
      phone: '+91 422 249 0000',
      sourceUrl: HARI,
      locationStatus: 'missing',
      // No coordinates to link to: a search for the place by name and address.
      mapsUrl:
        'https://www.openstreetmap.org/search?query=Haribhavanam%2C%2012%20DB%20Road%2C%20RS%20Puram%2C%20Coimbatore%2C%20641002'
    });
  });

  it.each([
    ['zero, zero', { latitude: 0, longitude: 0 }],
    ['outside the globe', { latitude: 111.0062, longitude: 76.9495 }],
    ['longitude outside the globe', { latitude: 11.0062, longitude: 276.9 }],
    ['not numbers', { latitude: 'north', longitude: 'east' }],
    ['only one of the two', { latitude: 11.0062 }],
    ['a pair of whole numbers', { latitude: 11, longitude: 77 }],
    ['empty', {}]
  ])('coordinates that are %s are not used: the place has no pin', async (_label, geo) => {
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Annapoorna Coimbatore restaurant')]
    });
    page(ANNA, 'Annapoorna', restaurant('Sree Annapoorna', { geo }));
    const [place] = (await maps('Coimbatore restaurants')).body.data.results;
    expect(place).toMatchObject({ title: 'Sree Annapoorna', latitude: null, longitude: null });
    expect(place.mapsUrl).toMatch(/^https:\/\/www\.openstreetmap\.org\/search\?query=/);
  });

  it('coordinates written as text are read as the numbers they are', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Annapoorna Coimbatore restaurant')]
    });
    page(
      ANNA,
      'Annapoorna',
      restaurant('Sree Annapoorna', { geo: { latitude: '11.0306446', longitude: '77.0272161' } })
    );
    const [place] = (await maps('Coimbatore restaurants')).body.data.results;
    expect(place).toMatchObject({ latitude: 11.0306446, longitude: 77.0272161 });
  });

  it('nothing is taken from a page’s prose: no structured place, no result', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Annapoorna Coimbatore restaurant')]
    });
    page(
      ANNA,
      'Annapoorna',
      [],
      '<h1>Sree Annapoorna</h1><p>12 DB Road, RS Puram, Coimbatore 641002. Call +91 422 254 1234. GPS 11.0062, 76.9495.</p>'
    );
    const { data } = (await maps('Coimbatore restaurants')).body;
    expect(data.results).toEqual([]);
    expect(data.external).toMatchObject({ provider: 'parallel', status: 'ok', count: 0 });
  });
});

describe('duplicates', () => {
  it('the same place described on two pages is shown once, with what either states', async () => {
    const DIR = 'https://directory.example/coimbatore/annapoorna';
    parallelSearch.mockResolvedValue({
      results: [
        found(DIR, 'Annapoorna - Coimbatore restaurant directory'),
        found(ANNA, 'Annapoorna Coimbatore restaurant')
      ]
    });
    // The directory has no coordinates but a rating; the restaurant's own page has the position.
    page(
      DIR,
      'Annapoorna',
      restaurant('Sree Annapoorna', {
        geo: undefined,
        aggregateRating: { ratingValue: 4.1, reviewCount: 300 }
      })
    );
    page(ANNA, 'Annapoorna', restaurant('SREE ANNAPOORNA'));

    const { data } = (await maps('Coimbatore restaurants')).body;
    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toMatchObject({
      title: 'Sree Annapoorna',
      rating: 4.1,
      reviews: 300,
      latitude: 11.0062,
      longitude: 76.9495
    });
    expect(data.total).toBe(1);
  });

  it('two entries of one name a few metres apart are one place', async () => {
    const OTHER = 'https://guide.example/annapoorna';
    parallelSearch.mockResolvedValue({
      results: [
        found(ANNA, 'Annapoorna Coimbatore restaurant'),
        found(OTHER, 'Annapoorna Coimbatore restaurant')
      ]
    });
    page(ANNA, 'Annapoorna', restaurant('Sree Annapoorna'));
    page(
      OTHER,
      'Annapoorna',
      restaurant('Sree Annapoorna', { geo: { latitude: 11.0064, longitude: 76.9497 } })
    );
    expect((await maps('Coimbatore restaurants')).body.data.results).toHaveLength(1);
  });

  it('branches of one name in different places are different places', async () => {
    const BRANCH = 'https://annapoorna.example/peelamedu';
    parallelSearch.mockResolvedValue({
      results: [
        found(ANNA, 'Annapoorna Coimbatore restaurant'),
        found(BRANCH, 'Annapoorna Coimbatore restaurant')
      ]
    });
    page(ANNA, 'Annapoorna RS Puram', restaurant('Sree Annapoorna'));
    page(
      BRANCH,
      'Annapoorna Peelamedu',
      restaurant('Sree Annapoorna', {
        address: { streetAddress: 'Avinashi Road, Peelamedu', addressLocality: 'Coimbatore' },
        geo: { latitude: 11.0257, longitude: 77.0143 },
        telephone: '+91 422 257 9999'
      })
    );
    const { results } = (await maps('Coimbatore restaurants')).body.data;
    expect(results.map(r => r.address)).toEqual([
      '12 DB Road, RS Puram, Coimbatore, 641002',
      'Avinashi Road, Peelamedu, Coimbatore'
    ]);
  });
});

describe('irrelevant results', () => {
  it('reads only pages that are about the subject', async () => {
    const OFF = 'https://shop.example/phone-cases';
    parallelSearch.mockResolvedValue({
      results: [
        found(OFF, 'Phone cases', 'Cases for every phone.'),
        found(ANNA, 'Annapoorna Coimbatore restaurant')
      ]
    });
    page(OFF, 'Phone cases', { '@type': 'Store', name: 'Case Store', address: 'Coimbatore' });
    page(ANNA, 'Annapoorna', restaurant('Sree Annapoorna'));
    const { results } = (await maps('Coimbatore restaurants')).body.data;
    expect(results.map(r => r.title)).toEqual(['Sree Annapoorna']);
    expect(fetched.mock.calls.map(([url]) => url)).not.toContain(OFF);
  });

  it('a publisher’s letterhead is not a place', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Best Coimbatore restaurants - a guide')]
    });
    page(ANNA, 'Best Coimbatore restaurants', [
      { '@type': 'Organization', name: 'Guide Media Ltd', address: 'Gurugram, Haryana' },
      {
        '@type': 'WebSite',
        name: 'Coimbatore restaurants guide',
        url: 'https://annapoorna.example/'
      },
      { '@type': 'Article', headline: 'Best Coimbatore restaurants' }
    ]);
    expect((await maps('Coimbatore restaurants')).body.data.results).toEqual([]);
  });

  it('on a page listing many places, only those that are on the subject are kept', async () => {
    const LIST = 'https://directory.example/coimbatore';
    parallelSearch.mockResolvedValue({ results: [found(LIST, 'Coimbatore restaurants and more')] });
    page(LIST, 'Coimbatore directory', {
      '@context': 'https://schema.org',
      '@graph': [
        restaurant('Sree Annapoorna'),
        {
          '@type': 'AutoDealer',
          name: 'City Motors',
          address: 'Salem Road, Erode',
          geo: { latitude: 11.341, longitude: 77.717 }
        },
        restaurant('Haribhavanam', { geo: { latitude: 11.0183, longitude: 76.9674 } })
      ]
    });
    const { results } = (await maps('Coimbatore restaurants')).body.data;
    expect(results.map(r => r.title)).toEqual(['Sree Annapoorna', 'Haribhavanam']);
  });

  it('from a page listing many, a bare name and address is not enough', async () => {
    const LIST = 'https://listings.example/coimbatore/restaurants';
    parallelSearch.mockResolvedValue({ results: [found(LIST, 'Coimbatore restaurants')] });
    page(LIST, 'Coimbatore restaurants', {
      '@graph': [
        // Nothing that could be checked: no phone, no rating, and a "website" that is the listing itself.
        restaurant('Royal Kitchen Civil Lines', {
          telephone: undefined,
          url: 'https://listings.example/coimbatore/restaurants/royal-kitchen',
          geo: { latitude: 10.789, longitude: 77.0497 }
        }),
        restaurant('Gandhi Chowk Restaurant', {
          telephone: undefined,
          geo: { latitude: 10.816, longitude: 77.0914 }
        }),
        // Each of these gives one thing that can be.
        restaurant('With A Phone', { geo: { latitude: 11.0101, longitude: 76.9601 } }),
        restaurant('With A Rating', {
          telephone: undefined,
          aggregateRating: { ratingValue: 4.2, reviewCount: 90 },
          geo: { latitude: 11.0202, longitude: 76.9702 }
        }),
        restaurant('With Its Own Site', {
          telephone: undefined,
          url: 'https://its-own-site.example/',
          geo: { latitude: 11.0303, longitude: 76.9803 }
        })
      ]
    });
    const { results } = (await maps('Coimbatore restaurants')).body.data;
    expect(results.map(r => r.title)).toEqual([
      'With A Phone',
      'With A Rating',
      'With Its Own Site'
    ]);
  });

  it('a page about one place is taken on Parallel having found it for the search', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Annapoorna Coimbatore restaurant')]
    });
    page(ANNA, 'Annapoorna', {
      '@type': 'Place',
      name: 'Seasons',
      address: 'Diwan Bahadur Road',
      geo: { latitude: 11.00884, longitude: 76.95056 }
    });
    const { results } = (await maps('Coimbatore restaurants')).body.data;
    expect(results.map(r => [r.title, r.category])).toEqual([['Seasons', null]]);
  });

  it('coordinates too coarse to be a building are not pinned', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Annapoorna Coimbatore restaurant')]
    });
    page(
      ANNA,
      'Annapoorna',
      restaurant('Sree Annapoorna', { geo: { latitude: 10.7942, longitude: 77.14 } })
    );
    const [place] = (await maps('Coimbatore restaurants')).body.data.results;
    expect(place).toMatchObject({ title: 'Sree Annapoorna', latitude: null, longitude: null });
  });

  it('does not read a site that names itself an adult site', async () => {
    const ADULT = 'https://clubs.anyxxx.example/coimbatore';
    parallelSearch.mockResolvedValue({ results: [found(ADULT, 'Coimbatore restaurants')] });
    page(ADULT, 'Coimbatore restaurants', restaurant('A Club'));
    expect((await maps('Coimbatore restaurants')).body.data.results).toEqual([]);
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe('nothing found, and failures', () => {
  it('an empty answer is an empty tab: "nothing found", not an outage', async () => {
    const res = await maps('Coimbatore restaurants');
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.external).toEqual({
      provider: 'parallel',
      status: 'ok',
      count: 0,
      indexCount: 0,
      cached: false
    });
  });

  it('pages that cannot be read, or describe no place, simply add nothing', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        found('https://blocked.example/coimbatore-restaurants', 'Coimbatore restaurants'),
        found('https://slow.example/coimbatore-restaurants', 'Coimbatore restaurants'),
        found('https://broken.example/coimbatore-restaurants', 'Coimbatore restaurants')
      ]
    });
    web.set('https://slow.example/coimbatore-restaurants', { fail: 'timeout' });
    web.set('https://broken.example/coimbatore-restaurants', {
      headers: { 'content-type': 'text/html' },
      buffer: Buffer.from('<script type="application/ld+json">{ not json </script>')
    });
    const res = await maps('Coimbatore restaurants');
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
    expect(res.body.data.external).toMatchObject({ status: 'ok', count: 0 });
  });

  it.each([
    ['timeout', 'Parallel did not answer in time'],
    ['unavailable', 'Parallel answered 503'],
    ['network', 'Parallel could not be reached'],
    ['auth', 'Parallel rejected the API key'],
    ['rate_limited', 'Parallel is limiting this key']
  ])(
    '%s: a normal page saying results are unavailable, and SerpApi is not asked',
    async (code, message) => {
      parallelSearch.mockRejectedValue(new ExternalSearchError(code, message));
      const res = await maps('Coimbatore restaurants');
      expect(res.status).toBe(200);
      expect(res.body.data.results).toEqual([]);
      expect(res.body.data.external).toEqual({
        provider: 'parallel',
        status: 'unavailable',
        count: 0,
        indexCount: 0,
        reason: code
      });
      expect(JSON.stringify(res.body)).not.toContain(PARALLEL_KEY);
    }
  );

  it('a repeat of the search, and its later pages, cost no second request', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Annapoorna Coimbatore restaurant')]
    });
    page(ANNA, 'Annapoorna', restaurant('Sree Annapoorna'));
    await maps('Coimbatore restaurants');
    const again = await maps('Coimbatore restaurants');
    await maps('Coimbatore restaurants', { page: 2 });
    expect(parallelSearch).toHaveBeenCalledTimes(2);
    expect(again.body.data.external).toMatchObject({ status: 'ok', cached: true });
    expect(again.body.data.results).toHaveLength(1);
  });
});

describe('missing configuration', () => {
  it.each([
    ['PARALLEL_VERTICALS_ENABLED is off', { verticals: false }],
    ['Parallel is switched off', { enabled: false }],
    ['Parallel has no key', { apiKey: '' }]
  ])('when %s, Maps is the crawler’s own and says its service is off', async (_label, settings) => {
    Object.assign(config.parallel, settings);
    const res = await maps('Coimbatore restaurants');
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
    expect(res.body.data.external).toMatchObject({
      provider: 'serpapi',
      status: 'disabled',
      reason: 'disabled'
    });
    expect(parallelSearch).not.toHaveBeenCalled();
  });
});

describe('the crawler’s own places', () => {
  const crawled = doc =>
    Place.create({
      pageId: new mongoose.Types.ObjectId(),
      pageUrl: 'https://crawled.example/coimbatore',
      pageTitle: 'Coimbatore restaurants',
      domain: 'crawled.example',
      terms: ['coimbatore', 'restaurants', 'restaurant'],
      ...doc
    });

  it('relevant crawled places come first, in the same shape, and Parallel’s follow without repeats', async () => {
    await crawled({
      name: 'Sree Annapoorna',
      latitude: 11.0063,
      longitude: 76.9496,
      address: 'RS Puram, Coimbatore',
      category: 'Restaurant'
    });
    // Shares a word with the query, and is somewhere else about something else.
    await crawled({
      name: 'Salem Hardware',
      latitude: 11.66,
      longitude: 78.14,
      address: 'Salem',
      terms: ['restaurants'],
      pageTitle: 'Hardware'
    });
    parallelSearch.mockResolvedValue({
      results: [
        found(ANNA, 'Annapoorna Coimbatore restaurant'),
        found(HARI, 'Haribhavanam Coimbatore restaurant')
      ]
    });
    page(ANNA, 'Annapoorna', restaurant('Sree Annapoorna'));
    page(
      HARI,
      'Haribhavanam',
      restaurant('Haribhavanam', { geo: { latitude: 11.0183, longitude: 76.9674 } })
    );

    const { data } = (await maps('Coimbatore restaurants')).body;
    expect(data.results.map(r => [r.source, r.title])).toEqual([
      ['index', 'Sree Annapoorna'],
      ['parallel', 'Haribhavanam']
    ]);
    expect(data.results[0]).toMatchObject({
      id: expect.stringMatching(/^index-place:/),
      address: 'RS Puram, Coimbatore',
      category: 'Restaurant',
      latitude: 11.0063,
      longitude: 76.9496,
      sourceUrl: 'https://crawled.example/coimbatore',
      mapsUrl: 'https://www.openstreetmap.org/?mlat=11.0063&mlon=76.9496#map=17/11.0063/76.9496'
    });
    expect(data.external).toMatchObject({
      provider: 'parallel',
      status: 'ok',
      count: 1,
      indexCount: 1
    });
  });

  it('crawled places are still shown when Parallel fails', async () => {
    await crawled({ name: 'Sree Annapoorna', latitude: 11.0063, longitude: 76.9496 });
    parallelSearch.mockRejectedValue(new ExternalSearchError('timeout', 'Parallel did not answer'));
    const { data } = (await maps('Coimbatore restaurants')).body;
    expect(data.results.map(r => r.source)).toEqual(['index']);
    expect(data.external).toMatchObject({
      status: 'unavailable',
      reason: 'timeout',
      indexCount: 1
    });
  });
});

// ---------------------------------------------------------------------------
// Whether a pin can be trusted
// ---------------------------------------------------------------------------

/** A listing found in testing: precise coordinates, 20 km south of the city its address names. */
const SPICE = 'https://listings.example/coimbatore/spice-garden-station-road';
const spiceGarden = (overrides = {}) =>
  restaurant('Spice Garden Station Road', {
    address: {
      '@type': 'PostalAddress',
      streetAddress: '318, Hospital Road',
      addressLocality: 'Coimbatore',
      addressRegion: 'Tamil Nadu',
      addressCountry: 'India'
    },
    geo: { latitude: 10.8249, longitude: 77.0748 },
    telephone: undefined,
    aggregateRating: { ratingValue: 4.1, reviewCount: 57 },
    ...overrides
  });

describe('a pin is drawn only where the position checks out', () => {
  it('coordinates outside the town the address names: the card stays, the pin does not', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        found(SPICE, 'Spice Garden Station Road - Coimbatore restaurant'),
        found(ANNA, 'Annapoorna Coimbatore restaurant')
      ]
    });
    page(SPICE, 'Spice Garden', spiceGarden());
    page(ANNA, 'Annapoorna', restaurant('Sree Annapoorna'));

    const { data } = (await maps('Coimbatore restaurants')).body;
    expect(data.results.map(r => [r.title, r.locationStatus, r.latitude, r.longitude])).toEqual([
      ['Sree Annapoorna', 'verified', 11.0062, 76.9495],
      ['Spice Garden Station Road', 'unverified', null, null]
    ]);
    const spice = data.results[1];
    // Everything the page states is still shown, with its source.
    expect(spice).toMatchObject({
      address: '318, Hospital Road, Coimbatore, Tamil Nadu, India',
      rating: 4.1,
      reviews: 57,
      sourceUrl: SPICE,
      locationReason: 'outside_locality'
    });
    // No coordinates were substituted: the map link is a search by name and address.
    expect(spice.mapsUrl).toMatch(
      /^https:\/\/www\.openstreetmap\.org\/search\?query=Spice%20Garden/
    );
    expect(JSON.stringify(spice)).not.toContain('10.8249');
  });

  it('precision is not evidence: a position given to seven decimals in the wrong town is not pinned', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(SPICE, 'Spice Garden Coimbatore restaurant')]
    });
    page(
      SPICE,
      'Spice Garden',
      spiceGarden({ geo: { latitude: 10.6676351, longitude: 77.0092111 } })
    );
    const [place] = (await maps('Coimbatore restaurants')).body.data.results;
    expect(place).toMatchObject({ locationStatus: 'unverified', latitude: null, longitude: null });
  });

  it('the address names another town than the coordinates are in', async () => {
    // A Chennai address with coordinates in Coimbatore.
    lookupLocality.mockImplementation(async ({ locality }) =>
      locality === 'chennai'
        ? {
            ok: true,
            found: true,
            name: 'Chennai',
            kind: 'city',
            south: 12.92,
            north: 13.24,
            west: 80.1,
            east: 80.33
          }
        : COIMBATORE
    );
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Annapoorna Coimbatore restaurant')]
    });
    page(
      ANNA,
      'Annapoorna',
      restaurant('Sree Annapoorna', {
        address: { streetAddress: '4 Anna Salai', addressLocality: 'Chennai', postalCode: '600002' }
      })
    );
    const [place] = (await maps('Coimbatore restaurants')).body.data.results;
    expect(place).toMatchObject({
      address: '4 Anna Salai, Chennai, 600002',
      locationStatus: 'unverified',
      locationReason: 'outside_locality',
      latitude: null
    });
  });

  it('an address given as one line is checked against the town it mentions', async () => {
    parallelSearch.mockResolvedValue({
      results: [
        found(ANNA, 'Annapoorna Coimbatore restaurant'),
        found(HARI, 'Haribhavanam Coimbatore restaurant')
      ]
    });
    page(ANNA, 'Annapoorna', restaurant('Sree Annapoorna'));
    page(
      HARI,
      'Haribhavanam',
      restaurant('Haribhavanam', {
        address: 'Gandhipuram, Coimbatore, Tamil Nadu 641012',
        geo: { latitude: 11.0183, longitude: 76.9674 }
      })
    );
    const { results } = (await maps('Coimbatore restaurants')).body.data;
    expect(results.map(r => [r.title, r.locationStatus])).toEqual([
      ['Sree Annapoorna', 'verified'],
      ['Haribhavanam', 'verified']
    ]);
  });

  it('a suburb is a small area: a place a few streets outside its box still belongs to it', async () => {
    lookupLocality.mockResolvedValue({
      ok: true,
      found: true,
      name: 'RS Puram',
      kind: 'suburb',
      south: 10.9962,
      north: 11.0162,
      west: 76.9395,
      east: 76.9595
    });
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Annapoorna Coimbatore restaurant')]
    });
    page(
      ANNA,
      'Annapoorna',
      restaurant('Sree Annapoorna', {
        address: { streetAddress: '12 DB Road', addressLocality: 'RS Puram' },
        geo: { latitude: 11.0201, longitude: 76.9611 }
      })
    );
    const [place] = (await maps('Coimbatore restaurants')).body.data.results;
    expect(place).toMatchObject({ locationStatus: 'verified', latitude: 11.0201 });
  });

  it('asks OpenStreetMap once per town, not once per place', async () => {
    const urls = Array.from(
      { length: 6 },
      (_, i) => `https://place${i}.example/coimbatore-restaurant`
    );
    parallelSearch.mockResolvedValue({
      results: urls.map(url => found(url, 'A Coimbatore restaurant'))
    });
    urls.forEach((url, i) =>
      page(
        url,
        'Restaurant',
        restaurant(`Restaurant ${i}`, {
          geo: { latitude: 11.0062 + i / 1000, longitude: 76.9495 + i / 1000 },
          telephone: `+91 422 000 000${i}`
        })
      )
    );
    const { results } = (await maps('Coimbatore restaurants')).body.data;
    expect(results).toHaveLength(6);
    expect(results.every(r => r.locationStatus === 'verified')).toBe(true);
    expect(lookupLocality).toHaveBeenCalledTimes(1);
    expect(lookupLocality).toHaveBeenCalledWith({
      locality: 'coimbatore',
      region: '',
      country: 'in'
    });
  });

  it('checks at most three towns for one search; places in the rest are listed without pins', async () => {
    const towns = ['Coimbatore', 'Tiruppur', 'Erode', 'Salem', 'Karur'];
    lookupLocality.mockResolvedValue(COIMBATORE);
    parallelSearch.mockResolvedValue({
      results: towns.map(town =>
        found(`https://${town.toLowerCase()}.example/r`, 'Coimbatore restaurant')
      )
    });
    towns.forEach((town, i) =>
      page(
        `https://${town.toLowerCase()}.example/r`,
        'Restaurant',
        restaurant(`Restaurant ${i}`, {
          address: { streetAddress: '1 Main Road', addressLocality: town },
          geo: { latitude: 11.0062 + i / 1000, longitude: 76.9495 }
        })
      )
    );
    const { results } = (await maps('Coimbatore restaurants')).body.data;
    expect(lookupLocality).toHaveBeenCalledTimes(3);
    expect(results.filter(r => r.locationStatus === 'verified')).toHaveLength(3);
    expect(results.filter(r => r.locationStatus === 'unverified')).toHaveLength(2);
  });
});

describe('when OpenStreetMap cannot be asked', () => {
  const twoSites = () => {
    parallelSearch.mockResolvedValue({
      results: [
        found(SPICE, 'Spice Garden Coimbatore restaurant'),
        found(ANNA, 'Annapoorna Coimbatore restaurant'),
        found(HARI, 'Haribhavanam Coimbatore restaurant')
      ]
    });
    page(SPICE, 'Spice Garden', spiceGarden());
    page(ANNA, 'Annapoorna', restaurant('Sree Annapoorna'));
    page(
      HARI,
      'Haribhavanam',
      restaurant('Haribhavanam', { geo: { latitude: 11.0183, longitude: 76.9674 } })
    );
  };

  it.each([
    ['it times out', () => lookupLocality.mockResolvedValue({ ok: false, reason: 'timeout' })],
    [
      'it is rate limiting',
      () => lookupLocality.mockResolvedValue({ ok: false, reason: 'rate_limited' })
    ],
    [
      'it is over its daily limit',
      () => lookupLocality.mockResolvedValue({ ok: false, reason: 'daily_limit' })
    ],
    [
      'it does not know the town',
      () => lookupLocality.mockResolvedValue({ ok: true, found: false })
    ],
    [
      'it is switched off',
      () => {
        config.maps.osm.enabled = false;
      }
    ]
  ])(
    '%s: a pin needs another website to place something in the same town nearby',
    async (_label, arrange) => {
      arrange();
      twoSites();
      const res = await maps('Coimbatore restaurants');
      expect(res.status).toBe(200);
      const { data } = res.body;
      // Two sites agree with each other about where Coimbatore is; the third is 20 km from both.
      expect(
        data.results.map(r => [r.title, r.locationStatus, r.locationEvidence || r.locationReason])
      ).toEqual([
        ['Sree Annapoorna', 'verified', 'sources'],
        ['Haribhavanam', 'verified', 'sources'],
        ['Spice Garden Station Road', 'unverified', 'unconfirmed']
      ]);
      expect(data.external).toMatchObject({ provider: 'parallel', status: 'ok', count: 3 });
    }
  );

  it('one website alone cannot vouch for itself: its places are listed without pins', async () => {
    config.maps.osm.enabled = false;
    const LIST = 'https://directory.example/coimbatore';
    parallelSearch.mockResolvedValue({ results: [found(LIST, 'Coimbatore restaurants')] });
    page(LIST, 'Coimbatore restaurants', {
      '@graph': [
        restaurant('Sree Annapoorna'),
        restaurant('Haribhavanam', { geo: { latitude: 11.0183, longitude: 76.9674 } })
      ]
    });
    const { results } = (await maps('Coimbatore restaurants')).body.data;
    expect(results.map(r => [r.title, r.locationStatus, r.latitude])).toEqual([
      ['Sree Annapoorna', 'unverified', null],
      ['Haribhavanam', 'unverified', null]
    ]);
    expect(lookupLocality).not.toHaveBeenCalled();
    expect(searchOsm).not.toHaveBeenCalled();
  });
});

describe('places OpenStreetMap knows itself', () => {
  const osm = (n, overrides = {}) => ({
    id: `osm-place:${n}`,
    title: `OSM Restaurant ${n}`,
    address: `${n} Trichy Road, Coimbatore, Tamil Nadu`,
    rating: null,
    reviews: null,
    phone: null,
    website: null,
    category: 'Restaurant',
    latitude: 10.99 + n / 1000,
    longitude: 77.0 + n / 1000,
    hours: null,
    thumbnailUrl: null,
    sourceUrl: `https://www.openstreetmap.org/node/${1000 + n}`,
    sourceDomain: 'openstreetmap.org',
    locality: 'Coimbatore',
    about: 'restaurant amenity',
    source: 'osm',
    ...overrides
  });

  it('are added after the pages’ places, with OpenStreetMap as their source and their own positions', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Annapoorna Coimbatore restaurant')]
    });
    page(ANNA, 'Annapoorna', restaurant('Sree Annapoorna'));
    searchOsm.mockResolvedValue({
      ok: true,
      places: [osm(1), osm(2, { hours: 'Mo-Su 11:00-23:00' })],
      cached: false
    });

    const { data } = (await maps('Coimbatore restaurants')).body;
    expect(searchOsm).toHaveBeenCalledTimes(1);
    expect(searchOsm).toHaveBeenCalledWith('Coimbatore restaurants');
    expect(data.results.map(r => [r.source, r.title, r.locationEvidence])).toEqual([
      ['parallel', 'Sree Annapoorna', 'openstreetmap'],
      ['osm', 'OSM Restaurant 1', 'map'],
      ['osm', 'OSM Restaurant 2', 'map']
    ]);
    expect(data.results[2]).toEqual({
      id: 'osm-place:2',
      title: 'OSM Restaurant 2',
      address: '2 Trichy Road, Coimbatore, Tamil Nadu',
      rating: null,
      reviews: null,
      phone: null,
      website: null,
      category: 'Restaurant',
      latitude: 10.992,
      longitude: 77.002,
      hours: 'Mo-Su 11:00-23:00',
      thumbnailUrl: null,
      sourceUrl: 'https://www.openstreetmap.org/node/1002',
      sourceDomain: 'openstreetmap.org',
      source: 'osm',
      locationStatus: 'verified',
      locationEvidence: 'map',
      mapsUrl: 'https://www.openstreetmap.org/?mlat=10.992&mlon=77.002#map=17/10.992/77.002',
      position: 3
    });
    expect(data.total).toBe(3);
  });

  it('a place both describe is shown once, as the page describes it', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Annapoorna Coimbatore restaurant')]
    });
    page(
      ANNA,
      'Annapoorna',
      restaurant('Sree Annapoorna', { aggregateRating: { ratingValue: 4.3, reviewCount: 10 } })
    );
    searchOsm.mockResolvedValue({
      ok: true,
      cached: false,
      places: [
        osm(1, { title: 'Sree Annapoorna Restaurant', latitude: 11.0063, longitude: 76.9496 }),
        osm(2)
      ]
    });
    const { results } = (await maps('Coimbatore restaurants')).body.data;
    expect(results.map(r => [r.source, r.title])).toEqual([
      ['parallel', 'Sree Annapoorna'],
      ['osm', 'OSM Restaurant 2']
    ]);
    expect(results[0].rating).toBe(4.3);
  });

  it('branches of one chain are all kept', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Annapoorna Coimbatore restaurant')]
    });
    page(ANNA, 'Annapoorna', restaurant('Sree Annapoorna'));
    searchOsm.mockResolvedValue({
      ok: true,
      cached: false,
      places: [
        osm(1, {
          title: 'Sree Annapoorna',
          latitude: 11.0257,
          longitude: 77.0143,
          address: 'Avinashi Road, Peelamedu, Coimbatore'
        }),
        osm(2, {
          title: 'Sree Annapoorna',
          latitude: 10.9925,
          longitude: 76.9614,
          address: 'Town Hall, Coimbatore'
        })
      ]
    });
    const { results } = (await maps('Coimbatore restaurants')).body.data;
    expect(results.map(r => r.title)).toEqual([
      'Sree Annapoorna',
      'Sree Annapoorna',
      'Sree Annapoorna'
    ]);
    expect(new Set(results.map(r => `${r.latitude},${r.longitude}`)).size).toBe(3);
  });

  it('a place whose pin could not be trusted is not corrected: OpenStreetMap’s own entry for it is shown instead', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(SPICE, 'Spice Garden Coimbatore restaurant')]
    });
    page(SPICE, 'Spice Garden', spiceGarden({ telephone: '+91 422 230 1111' }));
    searchOsm.mockResolvedValue({
      ok: true,
      cached: false,
      places: [
        osm(1, {
          title: 'Spice Garden Station Road',
          phone: '0422 230 1111',
          latitude: 10.9966,
          longitude: 76.9659
        })
      ]
    });
    const { results } = (await maps('Coimbatore restaurants')).body.data;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source: 'osm',
      sourceUrl: 'https://www.openstreetmap.org/node/1001',
      latitude: 10.9966,
      longitude: 76.9659,
      // OpenStreetMap's entry, with OpenStreetMap's details: the page's rating is not carried over.
      rating: null
    });
  });

  it('results OpenStreetMap returns that are about something else are left out', async () => {
    searchOsm.mockResolvedValue({
      ok: true,
      cached: false,
      places: [
        osm(1),
        osm(2, {
          title: 'City Motors',
          category: 'Car repair',
          about: 'car_repair shop',
          address: 'Salem Road, Erode'
        })
      ]
    });
    const { results } = (await maps('Coimbatore restaurants')).body.data;
    expect(results.map(r => r.title)).toEqual(['OSM Restaurant 1']);
  });

  it.each(['timeout', 'rate_limited', 'busy', 'daily_limit', 'unavailable'])(
    'when its search fails (%s), the pages’ places are shown as usual',
    async reason => {
      parallelSearch.mockResolvedValue({
        results: [found(ANNA, 'Annapoorna Coimbatore restaurant')]
      });
      page(ANNA, 'Annapoorna', restaurant('Sree Annapoorna'));
      searchOsm.mockResolvedValue({ ok: false, reason });
      const res = await maps('Coimbatore restaurants');
      expect(res.status).toBe(200);
      expect(res.body.data.results.map(r => [r.source, r.locationStatus])).toEqual([
        ['parallel', 'verified']
      ]);
      expect(res.body.data.external).toMatchObject({ status: 'ok', count: 1 });
    }
  );

  it('a repeat of the search asks neither Parallel nor OpenStreetMap again', async () => {
    searchOsm.mockResolvedValue({ ok: true, places: [osm(1)], cached: false });
    await maps('Coimbatore restaurants');
    const again = await maps('Coimbatore restaurants');
    expect(again.body.data.results).toHaveLength(1);
    expect(searchOsm).toHaveBeenCalledTimes(1);
    expect(parallelSearch).toHaveBeenCalledTimes(2);
  });

  it('are left out under a site filter: they come from no page on that site', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Annapoorna Coimbatore restaurant')]
    });
    page(ANNA, 'Annapoorna', restaurant('Sree Annapoorna'));
    searchOsm.mockResolvedValue({ ok: true, places: [osm(1), osm(2)], cached: false });

    const { data } = (await maps('Coimbatore restaurants', { domain: 'annapoorna.example' })).body;
    expect(parallelSearch.mock.calls[0][0].sourcePolicy).toEqual({
      include_domains: ['annapoorna.example']
    });
    expect(searchOsm).not.toHaveBeenCalled();
    expect(data.results.map(r => [r.source, r.sourceDomain])).toEqual([
      ['parallel', 'annapoorna.example']
    ]);
    expect(data.filters.domain).toBe('annapoorna.example');
    expect(data.ignoredFilters).toEqual([]);
  });
});

describe('filters a place cannot have', () => {
  it('date, language and sort are not applied on Maps, and the answer says so', async () => {
    parallelSearch.mockResolvedValue({
      results: [found(ANNA, 'Annapoorna Coimbatore restaurant')]
    });
    page(ANNA, 'Annapoorna', restaurant('Sree Annapoorna'));

    const res = await maps('Coimbatore restaurants', {
      date: 'week',
      language: 'ta',
      sort: 'newest'
    });
    expect(res.status).toBe(200);
    const { data } = res.body;
    // Not used to narrow the search: Parallel is asked without them, rather
    // than skipped, and no publication-date cut is sent for places.
    expect(parallelSearch).toHaveBeenCalled();
    expect(parallelSearch.mock.calls[0][0].sourcePolicy).toEqual({});
    expect(data.results.map(r => r.title)).toEqual(['Sree Annapoorna']);
    // And not claimed: the request is echoed, and what was ignored is listed.
    expect(data.filters).toMatchObject({ date: 'week', language: 'ta', sort: 'newest' });
    expect(data.ignoredFilters).toEqual(['date', 'language', 'sort']);
    expect(data.appliedSort).toBe('relevance');
  });

  it('only the filters actually set are listed as ignored', async () => {
    const { data } = (await maps('Coimbatore restaurants', { date: 'month' })).body;
    expect(data.ignoredFilters).toEqual(['date']);
    const plain = (await maps('Coimbatore restaurants')).body.data;
    expect(plain.ignoredFilters).toEqual([]);
    expect(plain.appliedSort).toBe('relevance');
  });
});
