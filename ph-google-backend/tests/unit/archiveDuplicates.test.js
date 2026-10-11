const { config } = require('../../config/env');
const { buildDocumentId } = require('../../services/opensearch/documentMapper');
const { buildSearchBody } = require('../../services/opensearch/queryBuilder');
const { parseQuery } = require('../../services/opensearch/queryParser');

jest.mock('../../services/opensearch/client', () => ({
  getClient: jest.fn(),
  checkHealth: jest.fn(async () => ({ ok: true })),
  describeConnectionError: jest.fn(() => 'unreachable')
}));
const openSearchClient = require('../../services/opensearch/client');
const openSearch = require('../../services/opensearch/searchService');
const searchDispatcher = require('../../services/searchDispatcher');

/**
 * web.archive.org copies, and the News tab's use of the relevance gate —
 * without a cluster. An archived copy is left out only when the page it is a
 * copy of is itself among the matches; whatever else it is, it stays.
 */

const { archivedOriginal, archiveDuplicates } = openSearch;
const ORIGINAL = 'https://www.theatlantic.example/technology/archive/2023/10/big-ai/675752';
const ARCHIVED = `https://web.archive.org/web/20240105020744/${ORIGINAL}`;

describe('archivedOriginal', () => {
  it.each([
    [ARCHIVED, ORIGINAL],
    [`http://web.archive.org/web/20240105020744/${ORIGINAL}`, ORIGINAL],
    // The timestamp may carry a flag, and may be shorter than 14 digits.
    [`https://web.archive.org/web/20240105020744id_/${ORIGINAL}`, ORIGINAL],
    [`https://web.archive.org/web/2024/${ORIGINAL}`, ORIGINAL],
    // The archive also accepts an address without its scheme.
    ['https://web.archive.org/web/20240105020744/example.com/a', 'http://example.com/a'],
    [
      'https://web.archive.org/web/2024/https://example.com/a?x=1&y=2',
      'https://example.com/a?x=1&y=2'
    ]
  ])('%s → %s', (url, expected) => {
    expect(archivedOriginal(url)).toBe(expected);
  });

  it.each([
    ORIGINAL,
    'https://web.archive.org/',
    'https://web.archive.org/about',
    'https://web.archive.org/web/',
    'https://web.archive.org/web/*/example.com',
    'https://archive.org/details/some-book',
    'https://example.com/web/20240105020744/https://other.example/a',
    '',
    null,
    undefined,
    42
  ])('%s is not an archived copy', url => {
    expect(archivedOriginal(url)).toBeNull();
  });
});

describe('archiveDuplicates', () => {
  const copy = (id, url) => ({ _id: id, _source: { url } });
  const matchingAll = async ids => new Set(ids);
  const matchingNone = async () => new Set();

  it('leaves out a copy whose original is among the matches', async () => {
    const asked = [];
    const out = await archiveDuplicates([copy('archived', ARCHIVED)], async ids => {
      asked.push(...ids);
      return new Set(ids);
    });
    expect(out).toEqual(['archived']);
    // The original is looked up by the id the index gives it.
    expect(asked).toEqual([buildDocumentId(ORIGINAL)]);
  });

  it('keeps a copy whose original is not among the matches', async () => {
    expect(await archiveDuplicates([copy('archived', ARCHIVED)], matchingNone)).toEqual([]);
  });

  it('decides each copy on its own original', async () => {
    const other = 'https://web.archive.org/web/2024/https://www.wire.example/chips';
    const out = await archiveDuplicates(
      [copy('a', ARCHIVED), copy('b', other)],
      async ids => new Set(ids.filter(id => id === buildDocumentId(ORIGINAL)))
    );
    expect(out).toEqual(['a']);
  });

  it('leaves out every capture of the same page', async () => {
    const later = `https://web.archive.org/web/20250101000000/${ORIGINAL}`;
    const out = await archiveDuplicates([copy('a', ARCHIVED), copy('b', later)], matchingAll);
    expect(out.sort()).toEqual(['a', 'b']);
  });

  it('asks nothing when no hit is an archived copy', async () => {
    const matching = jest.fn(matchingAll);
    const out = await archiveDuplicates(
      [copy('x', 'https://web.archive.org/about'), copy('y', ORIGINAL), {}, null],
      matching
    );
    expect(out).toEqual([]);
    expect(matching).not.toHaveBeenCalled();
  });
});

