const net = require('net');
const { searchGoogle } = require('../../services/external/serpApiClient');
const { startSerpApiStandIn, organic } = require('../helpers/serpApiStandIn');

/**
 * The SerpApi client against a local stand-in: what it sends, and how every
 * kind of reply and failure becomes one controlled outcome.
 */

const KEY = 'test-serpapi-key-0123456789abcdef-NOT-REAL';
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
    gl: '',
    location: '',
    timeoutMs: 1000
  };
});

const call = (request = { q: 'python' }, extra = {}) =>
  searchGoogle(request, { settings: { ...settings, ...extra } });

/** Awaits a rejection and returns the error. */
async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

describe('serpApiClient — the request', () => {
  it('calls /search with engine=google, the query, the key and the configured language', async () => {
    await call({ q: 'python site:python.org', params: { lr: 'lang_en', tbs: 'qdr:w' } });
    expect(standIn.state.requests).toHaveLength(1);
    const { path, query } = standIn.state.requests[0];
    expect(path).toBe('/search');
    expect(query).toMatchObject({
      engine: 'google',
      q: 'python site:python.org',
      output: 'json',
      hl: 'en',
      lr: 'lang_en',
      tbs: 'qdr:w',
      api_key: KEY
    });
    // Empty settings are not sent at all.
    expect(query).not.toHaveProperty('gl');
    expect(query).not.toHaveProperty('location');
  });

  it('returns organic_results as they came', async () => {
    standIn.state.organic = organic(4);
    const { results } = await call();
    expect(results).toHaveLength(4);
    expect(results[0]).toMatchObject({ position: 1, link: 'https://external.example/page-1' });
  });

  it('refuses to send anything without a key', async () => {
    const error = await failure(call({ q: 'python' }, { apiKey: '' }));
    expect(error.code).toBe('not_configured');
    expect(standIn.state.requests).toHaveLength(0);
  });
});

describe('serpApiClient — replies and failures', () => {
  it('reads "Google hasn\'t returned any results" as an empty result, not a failure', async () => {
    standIn.state.mode = 'no_results';
    await expect(call()).resolves.toEqual({ results: [] });
  });

  it('reads a reply with metadata but no organic results as empty', async () => {
    standIn.state.mode = 'status';
    standIn.state.status = 200;
    standIn.state.body = { search_metadata: { status: 'Success' }, answer_box: {} };
    await expect(call()).resolves.toEqual({ results: [] });
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [503, 'unavailable']
  ])('maps HTTP %i to %s', async (status, code) => {
    standIn.state.mode = 'status';
    standIn.state.status = status;
    standIn.state.body = { error: 'Invalid API key. Your API key should be here: …' };
    const error = await failure(call());
    expect(error.name).toBe('ExternalSearchError');
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  });

  it('honours Retry-After on 429', async () => {
    standIn.state.mode = 'status';
    standIn.state.status = 429;
    standIn.state.headers = { 'retry-after': '7' };
    const error = await failure(call());
    expect(error.retryAfterMs).toBe(7000);
  });

  it('maps an "out of searches" error in the body to rate_limited', async () => {
    standIn.state.mode = 'status';
    standIn.state.status = 200;
    standIn.state.body = { error: 'Your account has run out of searches.' };
    expect((await failure(call())).code).toBe('rate_limited');
  });

  it('maps another 4xx to bad_request', async () => {
    standIn.state.mode = 'status';
    standIn.state.status = 400;
    standIn.state.body = { error: 'Unsupported `foo` parameter.' };
    expect((await failure(call())).code).toBe('bad_request');
  });

  it('times out', async () => {
    standIn.state.mode = 'slow';
    standIn.state.delayMs = 2000;
    const started = Date.now();
    const error = await failure(call({ q: 'python' }, { timeoutMs: 300 }));
    expect(error.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('reports a network failure', async () => {
    // A port with nothing listening on it.
    const port = await new Promise(resolve => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const p = probe.address().port;
        probe.close(() => resolve(p));
      });
    });
    const error = await failure(call({ q: 'python' }, { baseUrl: `http://127.0.0.1:${port}` }));
    expect(error.code).toBe('network');
  });

  it('reports a reply that is not JSON', async () => {
    standIn.state.mode = 'malformed';
    expect((await failure(call())).code).toBe('invalid_response');
  });

  it('reports organic_results that are not a list', async () => {
    standIn.state.mode = 'status';
    standIn.state.status = 200;
    standIn.state.body = { search_metadata: {}, organic_results: 'nope' };
    expect((await failure(call())).code).toBe('invalid_response');
  });

  it('reports a reply with neither results nor metadata', async () => {
    standIn.state.mode = 'status';
    standIn.state.status = 200;
    standIn.state.body = { something: 'else' };
    expect((await failure(call())).code).toBe('invalid_response');
  });

  it('never puts the key in an error, whatever went wrong', async () => {
    const errors = [];
    for (const [mode, status] of [
      ['status', 401],
      ['status', 429],
      ['status', 500],
      ['malformed', 200]
    ]) {
      standIn.reset();
      standIn.state.mode = mode;
      standIn.state.status = status;
      standIn.state.body = { error: `Invalid API key ${KEY}` };
      errors.push(await failure(call()));
    }
    errors.push(await failure(call({ q: 'x' }, { baseUrl: 'http://127.0.0.1:1' })));
    for (const error of errors) {
      expect(JSON.stringify({ ...error, message: error.message })).not.toContain(KEY);
      expect(String(error.stack)).not.toContain(KEY);
    }
  });
});
