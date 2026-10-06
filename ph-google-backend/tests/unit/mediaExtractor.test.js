const cheerio = require('cheerio');
const {
  extractVerticalContent,
  extractImages,
  extractVideos,
  extractArticle,
  extractPlaces,
  matchEmbed,
  isContentImage,
  parseIsoDuration,
  wordsFromFilename,
  largestFromSrcset,
  cleanPageTitle,
  absolute
} = require('../../crawler/mediaExtractor');

const BASE = 'https://example.com/articles/guide';
const load = html => cheerio.load(html);

describe('URL resolution', () => {
  it('resolves relative, root-relative and protocol-relative sources', () => {
    expect(absolute('pic.jpg', BASE)).toBe('https://example.com/articles/pic.jpg');
    expect(absolute('/pic.jpg', BASE)).toBe('https://example.com/pic.jpg');
    expect(absolute('//cdn.example.com/pic.jpg', BASE)).toBe('https://cdn.example.com/pic.jpg');
  });

  it('rejects inline and non-web sources', () => {
    expect(absolute('data:image/png;base64,AAAA', BASE)).toBe('');
    expect(absolute('blob:https://x/y', BASE)).toBe('');
    expect(absolute('javascript:void(0)', BASE)).toBe('');
    expect(absolute('', BASE)).toBe('');
  });
});

describe('image extraction', () => {
  it('extracts an image with its alt text and dimensions', () => {
    const images = extractImages(
      load('<img src="/photo.jpg" alt="A red bridge" width="800" height="600">'),
      BASE,
      'Page'
    );
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      url: 'https://example.com/photo.jpg',
      alt: 'A red bridge',
      width: 800,
      height: 600,
      format: 'jpg'
    });
  });

  it('prefers a figcaption as the caption', () => {
    const images = extractImages(
      load(
        '<figure><img src="/p.jpg" width="500" height="400"><figcaption>Sunset over the lake</figcaption></figure>'
      ),
      BASE,
      'Page'
    );
    expect(images[0].caption).toBe('Sunset over the lake');
  });

  it('reads lazy-loaded sources from data attributes', () => {
    const images = extractImages(
      load('<img data-src="/lazy.jpg" alt="Lazy" width="400" height="300">'),
      BASE,
      'Page'
    );
    expect(images[0].url).toBe('https://example.com/lazy.jpg');
  });

  it('picks the largest candidate from a srcset', () => {
    expect(largestFromSrcset('a.jpg 480w, b.jpg 1024w, c.jpg 800w')).toBe('b.jpg');
    expect(largestFromSrcset('')).toBe('');
  });

  it('includes the page og:image', () => {
    const images = extractImages(
      load(
        '<meta property="og:image" content="https://cdn.example.com/hero.jpg"><meta property="og:image:width" content="1200">'
      ),
      BASE,
      'Hero page'
    );
    expect(images.some(i => i.url === 'https://cdn.example.com/hero.jpg')).toBe(true);
  });

  it('de-duplicates the same image seen twice', () => {
    const images = extractImages(
      load(
        '<img src="/same.jpg" width="500" height="400"><img src="/same.jpg" alt="Better" width="500" height="400">'
      ),
      BASE,
      'Page'
    );
    expect(images).toHaveLength(1);
  });

  it('returns nothing for markup with no images', () => {
    expect(extractImages(load('<p>Just text</p>'), BASE, 'Page')).toEqual([]);
  });

  describe('content filtering', () => {
    it('keeps a reasonably sized photograph', () => {
      expect(
        isContentImage({
          url: 'https://x.com/photo.jpg',
          width: 800,
          height: 600,
          sourceType: 'img'
        })
      ).toBe(true);
    });

    it('drops images below the minimum dimension', () => {
      expect(
        isContentImage({ url: 'https://x.com/p.jpg', width: 40, height: 40, sourceType: 'img' })
      ).toBe(false);
    });

    it('drops icons, spacers and tracking pixels by filename', () => {
      for (const url of [
        'https://x.com/icon-home.png',
        'https://x.com/spacer.gif',
        'https://x.com/tracking.gif',
        'https://x.com/sprite.png',
        'https://x.com/avatar.jpg'
      ]) {
        expect(isContentImage({ url, width: null, height: null, sourceType: 'img' })).toBe(false);
      }
    });

    it('drops an SVG with no declared size', () => {
      expect(
        isContentImage({
          url: 'https://x.com/chart.svg',
          width: null,
          height: null,
          sourceType: 'img'
        })
      ).toBe(false);
    });
  });

  it('turns a filename into searchable words', () => {
    expect(wordsFromFilename('https://x.com/a/Sunset-over_the.lake_01.jpg')).toBe(
      'Sunset over the lake 01'
    );
    expect(wordsFromFilename('not a url')).toBe('');
  });
});

