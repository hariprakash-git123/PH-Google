const http = require('http');
const zlib = require('zlib');
const { fetchSitemap } = require('../../crawler/sitemapFetcher');
const { config } = require('../../config/env');

/**
 * The sitemap fetcher, against a local HTTP server on 127.0.0.1.
 * Nothing here reaches a real website.
 */

const SITEMAP =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  '<url><loc>https://a.test/page</loc></url></urlset>';

// Small limits so oversize cases stay fast.
const MAX_BYTES = 8 * 1024;
const TIMEOUT_MS = 400;

let server;
let base;
let port;
const requests = [];
const saved = {};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

const routes = {
  '/sitemap.xml': (req, res) => send(res, 200, SITEMAP, { 'Content-Type': 'application/xml' }),
  '/text.xml': (req, res) => send(res, 200, SITEMAP, { 'Content-Type': 'text/xml; charset=utf-8' }),
  '/plain.txt': (req, res) => send(res, 200, SITEMAP, { 'Content-Type': 'text/plain' }),
  '/untyped.xml': (req, res) => send(res, 200, SITEMAP),
  // Untyped, and starting with a UTF-8 byte-order mark.
  '/bom-untyped.xml': (req, res) =>
    send(res, 200, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SITEMAP)])),
  // gzip as a transfer encoding, decoded in transit.
  '/encoded.xml': (req, res) =>
    send(res, 200, zlib.gzipSync(SITEMAP), {
      'Content-Type': 'application/xml',
      'Content-Encoding': 'gzip'
    }),
  // A .xml.gz file: the body itself is gzip, under the types servers use.
  '/sitemap.xml.gz': (req, res) =>
    send(res, 200, zlib.gzipSync(SITEMAP), { 'Content-Type': 'application/x-gzip' }),
  '/octet.xml.gz': (req, res) =>
    send(res, 200, zlib.gzipSync(SITEMAP), { 'Content-Type': 'application/octet-stream' }),
  '/corrupt.xml.gz': (req, res) =>
    send(res, 200, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6, 7]), {
      'Content-Type': 'application/x-gzip'
    }),
  '/big.xml': (req, res) =>
    send(res, 200, `<urlset>${'x'.repeat(MAX_BYTES * 2)}</urlset>`, {
      'Content-Type': 'application/xml'
    }),
  // No Content-Length: the limit must hold on a streamed body too.
  '/big-chunked.xml': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    for (let i = 0; i < 8; i += 1) res.write('x'.repeat(MAX_BYTES / 2));
    res.end();
  },
  // A few KB that expand to 5 MB.
  '/bomb.xml.gz': (req, res) =>
    send(res, 200, zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024, 0x20)), {
      'Content-Type': 'application/x-gzip'
    }),
  '/bomb-encoded.xml': (req, res) =>
    send(res, 200, zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024, 0x20)), {
      'Content-Type': 'application/xml',
      'Content-Encoding': 'gzip'
    }),
  '/hang.xml': () => {
    // Never answers.
  },
  // Answers, then drips a byte at a time for longer than the timeout.
  '/drip.xml': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    const timer = setInterval(() => res.write(' '), 50);
    req.on('close', () => clearInterval(timer));
    setTimeout(() => {
      clearInterval(timer);
      res.end();
    }, TIMEOUT_MS * 5);
  },
  '/missing.xml': (req, res) => send(res, 404, 'Not found', { 'Content-Type': 'text/plain' }),
  '/error.xml': (req, res) => send(res, 500, 'Oops', { 'Content-Type': 'text/plain' }),
  '/page.html': (req, res) =>
    send(res, 200, '<!DOCTYPE html><html><body>Not a sitemap</body></html>', {
      'Content-Type': 'text/html; charset=utf-8'
    }),
  // XHTML is XML by media type, but a page, not a sitemap.
  '/page.xhtml': (req, res) =>
    send(res, 200, '<html xmlns="http://www.w3.org/1999/xhtml"><body>Page</body></html>', {
      'Content-Type': 'application/xhtml+xml'
    }),
  // A gzipped HTML page: the gzip bytes alone must not make it a sitemap.
  '/page.html.gz': (req, res) =>
    send(res, 200, zlib.gzipSync('<html><body>Page</body></html>'), {
      'Content-Type': 'text/html'
    }),
  '/image.png': (req, res) =>
    send(res, 200, Buffer.from([0x89, 0x50, 0x4e, 0x47]), { 'Content-Type': 'image/png' }),
  '/empty.xml': (req, res) => send(res, 200, '', { 'Content-Type': 'application/xml' }),
  '/redirect-same.xml': (req, res) => send(res, 301, '', { Location: '/sitemap.xml' }),
  // 127.0.0.1 and localhost are the same server but different hosts.
  '/redirect-other.xml': (req, res) =>
    send(res, 302, '', { Location: `http://localhost:${port}/sitemap.xml` }),
  '/redirect-loop.xml': (req, res) => send(res, 302, '', { Location: '/redirect-loop.xml' })
};

beforeAll(async () => {
  saved.maxBytes = config.crawler.sitemapMaxBytes;
  saved.timeout = config.crawler.requestTimeoutMs;
  config.crawler.sitemapMaxBytes = MAX_BYTES;
  config.crawler.requestTimeoutMs = TIMEOUT_MS;

  server = http.createServer((req, res) => {
    requests.push({ host: req.headers.host, path: req.url, userAgent: req.headers['user-agent'] });
    const route = routes[req.url];
    if (route) route(req, res);
    else send(res, 404, 'Not found');
  });
  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  config.crawler.sitemapMaxBytes = saved.maxBytes;
  config.crawler.requestTimeoutMs = saved.timeout;
  server.closeAllConnections();
  await new Promise(resolve => {
    server.close(resolve);
  });
});

