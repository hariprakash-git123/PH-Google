const {
  readRobotsDirectives,
  extractCanonical,
  botToken
} = require('../../crawler/pageDirectives');

/**
 * What a page says about itself: meta robots, X-Robots-Tag and the canonical
 * link. Pure parsing — no network, no database.
 */

const page = head => `<!DOCTYPE html><html><head>${head}</head><body><p>Body</p></body></html>`;

describe('botToken', () => {
  it('is the product name of the user agent, lowercased', () => {
    expect(botToken('PH-SearchBot/1.0 (+https://example.org/bot)')).toBe('ph-searchbot');
    expect(botToken()).toBe('ph-searchbot');
  });
});

describe('readRobotsDirectives', () => {
  it('allows indexing and following when the page says nothing', () => {
    expect(readRobotsDirectives(page('<title>T</title>'))).toEqual({ index: true, follow: true });
    expect(readRobotsDirectives('', {})).toEqual({ index: true, follow: true });
  });

  it('reads noindex without touching follow', () => {
    const html = page('<meta name="robots" content="noindex">');
    expect(readRobotsDirectives(html)).toEqual({ index: false, follow: true });
  });

  it('reads nofollow without touching index', () => {
    const html = page('<meta name="robots" content="nofollow">');
    expect(readRobotsDirectives(html)).toEqual({ index: true, follow: false });
  });

  it('reads both from one tag, whatever the case and spacing', () => {
    const html = page('<meta name="ROBOTS" content=" NoIndex ,NOFOLLOW ">');
    expect(readRobotsDirectives(html)).toEqual({ index: false, follow: false });
  });

  it('treats none as noindex and nofollow', () => {
    const html = page('<meta name="robots" content="none">');
    expect(readRobotsDirectives(html)).toEqual({ index: false, follow: false });
  });

  it('ignores directives that are not about indexing or following', () => {
    const html = page('<meta name="robots" content="index, follow, noarchive, max-snippet:20">');
    expect(readRobotsDirectives(html)).toEqual({ index: true, follow: true });
  });

  it('obeys a tag addressed to this crawler by name', () => {
    const html = page('<meta name="PH-SearchBot" content="noindex">');
    expect(readRobotsDirectives(html)).toEqual({ index: false, follow: true });
  });

  it('ignores a tag addressed to another crawler', () => {
    const html = page('<meta name="googlebot" content="noindex, nofollow">');
    expect(readRobotsDirectives(html)).toEqual({ index: true, follow: true });
  });

  it('takes the most restrictive answer across several tags', () => {
    const html = page(
      '<meta name="robots" content="index, follow"><meta name="robots" content="noindex">'
    );
    expect(readRobotsDirectives(html)).toEqual({ index: false, follow: true });
  });

  it('reads the X-Robots-Tag header', () => {
    expect(readRobotsDirectives(page(''), { 'x-robots-tag': 'noindex' })).toEqual({
      index: false,
      follow: true
    });
    expect(readRobotsDirectives(page(''), { 'x-robots-tag': 'noindex, nofollow' })).toEqual({
      index: false,
      follow: false
    });
  });

  it('obeys a header addressed to this crawler and ignores one for another', () => {
    expect(readRobotsDirectives(page(''), { 'x-robots-tag': 'ph-searchbot: noindex' })).toEqual({
      index: false,
      follow: true
    });
    expect(
      readRobotsDirectives(page(''), { 'x-robots-tag': 'googlebot: noindex, nofollow' })
    ).toEqual({ index: true, follow: true });
  });

  it('reads several X-Robots-Tag headers, each on its own', () => {
    const headers = { 'x-robots-tag': ['googlebot: noindex', 'nofollow'] };
    expect(readRobotsDirectives(page(''), headers)).toEqual({ index: true, follow: false });
  });

  it('does not mistake unavailable_after for a crawler name', () => {
    const headers = { 'x-robots-tag': 'unavailable_after: 25 Jun 2030 15:00:00 PST, noindex' };
    expect(readRobotsDirectives(page(''), headers)).toEqual({ index: false, follow: true });
  });

  it('combines the header with the markup', () => {
    const html = page('<meta name="robots" content="nofollow">');
    expect(readRobotsDirectives(html, { 'x-robots-tag': 'noindex' })).toEqual({
      index: false,
      follow: false
    });
  });
});

