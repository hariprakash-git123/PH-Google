const { config } = require('../../config/env');
const nominatimClient = require('../../services/external/nominatimClient');
const placeTrust = require('../../services/external/placeTrust');
const logger = require('../../utils/logger');

/**
 * The OpenStreetMap (Nominatim) client, held to the public service's usage
 * policy: one request at a time and never two within the interval, every
 * answer cached, the application named in User-Agent, the address a matter
 * of configuration, a daily ceiling — and no exception for anything that
 * goes wrong. No network: fetch is injected.
 */

const original = { ...config.maps.osm };
const INTERVAL = 120;

/** A fake Nominatim that records when each request arrived and what it carried. */
function service(answer = () => []) {
  const calls = [];
  const fetchImpl = jest.fn(async (url, init) => {
    const call = { at: Date.now(), url: new URL(url), headers: init.headers };
    calls.push(call);
    const value = await answer(call, calls.length);
    if (value instanceof Error) throw value;
    if (value && value.status) return { ok: false, status: value.status, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (value === 'not-json') throw new SyntaxError('Unexpected token');
        return value;
      }
    };
  });
  return { fetchImpl, calls };
}

const cityHit = (overrides = {}) => ({
  place_id: 1,
  osm_type: 'node',
  osm_id: 245761010,
  lat: '11.0018115',
  lon: '76.9628425',
  category: 'place',
  type: 'city',
  addresstype: 'city',
  name: 'Coimbatore',
  display_name: 'Coimbatore, Tamil Nadu, India',
  boundingbox: ['10.8418115', '11.1618115', '76.8028425', '77.1228425'],
  ...overrides
});