beforeEach(() => {
  requests.length = 0;
});

describe('successful fetches', () => {
  it('fetches an XML sitemap', async () => {
    const result = await fetchSitemap(`${base}/sitemap.xml`);

    expect(result).toMatchObject({ ok: true, status: 200, body: SITEMAP, compressed: false });
    expect(result.finalUrl).toBe(`${base}/sitemap.xml`);
  });

  it('identifies itself with the crawler user agent', async () => {
    await fetchSitemap(`${base}/sitemap.xml`);
    expect(requests[0].userAgent).toBe(config.crawler.userAgent);
  });

  it.each(['/text.xml', '/plain.txt', '/untyped.xml'])('accepts %s', async path => {
    const result = await fetchSitemap(`${base}${path}`);
    expect(result).toMatchObject({ ok: true, body: SITEMAP });
  });

  it('accepts an untyped sitemap that starts with a byte-order mark', async () => {
    const result = await fetchSitemap(`${base}/bom-untyped.xml`);
    expect(result.ok).toBe(true);
    // Passed through for the parser, which strips it.
    expect(result.body.charCodeAt(0)).toBe(0xfeff);
    expect(result.body.slice(1)).toBe(SITEMAP);
  });

  it('decodes a gzip Content-Encoding in transit', async () => {
    const result = await fetchSitemap(`${base}/encoded.xml`);
    expect(result).toMatchObject({ ok: true, body: SITEMAP });
  });

  it.each(['/sitemap.xml.gz', '/octet.xml.gz'])('gunzips a %s file', async path => {
    const result = await fetchSitemap(`${base}${path}`);
    expect(result).toMatchObject({ ok: true, body: SITEMAP, compressed: true });
  });

  it('follows a redirect that stays on the same host', async () => {
    const result = await fetchSitemap(`${base}/redirect-same.xml`);
    expect(result).toMatchObject({ ok: true, body: SITEMAP, finalUrl: `${base}/sitemap.xml` });
  });
});

describe('size limits', () => {
  it('refuses a response larger than the limit', async () => {
    expect(await fetchSitemap(`${base}/big.xml`)).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('refuses a streamed response larger than the limit', async () => {
    expect(await fetchSitemap(`${base}/big-chunked.xml`)).toMatchObject({
      ok: false,
      reason: 'too_large'
    });
  });

  it('stops a .xml.gz bomb at the limit instead of expanding it', async () => {
    const result = await fetchSitemap(`${base}/bomb.xml.gz`);
    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
    expect(result.body).toBeUndefined();
  });

  it('stops a gzip Content-Encoding bomb at the limit', async () => {
    expect(await fetchSitemap(`${base}/bomb-encoded.xml`)).toMatchObject({
      ok: false,
      reason: 'too_large'
    });
  });

  it('reports a corrupt gzip file', async () => {
    expect(await fetchSitemap(`${base}/corrupt.xml.gz`)).toMatchObject({
      ok: false,
      reason: 'invalid_gzip'
    });
  });
});

describe('timeouts', () => {
  it('gives up on a server that never answers', async () => {
    const started = Date.now();
    const result = await fetchSitemap(`${base}/hang.xml`);

    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 4);
  });

  it('gives up on a server that drips bytes past the deadline', async () => {
    const started = Date.now();
    const result = await fetchSitemap(`${base}/drip.xml`);

    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 4);
  });
});

describe('HTTP errors and wrong content', () => {
  it('reports a 404', async () => {
    expect(await fetchSitemap(`${base}/missing.xml`)).toMatchObject({
      ok: false,
      status: 404,
      reason: 'http_error'
    });
  });

  it('reports a 500', async () => {
    expect(await fetchSitemap(`${base}/error.xml`)).toMatchObject({
      ok: false,
      status: 500,
      reason: 'http_error'
    });
  });

  it.each(['/page.html', '/page.xhtml', '/page.html.gz', '/image.png'])(
    'refuses %s as not a sitemap',
    async path => {
      expect(await fetchSitemap(`${base}${path}`)).toMatchObject({
        ok: false,
        reason: 'unsupported_content_type'
      });
    }
  );

  it('reports an empty body', async () => {
    expect(await fetchSitemap(`${base}/empty.xml`)).toMatchObject({
      ok: false,
      reason: 'empty_body'
    });
  });

  it('reports an invalid URL without making a request', async () => {
    expect(await fetchSitemap('not a url')).toMatchObject({ ok: false, reason: 'invalid_url' });
    expect(requests).toHaveLength(0);
  });

  it('reports a connection failure', async () => {
    // A port nothing listens on.
    const closed = http.createServer();
    await new Promise(resolve => {
      closed.listen(0, '127.0.0.1', resolve);
    });
    const deadPort = closed.address().port;
    await new Promise(resolve => {
      closed.close(resolve);
    });

    expect(await fetchSitemap(`http://127.0.0.1:${deadPort}/sitemap.xml`)).toMatchObject({
      ok: false,
      reason: 'network_error'
    });
  });
});

describe('redirects', () => {
  it('refuses a redirect to another host before following it', async () => {
    const result = await fetchSitemap(`${base}/redirect-other.xml`);

    expect(result).toMatchObject({ ok: false, reason: 'cross_host_redirect' });
    // The other host was never contacted.
    expect(requests.map(r => r.host)).toEqual([`127.0.0.1:${port}`]);
  });

  it('stops following an endless redirect', async () => {
    expect(await fetchSitemap(`${base}/redirect-loop.xml`)).toMatchObject({
      ok: false,
      reason: 'too_many_redirects'
    });
    // The first request plus five redirects, and no more.
    expect(requests.length).toBeLessThanOrEqual(6);
  });
});
