const { parseQuery } = require('../../services/opensearch/queryParser');
const { buildVerticalRequest } = require('../../services/external/serpApiQuery');
const { mapImageResult, mapImageResults } = require('../../services/external/serpApiImageMapper');
const { mapVideoResult, mapVideoResults } = require('../../services/external/serpApiVideoMapper');
const { mapPlaceResult, mapPlaceResults } = require('../../services/external/serpApiMapsMapper');
const { httpUrl, number, text } = require('../../services/external/fields');
const { searchEngine } = require('../../services/external/serpApiClient');
const { startSerpApiStandIn, images, videos, places } = require('../helpers/serpApiStandIn');

/**
 * The image, video and maps verticals from SerpApi: the requests built for
 * each engine, how each kind of result is normalised, and how the client
 * reads each engine's reply. SerpApi is a local stand-in throughout.
 */

const build = (q, vertical, filters) => buildVerticalRequest(parseQuery(q), vertical, filters);

describe('vertical requests', () => {
  it('images use google_images with the same Google query as web search', () => {
    expect(build('python', 'images')).toEqual({
      skip: false,
      engine: 'google_images',
      q: 'python',
      params: {}
    });
    expect(build('logo site:python.org -snake', 'images')).toMatchObject({
      q: 'logo site:python.org -snake'
    });
  });

  it('videos use google_videos, with the domain, language and date filters', () => {
    expect(
      build('python tutorial', 'videos', {
        domain: 'youtube.com',
        language: 'en',
        dateWindow: 'month'
      })
    ).toEqual({
      skip: false,
      engine: 'google_videos',
      q: 'python tutorial site:youtube.com',
      params: { lr: 'lang_en', tbs: 'qdr:m' }
    });
  });

  it('maps use google_maps with plain words only', () => {
    expect(build('restaurants in Chennai', 'maps')).toEqual({
      skip: false,
      engine: 'google_maps',
      q: 'restaurants in Chennai',
      params: { type: 'search' }
    });
    // Operators mean nothing to a map search.
    expect(build('cafes site:example.com -chain', 'maps').q).toBe('cafes');
  });

  it('a date sort is not a reason to skip a vertical', () => {
    expect(build('python', 'images', { sort: 'newest' }).skip).toBe(false);
  });

  it.each([
    ['an empty query', '   ', 'images', 'empty_query'],
    ['exclusions only', '-java', 'videos', 'empty_query'],
    ['operators only on maps', 'site:python.org', 'maps', 'no_search_text'],
    ['-lang: on images', 'python -lang:de', 'images', 'unsupported_operator'],
    ['an unknown vertical', 'python', 'news', 'not_web_search']
  ])('skips %s', (_label, q, vertical, reason) => {
    expect(build(q, vertical)).toEqual({ skip: true, reason });
  });
});

describe('field helpers', () => {
  it.each([
    ['https://a.example/x', 'https://a.example/x'],
    ['http://a.example', 'http://a.example/'],
    ['javascript:alert(1)', null],
    ['data:image/png;base64,AAAA', null],
    ['//a.example/x', null],
    ['/relative', null],
    ['ftp://a.example/f', null],
    ['', null],
    [42, null]
  ])('httpUrl(%p) → %p', (input, expected) => {
    expect(httpUrl(input)).toBe(expected);
  });

  it('reads numbers strictly', () => {
    expect(number('1,245')).toBe(1245);
    expect(number('4.4', { min: 0, max: 5 })).toBe(4.4);
    expect(number('9', { min: 0, max: 5 })).toBeNull();
    expect(number('lots')).toBeNull();
    expect(number(undefined)).toBeNull();
  });

  it('keeps text as plain text', () => {
    expect(text('  a\n\n b ')).toBe('a b');
    expect(text({ toString: () => 'x' })).toBe('');
  });
});

