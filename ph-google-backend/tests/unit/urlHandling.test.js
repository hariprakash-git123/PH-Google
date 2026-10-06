const UrlQueue = require('../../crawler/urlQueue');
const {
  extractLinks,
  extractMetadata,
  extractLanguage,
  isSameDomain
} = require('../../crawler/linkExtractor');
const { parseSeedUrl, parseDomain, isValidObjectId } = require('../../utils/validators');

describe('UrlQueue', () => {
  let queue;
  beforeEach(() => {
    queue = new UrlQueue();
  });

  describe('valid URLs', () => {
    it('accepts absolute http and https URLs', () => {
      expect(queue.enqueue('https://example.com/a')).toBe(true);
      expect(queue.enqueue('http://example.com/b')).toBe(true);
      expect(queue.size()).toBe(2);
    });

    it('preserves query strings, which identify distinct pages', () => {
      queue.enqueue('https://example.com/search?q=react');
      expect(queue.dequeue().url).toBe('https://example.com/search?q=react');
    });
  });

  describe('invalid URLs', () => {
    it('rejects a malformed URL', () => {
      expect(queue.enqueue('not a url')).toBe(false);
      expect(queue.enqueue('http://')).toBe(false);
      expect(queue.size()).toBe(0);
    });

    it('rejects non-http(s) schemes', () => {
      expect(queue.enqueue('ftp://example.com/file')).toBe(false);
      expect(queue.enqueue('mailto:a@b.com')).toBe(false);
      expect(queue.enqueue('javascript:alert(1)')).toBe(false);
    });

    it('rejects empty and non-string values', () => {
      expect(queue.enqueue('')).toBe(false);
      expect(queue.enqueue(null)).toBe(false);
      expect(queue.enqueue(undefined)).toBe(false);
      expect(queue.enqueue(42)).toBe(false);
    });

    it('returns null when normalizing an invalid URL', () => {
      expect(queue.normalize('nonsense')).toBeNull();
    });
  });

  describe('duplicate URLs', () => {
    it('enqueues a URL only once', () => {
      expect(queue.enqueue('https://example.com/page')).toBe(true);
      expect(queue.enqueue('https://example.com/page')).toBe(false);
      expect(queue.size()).toBe(1);
    });

    it('treats tracking-parameter and www variants as the same page', () => {
      // The same identity the durable frontier and the OpenSearch id use.
      expect(queue.enqueue('https://example.com/page')).toBe(true);
      expect(queue.enqueue('https://example.com/page?utm_source=news')).toBe(false);
      expect(queue.enqueue('https://www.example.com/page/')).toBe(false);
      expect(queue.hasSeen('http://example.com/page?fbclid=abc')).toBe(true);
      expect(queue.size()).toBe(1);
    });

    it('still treats a meaningful query parameter as a different page', () => {
      expect(queue.enqueue('https://example.com/list?page=1')).toBe(true);
      expect(queue.enqueue('https://example.com/list?page=2')).toBe(true);
    });

    it('treats a fragment-only difference as the same page', () => {
      queue.enqueue('https://example.com/page');
      expect(queue.enqueue('https://example.com/page#section')).toBe(false);
    });

    it('treats a trailing slash as the same page', () => {
      queue.enqueue('https://example.com/about');
      expect(queue.enqueue('https://example.com/about/')).toBe(false);
    });

    it('treats host casing as the same page', () => {
      queue.enqueue('https://Example.COM/page');
      expect(queue.enqueue('https://example.com/page')).toBe(false);
    });

    it('treats a default port as the same page', () => {
      queue.enqueue('https://example.com/page');
      expect(queue.enqueue('https://example.com:443/page')).toBe(false);
    });

    it('treats the bare origin and the root path as the same page', () => {
      queue.enqueue('https://example.com');
      expect(queue.enqueue('https://example.com/')).toBe(false);
      expect(queue.normalize('https://example.com/')).toBe('https://example.com');
    });

    it('reports whether a URL has been seen', () => {
      queue.enqueue('https://example.com/x');
      expect(queue.hasSeen('https://example.com/x/')).toBe(true);
      expect(queue.hasSeen('https://example.com/y')).toBe(false);
    });

    it('does not re-enqueue a URL after it has been dequeued', () => {
      queue.enqueue('https://example.com/x');
      queue.dequeue();
      expect(queue.enqueue('https://example.com/x')).toBe(false);
    });
  });

  describe('queue mechanics', () => {
    it('is FIFO', () => {
      queue.enqueue('https://example.com/1');
      queue.enqueue('https://example.com/2');
      expect(queue.dequeue().url).toBe('https://example.com/1');
      expect(queue.dequeue().url).toBe('https://example.com/2');
    });

    it('tracks depth', () => {
      queue.enqueue('https://example.com/seed', 0);
      queue.enqueue('https://example.com/child', 1);
      expect(queue.dequeue().depth).toBe(0);
      expect(queue.dequeue().depth).toBe(1);
    });

    it('reports emptiness and total discovered', () => {
      expect(queue.isEmpty()).toBe(true);
      queue.enqueue('https://example.com/a');
      queue.enqueue('https://example.com/b');
      queue.dequeue();
      expect(queue.isEmpty()).toBe(false);
      expect(queue.discoveredCount()).toBe(2);
    });

    it('returns undefined when dequeuing an empty queue', () => {
      expect(queue.dequeue()).toBeUndefined();
    });

    it('does not share state between instances', () => {
      const a = new UrlQueue();
      const b = new UrlQueue();
      a.enqueue('https://example.com/shared');
      // A second crawl must be able to visit the same URL again.
      expect(b.enqueue('https://example.com/shared')).toBe(true);
    });
  });
});

