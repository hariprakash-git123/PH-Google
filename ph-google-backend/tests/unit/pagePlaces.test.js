const pagePlaces = require('../../services/external/pagePlaces');
const safeFetch = require('../../services/external/safeFetch');
const parallelVerticals = require('../../services/parallelVerticals');

/**
 * Places read from a page's own structured data (schema.org JSON-LD): what
 * counts as a place, which coordinates are believed, and that nothing a page
 * does not state is ever filled in. No network.
 */

const PAGE = 'https://dir.example/coimbatore/annapoorna';
const ld = (...nodes) =>
  nodes.map(node => `<script type="application/ld+json">${JSON.stringify(node)}</script>`).join('');
const extract = (...nodes) =>
  pagePlaces.extractPlaces(`<html><head>${ld(...nodes)}</head></html>`, PAGE);
const place = (overrides = {}) => ({
  '@type': 'Restaurant',
  name: 'Sree Annapoorna',
  address: '12 DB Road, Coimbatore',
  geo: { latitude: 11.0062, longitude: 76.9495 },
  ...overrides
});

afterEach(() => jest.restoreAllMocks());

describe('what counts as a place', () => {
  it.each([
    'Restaurant',
    'CafeOrCoffeeShop',
    'Hotel',
    'LodgingBusiness',
    'Hospital',
    'MedicalClinic',
    'Pharmacy',
    'Store',
    'GroceryStore',
    'ShoppingCenter',
    'TouristAttraction',
    'Museum',
    'Park',
    'HinduTemple',
    'LocalBusiness',
    'Place',
    'https://schema.org/Restaurant'
  ])('a %s with a name and an address is one', type => {
    expect(extract(place({ '@type': type }))).toHaveLength(1);
  });

  it.each([
    'Organization',
    'Corporation',
    'WebSite',
    'WebPage',
    'Article',
    'Person',
    'Product',
    'BreadcrumbList'
  ])('a %s is not, whatever address it carries', type => {
    expect(extract(place({ '@type': type }))).toEqual([]);
  });

  it('one of several types is enough', () => {
    expect(extract(place({ '@type': ['Organization', 'Restaurant'] }))).toHaveLength(1);
  });

  it('needs a name, and an address or a position', () => {
    expect(extract(place({ name: '' }))).toEqual([]);
    expect(extract(place({ name: undefined }))).toEqual([]);
    expect(extract(place({ address: undefined, geo: undefined }))).toEqual([]);
    expect(extract(place({ address: undefined }))).toHaveLength(1);
    expect(extract(place({ geo: undefined }))).toHaveLength(1);
  });

  it('finds places inside @graph, lists and nested objects, in page order', () => {
    const out = extract(
      {
        '@context': 'https://schema.org',
        '@graph': [{ '@type': 'WebSite', name: 'Dir' }, place({ name: 'One' })]
      },
      [place({ name: 'Two' })],
      {
        '@type': 'ItemList',
        itemListElement: [{ '@type': 'ListItem', item: place({ name: 'Three' }) }]
      }
    );
    expect(out.map(p => p.title)).toEqual(['One', 'Two', 'Three']);
    expect(out.every(p => p.sourceUrl === PAGE)).toBe(true);
  });

  it('takes a bounded number from one page', () => {
    const many = Array.from({ length: 40 }, (_, i) => place({ name: `Place ${i}` }));
    expect(extract({ '@graph': many })).toHaveLength(12);
  });

  it('structured data that does not parse, or a page that is not HTML, says nothing', () => {
    expect(
      pagePlaces.extractPlaces('<script type="application/ld+json">{ not json </script>', PAGE)
    ).toEqual([]);
    expect(pagePlaces.extractPlaces('\u0000 not html', PAGE)).toEqual([]);
    expect(pagePlaces.extractPlaces(null, PAGE)).toEqual([]);
    expect(extract('just a string', 42, null)).toEqual([]);
  });

  it('reads nothing from the page’s prose', () => {
    const html =
      '<h1>Sree Annapoorna</h1><address>12 DB Road, Coimbatore</address><p>11.0062, 76.9495</p>';
    expect(pagePlaces.extractPlaces(html, PAGE)).toEqual([]);
  });
});