describe('image mapper', () => {
  const raw = images(1)[0];

  it('maps every field', () => {
    expect(mapImageResult(raw)).toEqual({
      id: expect.stringMatching(/^serpapi-image:[0-9a-f]{40}$/),
      title: 'Image 1',
      imageUrl: 'https://pics.example/full-1.jpg',
      thumbnailUrl: 'https://thumbs.example/t1.jpg',
      sourceUrl: 'https://pics.example/page-1',
      sourceDomain: 'pics.example',
      sourceName: 'Pics Example',
      width: 1200,
      height: 800,
      position: 1,
      downloadToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      source: 'serpapi'
    });
  });

  it('signs the full image address for the download endpoint, and only that', () => {
    const { verifyUrl } = require('../../utils/urlSigner');
    const image = mapImageResult(raw);
    expect(verifyUrl('image-download', image.imageUrl, image.downloadToken)).toBe(true);
    expect(verifyUrl('image-download', image.thumbnailUrl, image.downloadToken)).toBe(false);
    expect(mapImageResult({ ...raw, original: undefined }).downloadToken).toBeNull();
    expect(mapImageResult({ ...raw, original: 'javascript:x' }).downloadToken).toBeNull();
  });

  it('drops a result with no usable thumbnail, or nowhere to go', () => {
    expect(mapImageResult({ ...raw, thumbnail: 'data:image/jpeg;base64,AAA' })).toBeNull();
    expect(mapImageResult({ ...raw, thumbnail: undefined })).toBeNull();
    expect(mapImageResult({ ...raw, link: 'javascript:x', original: 'javascript:y' })).toBeNull();
  });

  it('nulls an unsafe link but keeps the result when the other one is fine', () => {
    const image = mapImageResult({ ...raw, link: 'javascript:alert(1)' });
    expect(image.sourceUrl).toBeNull();
    expect(image.imageUrl).toBe('https://pics.example/full-1.jpg');
    expect(image.sourceDomain).toBe('pics.example');
  });

  it('nulls missing dimensions rather than inventing them', () => {
    const image = mapImageResult({ ...raw, original_width: undefined, original_height: 'big' });
    expect(image.width).toBeNull();
    expect(image.height).toBeNull();
  });

  it('keeps order and drops repeats of the same image', () => {
    const list = [...images(2), images(1)[0], null, 'junk'];
    expect(mapImageResults(list).map(i => i.title)).toEqual(['Image 1', 'Image 2']);
    expect(mapImageResults(undefined)).toEqual([]);
  });
});

describe('video mapper', () => {
  const raw = videos(1)[0];

  it('maps every field', () => {
    expect(mapVideoResult(raw)).toEqual({
      id: expect.stringMatching(/^serpapi-video:[0-9a-f]{40}$/),
      title: 'Video 1',
      thumbnailUrl: 'https://i.ytimg.example/vi/1/hq.jpg',
      videoUrl: 'https://www.youtube.com/watch?v=vid1',
      sourceUrl: 'https://www.youtube.com/watch?v=vid1',
      sourceDomain: 'youtube.com',
      sourceName: 'YouTube',
      duration: '12:34',
      publishedAt: new Date('Mar 3, 2025').toISOString(),
      publishedAgo: expect.stringMatching(/ago$/),
      snippet: '',
      position: 1,
      source: 'serpapi'
    });
  });

  it('drops a result without a safe link', () => {
    expect(mapVideoResult({ ...raw, link: 'javascript:alert(1)' })).toBeNull();
    expect(mapVideoResult({ ...raw, link: undefined })).toBeNull();
  });

  it("opens the video's own page, never Google's preview clip (video_link)", () => {
    const video = mapVideoResult({
      ...raw,
      video_link: 'https://encrypted-vtbn0.gstatic.com/video?q=tbn:preview'
    });
    expect(video.videoUrl).toBe('https://www.youtube.com/watch?v=vid1');
    expect(video.sourceUrl).toBe('https://www.youtube.com/watch?v=vid1');
    expect(JSON.stringify(video)).not.toContain('gstatic');
  });

  it('reads a thumbnail object, and drops an unsafe thumbnail', () => {
    expect(
      mapVideoResult({ ...raw, thumbnail: { static: 'https://t.example/s.jpg' } }).thumbnailUrl
    ).toBe('https://t.example/s.jpg');
    expect(mapVideoResult({ ...raw, thumbnail: 'javascript:x' }).thumbnailUrl).toBeNull();
  });

  it('keeps only real duration labels and real dates', () => {
    const video = mapVideoResult({ ...raw, duration: 'long', date: 'sometime' });
    expect(video.duration).toBeNull();
    expect(video.publishedAt).toBeNull();
    expect(video.publishedAgo).toBeNull();
    expect(mapVideoResult({ ...raw, date: '2 weeks ago' }).publishedAgo).toBe('2 weeks ago');
  });

  it('keeps order and drops repeats of the same page', () => {
    const list = [...videos(2), { ...videos(1)[0], link: 'https://youtube.com/watch?v=vid1' }];
    expect(mapVideoResults(list).map(v => v.title)).toEqual(['Video 1', 'Video 2']);
  });
});

