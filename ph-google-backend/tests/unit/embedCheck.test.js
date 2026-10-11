const http = require('http');
const embedCheck = require('../../services/embedCheckService');
const { readFramePolicy } = require('../../services/embedCheckService');

/**
 * Whether a page may be shown in a frame (the in-app browser tabs).
 *
 * No real site is contacted: a local server stands in, reached through the
 * test-only `connect` hook after the address checks have run on the name.
 */

const ORIGIN = 'http://localhost:8080';

describe('reading a site’s frame policy', () => {
  it.each([
    [{}, true],
    [{ 'x-frame-options': 'DENY' }, false],
    [{ 'x-frame-options': 'SAMEORIGIN' }, false],
    [{ 'x-frame-options': 'sameorigin, sameorigin' }, false],
    // Browsers ignore values they do not know, and the obsolete ALLOW-FROM.
    [{ 'x-frame-options': 'ALLOWALL' }, true],
    [{ 'x-frame-options': 'ALLOW-FROM https://a.example' }, true],
    [{ 'content-security-policy': "default-src 'self'" }, true],
    [{ 'content-security-policy': "frame-ancestors 'none'" }, false],
    [{ 'content-security-policy': "frame-ancestors 'self'" }, false],
    [{ 'content-security-policy': "default-src 'self'; frame-ancestors *" }, true],
    [{ 'content-security-policy': 'frame-ancestors http:' }, true],
    [{ 'content-security-policy': 'frame-ancestors https:' }, false],
    [{ 'content-security-policy': `frame-ancestors https://a.example ${ORIGIN}` }, true],
    [{ 'content-security-policy': 'frame-ancestors https://a.example' }, false],
    // Every policy that names frame-ancestors must allow.
    [{ 'content-security-policy': "frame-ancestors *, frame-ancestors 'none'" }, false],
    // frame-ancestors, when present, replaces X-Frame-Options.
    [{ 'content-security-policy': 'frame-ancestors *', 'x-frame-options': 'DENY' }, true]
  ])('%j → embeddable: %s', (headers, embeddable) => {
    expect(readFramePolicy(headers, ORIGIN).embeddable).toBe(embeddable);
  });

  it('says which header refused', () => {
    expect(readFramePolicy({ 'x-frame-options': 'deny' }, ORIGIN).reason).toBe('x_frame_options');
    expect(
      readFramePolicy({ 'content-security-policy': "frame-ancestors 'none'" }, ORIGIN).reason
    ).toBe('frame_ancestors');
  });
});

describe('checking an address', () => {
  let server;
  let port;
  let routes;
  const seen = [];
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const connect = () => ({ host: '127.0.0.1', port, protocol: 'http:' });
  const check = (url, extra = {}) =>
    embedCheck.check(url, { origin: ORIGIN, lookup: publicLookup, connect, ...extra });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ host: req.headers.host, path: req.url, accept: req.headers.accept });
      const route = routes[req.url] || { status: 200, headers: {} };
      res.writeHead(route.status, route.headers);
      // A body the check must never wait for.
      res.write('<html>');
      if (!route.hang) res.end('</html>');
    });
    await new Promise(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
  });
  afterAll(
    () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  beforeEach(() => {
    embedCheck.reset();
    seen.length = 0;
    routes = {};
  });

  it('a page with no frame restriction can be embedded', async () => {
    expect(await check('https://open.example/page')).toEqual({ embeddable: true });
    expect(seen[0]).toMatchObject({ host: 'open.example', path: '/page' });
    expect(seen[0].accept).toContain('text/html');
  });

  it('a page that refuses framing is reported, with the header that said so', async () => {
    routes['/'] = { status: 200, headers: { 'X-Frame-Options': 'DENY' } };
    expect(await check('https://closed.example/')).toEqual({
      embeddable: false,
      reason: 'x_frame_options'
    });
  });

  it('does not wait for the body', async () => {
    routes['/slow'] = { status: 200, headers: {}, hang: true };
    expect(await check('https://open.example/slow')).toEqual({ embeddable: true });
  });

  it('follows redirects and judges the page they end at', async () => {
    routes['/start'] = { status: 302, headers: { Location: 'https://www.closed.example/end' } };
    routes['/end'] = {
      status: 200,
      headers: { 'Content-Security-Policy': "frame-ancestors 'self'" }
    };
    expect(await check('https://closed.example/start')).toEqual({
      embeddable: false,
      reason: 'frame_ancestors'
    });
    expect(seen.map(s => s.host)).toEqual(['closed.example', 'www.closed.example']);
  });

  it('an error status without a refusal is "don’t know", not "blocked"', async () => {
    routes['/bots'] = { status: 403, headers: {} };
    expect(await check('https://open.example/bots')).toEqual({
      embeddable: null,
      reason: 'http_error'
    });
  });

  it('remembers a verdict instead of asking the site again', async () => {
    await check('https://open.example/page');
    await check('https://open.example/page');
    expect(seen).toHaveLength(1);
  });

  describe('never contacts what it must not', () => {
    it.each([
      ['not a url', 'invalid_url'],
      ['javascript:alert(1)', 'invalid_url'],
      ['file:///etc/passwd', 'invalid_url'],
      ['https://user:pass@open.example/', 'invalid_url'],
      ['https://open.example:8443/', 'invalid_url']
    ])('%s', async (url, reason) => {
      expect(await check(url)).toEqual({ embeddable: false, reason });
      expect(seen).toHaveLength(0);
    });

    it.each([
      'http://127.0.0.1/',
      'http://localhost/',
      'http://10.0.0.5/',
      'http://169.254.169.254/'
    ])('a private address: %s', async url => {
      // The real address rules, not the stand-in lookup.
      expect(await embedCheck.check(url, { origin: ORIGIN, connect })).toEqual({
        embeddable: false,
        reason: 'blocked_address'
      });
      expect(seen).toHaveLength(0);
    });

    it('a public name that resolves to a private address', async () => {
      const lookup = async () => [{ address: '10.0.0.5', family: 4 }];
      expect(await check('https://sneaky.example/', { lookup })).toEqual({
        embeddable: false,
        reason: 'blocked_address'
      });
      expect(seen).toHaveLength(0);
    });

    it('a redirect to a private address', async () => {
      routes['/out'] = { status: 302, headers: { Location: 'http://169.254.169.254/latest' } };
      const lookup = async hostname =>
        hostname === 'open.example'
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '169.254.169.254', family: 4 }];
      expect(await check('https://open.example/out', { lookup })).toEqual({
        embeddable: false,
        reason: 'blocked_address'
      });
      expect(seen).toHaveLength(1);
    });
  });

  it('a site that cannot be reached is "don’t know"', async () => {
    const closed = () => ({ host: '127.0.0.1', port: 1, protocol: 'http:' });
    expect(await check('https://down.example/', { connect: closed })).toEqual({
      embeddable: null,
      reason: 'unreachable'
    });
  });
});