describe('the search', () => {
  const hit = (id, extra = {}) => ({
    _id: id,
    _score: 1,
    _source: {
      urlHash: id,
      contentHash: `hash-${id}`,
      wordCount: 100,
      url: `https://x.example/${id}`,
      title: id,
      ...extra
    }
  });

  /** A cluster holding one article and its archived copy. */
  function fakeCluster({ originalMatches = true, archived = true } = {}) {
    const originalId = buildDocumentId(ORIGINAL);
    const docs = [
      hit('archived-copy', { url: ARCHIVED }),
      ...(originalMatches ? [hit(originalId, { url: ORIGINAL })] : [])
    ];
    const requests = [];
    openSearchClient.getClient.mockReturnValue({
      search: jest.fn(async ({ body }) => {
        requests.push(body);
        const bool = body.query.function_score.query.bool;
        const only = (bool.filter.find(f => f.ids) || {}).ids;
        const excluded = ((bool.must_not || []).find(f => f.ids) || { ids: { values: [] } }).ids;
        const hits = docs.filter(
          d => (!only || only.values.includes(d._id)) && !excluded.values.includes(d._id)
        );
        return {
          body: {
            hits: { total: { value: hits.length }, hits },
            aggregations: body.aggs
              ? {
                  duplicates: { groups: { buckets: [] } },
                  ...(body.aggs.aboutMatches
                    ? { aboutMatches: { doc_count: 1 }, fullMatches: { doc_count: 1 } }
                    : {}),
                  ...(body.aggs.archived && archived
                    ? { archived: { copies: { hits: { hits: [docs[0]] } } } }
                    : {})
                }
              : undefined
          }
        };
      })
    });
    return requests;
  }

  it('asks for the archived copies beside the first request only', async () => {
    const requests = fakeCluster({ archived: false });
    await openSearch.search({ query: 'big ai' });
    expect(requests[0].aggs.archived).toEqual({
      filter: { term: { domain: 'web.archive.org' } },
      aggs: { copies: { top_hits: { size: 100, _source: ['url'] } } }
    });
    // No copy among the matches: the ranking and the page fetch, nothing more.
    expect(requests).toHaveLength(2);
    expect(requests[0].query).toEqual(
      buildSearchBody(parseQuery('big ai'), { from: 0, size: 30 }).query
    );
  });

  it('ranks again without the copy when its original matches, and counts from that', async () => {
    const requests = fakeCluster();
    const outcome = await openSearch.search({ query: 'big ai' });
    expect(outcome.results.map(r => r.url)).toEqual([ORIGINAL]);
    expect(outcome.totalResults).toBe(1);
    expect(outcome.reachableResults).toBe(1);
    // ranking, "does the original match?", ranking without the copy, page fetch
    expect(requests).toHaveLength(4);
    const excluded = requests[2].query.function_score.query.bool.must_not;
    expect(excluded).toEqual([{ ids: { values: ['archived-copy'] } }]);
    expect(requests[2].aggs.archived).toBeUndefined();
  });

  it('keeps the copy when its original does not match', async () => {
    const requests = fakeCluster({ originalMatches: false });
    const outcome = await openSearch.search({ query: 'big ai' });
    expect(outcome.results.map(r => r.url)).toEqual([ARCHIVED]);
    expect(outcome.totalResults).toBe(1);
    // ranking, the check, page fetch — no second ranking.
    expect(requests).toHaveLength(3);
    expect(requests.every(r => !r.query.function_score.query.bool.must_not)).toBe(true);
  });

  it('an article search is measured like any other', async () => {
    const requests = fakeCluster({ archived: false });
    const outcome = await openSearch.search({ query: 'big ai', isArticle: true });
    expect(requests[0].aggs.aboutMatches).toBeDefined();
    expect(requests[0].query.function_score.query.bool.filter).toEqual(
      expect.arrayContaining([{ term: { isArticle: true } }])
    );
    expect(outcome.quality).toEqual({ fullMatches: 1, aboutMatches: 1 });
  });
});

describe('newsSearch', () => {
  const originalGate = config.externalSearch.relevanceGate;
  const originalEngine = config.searchEngine;
  let search;

  beforeEach(() => {
    config.searchEngine = 'opensearch';
    search = jest.spyOn(openSearch, 'search').mockResolvedValue({ results: [], totalResults: 0 });
  });
  afterEach(() => {
    config.externalSearch.relevanceGate = originalGate;
    config.searchEngine = originalEngine;
    jest.restoreAllMocks();
  });

  it('asks the engine to be strict when no article is about the query', async () => {
    config.externalSearch.relevanceGate = true;
    await searchDispatcher.newsSearch({
      query: 'top beaches in goa',
      page: 1,
      limit: 10,
      sort: 'relevance'
    });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ isArticle: true, topicalWhenWeak: true, sort: 'newest' })
    );
  });

  it('does not when the relevance gate is off', async () => {
    config.externalSearch.relevanceGate = false;
    await searchDispatcher.newsSearch({
      query: 'top beaches in goa',
      page: 1,
      limit: 10,
      sort: 'relevance'
    });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ isArticle: true, topicalWhenWeak: false })
    );
  });
});
