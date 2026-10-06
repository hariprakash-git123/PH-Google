const { parseSitemap, parseLastmod } = require('../../crawler/sitemapParser');

/**
 * The sitemap parser, on documents built in memory. No network, no database.
 */

const NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

const urlset = (inner, attrs = `xmlns="${NS}"`) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset ${attrs}>${inner}</urlset>`;
const url = (loc, lastmod) =>
  `<url><loc>${loc}</loc>${lastmod !== undefined ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
const locs = result => result.entries.map(e => e.loc);

describe('urlset', () => {
  it('reads every <url>/<loc> in order', () => {
    const result = parseSitemap(urlset(url('https://a.test/1') + url('https://a.test/2')));

    expect(result.type).toBe('urlset');
    expect(locs(result)).toEqual(['https://a.test/1', 'https://a.test/2']);
    expect(result).toMatchObject({ capped: false, truncated: false, rejected: 0 });
  });

  it('reads <lastmod> as a Date', () => {
    const result = parseSitemap(
      urlset(
        url('https://a.test/1', '2026-09-01') + url('https://a.test/2', '2026-09-02T10:30:00Z')
      )
    );

    expect(result.entries[0].lastmod.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(result.entries[1].lastmod.toISOString()).toBe('2026-09-02T10:30:00.000Z');
  });

  it('leaves lastmod null when it is missing', () => {
    expect(parseSitemap(urlset(url('https://a.test/1'))).entries[0].lastmod).toBeNull();
  });

  it('ignores an invalid lastmod but keeps the URL', () => {
    const result = parseSitemap(
      urlset(
        url('https://a.test/1', 'yesterday') +
          url('https://a.test/2', '2026-13-45') +
          url('https://a.test/3', '01/09/2026') +
          url('https://a.test/4', '2999-01-01')
      )
    );

    expect(locs(result)).toHaveLength(4);
    expect(result.entries.every(e => e.lastmod === null)).toBe(true);
  });

  it('trims whitespace around a loc', () => {
    const result = parseSitemap(urlset('<url><loc>\n    https://a.test/page  \t\n</loc></url>'));
    expect(locs(result)).toEqual(['https://a.test/page']);
  });

  it('decodes &amp; in a loc', () => {
    const result = parseSitemap(urlset(url('https://a.test/p?a=1&amp;b=2')));
    expect(locs(result)).toEqual(['https://a.test/p?a=1&b=2']);
  });

  it('reads a document with a byte-order mark, as a string or as bytes', () => {
    const doc = String.fromCharCode(0xfeff) + urlset(url('https://a.test/bom'));
    const bytes = Buffer.from(doc, 'utf8');
    // The input really does start with a BOM, as characters and as bytes.
    expect(doc.charCodeAt(0)).toBe(0xfeff);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    expect(locs(parseSitemap(doc))).toEqual(['https://a.test/bom']);
    expect(locs(parseSitemap(bytes))).toEqual(['https://a.test/bom']);
  });

  it('rejects an empty loc and a loc over 2,048 characters', () => {
    const result = parseSitemap(
      urlset(url('') + url(`https://a.test/${'x'.repeat(2100)}`) + url('https://a.test/ok'))
    );
    expect(locs(result)).toEqual(['https://a.test/ok']);
    expect(result.rejected).toBe(2);
  });
});

describe('sitemapindex', () => {
  it('reads every <sitemap>/<loc> and its lastmod', () => {
    const result = parseSitemap(
      `<sitemapindex xmlns="${NS}">` +
        '<sitemap><loc>https://a.test/s1.xml</loc><lastmod>2026-09-01</lastmod></sitemap>' +
        '<sitemap><loc>https://a.test/s2.xml.gz</loc></sitemap>' +
        '</sitemapindex>'
    );

    expect(result.type).toBe('sitemapindex');
    expect(locs(result)).toEqual(['https://a.test/s1.xml', 'https://a.test/s2.xml.gz']);
    expect(result.entries[0].lastmod).toBeInstanceOf(Date);
  });

  it('does not read <url> entries inside an index, or <sitemap> entries inside a urlset', () => {
    const index = parseSitemap(
      `<sitemapindex xmlns="${NS}"><url><loc>https://a.test/page</loc></url></sitemapindex>`
    );
    const set = parseSitemap(urlset('<sitemap><loc>https://a.test/s.xml</loc></sitemap>'));
    expect(index.entries).toEqual([]);
    expect(set.entries).toEqual([]);
  });
});

describe('namespaces', () => {
  it('reads a prefixed sitemap namespace', () => {
    const result = parseSitemap(
      `<sm:urlset xmlns:sm="${NS}"><sm:url><sm:loc>https://a.test/p</sm:loc></sm:url></sm:urlset>`
    );
    expect(result.type).toBe('urlset');
    expect(locs(result)).toEqual(['https://a.test/p']);
  });

  it('reads an unprefixed sitemap with no namespace, and the https namespace', () => {
    expect(locs(parseSitemap(urlset(url('https://a.test/p'), '')))).toEqual(['https://a.test/p']);
    expect(
      locs(
        parseSitemap(urlset(url('https://a.test/p'), `xmlns="${NS.replace('http:', 'https:')}"`))
      )
    ).toEqual(['https://a.test/p']);
  });

  it('reads only the page URL from image, video and news extensions', () => {
    const result = parseSitemap(
      urlset(
        '<url><loc>https://a.test/article</loc>' +
          '<image:image><image:loc>https://cdn.test/photo.jpg</image:loc></image:image>' +
          '<video:video><video:content_loc>https://cdn.test/v.mp4</video:content_loc></video:video>' +
          '<news:news><news:title>Headline</news:title></news:news>' +
          '<image:loc>https://cdn.test/stray.jpg</image:loc>' +
          '</url>',
        `xmlns="${NS}" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" ` +
          'xmlns:video="http://www.google.com/schemas/sitemap-video/1.1" ' +
          'xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"'
      )
    );
    expect(locs(result)).toEqual(['https://a.test/article']);
  });

  it('does not treat a root in a foreign namespace as a sitemap', () => {
    const result = parseSitemap(
      '<x:urlset xmlns:x="http://example.com/other"><x:url><x:loc>https://a.test/p</x:loc></x:url></x:urlset>'
    );
    expect(result.type).toBeNull();
    expect(result.entries).toEqual([]);
  });
});

describe('limits', () => {
  it('stops at the per-file URL cap', () => {
    const many = Array.from({ length: 50 }, (_, i) => url(`https://a.test/${i}`)).join('');
    const result = parseSitemap(urlset(many), { maxUrls: 10 });

    expect(result.entries).toHaveLength(10);
    expect(locs(result)[9]).toBe('https://a.test/9');
    expect(result.capped).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('uses CRAWLER_SITEMAP_MAX_URLS_PER_FILE by default', () => {
    const { config } = require('../../config/env');
    const saved = config.crawler.sitemapMaxUrlsPerFile;
    config.crawler.sitemapMaxUrlsPerFile = 3;
    try {
      const many = Array.from({ length: 8 }, (_, i) => url(`https://a.test/${i}`)).join('');
      expect(parseSitemap(urlset(many)).entries).toHaveLength(3);
    } finally {
      config.crawler.sitemapMaxUrlsPerFile = saved;
    }
  });

  it('stops reading a large document early rather than parsing all of it', () => {
    // 200,000 entries — several megabytes — but only the first 5 are wanted.
    const huge = urlset(
      Array.from({ length: 200000 }, (_, i) => url(`https://a.test/${i}`)).join('')
    );
    const started = Date.now();
    const result = parseSitemap(huge, { maxUrls: 5 });

    expect(result.entries).toHaveLength(5);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('broken documents', () => {
  it('keeps the complete entries of malformed XML and drops the broken one', () => {
    const result = parseSitemap(
      urlset(
        url('https://a.test/ok1') +
          '<url><loc>https://a.test/unclosed-lastmod</loc><lastmod>2026-09-01</url>' +
          '<url><loc>https://a.test/ok2</loc></url>'
      )
    );
    expect(locs(result)).toContain('https://a.test/ok1');
    expect(locs(result)).toContain('https://a.test/ok2');
  });

  it('drops an entry cut off by a truncated document and reports the truncation', () => {
    const result = parseSitemap(
      `<urlset xmlns="${NS}"><url><loc>https://a.test/complete</loc></url><url><loc>https://a.test/cut-o`
    );
    expect(locs(result)).toEqual(['https://a.test/complete']);
    expect(result.truncated).toBe(true);
  });

  it('returns nothing for an HTML page served in place of a sitemap', () => {
    const result = parseSitemap(
      '<!DOCTYPE html><html><head><title>Not found</title></head><body><a href="https://a.test/x"><loc>https://a.test/y</loc></a></body></html>'
    );
    expect(result).toMatchObject({ type: null, entries: [] });
  });

  it('returns nothing for plain text, empty input or garbage', () => {
    for (const input of ['https://a.test/1\nhttps://a.test/2', '', null, undefined, '<<<>>>&&&']) {
      expect(parseSitemap(input)).toMatchObject({ type: null, entries: [] });
    }
  });
});

describe('entity and XXE safety', () => {
  it('does not expand a nested-entity bomb', () => {
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE lolz [' +
      '<!ENTITY lol "lol">' +
      '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">' +
      '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">' +
      `]><urlset xmlns="${NS}"><url><loc>https://a.test/&lol3;</loc></url>` +
      '<url><loc>https://a.test/fine</loc></url></urlset>';

    const result = parseSitemap(bomb);

    expect(locs(result)).toEqual(['https://a.test/fine']);
    expect(result.rejected).toBe(1);
    expect(JSON.stringify(result)).not.toContain('lollol');
  });

  it('does not resolve an external entity', () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE urlset [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
      `<urlset xmlns="${NS}"><url><loc>&xxe;</loc></url><url><loc>https://a.test/fine</loc></url></urlset>`;

    const result = parseSitemap(xxe);

    expect(locs(result)).toEqual(['https://a.test/fine']);
    expect(result.rejected).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/root:|passwd/);
  });
});

describe('parseLastmod', () => {
  it('accepts every W3C Datetime precision', () => {
    for (const value of [
      '2026',
      '2026-09',
      '2026-09-01',
      '2026-09-01T10:30+02:00',
      '2026-09-01T10:30:15.5Z'
    ]) {
      expect(parseLastmod(value)).toBeInstanceOf(Date);
    }
  });

  it('rejects a date more than a day in the future', () => {
    const now = Date.parse('2026-09-30T00:00:00Z');
    expect(parseLastmod('2026-09-30T12:00:00Z', now)).toBeInstanceOf(Date);
    expect(parseLastmod('2026-10-05', now)).toBeNull();
  });
});
