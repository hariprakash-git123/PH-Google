const videoPlatforms = require('../../services/external/videoPlatforms');
const pageImages = require('../../services/external/pageImages');
const safeFetch = require('../../services/external/safeFetch');
const parallelVerticals = require('../../services/parallelVerticals');
const { parseQuery } = require('../../services/opensearch/queryParser');

/**
 * The checks behind image and video results that come from a web search:
 * what counts as one video's page and how a platform confirms it; which
 * pictures on a page are about the subject; and what an address must serve
 * to be shown as a picture. No network: fetches are injected or mocked.
 */

// ---------------------------------------------------------------- fixtures
const png = (width, height, extra = 0) => {
  const buffer = Buffer.alloc(33 + extra);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};
const jpeg = (width, height) => {
  const app0 = Buffer.from('ffe000104a46494600010100000100010000', 'hex');
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from('ffd8', 'hex'), app0, sof]);
};
const gif = (width, height) => {
  const buffer = Buffer.alloc(16);
  buffer.write('GIF89a', 0, 'latin1');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
};
const webp = (width, height) => {
  const buffer = Buffer.alloc(32);
  buffer.write('RIFF', 0, 'latin1');
  buffer.write('WEBPVP8X', 8, 'latin1');
  buffer.writeUIntLE(width - 1, 24, 3);
  buffer.writeUIntLE(height - 1, 27, 3);
  return buffer;
};
const served = (buffer, extra = {}) => ({
  ok: true,
  status: 200,
  headers: { 'content-type': 'image/png', 'content-length': String(buffer.length) },
  buffer,
  truncated: false,
  finalUrl: 'https://img.example/photo.png',
  ...extra
});

afterEach(() => jest.restoreAllMocks());

// ------------------------------------------------------------------ videos
describe('parseVideoUrl', () => {
  it.each([
    ['https://www.youtube.com/watch?v=sJWhMmpvAhs', 'youtube:sJWhMmpvAhs'],
    ['https://youtube.com/watch?v=sJWhMmpvAhs&t=42s&list=PLabc', 'youtube:sJWhMmpvAhs'],
    ['https://m.youtube.com/watch?v=sJWhMmpvAhs', 'youtube:sJWhMmpvAhs'],
    ['https://youtu.be/sJWhMmpvAhs?si=xyz', 'youtube:sJWhMmpvAhs'],
    ['https://www.youtube.com/shorts/sJWhMmpvAhs', 'youtube:sJWhMmpvAhs'],
    ['https://www.youtube.com/embed/sJWhMmpvAhs', 'youtube:sJWhMmpvAhs'],
    ['https://vimeo.com/76979871', 'vimeo:76979871'],
    ['https://vimeo.com/channels/staffpicks/76979871', 'vimeo:76979871'],
    ['https://www.dailymotion.com/video/x8abc12', 'dailymotion:x8abc12']
  ])('%s is the video %s', (url, key) => {
    expect(videoPlatforms.parseVideoUrl(url)).toMatchObject({ key });
  });

  it('gives every form of an address the same canonical page', () => {
    expect(videoPlatforms.parseVideoUrl('https://youtu.be/sJWhMmpvAhs?si=xyz')).toEqual({
      platform: 'youtube',
      id: 'sJWhMmpvAhs',
      key: 'youtube:sJWhMmpvAhs',
      videoUrl: 'https://www.youtube.com/watch?v=sJWhMmpvAhs',
      label: 'YouTube'
    });
  });

  it.each([
    // On a platform, but not one video's page.
    'https://www.youtube.com/channel/UCs5zOg5Ad0QAkRPJsYiRm9g',
    'https://www.youtube.com/@AmpedAuto/videos',
    'https://www.youtube.com/playlist?list=PLxzq_Qs_Uo3cnHsQfT6SRsVEfzen6eln2',
    'https://www.youtube.com/hashtag/electriccars2026',
    'https://www.youtube.com/results?search_query=electric+cars',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=sJWhMmpvAhs<script>',
    'https://vimeo.com/about',
    'https://vimeo.com/categories/animation',
    'https://www.dailymotion.com/tech',
    // Not a platform this application can confirm with.
    'https://example.com/watch?v=sJWhMmpvAhs',
    'https://youtube.com.evil.example/watch?v=sJWhMmpvAhs',
    'https://news.example.com/article-with-a-video',
    // Not an address to open at all.
    'javascript:alert(1)',
    'data:text/html,<video>',
    '//youtube.com/watch?v=sJWhMmpvAhs',
    'not a url',
    '',
    null,
    undefined
  ])('%s is not a video page', url => {
    expect(videoPlatforms.parseVideoUrl(url)).toBeNull();
  });
});

