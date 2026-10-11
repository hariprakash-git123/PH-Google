const { parseQuery } = require('../../services/opensearch/queryParser');
const {
  mapOrganicResult,
  mapOrganicResults,
  readDate
} = require('../../services/external/serpApiMapper');
const { buildDocumentId } = require('../../services/opensearch/documentMapper');
const { formatHit } = require('../../services/opensearch/searchService');

/** SerpApi organic results in the schema the search page already renders. */

const raw = (overrides = {}) => ({
  position: 3,
  title: '  Python  Tutorial ',
  link: 'https://www.example.com/python/',
  displayed_link: 'www.example.com › python',
  snippet: 'Learn   python.',
  ...overrides
});

describe('serpApiMapper — one result', () => {
  it('maps every field of the existing result schema', () => {
    const result = mapOrganicResult(raw());
    expect(result).toEqual({
      id: expect.stringMatching(/^serpapi:[0-9a-f]{40}$/),
      url: 'https://www.example.com/python',
      displayUrl: 'example.com/python',
      domain: 'www.example.com',
      favicon: '\u{1F310}',
      title: 'Python Tutorial',
      snippet: 'Learn python.',
      publishedAt: null,
      publishedAgo: 'Unknown',
      dateLabel: null,
      modifiedAt: null,
      modifiedLabel: null,
      crawledAt: null,
      language: '',
      category: 'Google Web',
      saved: false,
      score: null,
      source: 'serpapi',
      sourceRank: 3
    });
  });

  it('has every field an index result has', () => {
    const indexResult = formatHit(
      { _id: 'x', _score: 1, _source: { url: 'https://a.example/x', title: 'X' } },
      { includeDebug: false }
    );
    const external = mapOrganicResult(raw());
    for (const field of Object.keys(indexResult)) expect(external).toHaveProperty(field);
  });

  it('uses the index document id hash, so the same page has the same key', () => {
    const result = mapOrganicResult(raw({ link: 'http://example.com/page/?utm_source=x' }));
    expect(result.id).toBe(`serpapi:${buildDocumentId('https://www.example.com/page')}`);
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<b>x</b>'],
    ['ftp:', 'ftp://example.com/file'],
    ['relative', '/just/a/path'],
    ['missing', undefined]
  ])('drops a %s link', (_label, link) => {
    expect(mapOrganicResult(raw({ link }))).toBeNull();
  });

  it('falls back to the URL for a missing title and a placeholder for a missing snippet', () => {
    const result = mapOrganicResult(raw({ title: '', snippet: undefined }));
    expect(result.title).toBe('https://www.example.com/python');
    expect(result.snippet).toBe('No description available.');
  });

  it('caps a long snippet like the index does', () => {
    const result = mapOrganicResult(raw({ snippet: 'word '.repeat(200) }));
    expect(result.snippet.length).toBeLessThanOrEqual(301);
    expect(result.snippet.endsWith('…')).toBe(true);
  });

  it('uses the list position when SerpApi gives none', () => {
    expect(mapOrganicResult(raw({ position: undefined }), 4).sourceRank).toBe(5);
  });
});

describe('serpApiMapper — dates', () => {
  it('reads a calendar date as publishedAt', () => {
    const { publishedAt, publishedAgo } = readDate('Mar 3, 2025');
    expect(publishedAt).toBe(new Date('Mar 3, 2025').toISOString());
    expect(publishedAgo).toMatch(/ago$/);
  });

  it('shows relative wording as written, with no invented date', () => {
    expect(readDate('3 days ago')).toEqual({
      publishedAt: null,
      publishedAgo: '3 days ago',
      dateLabel: { kind: 'published', at: null, text: 'Published 3 days ago' }
    });
  });

  it('ignores anything else', () => {
    expect(readDate('sometime')).toEqual({
      publishedAt: null,
      publishedAgo: 'Unknown',
      dateLabel: null
    });
    expect(readDate(undefined)).toEqual({
      publishedAt: null,
      publishedAgo: 'Unknown',
      dateLabel: null
    });
    expect(readDate('Jan 1, 2999').publishedAt).toBeNull();
  });
});

describe('serpApiMapper — the list', () => {
  const list = links => links.map((link, i) => raw({ link, position: i + 1 }));

  it('keeps Google order and drops repeats of the same page', () => {
    const results = mapOrganicResults(
      list([
        'https://example.com/a',
        'https://www.example.com/a/',
        'https://example.com/b',
        'http://example.com/a?utm_source=news'
      ]),
      parseQuery('python')
    );
    expect(results.map(r => r.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
  });

  it('enforces site:, -site:, inurl: and the domain filter on the address', () => {
    const links = list([
      'https://docs.python.org/3/tutorial',
      'https://python.org/about',
      'https://pinterest.com/python',
      'https://other.example/python'
    ]);
    expect(
      mapOrganicResults(links, parseQuery('tutorial site:python.org')).map(r => r.domain)
    ).toEqual(['docs.python.org', 'python.org']);
    expect(mapOrganicResults(links, parseQuery('python -site:pinterest.com'))).toHaveLength(3);
    expect(mapOrganicResults(links, parseQuery('inurl:tutorial'))).toHaveLength(1);
    expect(
      mapOrganicResults(links, parseQuery('python'), { domain: 'other.example' }).map(r => r.domain)
    ).toEqual(['other.example']);
  });

  it('survives junk', () => {
    expect(mapOrganicResults(null, parseQuery('x'))).toEqual([]);
    expect(mapOrganicResults([null, 7, 'x', {}], parseQuery('x'))).toEqual([]);
  });
});
