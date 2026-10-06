const http = require('http');
const net = require('net');
const {
  isPublicAddress,
  isPublicHostname,
  resolvePublicAddress
} = require('../../utils/publicAddress');
const { signUrl, verifyUrl } = require('../../utils/urlSigner');
const { fetchImage, parseImageUrl, sniffImage } = require('../../services/imageDownloadService');
const { safeFileName } = require('../../controllers/imageController');

/**
 * The image download path: which addresses may be fetched at all, and what
 * the fetch does with every kind of reply. No real network is used — DNS is
 * a stub and every "remote" server is a local stand-in reached through the
 * test-only `connect` hook, AFTER the address checks have run on the name
 * the test asked for.
 */

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  Buffer.alloc(64, 1)
]);
const JPEG = Buffer.concat([Buffer.from('ffd8ffe000104a464946000101', 'hex'), Buffer.alloc(64, 2)]);
const HTML = Buffer.from('<!doctype html><html><body>not an image at all</body></html>');

/** DNS stub: public names resolve to a public address, the rest as listed. */
const DNS = {
  'img.example.com': [{ address: '93.184.216.34', family: 4 }],
  'cdn.example.org': [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }],
  'rebind.example.com': [{ address: '127.0.0.1', family: 4 }],
  'mixed.example.com': [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.7', family: 4 }
  ],
  'metadata.example.com': [{ address: '169.254.169.254', family: 4 }],
  'v6local.example.com': [{ address: 'fd00::1', family: 6 }]
};
const lookup = jest.fn(async host => {
  if (!DNS[host]) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return DNS[host];
});

describe('public address rules', () => {
  it.each([
    ['93.184.216.34', true],
    ['8.8.8.8', true],
    ['2606:4700:4700::1111', true],
    ['127.0.0.1', false],
    ['127.255.255.254', false],
    ['0.0.0.0', false],
    ['10.1.2.3', false],
    ['172.16.0.1', false],
    ['172.31.255.255', false],
    ['192.168.1.10', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['224.0.0.1', false],
    ['255.255.255.255', false],
    ['::1', false],
    ['::', false],
    ['fc00::1', false],
    ['fd12:3456::1', false],
    ['fe80::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:7f00:1', false],
    ['::ffff:10.0.0.1', false],
    ['not-an-ip', false],
    ['', false]
  ])('isPublicAddress(%s) → %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it.each([
    ['img.example.com', true],
    ['upload.wikimedia.org', true],
    ['93.184.216.34', true],
    ['localhost', false],
    ['app.localhost', false],
    ['redis', false],
    ['mongo', false],
    ['opensearch', false],
    ['backend', false],
    ['dashboards', false],
    ['host.docker.internal', false],
    ['printer.local', false],
    ['intranet.corp', false],
    ['nas.lan', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false],
    ['', false]
  ])('isPublicHostname(%s) → %s', (host, expected) => {
    expect(isPublicHostname(host)).toBe(expected);
  });

  it('resolves a public name to one address to connect to', async () => {
    await expect(resolvePublicAddress('img.example.com', lookup)).resolves.toEqual({
      address: '93.184.216.34',
      family: 4
    });
  });

  it.each([
    ['a public-looking name that resolves to loopback', 'rebind.example.com'],
    ['a name with one private address among public ones', 'mixed.example.com'],
    ['a name that resolves to the cloud metadata address', 'metadata.example.com'],
    ['a name that resolves to a private IPv6 address', 'v6local.example.com'],
    ['a name that does not resolve', 'nowhere.example.com'],
    ['a private literal', '10.0.0.5'],
    ['an IPv6 loopback literal', '[::1]'],
    ['a Docker service name', 'opensearch']
  ])('refuses %s', async (_label, host) => {
    await expect(resolvePublicAddress(host, lookup)).resolves.toBeNull();
  });
});

describe('image address parsing', () => {
  it.each([
    'https://img.example.com/a.png',
    'http://img.example.com/a.png',
    'https://img.example.com:443/a.png?x=1'
  ])('accepts %s', url => {
    expect(parseImageUrl(url).hostname).toBe('img.example.com');
  });

  it.each([
    ['javascript:alert(1)', 'invalid_url'],
    ['data:image/png;base64,AAAA', 'invalid_url'],
    ['file:///etc/passwd', 'invalid_url'],
    ['ftp://img.example.com/a.png', 'invalid_url'],
    ['//img.example.com/a.png', 'invalid_url'],
    ['/a.png', 'invalid_url'],
    ['', 'invalid_url'],
    ['https://user:pass@img.example.com/a.png', 'invalid_url'],
    ['http://img.example.com:6379/', 'blocked'],
    ['http://img.example.com:9200/_cat/indices', 'blocked'],
    ['https://img.example.com:8443/a.png', 'blocked']
  ])('refuses %s (%s)', (url, code) => {
    expect(() => parseImageUrl(url)).toThrow(expect.objectContaining({ code }));
  });
});