describe('link extraction', () => {
  const BASE = 'https://example.com/docs/guide';

  it('resolves a relative URL against the page URL', () => {
    const links = extractLinks('<a href="intro">Intro</a>', BASE);
    expect(links).toContain('https://example.com/docs/intro');
  });

  it('resolves a root-relative URL', () => {
    const links = extractLinks('<a href="/about">About</a>', BASE);
    expect(links).toContain('https://example.com/about');
  });

  it('resolves a protocol-relative URL', () => {
    const links = extractLinks('<a href="//cdn.example.com/x">CDN</a>', BASE);
    expect(links).toContain('https://cdn.example.com/x');
  });

  it('keeps an absolute URL as-is', () => {
    const links = extractLinks('<a href="https://other.org/page">Other</a>', BASE);
    expect(links).toContain('https://other.org/page');
  });

  it('honours a <base href> when present', () => {
    const links = extractLinks(
      '<head><base href="https://cdn.example.com/v2/"></head><a href="x">X</a>',
      BASE
    );
    expect(links).toContain('https://cdn.example.com/v2/x');
  });

  it('de-duplicates repeated links', () => {
    const links = extractLinks('<a href="/a">1</a><a href="/a">2</a><a href="/a/">3</a>', BASE);
    expect(links.filter(l => l === 'https://example.com/a')).toHaveLength(1);
  });

  it('skips fragments, mail, tel and javascript links', () => {
    const links = extractLinks(
      '<a href="#top">Top</a><a href="mailto:a@b.c">Mail</a><a href="tel:+1">Call</a><a href="javascript:void(0)">JS</a>',
      BASE
    );
    expect(links).toHaveLength(0);
  });

  it('skips rel="nofollow" links', () => {
    const links = extractLinks('<a href="/paid" rel="nofollow">Ad</a><a href="/ok">OK</a>', BASE);
    expect(links).toEqual(['https://example.com/ok']);
  });

  it('skips asset URLs that are not HTML pages', () => {
    const links = extractLinks(
      '<a href="/f.pdf">PDF</a><a href="/i.png">Img</a><a href="/s.css">CSS</a><a href="/real">Page</a>',
      BASE
    );
    expect(links).toEqual(['https://example.com/real']);
  });

  it('strips fragments from otherwise valid links', () => {
    const links = extractLinks('<a href="/page#section">Section</a>', BASE);
    expect(links).toEqual(['https://example.com/page']);
  });

  it('returns an empty array for empty input or a missing base', () => {
    expect(extractLinks('', BASE)).toEqual([]);
  });

  it('lists main-content links before navigation links', () => {
    const html = `
      <header><a href="/donate">Donate</a><a href="/about">About</a></header>
      <main><p>Text <a href="/topic-a">A</a> and <a href="/topic-b">B</a>.</p></main>
      <footer><a href="/contact">Contact</a></footer>`;
    expect(extractLinks(html, BASE)).toEqual([
      'https://example.com/topic-a',
      'https://example.com/topic-b',
      'https://example.com/donate',
      'https://example.com/about',
      'https://example.com/contact'
    ]);
  });

  it('keeps document order when a page marks no main content', () => {
    expect(extractLinks('<a href="/1">1</a><a href="/2">2</a>', BASE)).toEqual([
      'https://example.com/1',
      'https://example.com/2'
    ]);
    expect(extractLinks('<a href="/x">X</a>', '')).toEqual([]);
    expect(extractLinks(null, BASE)).toEqual([]);
  });

  it('ignores unparseable hrefs instead of throwing', () => {
    expect(() => extractLinks('<a href="ht!tp://[bad">Bad</a>', BASE)).not.toThrow();
  });
});

