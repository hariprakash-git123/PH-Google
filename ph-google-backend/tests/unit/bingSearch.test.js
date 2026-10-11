const net = require('net');
const { parseQuery } = require('../../services/opensearch/queryParser');
const { searchWeb } = require('../../services/external/bingSearchClient');
const { buildBingRequest } = require('../../services/external/bingSearchQuery');
const { mapBingItem, mapBingItems } = require('../../services/external/bingSearchMapper');
const { formatHit } = require('../../services/opensearch/searchService');
const { buildDocumentId } = require('../../services/opensearch/documentMapper');
const { startBingStandIn, items } = require('../helpers/bingStandIn');

/**
 * The Bing provider on its own: the request it sends, how each kind of reply
 * and failure becomes one controlled outcome, how PH queries are translated,
 * and how Bing items become PH results. Bing is a local stand-in throughout.
 */

const KEY = 'bing-unit-test-key-NOT-REAL-0123456789abcdef';
const HOST = 'bing-search-apis.p.rapidapi.com';

describe('bingSearchClient', () => {
  let standIn;
  let settings;

  beforeAll(async () => {
    standIn = await startBingStandIn();
  });
  afterAll(async () => {
    await standIn.close();
  });
  beforeEach(() => {
    standIn.reset();
    settings = {
      apiKey: KEY,
      host: HOST,
      baseUrl: standIn.baseUrl,
      timeoutMs: 1000,
      maxResults: 10,
      cc: 'IN'
    };
  });

  const call = (request = { keyword: 'Nike' }, extra = {}) =>
    searchWeb(request, { settings: { ...settings, ...extra } });
  const failure = async promise => {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error('expected the call to fail');
  };

  it('sends GET /api/rapid/web_search with keyword, page, size and cc', async () => {
    await call({ keyword: 'Nike', page: 0, size: 10, cc: 'IN' });
    expect(standIn.state.requests).toHaveLength(1);
    const sent = standIn.state.requests[0];
    expect(sent.method).toBe('GET');
    expect(sent.path).toBe('/api/rapid/web_search');
    expect(sent.query).toEqual({ keyword: 'Nike', page: '0', size: '10', cc: 'IN' });
  });

  it('sends the key and host as RapidAPI headers — never in the URL', async () => {
    await call();
    const sent = standIn.state.requests[0];
    expect(sent.headers['x-rapidapi-key']).toBe(KEY);
    expect(sent.headers['x-rapidapi-host']).toBe(HOST);
    expect(JSON.stringify(sent.query)).not.toContain(KEY);
    expect(sent.path).not.toContain(KEY);
  });

  it('uses the configured size and country when the request names none', async () => {
    await call({ keyword: 'x' }, { maxResults: 7, cc: 'US' });
    expect(standIn.state.requests[0].query).toMatchObject({ page: '0', size: '7', cc: 'US' });
  });

  it('returns data.items as they came', async () => {
    standIn.state.items = items(4);
    const { results } = await call();
    expect(results).toHaveLength(4);
    expect(results[0]).toEqual({
      title: 'Bing result 1',
      link: 'https://bing.example/page-1',
      description: 'Description for Bing result 1.',
      img: null
    });
  });

  it('an empty item list is a valid, empty result', async () => {
    standIn.state.items = [];
    await expect(call()).resolves.toEqual({ results: [] });
  });

  it('refuses to send anything without a key', async () => {
    const error = await failure(call({ keyword: 'Nike' }, { apiKey: '' }));
    expect(error.name).toBe('ExternalSearchError');
    expect(error.code).toBe('not_configured');
    expect(standIn.state.requests).toHaveLength(0);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
    [400, 'bad_request']
  ])('maps HTTP %i to %s', async (status, code) => {
    Object.assign(standIn.state, {
      mode: 'status',
      status,
      body: { message: 'You are not subscribed to this API.' }
    });
    const error = await failure(call());
    expect(error.name).toBe('ExternalSearchError');
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  });

  it('honours Retry-After on 429', async () => {
    Object.assign(standIn.state, { mode: 'status', status: 429, headers: { 'retry-after': '9' } });
    expect((await failure(call())).retryAfterMs).toBe(9000);
  });

  it('times out', async () => {
    Object.assign(standIn.state, { mode: 'slow', delayMs: 2000 });
    const started = Date.now();
    const error = await failure(call({ keyword: 'Nike' }, { timeoutMs: 300 }));
    expect(error.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('reports a network failure', async () => {
    const port = await new Promise(resolve => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const p = probe.address().port;
        probe.close(() => resolve(p));
      });
    });
    const error = await failure(call({ keyword: 'Nike' }, { baseUrl: `http://127.0.0.1:${port}` }));
    expect(error.code).toBe('network');
  });

  it.each([
    ['not JSON', { mode: 'malformed' }],
    ['no data', { mode: 'status', status: 200, body: { request: {} } }],
    [
      'data without items',
      { mode: 'status', status: 200, body: { data: { keyword_related: [] } } }
    ],
    [
      'items that are not a list',
      { mode: 'status', status: 200, body: { data: { items: 'nope' } } }
    ],
    ['a list instead of an object', { mode: 'status', status: 200, body: [] }]
  ])('reports a malformed reply: %s', async (_label, setup) => {
    Object.assign(standIn.state, setup);
    expect((await failure(call())).code).toBe('invalid_response');
  });

  it('never puts the key in an error, whatever went wrong', async () => {
    const errors = [];
    for (const setup of [
      { mode: 'status', status: 401 },
      { mode: 'status', status: 429 },
      { mode: 'status', status: 500 },
      { mode: 'malformed' }
    ]) {
      standIn.reset();
      Object.assign(standIn.state, setup, { body: { message: `bad key ${KEY}` } });
      errors.push(await failure(call()));
    }
    errors.push(await failure(call({ keyword: 'x' }, { baseUrl: 'http://127.0.0.1:1' })));
    for (const error of errors) {
      expect(JSON.stringify({ ...error, message: error.message })).not.toContain(KEY);
      expect(String(error.stack)).not.toContain(KEY);
    }
  });
});