describe('extractCanonical', () => {
  const pageUrl = 'https://example.com/shop/item?ref=home';

  it('returns null when the page declares none', () => {
    expect(extractCanonical(page('<title>T</title>'), pageUrl)).toBeNull();
    expect(extractCanonical('', pageUrl)).toBeNull();
  });

  it('reads an absolute canonical', () => {
    const html = page('<link rel="canonical" href="https://example.com/shop/item">');
    expect(extractCanonical(html, pageUrl)).toBe('https://example.com/shop/item');
  });

  it('resolves a relative canonical against the page URL', () => {
    expect(extractCanonical(page('<link rel="canonical" href="other">'), pageUrl)).toBe(
      'https://example.com/shop/other'
    );
    expect(extractCanonical(page('<link rel="canonical" href="/top">'), pageUrl)).toBe(
      'https://example.com/top'
    );
  });

  it('resolves against <base href> when the page has one', () => {
    const html = page('<base href="https://example.com/base/"><link rel="canonical" href="x">');
    expect(extractCanonical(html, pageUrl)).toBe('https://example.com/base/x');
  });

  it('normalises the canonical', () => {
    const html = page('<link rel="canonical" href="HTTPS://EXAMPLE.com:443/shop/item/#top">');
    expect(extractCanonical(html, pageUrl)).toBe('https://example.com/shop/item');
  });

  it('counts the same canonical given twice as one', () => {
    const html = page(
      '<link rel="canonical" href="https://example.com/a">' +
        '<link rel="canonical" href="https://www.example.com/a/">'
    );
    expect(extractCanonical(html, pageUrl)).toBe('https://example.com/a');
  });

  it('ignores canonical tags that disagree', () => {
    const html = page(
      '<link rel="canonical" href="https://example.com/a">' +
        '<link rel="canonical" href="https://example.com/b">'
    );
    expect(extractCanonical(html, pageUrl)).toBeNull();
  });

  it('ignores a malformed canonical', () => {
    expect(extractCanonical(page('<link rel="canonical" href="http://[bad">'), pageUrl)).toBeNull();
    expect(extractCanonical(page('<link rel="canonical" href="">'), pageUrl)).toBeNull();
    expect(
      extractCanonical(page('<link rel="canonical" href="javascript:void(0)">'), pageUrl)
    ).toBeNull();
    expect(
      extractCanonical(page('<link rel="canonical" href="mailto:a@example.com">'), pageUrl)
    ).toBeNull();
  });

  it('keeps a usable canonical when another one is malformed', () => {
    const html = page(
      '<link rel="canonical" href="http://[bad"><link rel="canonical" href="/good">'
    );
    expect(extractCanonical(html, pageUrl)).toBe('https://example.com/good');
  });

  it('accepts rel values that list canonical among others', () => {
    const html = page('<link rel="Canonical alternate" href="/a">');
    expect(extractCanonical(html, pageUrl)).toBe('https://example.com/a');
  });

  it('ignores other link relations', () => {
    const html = page('<link rel="stylesheet" href="/s.css"><link rel="alternate" href="/feed">');
    expect(extractCanonical(html, pageUrl)).toBeNull();
  });

  it("reads a canonical on another host as written — scope is the caller's decision", () => {
    const html = page('<link rel="canonical" href="https://elsewhere.test/item">');
    expect(extractCanonical(html, pageUrl)).toBe('https://elsewhere.test/item');
  });

  it('reads the Link response header', () => {
    const headers = { link: '<https://example.com/doc>; rel="canonical"' };
    expect(extractCanonical(page(''), pageUrl, headers)).toBe('https://example.com/doc');
  });

  it('picks the canonical out of a Link header with several relations', () => {
    const headers = {
      link: '</style.css>; rel=preload; as=style, </doc>; rel="canonical", </next>; rel="next"'
    };
    expect(extractCanonical(page(''), pageUrl, headers)).toBe('https://example.com/doc');
  });

  it('ignores the header and the markup when they disagree', () => {
    const html = page('<link rel="canonical" href="/a">');
    const headers = { link: '</b>; rel="canonical"' };
    expect(extractCanonical(html, pageUrl, headers)).toBeNull();
  });
});