describe('metadata extraction', () => {
  it('reads the title, description, keywords and language', () => {
    const meta = extractMetadata(`
      <html lang="en-GB">
        <head>
          <title>  Page Title  </title>
          <meta name="description" content="A description.">
          <meta name="keywords" content="a, b, c">
        </head>
        <body><p>Body</p></body>
      </html>`);

    expect(meta.title).toBe('Page Title');
    expect(meta.description).toBe('A description.');
    expect(meta.keywords).toBe('a, b, c');
    expect(meta.language).toBe('en');
  });

  it('falls back to og:description', () => {
    const meta = extractMetadata(
      '<html><head><meta property="og:description" content="OG text"></head></html>'
    );
    expect(meta.description).toBe('OG text');
  });

  it('falls back to the first substantial paragraph', () => {
    const meta = extractMetadata(
      '<html><body><p>tiny</p><p>This paragraph is long enough to serve as a description fallback.</p></body></html>'
    );
    expect(meta.description).toContain('long enough to serve');
  });

  it('returns blank fields for empty input', () => {
    expect(extractMetadata('')).toEqual({ title: '', description: '', keywords: '', language: '' });
    expect(extractMetadata(null).title).toBe('');
  });

  it('detects the language from meta tags when <html lang> is absent', () => {
    const cheerio = require('cheerio');
    expect(extractLanguage(cheerio.load('<meta property="og:locale" content="fr_FR">'))).toBe('fr');
    expect(extractLanguage(cheerio.load('<html><body></body></html>'))).toBe('');
  });
});

describe('isSameDomain', () => {
  it('matches identical hosts', () => {
    expect(isSameDomain('https://example.com/a', 'https://example.com/b')).toBe(true);
  });

  it('ignores a www prefix', () => {
    expect(isSameDomain('https://www.example.com/a', 'https://example.com/b')).toBe(true);
  });

  it('treats a subdomain as a different host', () => {
    expect(isSameDomain('https://blog.example.com/a', 'https://example.com/b')).toBe(false);
  });

  it('matches across protocols', () => {
    expect(isSameDomain('http://example.com/a', 'https://example.com/b')).toBe(true);
  });

  it('returns false for invalid input', () => {
    expect(isSameDomain('bad', 'https://example.com')).toBe(false);
  });
});

describe('URL validators', () => {
  describe('parseSeedUrl', () => {
    it('accepts an http(s) URL', () => {
      expect(parseSeedUrl('https://example.com')).toBe('https://example.com/');
      expect(parseSeedUrl('https://example.com/docs')).toBe('https://example.com/docs');
    });

    it('rejects a missing or empty value', () => {
      expect(() => parseSeedUrl('')).toThrow(/required/i);
      expect(() => parseSeedUrl(undefined)).toThrow(/required/i);
    });

    it('rejects a relative or malformed URL', () => {
      expect(() => parseSeedUrl('/relative/path')).toThrow(/absolute http/i);
      expect(() => parseSeedUrl('example.com')).toThrow(/absolute http/i);
    });

    it('rejects a non-http scheme', () => {
      expect(() => parseSeedUrl('ftp://example.com')).toThrow(/only http/i);
      expect(() => parseSeedUrl('file:///etc/passwd')).toThrow();
    });
  });

  describe('parseDomain', () => {
    it('accepts a bare domain', () => {
      expect(parseDomain('example.com')).toBe('example.com');
      expect(parseDomain('sub.example.co.uk')).toBe('sub.example.co.uk');
    });

    it('extracts the host from a full URL', () => {
      expect(parseDomain('https://www.example.com/path?q=1')).toBe('example.com');
    });

    it('normalizes case and strips a www prefix', () => {
      expect(parseDomain('WWW.Example.COM')).toBe('example.com');
    });

    it('returns an empty string when no domain is supplied', () => {
      expect(parseDomain('')).toBe('');
      expect(parseDomain(undefined)).toBe('');
    });

    it('rejects a value that is not a domain', () => {
      expect(() => parseDomain('not a domain!')).toThrow(/domain/i);
      expect(() => parseDomain('localhost')).toThrow(/domain/i);
    });
  });

  describe('isValidObjectId', () => {
    it('accepts a 24-character hex string', () => {
      expect(isValidObjectId('6aabc623cb678866868d115e')).toBe(true);
    });

    it('rejects anything else', () => {
      expect(isValidObjectId('abc')).toBe(false);
      expect(isValidObjectId('')).toBe(false);
      expect(isValidObjectId(null)).toBe(false);
      // A regex-injection attempt must not be treated as an id.
      expect(isValidObjectId('{"$ne":null}')).toBe(false);
    });
  });
});