describe('bingSearchQuery', () => {
  const build = (q, filters = {}) => buildBingRequest(parseQuery(q), filters);

  it('builds keyword, page 0, size and country', () => {
    expect(build('Nike')).toEqual({ skip: false, keyword: 'Nike', page: 0, size: 10, cc: 'IN' });
  });

  it.each([
    ['site:developer.mozilla.org javascript', 'javascript site:developer.mozilla.org'],
    ['"climate change"', '"climate change"'],
    ['python -java', 'python -java'],
    ['intitle:javascript', 'intitle:javascript'],
    ['python OR javascript', 'python OR javascript'],
    ['python AND programming', 'python programming'],
    ['lang:en machine learning', 'machine learning language:en'],
    // No dependable inurl: on Bing — the word is searched, the address checked later.
    ['inurl:python', 'python'],
    ['docs site:python.org site:docs.python.org', 'docs (site:python.org OR site:docs.python.org)'],
    ['how does gravity work', 'how does gravity work']
  ])('%s → %s', (input, keyword) => {
    expect(build(input)).toMatchObject({ skip: false, keyword });
  });

  it('maps the domain and language filters into the query', () => {
    expect(build('python', { domain: 'python.org', language: 'fr' }).keyword).toBe(
      'python site:python.org language:fr'
    );
  });

  it('never forwards an operator the parser ignored', () => {
    expect(build('python -site:').keyword).toBe('python');
  });

  it.each([
    ['page 2', 'python', { page: 2 }, 'not_first_page'],
    ['a vertical', 'python', { category: 'images' }, 'not_web_search'],
    ['a date sort', 'python', { sort: 'newest' }, 'date_sort'],
    ['an empty query', '  ', {}, 'empty_query'],
    ['exclusions only', '-java', {}, 'empty_query'],
    ['a site alone', 'site:python.org', {}, 'no_search_text'],
    ['-lang:', 'python -lang:de', {}, 'unsupported_operator'],
    ['a date window (no parameter for it)', 'python', { dateWindow: 'week' }, 'unsupported_filter'],
    ['two languages', 'python lang:en lang:fr', {}, 'unsupported_filter'],
    ['conflicting languages', 'lang:en python', { language: 'fr' }, 'conflicting_filters']
  ])('declines %s', (_label, q, filters, reason) => {
    expect(build(q, filters)).toEqual({ skip: true, reason });
  });
});