describe('lookup (the platform confirms the video)', () => {
  const video = videoPlatforms.parseVideoUrl('https://youtu.be/sJWhMmpvAhs');
  const answering = (status, body) =>
    jest.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === 'not-json') throw new SyntaxError('Unexpected token');
        return body;
      }
    }));

  it('asks the platform’s own oEmbed endpoint about the canonical address', async () => {
    const fetchImpl = answering(200, { type: 'video', title: 'A video' });
    await videoPlatforms.lookup(video, { fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DsJWhMmpvAhs'
    );
    // Never follows the platform anywhere else.
    expect(init.redirect).toBe('error');
  });

  it('returns the platform’s title, channel and thumbnail', async () => {
    const fetchImpl = answering(200, {
      type: 'video',
      title: '  Palak Aloo Curry \n in Tamil ',
      author_name: 'Madras Samayal',
      thumbnail_url: 'https://i.ytimg.com/vi/sJWhMmpvAhs/hqdefault.jpg'
    });
    expect(await videoPlatforms.lookup(video, { fetchImpl })).toEqual({
      ok: true,
      title: 'Palak Aloo Curry in Tamil',
      channel: 'Madras Samayal',
      thumbnailUrl: 'https://i.ytimg.com/vi/sJWhMmpvAhs/hqdefault.jpg'
    });
  });

  it('drops a thumbnail that is not an http(s) address, keeping the video', async () => {
    const fetchImpl = answering(200, {
      type: 'video',
      title: 'A video',
      thumbnail_url: 'javascript:alert(1)'
    });
    expect(await videoPlatforms.lookup(video, { fetchImpl })).toMatchObject({
      ok: true,
      thumbnailUrl: null
    });
  });

  it.each([
    ['private', 401],
    ['embedding off', 403],
    ['removed or never existed', 404],
    ['the platform is failing', 503]
  ])('%s (%i): not confirmed', async (_label, status) => {
    const outcome = await videoPlatforms.lookup(video, { fetchImpl: answering(status, {}) });
    expect(outcome).toEqual({ ok: false, reason: 'not_confirmed' });
  });

  it.each([
    ['a reply that is not JSON', 'not-json', 'invalid_response'],
    ['a list', [], 'invalid_response'],
    ['no title', { type: 'video' }, 'not_a_video'],
    ['something that is not a video', { type: 'photo', title: 'A picture' }, 'not_a_video']
  ])('%s: refused', async (_label, body, reason) => {
    const outcome = await videoPlatforms.lookup(video, { fetchImpl: answering(200, body) });
    expect(outcome).toEqual({ ok: false, reason });
  });

  it('a timeout and a network failure are reasons, never exceptions', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(
      await videoPlatforms.lookup(video, { fetchImpl: jest.fn().mockRejectedValue(timeout) })
    ).toEqual({ ok: false, reason: 'timeout' });
    expect(
      await videoPlatforms.lookup(video, {
        fetchImpl: jest.fn().mockRejectedValue(new Error('ECONNRESET'))
      })
    ).toEqual({ ok: false, reason: 'network' });
  });

  it('asks nothing about a platform it does not know', async () => {
    const fetchImpl = jest.fn();
    expect(
      await videoPlatforms.lookup({ platform: 'other', videoUrl: 'x' }, { fetchImpl })
    ).toEqual({ ok: false, reason: 'unknown_platform' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ images
describe('extractCandidates (which pictures on a page are about the subject)', () => {
  const PAGE = 'https://cars.example/guide/electric';
  const terms = ['electric', 'car'];
  const urls = html => pageImages.extractCandidates(html, PAGE, terms).map(c => c.imageUrl);

  it('keeps a picture whose alt text is about the subject, with that text as its title', () => {
    const out = pageImages.extractCandidates(
      '<img src="/media/a81f.jpg" alt="A red electric car charging">',
      PAGE,
      terms
    );
    expect(out).toEqual([
      {
        imageUrl: 'https://cars.example/media/a81f.jpg',
        title: 'A red electric car charging',
        lead: false,
        matched: 2
      }
    ]);
  });

  it('a caption or the file name can say what a picture is of', () => {
    expect(
      urls(`
        <figure><img src="https://cdn.example/p/001.jpg"><figcaption>The new electric hatchback</figcaption></figure>
        <img src="https://cdn.example/p/tesla-electric-car_front.webp" alt="">
      `)
    ).toEqual([
      // Both words in the file name: the clearer match comes first.
      'https://cdn.example/p/tesla-electric-car_front.webp',
      'https://cdn.example/p/001.jpg'
    ]);
  });

  it('leaves out pictures of something else, however many the page has', () => {
    expect(
      urls(`
        <img src="/a.jpg" alt="Our newsletter editor">
        <img src="/b.jpg" alt="Sunset over the harbour">
        <img src="/c.jpg">
      `)
    ).toEqual([]);
  });

  it.each([
    '<img src="/static/site-logo.png" alt="Electric car news">',
    '<img src="/img/icons/electric-car.png" alt="electric car icon">',
    '<img src="/u/avatar-electric.jpg" alt="electric car fan">',
    '<img src="/ads/electric-car-advert.jpg" alt="electric car">',
    '<img src="/x/placeholder.gif" alt="electric car">'
  ])('leaves out page furniture: %s', html => {
    expect(urls(html)).toEqual([]);
  });

  it('but someone searching for logos is asking for exactly those', () => {
    const out = pageImages.extractCandidates(
      '<img src="/brand/tesla-logo.png" alt="Tesla logo">',
      PAGE,
      ['tesla', 'logo']
    );
    expect(out.map(c => c.imageUrl)).toEqual(['https://cars.example/brand/tesla-logo.png']);
  });

  it('leaves out what the markup sizes like an icon', () => {
    expect(
      urls(`
        <img src="/s.jpg" alt="electric car" width="48" height="48">
        <img src="/l.jpg" alt="electric car" width="800" height="600">
      `)
    ).toEqual(['https://cars.example/l.jpg']);
  });

  it('takes the page’s own lead image on the strength of the page’s title', () => {
    const out = pageImages.extractCandidates(
      `<html><head><title>Best electric cars of 2026</title>
        <meta property="og:image" content="https://cdn.example/hero/8842.jpg"></head></html>`,
      PAGE,
      terms
    );
    expect(out).toEqual([
      {
        imageUrl: 'https://cdn.example/hero/8842.jpg',
        title: 'Best electric cars of 2026',
        lead: true,
        matched: 2
      }
    ]);
  });

  it('does not take a lead image from a page whose title is about something else', () => {
    expect(
      urls(`<html><head><title>Subscribe to our newsletter</title>
        <meta property="og:image" content="https://cdn.example/hero/8842.jpg"></head></html>`)
    ).toEqual([]);
  });

  it('only ever returns absolute http(s) addresses', () => {
    expect(
      urls(`
        <img src="javascript:alert(1)" alt="electric car">
        <img src="data:image/png;base64,AAAA" alt="electric car">
        <img src="ftp://files.example/electric-car.jpg" alt="electric car">
        <img src="" alt="electric car">
        <img alt="electric car">
        <img src="/vector/electric-car.svg" alt="electric car">
        <img src="../photos/ok.jpg" alt="electric car">
        <img src="//cdn.example/also-ok.jpg" alt="electric car">
      `)
    ).toEqual(['https://cars.example/photos/ok.jpg', 'https://cdn.example/also-ok.jpg']);
  });

  it('reads lazy-loaded and responsive images, taking the largest', () => {
    expect(
      urls(`
        <img src="/blank.gif" data-src="/lazy/one.jpg" alt="electric car">
        <img srcset="/r/two-400.jpg 400w, /r/two-1600.jpg 1600w, /r/two-800.jpg 800w" alt="electric car">
      `)
    ).toEqual(['https://cars.example/lazy/one.jpg', 'https://cars.example/r/two-1600.jpg']);
  });

  it('counts the same file at two sizes once', () => {
    expect(
      urls(`
        <img src="https://cdn.example/p/car.jpg?w=400" alt="electric car">
        <img src="https://cdn.example/p/car.jpg?w=1600&fit=crop" alt="electric car, larger">
      `)
    ).toEqual(['https://cdn.example/p/car.jpg?w=400']);
  });

  it('takes a few pictures from a page, the most clearly on-subject first', () => {
    const many = Array.from(
      { length: 20 },
      (_, i) => `<img src="/g/${i}.jpg" alt="car number ${i}">`
    ).join('');
    const out = pageImages.extractCandidates(
      `${many}<img src="/g/best.jpg" alt="an electric car">`,
      PAGE,
      terms
    );
    expect(out).toHaveLength(8);
    expect(out[0].imageUrl).toBe('https://cars.example/g/best.jpg');
  });

  it('survives a page that is not HTML at all', () => {
    expect(pageImages.extractCandidates('\u0000\u0001 not html', PAGE, terms)).toEqual([]);
    expect(pageImages.extractCandidates(null, PAGE, terms)).toEqual([]);
  });
});

describe('imageSize', () => {
  it.each([
    ['image/png', png(640, 480)],
    ['image/jpeg', jpeg(640, 480)],
    ['image/gif', gif(640, 480)],
    ['image/webp', webp(640, 480)]
  ])('reads the size from a %s header', (type, buffer) => {
    expect(pageImages.imageSize(buffer, type)).toEqual({ width: 640, height: 480 });
  });

  it('has no size for a format or a header it cannot read', () => {
    expect(pageImages.imageSize(Buffer.alloc(64), 'image/avif')).toBeNull();
    expect(pageImages.imageSize(Buffer.from('ffd8ffe0', 'hex'), 'image/jpeg')).toBeNull();
    expect(pageImages.imageSize(Buffer.alloc(4), 'image/png')).toBeNull();
  });
});

describe('verifyImage (what an address must serve to be shown as a picture)', () => {
  const verify = response => {
    jest.spyOn(safeFetch, 'get').mockResolvedValue(response);
    return pageImages.verifyImage('https://img.example/photo.png');
  };

  it('accepts a real image of a useful size, with its dimensions', async () => {
    expect(await verify(served(png(1200, 800)))).toMatchObject({
      ok: true,
      imageUrl: 'https://img.example/photo.png',
      width: 1200,
      height: 800
    });
  });

  it('reports the address the image is really at, after redirects', async () => {
    const outcome = await verify(
      served(jpeg(800, 600), { finalUrl: 'https://cdn.example/final.jpg' })
    );
    expect(outcome.imageUrl).toBe('https://cdn.example/final.jpg');
  });

  it('goes by the bytes, not by what the server calls them', async () => {
    const html = Buffer.from('<!doctype html><html><body>Not found</body></html>');
    expect(await verify(served(html))).toEqual({ ok: false, reason: 'not_image' });
    const mislabelled = served(png(800, 600), { headers: { 'content-type': 'text/html' } });
    expect(await verify(mislabelled)).toMatchObject({ ok: true, width: 800 });
  });

  it.each([
    ['an icon', png(64, 64), 'too_small'],
    ['a thumbnail strip', png(600, 100), 'too_small'],
    ['a banner', png(1600, 300), 'not_a_picture'],
    ['a tracking pixel', gif(1, 1), 'too_small']
  ])('refuses %s', async (_label, buffer, reason) => {
    expect(await verify(served(buffer))).toEqual({ ok: false, reason });
  });

  it('refuses a format a browser may not show', async () => {
    const tiff = Buffer.concat([Buffer.from('49492a00', 'hex'), Buffer.alloc(40)]);
    expect(await verify(served(tiff))).toEqual({ ok: false, reason: 'not_image' });
  });

  it('with no readable size, a small file is not a picture and a large one is', async () => {
    const avif = size => {
      const buffer = Buffer.alloc(size);
      buffer.write('ftypavif', 4, 'latin1');
      return buffer;
    };
    expect(await verify(served(avif(2000)))).toEqual({ ok: false, reason: 'too_small' });
    expect(
      await verify(served(avif(2000), { headers: { 'content-length': '250000' } }))
    ).toMatchObject({ ok: true, width: null, height: null });
  });

  it.each(['timeout', 'network', 'blocked', 'invalid_url', 'upstream'])(
    'an address that cannot be fetched (%s) is refused, not an error',
    async reason => {
      expect(await verify({ ok: false, reason })).toEqual({ ok: false, reason });
    }
  );

  it('the same file gives the same fingerprint, a different one a different fingerprint', async () => {
    const a = await verify(served(png(800, 600)));
    const b = await verify(served(png(800, 600), { finalUrl: 'https://mirror.example/x.png' }));
    const c = await verify(served(png(801, 600)));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });
});

describe('imageIdentity', () => {
  it.each([
    [
      'https://images.example/photos/1/photo-1.jpeg?h=350',
      'https://images.example/photos/1/photo-1.jpeg?auto=compress&w=1260'
    ],
    [
      'https://lh3.googleusercontent.com/abcDEF=w800',
      'https://lh3.googleusercontent.com/abcDEF=w1080-h834'
    ],
    ['https://www.x.example/a.png', 'http://x.example/a.png']
  ])('%s and %s are the same picture', (a, b) => {
    expect(pageImages.imageIdentity(a)).toBe(pageImages.imageIdentity(b));
  });

  it.each([
    ['https://x.example/image?id=7', 'https://x.example/image?id=8'],
    ['https://x.example/a.jpg', 'https://x.example/b.jpg'],
    ['https://x.example/a.jpg', 'https://y.example/a.jpg']
  ])('%s and %s are different pictures', (a, b) => {
    expect(pageImages.imageIdentity(a)).not.toBe(pageImages.imageIdentity(b));
  });
});

// ----------------------------------------------------------- the request
describe('buildRequest', () => {
  const build = (query, category, params = {}) =>
    parallelVerticals.buildRequest(parseQuery(query), category, { sort: 'relevance', ...params });

  it('a video search is restricted to the platforms that can be confirmed', () => {
    expect(build('electric cars', 'videos')).toEqual({
      skip: false,
      objective: 'videos about electric cars',
      // Three ways of asking, each sent as its own request.
      searchQueries: ['electric cars video', 'electric cars', 'best electric cars'],
      sourcePolicy: { include_domains: ['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com'] }
    });
  });

  it('an image search asks for pages of pictures, on any site', () => {
    expect(build('Coimbatore restaurants', 'images')).toEqual({
      skip: false,
      objective: 'photos and pictures of Coimbatore restaurants',
      searchQueries: ['Coimbatore restaurants photos', 'Coimbatore restaurants images'],
      sourcePolicy: {}
    });
  });

  it('does not repeat a medium word the query already has', () => {
    expect(build('Tamil cooking videos', 'videos').searchQueries).toEqual([
      'Tamil cooking videos',
      'best Tamil cooking videos'
    ]);
    expect(build('sunset photos', 'images').searchQueries).toEqual([
      'sunset photos',
      'sunset photos images'
    ]);
  });

  it('a site filter naming a platform narrows to it; any other cannot be served', () => {
    expect(build('cooking', 'videos', { domain: 'vimeo.com' }).sourcePolicy).toEqual({
      include_domains: ['vimeo.com']
    });
    expect(build('cooking', 'videos', { domain: 'bbc.co.uk' })).toEqual({
      skip: true,
      reason: 'unsupported_filter'
    });
    // Images can come from any site.
    expect(build('cooking', 'images', { domain: 'bbc.co.uk' }).sourcePolicy).toEqual({
      include_domains: ['bbc.co.uk']
    });
  });

  it('declines what web search declines', () => {
    expect(build('cooking -onion', 'videos')).toEqual({
      skip: true,
      reason: 'unsupported_operator'
    });
    expect(build('cooking', 'images', { language: 'ta' })).toEqual({
      skip: true,
      reason: 'unsupported_filter'
    });
    expect(build('cooking', 'images', { sort: 'newest' })).toEqual({
      skip: true,
      reason: 'date_sort'
    });
  });

  it('the subject of a query leaves out the word for the medium', () => {
    expect(parallelVerticals.subjectTerms(parseQuery('Tamil cooking videos'), 'videos')).toEqual([
      'tamil',
      'cooking'
    ]);
    expect(
      parallelVerticals.subjectTerms(parseQuery('best electric car photos'), 'images')
    ).toEqual(['electric', 'car']);
    // On the other tab the same word is part of the subject.
    expect(parallelVerticals.subjectTerms(parseQuery('video camera'), 'images')).toEqual([
      'video',
      'camera'
    ]);
  });
});