describe('coordinates', () => {
  const of = geo => {
    const [found] = extract(place({ geo }));
    return [found.latitude, found.longitude];
  };

  it.each([
    [{ latitude: 11.0062, longitude: 76.9495 }, [11.0062, 76.9495]],
    [{ latitude: '11.0306446', longitude: '77.02721609999999' }, [11.0306446, 77.02721609999999]],
    [{ latitude: -33.8568, longitude: 151.2153 }, [-33.8568, 151.2153]],
    [[{ latitude: 11.0062, longitude: 76.9495 }], [11.0062, 76.9495]]
  ])('%j is believed', (geo, expected) => {
    expect(of(geo)).toEqual(expected);
  });

  it.each([
    [{ latitude: 0, longitude: 0 }],
    [{ latitude: 91, longitude: 76.9 }],
    [{ latitude: 11.0, longitude: 181.5 }],
    [{ latitude: 'x', longitude: 'y' }],
    [{ latitude: 11.0062 }],
    [{ longitude: 76.9495 }],
    [{ latitude: 11, longitude: 77 }],
    // A district, not a building: too coarse to pin.
    [{ latitude: 10.79, longitude: 77.14 }],
    [{ latitude: 10.7942, longitude: 77.14 }],
    [{ latitude: '11.0', longitude: '76.9' }],
    [{ latitude: null, longitude: null }],
    [{ latitude: '', longitude: '' }],
    [{}],
    ['11.0062,76.9495'],
    [null]
  ])('%j is not: the place has no position', geo => {
    expect(of(geo)).toEqual([null, null]);
  });
});

describe('details are the page’s, or absent', () => {
  it('an address is one line, without repeating what the street line already says', () => {
    expect(
      pagePlaces.addressOf({
        streetAddress: '12 DB Road, RS Puram, Coimbatore, Tamil Nadu 641002',
        addressLocality: 'Coimbatore',
        addressRegion: 'Tamil Nadu',
        postalCode: '641002',
        addressCountry: 'IN'
      })
    ).toBe('12 DB Road, RS Puram, Coimbatore, Tamil Nadu 641002');
    expect(
      pagePlaces.addressOf({
        streetAddress: '12 DB Road',
        addressLocality: 'Coimbatore',
        addressRegion: 'Tamil Nadu',
        postalCode: '641002',
        addressCountry: { '@type': 'Country', name: 'India' }
      })
    ).toBe('12 DB Road, Coimbatore, Tamil Nadu, 641002, India');
    expect(pagePlaces.addressOf('  12 DB Road,\n Coimbatore ')).toBe('12 DB Road, Coimbatore');
    expect(pagePlaces.addressOf({})).toBeNull();
    expect(pagePlaces.addressOf(null)).toBeNull();
    expect(pagePlaces.addressOf(['x'])).toBeNull();
  });

  it('a rating is shown only when it is out of five', () => {
    const rated = aggregateRating => extract(place({ aggregateRating }))[0];
    expect(rated({ ratingValue: '4.3', reviewCount: '1,245' })).toMatchObject({
      rating: 4.3,
      reviews: 1245
    });
    expect(rated({ ratingValue: 4.6, ratingCount: 88, bestRating: '5' })).toMatchObject({
      rating: 4.6,
      reviews: 88
    });
    expect(rated({ ratingValue: 8.7, bestRating: 10, reviewCount: 40 })).toMatchObject({
      rating: null,
      reviews: null
    });
    expect(rated({ ratingValue: 7 })).toMatchObject({ rating: null, reviews: null });
    expect(rated({ ratingValue: 'great' })).toMatchObject({ rating: null, reviews: null });
    expect(rated(undefined)).toMatchObject({ rating: null, reviews: null });
  });

  it('a phone number must look like one', () => {
    const phoned = telephone => extract(place({ telephone }))[0].phone;
    expect(phoned('+91 422 254 1234')).toBe('+91 422 254 1234');
    expect(phoned(['089519 41704', '080 1111 2222'])).toBe('089519 41704');
    expect(phoned('call us now!')).toBeNull();
    expect(phoned('<b onclick=alert(1)>0422</b>')).toBeNull();
    expect(phoned(undefined)).toBeNull();
  });

  it('opening hours are quoted as written, never worked out', () => {
    expect(extract(place({ openingHours: 'Mo-Su 07:00-22:00' }))[0].hours).toBe(
      'Mo-Su 07:00-22:00'
    );
    expect(extract(place({ openingHours: ['Mo-Fr 09:00-18:00', 'Sa 10:00-14:00'] }))[0].hours).toBe(
      'Mo-Fr 09:00-18:00; Sa 10:00-14:00'
    );
    expect(extract(place({ openingHoursSpecification: [{ opens: '09:00' }] }))[0].hours).toBeNull();
  });

  it('links must be http(s); the place’s own site is not the page it was read from', () => {
    expect(extract(place({ url: 'https://annapoorna.example/' }))[0].website).toBe(
      'https://annapoorna.example/'
    );
    expect(extract(place({ url: '/coimbatore/annapoorna' }))[0].website).toBeNull();
    expect(extract(place({ url: 'javascript:alert(1)' }))[0].website).toBeNull();
    expect(extract(place({ image: 'javascript:alert(1)' }))[0].thumbnailUrl).toBeNull();
    expect(extract(place({ image: ['https://x.example/a.jpg'] }))[0].thumbnailUrl).toBe(
      'https://x.example/a.jpg'
    );
    expect(extract(place({ image: { url: 'https://x.example/b.jpg' } }))[0].thumbnailUrl).toBe(
      'https://x.example/b.jpg'
    );
  });

  it('the category is the page’s own type, in words', () => {
    expect(pagePlaces.categoryOf(['CafeOrCoffeeShop'])).toBe('Cafe or coffee shop');
    expect(pagePlaces.categoryOf(['LocalBusiness', 'Restaurant'])).toBe('Restaurant');
    expect(pagePlaces.categoryOf(['Place'])).toBeNull();
    expect(pagePlaces.categoryOf(['LocalBusiness'])).toBeNull();
  });

  it('text is plain text: markup in a name stays text', () => {
    const [found] = extract(place({ name: '<img src=x onerror=alert(1)> Cafe' }));
    expect(found.title).toBe('<img src=x onerror=alert(1)> Cafe');
  });
});