describe('bingSearchMapper', () => {
  const raw = (overrides = {}) => ({
    title: '  Nike. Just Do It.   Nike.com ',
    link: 'https://www.nike.com/',
    description: "Inspiring the world's   athletes.",
    img: 'https://img.example/nike.png',
    ...overrides
  });

  it('maps a Bing item onto the existing result schema', () => {
    expect(mapBingItem(raw(), 2)).toEqual({
      id: expect.stringMatching(/^bing:[0-9a-f]{40}$/),
      url: 'https://www.nike.com',
      displayUrl: 'nike.com',
      domain: 'www.nike.com',
      favicon: '\u{1F310}',
      title: 'Nike. Just Do It. Nike.com',
      snippet: "Inspiring the world's athletes.",
      publishedAt: null,
      publishedAgo: 'Unknown',
      dateLabel: null,
      crawledAt: null,
      language: '',
      category: 'Bing Web',
      saved: false,
      score: null,
      source: 'bing',
      sourceRank: 3
    });
  });

  it('has every field an index result has, and no others the frontend does not know', () => {
    const indexResult = formatHit(
      { _id: 'x', _score: 1, _source: { url: 'https://a.example/x', title: 'X' } },
      { includeDebug: false }
    );
    const bing = mapBingItem(raw());
    for (const field of Object.keys(indexResult)) expect(bing).toHaveProperty(field);
    expect(
      Object.keys(bing)
        .filter(k => !(k in indexResult))
        .sort()
    ).toEqual(['source', 'sourceRank']);
  });

  it('uses the same page key as the index, so duplicates can be found', () => {
    const item = mapBingItem(raw({ link: 'http://example.com/page/?utm_source=x' }));
    expect(item.id).toBe(`bing:${buildDocumentId('https://www.example.com/page')}`);
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<b>x</b>'],
    ['relative', '/just/a/path'],
    ['missing', undefined],
    ['not a string', 42]
  ])('drops an item with a %s link', (_label, link) => {
    expect(mapBingItem(raw({ link }))).toBeNull();
  });

  it('falls back to the URL for a missing title and a placeholder for a missing description', () => {
    const item = mapBingItem(raw({ title: null, description: undefined }));
    expect(item.title).toBe('https://www.nike.com');
    expect(item.snippet).toBe('No description available.');
  });

  it('keeps markup in a description as text and caps its length', () => {
    const item = mapBingItem(raw({ description: `<b>bold</b> ${'word '.repeat(200)}` }));
    expect(item.snippet.startsWith('<b>bold</b>')).toBe(true);
    expect(item.snippet.length).toBeLessThanOrEqual(301);
  });

  it('keeps Bing order, drops repeats of a page, and re-checks site: and inurl:', () => {
    const list = [
      raw({ link: 'https://docs.python.org/3/tutorial' }),
      raw({ link: 'https://www.docs.python.org/3/tutorial/' }),
      raw({ link: 'https://python.org/about' }),
      raw({ link: 'https://other.example/python' })
    ];
    expect(mapBingItems(list, parseQuery('python')).map(r => r.domain)).toEqual([
      'docs.python.org',
      'python.org',
      'other.example'
    ]);
    expect(mapBingItems(list, parseQuery('x site:python.org')).map(r => r.domain)).toEqual([
      'docs.python.org',
      'python.org'
    ]);
    expect(mapBingItems(list, parseQuery('inurl:tutorial'))).toHaveLength(1);
    expect(mapBingItems(list, parseQuery('x'), { domain: 'other.example' })).toHaveLength(1);
  });

  it('survives junk', () => {
    expect(mapBingItems(null, parseQuery('x'))).toEqual([]);
    expect(mapBingItems([null, 7, 'x', {}], parseQuery('x'))).toEqual([]);
  });
});