describe('video extraction', () => {
  it('extracts a native video with its poster', () => {
    const videos = extractVideos(
      load('<video src="/clip.mp4" poster="/poster.jpg" title="A clip"></video>'),
      BASE,
      'Page'
    );
    expect(videos[0]).toMatchObject({
      url: 'https://example.com/clip.mp4',
      provider: 'native',
      thumbnailUrl: 'https://example.com/poster.jpg',
      format: 'mp4'
    });
  });

  it('extracts a video from a <source> child', () => {
    const videos = extractVideos(
      load('<video><source src="/clip.webm" type="video/webm"></video>'),
      BASE,
      'Page'
    );
    expect(videos[0].url).toBe('https://example.com/clip.webm');
  });

  it('recognises a YouTube embed and builds a thumbnail', () => {
    const videos = extractVideos(
      load('<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Demo"></iframe>'),
      BASE,
      'Page'
    );
    expect(videos[0]).toMatchObject({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      provider: 'youtube',
      providerId: 'dQw4w9WgXcQ',
      thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
    });
  });

  it('recognises Vimeo and Dailymotion', () => {
    expect(matchEmbed('https://vimeo.com/123456789')).toMatchObject({
      provider: 'vimeo',
      providerId: '123456789'
    });
    expect(matchEmbed('https://www.dailymotion.com/video/x8abcd')).toMatchObject({
      provider: 'dailymotion'
    });
  });

  it('normalises every YouTube URL form to one watch URL', () => {
    for (const url of [
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ'
    ]) {
      expect(matchEmbed(url).url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    }
  });

  it('ignores an iframe that is not a video', () => {
    expect(
      extractVideos(load('<iframe src="https://example.com/form"></iframe>'), BASE, 'Page')
    ).toEqual([]);
  });

  it('de-duplicates the same video linked and embedded', () => {
    const videos = extractVideos(
      load(
        '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>' +
          '<a href="https://youtu.be/dQw4w9WgXcQ">Watch</a>'
      ),
      BASE,
      'Page'
    );
    expect(videos).toHaveLength(1);
  });

  it('reads duration from a JSON-LD VideoObject', () => {
    const videos = extractVideos(
      load(`<script type="application/ld+json">
        {"@type":"VideoObject","name":"Tutorial","contentUrl":"https://example.com/v.mp4","duration":"PT1H2M30S"}
      </script>`),
      BASE,
      'Page'
    );
    expect(videos[0]).toMatchObject({ title: 'Tutorial', durationSeconds: 3750 });
  });

  it('parses ISO-8601 durations', () => {
    expect(parseIsoDuration('PT2M30S')).toBe(150);
    expect(parseIsoDuration('PT1H')).toBe(3600);
    expect(parseIsoDuration('nonsense')).toBeNull();
    expect(parseIsoDuration(null)).toBeNull();
  });
});

describe('article detection', () => {
  it('detects og:type=article', () => {
    const a = extractArticle(
      load(
        '<meta property="og:type" content="article"><meta property="og:site_name" content="The Daily">'
      ),
      'https://news.example.com/story',
      'Story'
    );
    expect(a.isArticle).toBe(true);
    expect(a.siteName).toBe('The Daily');
  });

  it('detects a JSON-LD NewsArticle and reads its metadata', () => {
    const a = extractArticle(
      load(`<script type="application/ld+json">
        {"@type":"NewsArticle","datePublished":"2026-01-15T10:00:00Z",
         "author":{"name":"Jane Doe"},"articleSection":"Technology"}
      </script>`),
      'https://news.example.com/story',
      'Story'
    );
    expect(a.isArticle).toBe(true);
    expect(a.author).toBe('Jane Doe');
    expect(a.section).toBe('Technology');
    expect(a.publishedAt.getUTCFullYear()).toBe(2026);
  });

  it('does NOT treat a reference page as news', () => {
    // Wikipedia's shape: og:type=website plus a generic JSON-LD Article.
    const a = extractArticle(
      load(`<meta property="og:type" content="website">
            <script type="application/ld+json">{"@type":"Article","datePublished":"2001-05-20"}</script>`),
      'https://en.wikipedia.org/wiki/Mumbai',
      'Mumbai - Wikipedia'
    );
    expect(a.isArticle).toBe(false);
  });

  it('does not treat a bare date as news', () => {
    const a = extractArticle(
      load('<meta name="date" content="2026-02-01"><p>Just a page with a date.</p>'),
      'https://example.com/page',
      'Page'
    );
    expect(a.isArticle).toBe(false);
    expect(a.publishedAt).toBeTruthy();
  });

  it('rejects an implausible publication date', () => {
    const a = extractArticle(
      load(
        '<meta property="og:type" content="article"><meta property="article:published_time" content="1804-01-01">'
      ),
      'https://example.com/x',
      'X'
    );
    expect(a.publishedAt).toBeNull();
  });

  it('falls back to the hostname for the site name', () => {
    const a = extractArticle(load('<p>No metadata</p>'), 'https://www.example.com/x', 'X');
    expect(a.siteName).toBe('example.com');
  });
});

describe('place extraction', () => {
  it('extracts coordinates from JSON-LD', () => {
    const places = extractPlaces(
      load(`<script type="application/ld+json">
        {"@type":"Place","name":"Central Library",
         "geo":{"latitude":51.5194,"longitude":-0.127},
         "address":{"streetAddress":"10 Main St","addressLocality":"London"}}
      </script>`),
      'https://example.com/lib',
      'Library'
    );
    expect(places[0]).toMatchObject({
      name: 'Central Library',
      latitude: 51.5194,
      longitude: -0.127
    });
    expect(places[0].address).toContain('London');
  });

  it('extracts the .geo microformat', () => {
    const places = extractPlaces(
      load('<span class="geo">48.858222; 2.2945</span>'),
      'https://en.wikipedia.org/wiki/Eiffel_Tower',
      'Eiffel Tower - Wikipedia'
    );
    expect(places[0]).toMatchObject({
      name: 'Eiffel Tower',
      latitude: 48.858222,
      longitude: 2.2945
    });
  });

  it('extracts geo meta tags', () => {
    const places = extractPlaces(
      load(
        '<meta name="geo.position" content="35.6897;139.6922"><meta name="geo.placename" content="Tokyo">'
      ),
      'https://example.com/tokyo',
      'Tokyo'
    );
    expect(places[0]).toMatchObject({ name: 'Tokyo', latitude: 35.6897 });
  });

  it('merges the same place quoted at two precisions, keeping the precise one', () => {
    const places = extractPlaces(
      load(
        '<span class="geo">19.07611; 72.8775</span><span class="latitude">19</span><span class="longitude">72</span>'
      ),
      'https://en.wikipedia.org/wiki/Mumbai',
      'Mumbai - Wikipedia'
    );
    expect(places).toHaveLength(1);
    expect(places[0].latitude).toBe(19.07611);
  });

  it('rejects invalid and null-island coordinates', () => {
    expect(extractPlaces(load('<span class="geo">0; 0</span>'), 'https://x.com', 'X')).toEqual([]);
    expect(extractPlaces(load('<span class="geo">999; 999</span>'), 'https://x.com', 'X')).toEqual(
      []
    );
  });

  it('returns nothing for a page with no geography', () => {
    expect(extractPlaces(load('<p>No coordinates here.</p>'), 'https://x.com', 'X')).toEqual([]);
  });
});

describe('cleanPageTitle', () => {
  it('strips the site suffix publishers append', () => {
    expect(cleanPageTitle('Mumbai - Wikipedia')).toBe('Mumbai');
    expect(cleanPageTitle('Paris | Britannica')).toBe('Paris');
    expect(cleanPageTitle('Tokyo — Travel Guide')).toBe('Tokyo');
  });

  it('leaves a title with no suffix alone', () => {
    expect(cleanPageTitle('Golden Gate Bridge')).toBe('Golden Gate Bridge');
  });
});

describe('extractVerticalContent', () => {
  it('runs every extractor over one document', () => {
    const result = extractVerticalContent(
      `
      <html lang="en">
        <head>
          <title>City Guide</title>
          <meta property="og:type" content="article">
          <meta property="article:published_time" content="2026-03-01T09:00:00Z">
        </head>
        <body>
          <img src="/city.jpg" alt="City skyline" width="900" height="600">
          <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
          <span class="geo">40.7128; -74.0060</span>
        </body>
      </html>`,
      BASE,
      'City Guide'
    );

    expect(result.images).toHaveLength(1);
    expect(result.videos).toHaveLength(1);
    expect(result.places).toHaveLength(1);
    expect(result.article.isArticle).toBe(true);
  });

  it('returns empty results for unusable input', () => {
    const empty = extractVerticalContent('', BASE, '');
    expect(empty.images).toEqual([]);
    expect(empty.videos).toEqual([]);
    expect(empty.places).toEqual([]);
    expect(empty.article.isArticle).toBe(false);
  });
});