describe('placesFromPage', () => {
  const answer = value => jest.spyOn(safeFetch, 'get').mockResolvedValue(value);
  const html = body => ({
    ok: true,
    status: 200,
    headers: { 'content-type': 'text/html' },
    buffer: Buffer.from(body),
    truncated: false,
    finalUrl: PAGE
  });

  it('reads the places a page describes', async () => {
    answer(html(ld(place())));
    const out = await pagePlaces.placesFromPage(PAGE);
    expect(out.places.map(p => p.title)).toEqual(['Sree Annapoorna']);
    expect(out.reason).toBeUndefined();
  });

  it('attributes them to the address the page was really served from', async () => {
    answer({ ...html(ld(place())), finalUrl: 'https://dir.example/moved' });
    const out = await pagePlaces.placesFromPage(PAGE);
    expect(out.places[0].sourceUrl).toBe('https://dir.example/moved');
  });

  it.each(['timeout', 'network', 'blocked', 'upstream', 'invalid_url'])(
    'a page that cannot be fetched (%s) has none, and is not an error',
    async reason => {
      answer({ ok: false, reason });
      expect(await pagePlaces.placesFromPage(PAGE)).toEqual({ pageUrl: PAGE, places: [], reason });
    }
  );

  it('something that is not a web page has none', async () => {
    answer({ ...html('%PDF-1.7'), headers: { 'content-type': 'application/pdf' } });
    expect(await pagePlaces.placesFromPage(PAGE)).toMatchObject({ places: [], reason: 'not_html' });
  });
});

describe('the same place', () => {
  const a = {
    title: 'Third Wave Coffee',
    latitude: 12.9716,
    longitude: 77.5978,
    phone: null,
    address: 'Lavelle Road',
    sourceUrl: 'https://a.example/1'
  };

  it('same name, a few metres apart', () => {
    expect(parallelVerticals.samePlace(a, { ...a, latitude: 12.9717, longitude: 77.5979 })).toBe(
      true
    );
  });
  it('same name, another branch across town', () => {
    expect(parallelVerticals.samePlace(a, { ...a, latitude: 12.9429, longitude: 77.6919 })).toBe(
      false
    );
  });
  it('a different name at the same spot (two shops in one mall)', () => {
    expect(parallelVerticals.samePlace(a, { ...a, title: 'Blue Tokai' })).toBe(false);
  });
  it('names are compared without case, accents or punctuation', () => {
    expect(
      parallelVerticals.samePlace(
        { ...a, title: 'Café Coffee-Day' },
        { ...a, title: 'cafe coffee day' }
      )
    ).toBe(true);
  });
  it('with one position missing: the same phone number, or the same address', () => {
    const noPosition = { ...a, latitude: null, longitude: null };
    expect(
      parallelVerticals.samePlace(a, { ...noPosition, phone: '080 4132 5887', address: 'x' })
    ).toBe(false);
    expect(
      parallelVerticals.samePlace(
        { ...a, phone: '+91 80 4132 5887' },
        { ...noPosition, phone: '080 4132 5887', address: 'x' }
      )
    ).toBe(true);
    expect(
      parallelVerticals.samePlace(a, { ...noPosition, address: 'Lavelle Road, Bengaluru' })
    ).toBe(true);
    expect(parallelVerticals.samePlace(a, { ...noPosition, address: 'Indiranagar' })).toBe(false);
  });
  it('distance is measured on the globe', () => {
    expect(
      Math.round(
        pagePlaces.distanceMetres({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }) /
          1000
      )
    ).toBe(111);
  });
});
