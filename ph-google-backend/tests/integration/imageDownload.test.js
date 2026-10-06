const request = require('supertest');
const testDb = require('../helpers/testDb');
const imageDownloadService = require('../../services/imageDownloadService');
const { ImageDownloadError } = require('../../services/imageDownloadService');
const { signUrl } = require('../../utils/urlSigner');
const { mapImageResult, DOWNLOAD_PURPOSE } = require('../../services/external/serpApiImageMapper');

/**
 * GET /api/images/download over HTTP: only addresses the server signed are
 * fetched, a signed address is still subject to every address check, and
 * what comes back is a safe attachment or a plain error.
 */

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  Buffer.alloc(32, 1)
]);
const URL_OK = 'https://img.example.com/photos/python-logo.png';
const signed = url => ({ url, sig: signUrl(DOWNLOAD_PURPOSE, url) });

let app;
let fetchImage;

beforeAll(async () => {
  await testDb.connect();
  app = require('../../app').createApp();
});
afterAll(async () => {
  await testDb.disconnect();
});
beforeEach(() => {
  fetchImage = jest.spyOn(imageDownloadService, 'fetchImage').mockResolvedValue({
    buffer: PNG,
    contentType: 'image/png',
    extension: 'png',
    finalUrl: URL_OK
  });
});
afterEach(() => jest.restoreAllMocks());

const download = query => request(app).get('/api/images/download').query(query);

describe('GET /api/images/download — what may be asked for', () => {
  it('requires a url', async () => {
    const res = await download({});
    expect(res.status).toBe(400);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it.each([
    ['no signature', { url: URL_OK }],
    ['a made-up signature', { url: URL_OK, sig: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }],
    ['a signature for a different address', { url: 'http://127.0.0.1/x', sig: signed(URL_OK).sig }],
    [
      'a signature with something appended to the address',
      { url: `${URL_OK}?x=1`, sig: signed(URL_OK).sig }
    ],
    ['an array for url', { url: [URL_OK, 'http://127.0.0.1/'], sig: signed(URL_OK).sig }]
  ])('refuses %s without fetching anything', async (_label, query) => {
    const res = await download(query);
    expect([400, 403]).toContain(res.status);
    expect(res.body.success).toBe(false);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('accepts the token image search puts on a result', async () => {
    const image = mapImageResult({
      thumbnail: 'https://thumbs.example/t.jpg',
      original: URL_OK,
      link: 'https://example.com/page',
      title: 'Python logo'
    });
    expect(image.downloadToken).toEqual(expect.any(String));
    const res = await download({ url: image.imageUrl, sig: image.downloadToken });
    expect(res.status).toBe(200);
    expect(fetchImage).toHaveBeenCalledWith(URL_OK);
  });

  it('gives a result with no full image no token', () => {
    const image = mapImageResult({
      thumbnail: 'https://thumbs.example/t.jpg',
      link: 'https://example.com/page'
    });
    expect(image.imageUrl).toBeNull();
    expect(image.downloadToken).toBeNull();
  });
});

describe('GET /api/images/download — the file', () => {
  it('returns the image as an attachment with safe headers', async () => {
    const res = await download({ ...signed(URL_OK), name: 'Python logo' }).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toBe('attachment; filename="Python logo.png"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(Number(res.headers['content-length'])).toBe(PNG.length);
    expect(Buffer.from(res.body).equals(PNG)).toBe(true);
  });

  it('uses the type the service recognised, not anything from the request', async () => {
    fetchImage.mockResolvedValue({ buffer: PNG, contentType: 'image/jpeg', extension: 'jpg' });
    const res = await download({ ...signed(URL_OK), name: 'photo.exe' });
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-disposition']).toBe('attachment; filename="photo.exe.jpg"');
  });

  it.each([
    ['a path', '../../etc/passwd', 'etc passwd.png'],
    ['header injection', 'a"\r\nSet-Cookie: x=1', 'a Set-Cookie x 1.png'],
    ['markup', '<script>alert(1)</script>', 'script alert 1 script.png'],
    ['nothing', '', 'image.png']
  ])('makes a safe file name from %s', async (_label, name, expected) => {
    const res = await download({ ...signed(URL_OK), name });
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${expected}"`);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('GET /api/images/download — failures', () => {
  it.each([
    ['blocked', 400],
    ['invalid_url', 400],
    ['not_image', 415],
    ['too_large', 413],
    ['timeout', 504],
    ['upstream', 502],
    ['network', 502],
    ['redirects', 502]
  ])('%s → %i with a plain message', async (code, status) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    fetchImage.mockRejectedValue(new ImageDownloadError(code, 'A safe message.', 404));
    const res = await download(signed(`${URL_OK}?token=SECRET-IN-URL`));
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ success: false, message: 'A safe message.' });
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('SECRET-IN-URL');
  });

  it('an unexpected error is a 500, not a leak', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    fetchImage.mockRejectedValue(new Error('boom at /app/services/x.js'));
    const res = await download(signed(URL_OK));
    expect(res.status).toBe(500);
  });
});

describe('GET /api/images/download — a signature does not unlock internal addresses', () => {
  // The real service, no stub: even an address the server signed is refused
  // when it is not public. (Nothing is contacted: these fail before any request.)
  it.each([
    'http://127.0.0.1/a.png',
    'http://localhost/a.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/a.png',
    'http://192.168.1.1/a.png',
    'http://[::1]/a.png',
    'http://opensearch/_cat/indices',
    'http://redis/',
    'http://mongo/',
    'http://backend/api/admin/users',
    'http://opensearch:9200/ph-google-pages/_search',
    'http://redis:6379/',
    'http://localhost:5000/api/health'
  ])('%s', async url => {
    jest.restoreAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await download(signed(url));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('That image address cannot be downloaded.');
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'ftp://img.example.com/a.png'])(
    '%s',
    async url => {
      jest.restoreAllMocks();
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const res = await download(signed(url));
      expect(res.status).toBe(400);
    }
  );
});