beforeEach(() => {
  nominatimClient.reset();
  Object.assign(config.maps.osm, original, {
    enabled: true,
    baseUrl: 'https://nominatim.test',
    userAgent: 'PH-Search-Maps/1.0 (+https://example.org/bot)',
    timeoutMs: 500,
    minIntervalMs: INTERVAL,
    maxWaitMs: 2000,
    dailyLimit: 0,
    cacheTtlMs: 60000,
    cacheMaxEntries: 100
  });
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => Object.assign(config.maps.osm, original));

describe('the usage policy', () => {
  it('names the application in User-Agent and asks the configured address', async () => {
    const { fetchImpl, calls } = service();
    await nominatimClient.searchPlaces('restaurants in coimbatore', { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0].url.origin).toBe('https://nominatim.test');
    expect(calls[0].url.pathname).toBe('/search');
    expect(calls[0].headers['user-agent']).toBe('PH-Search-Maps/1.0 (+https://example.org/bot)');
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({
      format: 'jsonv2',
      q: 'restaurants in coimbatore',
      limit: '40',
      addressdetails: '1',
      extratags: '1',
      layer: 'poi'
    });
  });

  it('the service can be switched by configuration alone', async () => {
    config.maps.osm.baseUrl = 'https://nominatim.internal.example';
    const { fetchImpl, calls } = service();
    await nominatimClient.searchPlaces('cafes', { fetchImpl });
    expect(calls[0].url.origin).toBe('https://nominatim.internal.example');
  });

  it('never sends two requests within the interval, however many are asked at once', async () => {
    const { fetchImpl, calls } = service();
    await Promise.all(
      ['one', 'two', 'three', 'four'].map(q => nominatimClient.searchPlaces(q, { fetchImpl }))
    );
    expect(calls).toHaveLength(4);
    const gaps = calls.slice(1).map((call, i) => call.at - calls[i].at);
    // A few milliseconds of timer slack; never back to back.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(INTERVAL - 15);
  });

  it('never has two requests in flight: the next waits for the answer', async () => {
    let inFlight = 0;
    let most = 0;
    const { fetchImpl } = service(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise(resolve => {
        setTimeout(resolve, 60);
      });
      inFlight -= 1;
      return [];
    });
    await Promise.all(['a', 'b', 'c'].map(q => nominatimClient.searchPlaces(q, { fetchImpl })));
    expect(most).toBe(1);
  });

  it('caches every answer: the same question is asked once', async () => {
    const { fetchImpl, calls } = service(() => [cityHit()]);
    const first = await nominatimClient.lookupLocality({ locality: 'Coimbatore' }, { fetchImpl });
    const again = await nominatimClient.lookupLocality(
      { locality: '  COIMBATORE ' },
      { fetchImpl }
    );
    expect(calls).toHaveLength(1);
    expect(again).toEqual(first);
    expect(nominatimClient.describe()).toMatchObject({ usedToday: 1, cached: 1 });
  });

  it('identical questions asked at the same moment share one request', async () => {
    const { fetchImpl, calls } = service(() => [cityHit()]);
    await Promise.all(
      Array.from({ length: 5 }, () =>
        nominatimClient.lookupLocality({ locality: 'Coimbatore' }, { fetchImpl })
      )
    );
    expect(calls).toHaveLength(1);
  });

  it('does not cache a failure: the next search may try again', async () => {
    const { fetchImpl, calls } = service((_call, n) => (n === 1 ? { status: 503 } : [cityHit()]));
    expect(await nominatimClient.lookupLocality({ locality: 'Coimbatore' }, { fetchImpl })).toEqual(
      {
        ok: false,
        reason: 'unavailable'
      }
    );
    expect(
      (await nominatimClient.lookupLocality({ locality: 'Coimbatore' }, { fetchImpl })).found
    ).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('stops at the daily ceiling', async () => {
    config.maps.osm.dailyLimit = 2;
    const { fetchImpl, calls } = service();
    await nominatimClient.searchPlaces('one', { fetchImpl });
    await nominatimClient.searchPlaces('two', { fetchImpl });
    expect(await nominatimClient.searchPlaces('three', { fetchImpl })).toEqual({
      ok: false,
      reason: 'daily_limit'
    });
    expect(calls).toHaveLength(2);
    // What is cached is still answered.
    expect((await nominatimClient.searchPlaces('one', { fetchImpl })).ok).toBe(true);
  });

  it('a search does not wait behind a long queue: it goes without', async () => {
    config.maps.osm.maxWaitMs = INTERVAL;
    const { fetchImpl, calls } = service();
    const outcomes = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map(q => nominatimClient.searchPlaces(q, { fetchImpl }))
    );
    expect(outcomes.filter(o => !o.ok).map(o => o.reason)).toEqual(
      expect.arrayContaining(['busy'])
    );
    expect(calls.length).toBeLessThan(5);
  });

  it.each([
    ['switched off', { enabled: false }, 'disabled'],
    ['no User-Agent to identify with', { userAgent: '' }, 'not_configured']
  ])('%s: nothing is sent', async (_label, settings, reason) => {
    Object.assign(config.maps.osm, settings);
    const { fetchImpl, calls } = service();
    expect(await nominatimClient.searchPlaces('cafes', { fetchImpl })).toEqual({
      ok: false,
      reason
    });
    expect(await nominatimClient.lookupLocality({ locality: 'Coimbatore' }, { fetchImpl })).toEqual(
      {
        ok: false,
        reason
      }
    );
    expect(calls).toHaveLength(0);
  });
});

describe('failures are reasons, never exceptions', () => {
  it.each([
    ['rate limited', { status: 429 }, 'rate_limited'],
    ['blocked', { status: 403 }, 'rate_limited'],
    ['an outage', { status: 500 }, 'unavailable'],
    ['a reply that is not JSON', 'not-json', 'invalid_response'],
    ['a reply that is not a list', { error: 'nope' }, 'invalid_response'],
    ['a timeout', Object.assign(new Error('t'), { name: 'TimeoutError' }), 'timeout'],
    ['no connection', new Error('ECONNRESET'), 'network']
  ])('%s', async (_label, answer, reason) => {
    const { fetchImpl } = service(() => answer);
    expect(await nominatimClient.searchPlaces('cafes', { fetchImpl })).toEqual({
      ok: false,
      reason
    });
  });
});

describe('lookupLocality', () => {
  it('returns where OpenStreetMap places the town', async () => {
    const { fetchImpl, calls } = service(() => [cityHit()]);
    const out = await nominatimClient.lookupLocality(
      { locality: 'Coimbatore', region: 'Tamil Nadu', country: 'IN' },
      { fetchImpl }
    );
    expect(out).toEqual({
      ok: true,
      found: true,
      name: 'Coimbatore',
      kind: 'city',
      south: 10.8418115,
      north: 11.1618115,
      west: 76.8028425,
      east: 77.1228425
    });
    expect(Object.fromEntries(calls[0].url.searchParams)).toMatchObject({
      q: 'coimbatore, tamil nadu',
      limit: '1',
      countrycodes: 'in'
    });
  });

  it('a country written out goes into the question', async () => {
    const { fetchImpl, calls } = service(() => [cityHit()]);
    await nominatimClient.lookupLocality(
      { locality: 'Coimbatore', country: 'India' },
      { fetchImpl }
    );
    expect(calls[0].url.searchParams.get('q')).toBe('coimbatore, india');
    expect(calls[0].url.searchParams.has('countrycodes')).toBe(false);
  });

  it.each([
    ['nothing by that name', []],
    ['a shop that happens to be called that', [cityHit({ category: 'shop', type: 'bakery' })]],
    ['an answer without a usable area', [cityHit({ boundingbox: ['a', 'b', 'c', 'd'] })]],
    ['an answer with no area at all', [cityHit({ boundingbox: undefined })]]
  ])('%s is "not found", not a failure', async (_label, results) => {
    const { fetchImpl } = service(() => results);
    expect(await nominatimClient.lookupLocality({ locality: 'Coimbatore' }, { fetchImpl })).toEqual(
      {
        ok: true,
        found: false
      }
    );
  });

  it('asks nothing for an address with no town', async () => {
    const { fetchImpl, calls } = service();
    expect(await nominatimClient.lookupLocality({ locality: '  ' }, { fetchImpl })).toEqual({
      ok: true,
      found: false
    });
    expect(calls).toHaveLength(0);
  });
});

describe('searchPlaces', () => {
  const poi = (overrides = {}) => ({
    osm_type: 'node',
    osm_id: 4455667788,
    lat: '11.0342806',
    lon: '77.0034812',
    category: 'amenity',
    type: 'restaurant',
    name: 'Sri Aaditya Restaurants',
    address: {
      house_number: '12',
      road: 'Gandhimanagar Road',
      suburb: 'Bharathi Nagar',
      city: 'Coimbatore',
      state: 'Tamil Nadu',
      postcode: '641004',
      country: 'India'
    },
    extratags: {
      phone: '+91 422 251 0000',
      cuisine: 'indian;south_indian',
      opening_hours: 'Mo-Su 07:00-22:30'
    },
    ...overrides
  });

  it('maps OpenStreetMap’s places with what OpenStreetMap holds, and nothing more', async () => {
    const { fetchImpl } = service(() => [poi()]);
    const out = await nominatimClient.searchPlaces('restaurants in Coimbatore', { fetchImpl });
    expect(out.ok).toBe(true);
    expect(out.places).toEqual([
      {
        id: expect.stringMatching(/^osm-place:[0-9a-f]{40}$/),
        title: 'Sri Aaditya Restaurants',
        address: '12 Gandhimanagar Road, Bharathi Nagar, Coimbatore, Tamil Nadu, 641004',
        // OpenStreetMap has no ratings: none is shown.
        rating: null,
        reviews: null,
        phone: '+91 422 251 0000',
        website: null,
        category: 'Restaurant',
        latitude: 11.0342806,
        longitude: 77.0034812,
        hours: 'Mo-Su 07:00-22:30',
        thumbnailUrl: null,
        sourceUrl: 'https://www.openstreetmap.org/node/4455667788',
        sourceDomain: 'openstreetmap.org',
        locality: 'Coimbatore',
        about: 'restaurant amenity indian south indian',
        source: 'osm'
      }
    ]);
  });

  it.each([
    ['a road', { category: 'highway', type: 'residential' }],
    ['a town', { category: 'place', type: 'city' }],
    ['a boundary', { category: 'boundary', type: 'administrative' }],
    ['something with no name', { name: '' }],
    ['something with no position', { lat: 'x' }],
    ['something with no OpenStreetMap id', { osm_id: 'abc' }],
    ['an unknown kind of object', { osm_type: 'changeset' }]
  ])('leaves out %s', async (_label, overrides) => {
    const { fetchImpl } = service(() => [poi(overrides), null, 'junk']);
    expect((await nominatimClient.searchPlaces('x', { fetchImpl })).places).toEqual([]);
  });

  it('drops unsafe links and things that are not phone numbers', async () => {
    const { fetchImpl } = service(() => [
      poi({ extratags: { phone: 'ask at the counter', website: 'javascript:alert(1)' } })
    ]);
    const [place] = (await nominatimClient.searchPlaces('x', { fetchImpl })).places;
    expect(place).toMatchObject({ phone: null, website: null, hours: null });
  });

  it('an empty search asks nothing', async () => {
    const { fetchImpl, calls } = service();
    expect(await nominatimClient.searchPlaces('   ', { fetchImpl })).toEqual({
      ok: true,
      places: [],
      cached: false
    });
    expect(calls).toHaveLength(0);
  });
});

describe('placeTrust', () => {
  it('measures distance on the globe', () => {
    // The known case: 20 km from the centre of the town it names.
    const km = placeTrust.kilometres(
      { latitude: 11.0018, longitude: 76.9628 },
      { latitude: 10.8249, longitude: 77.0748 }
    );
    expect(Math.round(km)).toBe(23);
  });

  it('finds the town an address line names, as a whole word', () => {
    expect(placeTrust.claimedLocality({ locality: ' Coimbatore ' }, [])).toBe('coimbatore');
    expect(
      placeTrust.claimedLocality({ address: 'Gandhipuram, Coimbatore, Tamil Nadu 641012' }, [
        'salem',
        'coimbatore'
      ])
    ).toBe('coimbatore');
    // "Salem" is not in "Jerusalem Street".
    expect(placeTrust.claimedLocality({ address: '4 Jerusalem Street' }, ['salem'])).toBe('');
    expect(placeTrust.claimedLocality({ address: '' }, ['coimbatore'])).toBe('');
  });
});
