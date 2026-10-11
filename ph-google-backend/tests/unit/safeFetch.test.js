const http = require('http');
const safeFetch = require('../../services/external/safeFetch');

/**
 * The fetch used to read pages and images a search provider pointed at:
 * public addresses only, redirects checked hop by hop, one deadline, a
 * bounded body — and a reason instead of an exception for everything that
 * goes wrong. A local server stands in for the web; the address checks still
 * run on the public name.
 */

let server;
let port;
let handler;
const requests = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
});
afterAll(
  () =>
    new Promise(resolve => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })
);
beforeEach(() => {
  requests.length = 0;
  handler = (req, res) => res.end('ok');
});

const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];
const PRIVATE = async () => [{ address: '10.0.0.5', family: 4 }];
const get = (url, options = {}) =>
  safeFetch.get(url, {
    lookup: PUBLIC,
    connect: () => ({ host: '127.0.0.1', port, protocol: 'http:' }),
    ...options
  });

describe('safeFetch.get', () => {
  it('returns the status, headers and body of a page', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p>hello</p>');
    };
    const out = await get('https://site.example/page?x=1', { accept: 'text/html' });
    expect(out).toMatchObject({
      ok: true,
      status: 200,
      truncated: false,
      finalUrl: 'https://site.example/page?x=1'
    });
    expect(out.headers['content-type']).toBe('text/html');
    expect(out.buffer.toString()).toBe('<p>hello</p>');
    expect(requests[0]).toMatchObject({ url: '/page?x=1' });
    expect(requests[0].headers).toMatchObject({ host: 'site.example', accept: 'text/html' });
  });

  it('keeps no more than maxBytes of a body, and says it stopped', async () => {
    handler = (req, res) => res.end(Buffer.alloc(200000, 1));
    const out = await get('https://site.example/big', { maxBytes: 1000 });
    expect(out.ok).toBe(true);
    expect(out.truncated).toBe(true);
    expect(out.buffer.length).toBe(1000);
  });

  it('follows a redirect and reports where it ended', async () => {
    handler = (req, res) => {
      if (req.url === '/old') {
        res.writeHead(302, { location: 'https://cdn.example/new' });
        return res.end();
      }
      return res.end('moved here');
    };
    const out = await get('https://site.example/old');
    expect(out).toMatchObject({ ok: true, finalUrl: 'https://cdn.example/new' });
    expect(out.buffer.toString()).toBe('moved here');
    expect(requests.map(r => r.headers.host)).toEqual(['site.example', 'cdn.example']);
  });

  it('checks every hop: a public page may not redirect this server somewhere private', async () => {
    handler = (req, res) => {
      res.writeHead(302, { location: 'http://internal.example/admin' });
      res.end();
    };
    const lookup = async hostname => (hostname === 'internal.example' ? PRIVATE() : PUBLIC());
    expect(await get('https://site.example/x', { lookup })).toEqual({
      ok: false,
      reason: 'blocked'
    });
    expect(requests).toHaveLength(1);
  });

  it('gives up on a redirect loop', async () => {
    handler = (req, res) => {
      res.writeHead(302, { location: '/again' });
      res.end();
    };
    expect(await get('https://site.example/again')).toEqual({ ok: false, reason: 'redirects' });
  });

  it.each([
    ['a private address', 'https://intranet.example/', PRIVATE],
    ['a name that does not resolve', 'https://nowhere.example/', async () => []]
  ])('refuses %s without connecting', async (_label, url, lookup) => {
    expect(await get(url, { lookup })).toEqual({ ok: false, reason: 'blocked' });
    expect(requests).toHaveLength(0);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'ftp://files.example/a',
    'file:///etc/passwd',
    'https://user:pass@site.example/',
    '/relative/path',
    'not a url',
    '',
    null
  ])('refuses %s as not an address to fetch', async url => {
    expect(await get(url)).toEqual({ ok: false, reason: 'invalid_url' });
    expect(requests).toHaveLength(0);
  });

  it('refuses a single-label host and a non-default port', async () => {
    expect((await get('http://redis/')).ok).toBe(false);
    expect((await get('http://localhost/')).ok).toBe(false);
    expect((await get('https://site.example:8443/')).ok).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it.each([403, 404, 500])('reports a %i as an upstream failure', async status => {
    handler = (req, res) => {
      res.writeHead(status);
      res.end('nope');
    };
    expect(await get('https://site.example/x')).toEqual({ ok: false, reason: 'upstream', status });
  });

  it('a server that never answers is a timeout, not a hang', async () => {
    handler = () => {};
    const started = Date.now();
    expect(await get('https://site.example/slow', { timeoutMs: 200 })).toEqual({
      ok: false,
      reason: 'timeout'
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a connection that drops is a network failure, not an exception', async () => {
    handler = req => req.socket.destroy();
    expect(await get('https://site.example/drop')).toEqual({ ok: false, reason: 'network' });
  });
});