describe('image recognition', () => {
  it('recognises images by their bytes and nothing else', () => {
    expect(sniffImage(PNG)).toEqual({ type: 'image/png', ext: 'png' });
    expect(sniffImage(JPEG)).toEqual({ type: 'image/jpeg', ext: 'jpg' });
    expect(sniffImage(Buffer.from('GIF89a' + 'x'.repeat(20)))).toEqual({
      type: 'image/gif',
      ext: 'gif'
    });
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toEqual({
      type: 'image/webp',
      ext: 'webp'
    });
    expect(sniffImage(HTML)).toBeNull();
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('url signing', () => {
  const url = 'https://img.example.com/a.png';

  it('accepts its own signature and nothing else', () => {
    const sig = signUrl('image-download', url);
    expect(verifyUrl('image-download', url, sig)).toBe(true);
    expect(verifyUrl('image-download', `${url}?x=1`, sig)).toBe(false);
    expect(verifyUrl('image-download', 'http://127.0.0.1/', sig)).toBe(false);
    expect(verifyUrl('another-purpose', url, sig)).toBe(false);
    expect(verifyUrl('image-download', url, '')).toBe(false);
    expect(verifyUrl('image-download', url, `${sig}x`)).toBe(false);
    expect(verifyUrl('image-download', url, undefined)).toBe(false);
  });
});

describe('download file names', () => {
  it.each([
    ['Python logo', 'png', 'Python logo.png'],
    ['../../etc/passwd', 'jpg', 'etc passwd.jpg'],
    ['Python logo ../../x', 'png', 'Python logo x.png'],
    ['report.final.v2', 'png', 'report.final.v2.png'],
    ['a"b\r\nSet-Cookie: x=1', 'png', 'a b Set-Cookie x 1.png'],
    ['<script>alert(1)</script>', 'gif', 'script alert 1 script.gif'],
    ['', 'png', 'image.png'],
    ['....', 'png', 'image.png'],
    ['x'.repeat(300), 'png', `${'x'.repeat(80)}.png`]
  ])('%j → %s', (name, ext, expected) => {
    expect(safeFileName(name, ext)).toBe(expected);
  });
});

describe('fetching an image', () => {
  let server;
  let port;
  let handler;
  const hits = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push({ url: req.url, host: req.headers.host });
      handler(req, res);
    });
    await new Promise(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
  });
  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise(resolve => {
      server.close(resolve);
    });
  });
  beforeEach(() => {
    hits.length = 0;
    lookup.mockClear();
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
      res.end(PNG);
    };
  });

  const connect = () => ({ host: '127.0.0.1', port, protocol: 'http:' });
  const get = (url, settings = {}) =>
    fetchImage(url, {
      lookup,
      connect,
      settings: { timeoutMs: 1500, maxBytes: 4096, maxRedirects: 3, ...settings }
    });
  const failure = async promise => {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error('expected the download to fail');
  };

  it.each(['https://img.example.com/logo.png', 'http://img.example.com/logo.png'])(
    'downloads %s',
    async url => {
      const image = await get(url);
      expect(image.contentType).toBe('image/png');
      expect(image.extension).toBe('png');
      expect(image.buffer.equals(PNG)).toBe(true);
      expect(hits).toEqual([{ url: '/logo.png', host: 'img.example.com' }]);
    }
  );

  it('reports the type from the bytes, not from the Content-Type header', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(JPEG);
    };
    expect((await get('https://img.example.com/a')).contentType).toBe('image/jpeg');
  });

  it.each([
    ['an HTML page', { 'content-type': 'text/html' }],
    ['an HTML page labelled as an image', { 'content-type': 'image/png' }]
  ])('refuses %s', async (_label, headers) => {
    handler = (req, res) => {
      res.writeHead(200, headers);
      res.end(HTML);
    };
    expect((await failure(get('https://img.example.com/a.png'))).code).toBe('not_image');
  });

  it('follows a redirect to another public address', async () => {
    handler = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: 'https://cdn.example.org/final.png' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    };
    const image = await get('https://img.example.com/start');
    expect(image.finalUrl).toBe('https://cdn.example.org/final.png');
    expect(hits.map(h => h.host)).toEqual(['img.example.com', 'cdn.example.org']);
  });

  it.each([
    ['a private IP', 'http://10.0.0.5/secret.png'],
    ['loopback', 'http://127.0.0.1/secret.png'],
    ['localhost', 'http://localhost/secret.png'],
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['a Docker service name', 'http://opensearch/_cat/indices'],
    ['a name that resolves to loopback', 'https://rebind.example.com/x.png'],
    ['another port', 'http://img.example.com:9200/x.png'],
    ['another scheme', 'file:///etc/passwd']
  ])('refuses a redirect to %s, without contacting it', async (_label, location) => {
    handler = (req, res) => {
      res.writeHead(302, { location });
      res.end();
    };
    const error = await failure(get('https://img.example.com/start'));
    expect(['blocked', 'invalid_url']).toContain(error.code);
    expect(hits).toHaveLength(1); // only the first, public hop
  });

  it('gives up on a redirect loop', async () => {
    handler = (req, res) => {
      res.writeHead(302, { location: '/again' });
      res.end();
    };
    expect((await failure(get('https://img.example.com/start'))).code).toBe('redirects');
    expect(hits).toHaveLength(4); // the first request and three redirects
  });

  it.each([
    ['localhost', 'http://localhost/a.png'],
    ['127.0.0.1', 'http://127.0.0.1/a.png'],
    ['0.0.0.0', 'http://0.0.0.0/a.png'],
    ['a private IP', 'http://192.168.1.20/a.png'],
    ['another private IP', 'http://172.20.0.3/a.png'],
    ['the metadata IP', 'http://169.254.169.254/latest/meta-data/iam'],
    ['IPv6 loopback', 'http://[::1]/a.png'],
    ['an IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/a.png'],
    ['a decimal IP for loopback', 'http://2130706433/a.png'],
    ['an internal hostname', 'http://intranet.corp/a.png'],
    ['a Docker service: redis', 'http://redis/a.png'],
    ['a Docker service: mongo', 'http://mongo/a.png'],
    ['a Docker service: opensearch', 'http://opensearch/a.png'],
    ['a Docker service: backend', 'http://backend/a.png'],
    ['a public name that resolves to loopback', 'https://rebind.example.com/a.png'],
    ['a name with a private address among its records', 'https://mixed.example.com/a.png'],
    ['a name that does not resolve', 'https://nowhere.example.com/a.png']
  ])('never contacts %s', async (_label, url) => {
    const error = await failure(get(url));
    expect(error.code).toBe('blocked');
    expect(hits).toHaveLength(0);
  });

  it.each([
    [404, 'upstream'],
    [403, 'upstream'],
    [500, 'upstream'],
    [503, 'upstream']
  ])('reports an upstream %i', async (status, code) => {
    handler = (req, res) => {
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end('secret upstream detail');
    };
    const error = await failure(get('https://img.example.com/a.png'));
    expect(error.code).toBe(code);
    expect(error.upstreamStatus).toBe(status);
    expect(error.message).not.toMatch(/secret upstream detail/);
  });

  it('refuses a file larger than the limit when the size is declared', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': 10 * 1024 * 1024 });
      res.end(PNG);
    };
    expect((await failure(get('https://img.example.com/huge.png'))).code).toBe('too_large');
  });

  it('stops reading a file that turns out larger than the limit', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write(PNG);
      const more = setInterval(() => res.write(Buffer.alloc(1024, 3)), 5);
      res.on('close', () => clearInterval(more));
    };
    expect((await failure(get('https://img.example.com/endless.png'))).code).toBe('too_large');
  });

  it('gives up after the deadline', async () => {
    handler = () => {}; // never answers
    const started = Date.now();
    const error = await failure(get('https://img.example.com/slow.png', { timeoutMs: 300 }));
    expect(error.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1400);
  });

  it('gives up when the body stalls', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.write(PNG.subarray(0, 8));
    };
    const error = await failure(get('https://img.example.com/stall.png', { timeoutMs: 300 }));
    expect(error.code).toBe('timeout');
  });

  it('reports an unreachable server', async () => {
    const closed = await new Promise(resolve => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const p = probe.address().port;
        probe.close(() => resolve(p));
      });
    });
    const error = await failure(
      fetchImage('https://img.example.com/a.png', {
        lookup,
        connect: () => ({ host: '127.0.0.1', port: closed, protocol: 'http:' }),
        settings: { timeoutMs: 1500 }
      })
    );
    expect(error.code).toBe('network');
  });
});
