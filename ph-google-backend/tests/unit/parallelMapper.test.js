const { parseQuery } = require('../../services/opensearch/queryParser');
const {
  mapResult,
  mapResults,
  plainText,
  readDate
} = require('../../services/external/parallelMapper');
const { mapOrganicResult } = require('../../services/external/serpApiMapper');

/**
 * Parallel results in the shape the search page already renders, and the
 * checks that keep a result from contradicting the query it is shown for.
 */

const raw = (overrides = {}) => ({
  url: 'https://www.nasa.gov/gravity?utm_source=x',
  title: '  What Is   Gravity? ',
  publish_date: '2025-03-03',
  excerpts: ['## Gravity\n\nGravity is the **force** that [pulls](https://x.example) objects.'],
  ...overrides
});

describe('parallelMapper — one result', () => {
  it('has exactly the fields a SerpApi result has, so the frontend is unchanged', () => {
    const serp = mapOrganicResult({ link: 'https://a.example', title: 't', snippet: 's' });
    expect(Object.keys(mapResult(raw())).sort()).toEqual(Object.keys(serp).sort());
  });

  it('maps url, title, snippet, date and source', () => {
    const result = mapResult(raw(), 4);
    expect(result).toMatchObject({
      domain: 'www.nasa.gov',
      title: 'What Is Gravity?',
      snippet: 'Gravity Gravity is the force that pulls objects.',
      publishedAt: '2025-03-03T00:00:00.000Z',
      crawledAt: null,
      language: '',
      category: 'Web',
      saved: false,
      score: null,
      source: 'parallel',
      sourceRank: 5
    });
    expect(result.id).toMatch(/^parallel:[0-9a-f]{40}$/);
    expect(result.url).toMatch(/^https:\/\/www\.nasa\.gov\/gravity/);
    expect(result.publishedAgo).toMatch(/ago$/);
  });

  it('gives the same id to every spelling of one page', () => {
    const a = mapResult(raw({ url: 'https://www.nasa.gov/gravity?utm_source=x' }));
    const b = mapResult(raw({ url: 'http://nasa.gov/gravity' }));
    expect(a.id).toBe(b.id);
  });

  it('falls back to the url for a missing title and to a placeholder for no excerpt', () => {
    const result = mapResult(raw({ title: null, excerpts: [] }));
    expect(result.title).toBe(result.url);
    expect(result.snippet).toBe('No description available.');
  });

  it('caps the snippet at 300 characters', () => {
    const result = mapResult(raw({ excerpts: ['word '.repeat(200)] }));
    expect(result.snippet.length).toBeLessThanOrEqual(301);
    expect(result.snippet.endsWith('…')).toBe(true);
  });

  it('skips empty and non-text excerpts to find the snippet', () => {
    expect(mapResult(raw({ excerpts: ['', 42, '   ', 'The real one.'] })).snippet).toBe(
      'The real one.'
    );
  });

  it.each([
    ['no url', { url: undefined }],
    ['a relative url', { url: '/gravity' }],
    ['a javascript: url', { url: 'javascript:alert(1)' }],
    ['a non-string url', { url: 42 }]
  ])('drops a result with %s', (_label, overrides) => {
    expect(mapResult(raw(overrides))).toBeNull();
  });

  it('drops anything that is not an object', () => {
    expect(mapResult(null)).toBeNull();
    expect(mapResult('https://a.example')).toBeNull();
  });
});

describe('parallelMapper — text and dates', () => {
  it('turns markdown into plain text', () => {
    expect(
      plainText(
        '# Title\n\n- item **one**\n- item _two_\n\n![alt](https://i.example/a.png) `code` <b>bold</b> | a | b |'
      )
    ).toBe('Title item one item two alt code bold a b');
  });

  it('removes code fences entirely', () => {
    expect(plainText('before ```js\nconst x = 1;\n``` after')).toBe('before after');
  });

  it.each([
    ['null', null],
    ['not a date', 'last week'],
    ['an impossible date', '2025-13-45'],
    ['a date before the web', '1850-01-01'],
    ['a date in the future', '2999-01-01']
  ])('treats %s as no date', (_label, value) => {
    expect(readDate(value)).toEqual({
      publishedAt: null,
      publishedAgo: 'Unknown',
      dateLabel: null
    });
  });
});

describe('parallelMapper — a list', () => {
  const map = (list, query = 'gravity', filters = {}) =>
    mapResults(list, parseQuery(query), filters);

  it('keeps Parallel order and shows each page once', () => {
    const out = map([
      raw({ url: 'https://a.example/1' }),
      raw({ url: 'https://b.example/2' }),
      raw({ url: 'http://www.a.example/1/' }),
      { title: 'no url' }
    ]);
    expect(out.map(r => r.url)).toEqual(['https://a.example/1', 'https://b.example/2']);
    expect(out.map(r => r.sourceRank)).toEqual([1, 2]);
  });

  it('is an empty list for anything that is not a list', () => {
    expect(map(null)).toEqual([]);
    expect(map({ results: [] })).toEqual([]);
  });

  it('re-checks site: and the domain filter on the address', () => {
    const list = [raw({ url: 'https://science.nasa.gov/a' }), raw({ url: 'https://esa.int/b' })];
    expect(map(list, 'gravity site:nasa.gov').map(r => r.domain)).toEqual(['science.nasa.gov']);
    expect(map(list, 'gravity', { domain: 'esa.int' }).map(r => r.domain)).toEqual(['esa.int']);
    expect(map(list, 'gravity -site:nasa.gov').map(r => r.domain)).toEqual(['esa.int']);
  });

  it('shows a result for a quoted phrase only if the phrase is in its title or excerpts', () => {
    const list = [
      raw({ url: 'https://a.example/1', title: 'General  Relativity explained', excerpts: [] }),
      raw({
        url: 'https://b.example/2',
        title: 'Physics',
        excerpts: ['About **general relativity**.']
      }),
      raw({ url: 'https://c.example/3', title: 'Relativity', excerpts: ['A general overview.'] })
    ];
    expect(map(list, '"general relativity"').map(r => r.url)).toEqual([
      'https://a.example/1',
      'https://b.example/2'
    ]);
  });

  it('with a date filter, keeps only results dated inside the window', () => {
    const list = [
      raw({ url: 'https://a.example/new', publish_date: '2026-06-01' }),
      raw({ url: 'https://b.example/old', publish_date: '2020-01-01' }),
      raw({ url: 'https://c.example/undated', publish_date: null })
    ];
    expect(map(list, 'gravity', { afterDate: '2026-01-01' }).map(r => r.url)).toEqual([
      'https://a.example/new'
    ]);
    // Without a date filter an undated result is fine.
    expect(map(list)).toHaveLength(3);
  });
});