describe('maps mapper', () => {
  const raw = places(1)[0];

  it('maps every field', () => {
    const place = mapPlaceResult(raw);
    expect(place).toEqual({
      id: expect.stringMatching(/^serpapi-place:[0-9a-f]{40}$/),
      title: 'Place 1',
      address: '1 Anna Salai, Chennai',
      rating: 4.4,
      reviews: 1245,
      phone: '+91 44 1234 5678',
      website: 'https://place1.example/',
      category: 'Restaurant',
      latitude: 13.06,
      longitude: 80.25,
      hours: 'Open ⋅ Closes 11 PM',
      thumbnailUrl: 'https://maps.example/thumb1.jpg',
      mapsUrl: expect.any(String),
      position: 1,
      source: 'serpapi'
    });
    const maps = new URL(place.mapsUrl);
    expect(maps.origin + maps.pathname).toBe('https://www.google.com/maps/search/');
    expect(maps.searchParams.get('query')).toBe('Place 1, 1 Anna Salai, Chennai');
    expect(maps.searchParams.get('query_place_id')).toBe('ChIJplace000001');
  });

  it('returns null for everything SerpApi did not send — nothing invented', () => {
    const place = mapPlaceResult({ title: 'Bare Place' });
    expect(place).toMatchObject({
      address: null,
      rating: null,
      reviews: null,
      phone: null,
      website: null,
      category: null,
      latitude: null,
      longitude: null,
      hours: null,
      thumbnailUrl: null
    });
    expect(new URL(place.mapsUrl).searchParams.get('query_place_id')).toBeNull();
  });

  it('rejects unsafe or malformed values', () => {
    const place = mapPlaceResult({
      ...raw,
      website: 'javascript:alert(1)',
      phone: '<script>',
      rating: 11,
      gps_coordinates: { latitude: 200, longitude: 80 },
      thumbnail: 'data:image/png;base64,AAAA'
    });
    expect(place).toMatchObject({
      website: null,
      phone: null,
      rating: null,
      latitude: null,
      longitude: null,
      thumbnailUrl: null
    });
  });

  it('drops a place without a name, keeps order and drops repeats', () => {
    expect(mapPlaceResult({ address: 'somewhere' })).toBeNull();
    const list = [...places(2), places(1)[0], { title: '' }];
    expect(mapPlaceResults(list).map(p => p.title)).toEqual(['Place 1', 'Place 2']);
  });
});

describe('client — each engine', () => {
  const KEY = 'vertical-test-key-NOT-REAL-0123456789abcdef';
  let standIn;
  let settings;

  beforeAll(async () => {
    standIn = await startSerpApiStandIn();
  });
  afterAll(async () => {
    await standIn.close();
  });
  beforeEach(() => {
    standIn.reset();
    settings = {
      apiKey: KEY,
      baseUrl: standIn.baseUrl,
      engine: 'google',
      hl: 'en',
      gl: 'in',
      location: 'Chennai, India',
      timeoutMs: 1000
    };
  });
  const call = request => searchEngine(request, { settings });
  const failure = async promise => {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error('expected a failure');
  };

  it.each([
    ['google_images', 3],
    ['google_videos', 3],
    ['google_maps', 3]
  ])('%s: sends the engine and reads its list', async (engine, count) => {
    const { results } = await call({ engine, q: 'python' });
    expect(results).toHaveLength(count);
    expect(standIn.state.requests[0].query).toMatchObject({ engine, q: 'python', api_key: KEY });
  });

  it('sends location to images and videos but not to maps', async () => {
    await call({ engine: 'google_images', q: 'x' });
    await call({ engine: 'google_maps', q: 'x', params: { type: 'search' } });
    expect(standIn.state.requests[0].query.location).toBe('Chennai, India');
    expect(standIn.state.requests[1].query).not.toHaveProperty('location');
    expect(standIn.state.requests[1].query.type).toBe('search');
  });

  it('reads a single named place (place_results)', async () => {
    standIn.state.placeResult = { title: 'Marina Beach', address: 'Chennai' };
    const { results } = await call({ engine: 'google_maps', q: 'marina beach' });
    expect(results).toEqual([{ title: 'Marina Beach', address: 'Chennai' }]);
  });

  it('refuses an engine it does not know', async () => {
    expect((await failure(call({ engine: 'google_shopping', q: 'x' }))).code).toBe('bad_request');
    expect(standIn.state.requests).toHaveLength(0);
  });

  it('refuses to send anything without a key', async () => {
    settings.apiKey = '';
    expect((await failure(call({ engine: 'google_images', q: 'x' }))).code).toBe('not_configured');
    expect(standIn.state.requests).toHaveLength(0);
  });

  it.each([
    [{ mode: 'status', status: 401 }, 'auth'],
    [{ mode: 'status', status: 403 }, 'auth'],
    [{ mode: 'status', status: 429 }, 'rate_limited'],
    [{ mode: 'malformed' }, 'invalid_response'],
    [
      { mode: 'status', status: 200, body: { search_metadata: {}, images_results: {} } },
      'invalid_response'
    ]
  ])('maps failures the same way for every engine (%p)', async (setup, code) => {
    Object.assign(standIn.state, setup);
    const error = await failure(call({ engine: 'google_images', q: 'x' }));
    expect(error.code).toBe(code);
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(KEY);
  });

  it('times out', async () => {
    Object.assign(standIn.state, { mode: 'slow', delayMs: 2000 });
    settings.timeoutMs = 300;
    expect((await failure(call({ engine: 'google_videos', q: 'x' }))).code).toBe('timeout');
  });
});
