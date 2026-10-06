const { isInScope, filterLinks, isOnDomain, compilePattern } = require('../../crawler/crawlScope');

/**
 * Where a crawl may go. These rules are what stop one seed from wandering
 * across the whole web, so each one is pinned down here.
 */

describe('isOnDomain', () => {
  it('matches the domain itself and its subdomains', () => {
    expect(isOnDomain('https://example.com/a', 'example.com')).toBe(true);
    expect(isOnDomain('https://docs.example.com/a', 'example.com')).toBe(true);
  });

  it('ignores a leading www. on either side', () => {
    expect(isOnDomain('https://www.example.com/a', 'example.com')).toBe(true);
    expect(isOnDomain('https://example.com/a', 'www.example.com')).toBe(true);
  });

  it('does not match a lookalike domain', () => {
    expect(isOnDomain('https://notexample.com/a', 'example.com')).toBe(false);
    expect(isOnDomain('https://example.com.evil.org/a', 'example.com')).toBe(false);
  });

  it('keeps sibling language subdomains apart', () => {
    expect(isOnDomain('https://de.wikipedia.org/wiki/X', 'en.wikipedia.org')).toBe(false);
    expect(isOnDomain('https://en.m.wikipedia.org/wiki/X', 'en.wikipedia.org')).toBe(false);
  });

  it('rejects an unparseable URL', () => {
    expect(isOnDomain('not a url', 'example.com')).toBe(false);
  });
});

describe('isInScope', () => {
  const seedUrl = 'https://example.com/start';

  it('stays on the seed host by default', () => {
    expect(isInScope('https://example.com/other', { seedUrl })).toBe(true);
    expect(isInScope('https://elsewhere.org/page', { seedUrl })).toBe(false);
  });

  it('allows any host only when sameDomainOnly is explicitly false', () => {
    expect(isInScope('https://elsewhere.org/page', { seedUrl, sameDomainOnly: false })).toBe(true);
  });

  it('uses allowedDomains as the whole domain policy when set', () => {
    const scope = { seedUrl, allowedDomains: ['partner.org'] };
    expect(isInScope('https://partner.org/x', scope)).toBe(true);
    // The seed host is not implicitly allowed once a list is given.
    expect(isInScope('https://example.com/x', scope)).toBe(false);
    expect(isInScope('https://random.net/x', scope)).toBe(false);
  });

  it('allowedDomains wins even when sameDomainOnly is false', () => {
    const scope = { seedUrl, sameDomainOnly: false, allowedDomains: ['example.com'] };
    expect(isInScope('https://random.net/x', scope)).toBe(false);
  });

  it('drops links matching an exclude pattern', () => {
    const scope = { seedUrl, excludePatterns: ['/wiki/Talk:', '[?&]action='] };
    expect(isInScope('https://example.com/wiki/Talk:Physics', scope)).toBe(false);
    expect(isInScope('https://example.com/w?title=X&action=edit', scope)).toBe(false);
    expect(isInScope('https://example.com/wiki/Physics', scope)).toBe(true);
  });

  it('matches exclude patterns case-insensitively', () => {
    expect(isInScope('https://example.com/LOGIN', { seedUrl, excludePatterns: ['/login'] })).toBe(
      false
    );
  });
});

describe('filterLinks', () => {
  const scope = { seedUrl: 'https://example.com/' };

  it('keeps in-scope links in document order', () => {
    const links = ['https://example.com/a', 'https://other.org/b', 'https://example.com/c'];
    expect(filterLinks(links, scope, { maxLinks: 10 })).toEqual([
      'https://example.com/a',
      'https://example.com/c'
    ]);
  });

  it('caps how many links one page may contribute', () => {
    const links = Array.from({ length: 50 }, (_, i) => `https://example.com/p${i}`);
    const kept = filterLinks(links, scope, { maxLinks: 5 });
    expect(kept).toHaveLength(5);
    expect(kept[0]).toBe('https://example.com/p0');
  });

  it('counts only in-scope links against the cap', () => {
    const links = ['https://other.org/1', 'https://other.org/2', 'https://example.com/a'];
    expect(filterLinks(links, scope, { maxLinks: 1 })).toEqual(['https://example.com/a']);
  });

  it('handles a missing link list', () => {
    expect(filterLinks(undefined, scope)).toEqual([]);
  });
});

describe('compilePattern', () => {
  it('reports an invalid pattern clearly', () => {
    expect(() => compilePattern('([unclosed')).toThrow(/Invalid exclude pattern/);
  });
});
