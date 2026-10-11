const parallelClient = require('../../services/external/parallelClient');
const { ExternalSearchError } = require('../../services/external/externalSearchError');

/**
 * The Parallel Search client: what it sends, and how each kind of reply
 * becomes either the result list or one controlled error. `fetch` is
 * replaced, so nothing leaves the machine.
 */

const KEY = 'unit-test-parallel-key-NOT-REAL-0123456789';
const settings = {
  apiKey: KEY,
  baseUrl: 'https://parallel.test',
  mode: 'fast',
  timeoutMs: 1000,
  maxResults: 10
};

const reply = (status, body, headers = {}) => ({
  status,
  headers: { get: name => headers[name.toLowerCase()] ?? null },
  json: async () => {
    if (body instanceof Error) throw body;
    return body;
  }
});

const call = (request, fetchImpl, overrides = {}) =>
  parallelClient.search(
    { searchQueries: ['gravity'], ...request },
    { settings: { ...settings, ...overrides }, fetchImpl }
  );

const failure = async promise => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
};

describe('parallelClient — the request', () => {
  it('POSTs to /v1/search with the key in the x-api-key header only', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { results: [] }));
    await call({ objective: 'how does gravity work' }, fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://parallel.test/v1/search');
    expect(String(url)).not.toContain(KEY);
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe(KEY);
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).not.toContain(KEY);
    expect(init.signal).toBeDefined();
  });

  it('sends the documented fields: search_queries, objective, mode, max_results', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { results: [] }));
    await call({ objective: 'how does gravity work' }, fetchImpl);

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      search_queries: ['gravity'],
      objective: 'how does gravity work',
      mode: 'fast',
      advanced_settings: { max_results: 10 }
    });
  });

  it('sends a source policy only when there is one', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { results: [] }));
    await call({ sourcePolicy: {} }, fetchImpl);
    await call(
      { sourcePolicy: { include_domains: ['nasa.gov'], after_date: '2026-01-01' } },
      fetchImpl
    );

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).advanced_settings).toEqual({
      max_results: 10
    });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).advanced_settings).toEqual({
      max_results: 10,
      source_policy: { include_domains: ['nasa.gov'], after_date: '2026-01-01' }
    });
  });

  it('uses the configured mode and result limit, and omits an empty objective', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { results: [] }));
    await call({ objective: '  ' }, fetchImpl, { mode: 'turbo', maxResults: 5 });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.mode).toBe('turbo');
    expect(body.advanced_settings.max_results).toBe(5);
    expect(body).not.toHaveProperty('objective');
  });

  it('returns the result list as the API ordered it', async () => {
    const results = [{ url: 'https://a.example' }, { url: 'https://b.example' }];
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, { search_id: 's', results }));
    expect(await call({}, fetchImpl)).toEqual({ results });
  });
});

describe('parallelClient — refused before sending', () => {
  it.each([
    ['no key', {}, { apiKey: '' }, 'not_configured'],
    ['an unknown mode', {}, { mode: 'warp' }, 'bad_request'],
    ['no query', { searchQueries: [' ', ''] }, {}, 'bad_request']
  ])('%s', async (_label, request, overrides, code) => {
    const fetchImpl = jest.fn();
    const error = await failure(call(request, fetchImpl, overrides));
    expect(error).toBeInstanceOf(ExternalSearchError);
    expect(error.code).toBe(code);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('parallelClient — replies that are failures', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limited'],
    [402, 'rate_limited'],
    [422, 'bad_request'],
    [400, 'bad_request'],
    [500, 'unavailable'],
    [503, 'unavailable']
  ])('HTTP %i -> %s', async (status, code) => {
    const body = { type: 'error', error: { ref_id: 'ref', message: `provider says ${KEY}` } };
    const error = await failure(call({}, jest.fn().mockResolvedValue(reply(status, body))));
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    // The provider's own wording is never passed on.
    expect(error.message).not.toContain('provider says');
    expect(error.message).not.toContain(KEY);
  });

  it('reads Retry-After on a 429', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(429, {}, { 'retry-after': '30' }));
    expect((await failure(call({}, fetchImpl))).retryAfterMs).toBe(30000);
  });

  it.each(['TimeoutError', 'AbortError'])('%s -> timeout', async name => {
    const error = Object.assign(new Error('aborted'), { name });
    expect((await failure(call({}, jest.fn().mockRejectedValue(error)))).code).toBe('timeout');
  });

  it('a connection failure -> network, without the underlying error', async () => {
    const cause = Object.assign(new TypeError(`fetch failed for key ${KEY}`), {
      cause: { code: 'ECONNREFUSED' }
    });
    const error = await failure(call({}, jest.fn().mockRejectedValue(cause)));
    expect(error.code).toBe('network');
    expect(error.message).not.toContain(KEY);
    expect(error.cause).toBeUndefined();
  });

  it('a body that is not JSON -> invalid_response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, new SyntaxError('Unexpected token')));
    expect((await failure(call({}, fetchImpl))).code).toBe('invalid_response');
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['no results field', { search_id: 's' }],
    ['results that are not a list', { results: 'none' }]
  ])('%s -> invalid_response', async (_label, body) => {
    const fetchImpl = jest.fn().mockResolvedValue(reply(200, body));
    expect((await failure(call({}, fetchImpl))).code).toBe('invalid_response');
  });
});
