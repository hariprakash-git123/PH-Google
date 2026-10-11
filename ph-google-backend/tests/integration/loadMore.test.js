const request = require('supertest');
const testDb = require('../helpers/testDb');
const { seedManyPages } = require('../helpers/factories');
const { config } = require('../../config/env');
const externalSearch = require('../../services/externalSearch');
const parallelClient = require('../../services/external/parallelClient');
const videoPlatforms = require('../../services/external/videoPlatforms');
const serpApiClient = require('../../services/external/serpApiClient');
const { ExternalSearchError } = require('../../services/external/externalSearchError');
const { encodeCursor } = require('../../utils/searchCursor');
const logger = require('../../utils/logger');

/**
 * GET /api/search with "Load more": the first page as before, then batches
 * from a cursor until the sources run out. Both sources continue — the index
 * from its offset, the external answer from the results already shown — and
 * nothing appears twice or is made up. Providers are mocked: no quota is used.
 */

const original = {
  parallel: { ...config.parallel },
  serpapi: { ...config.serpapi },
  externalSearch: { ...config.externalSearch }
};
let app;
let parallelSearch;

const external = (n, host = 'parallel.example') =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://${host}/load-more-${i + 1}`,
    title: `External ${i + 1}`,
    publish_date: null,
    excerpts: [`External result ${i + 1}.`]
  }));

beforeAll(async () => {
  await testDb.connect();
  app = require('../../app').createApp();
});
afterAll(async () => {
  Object.assign(config.parallel, original.parallel);
  Object.assign(config.serpapi, original.serpapi);
  Object.assign(config.externalSearch, original.externalSearch);
  await testDb.disconnect();
});
beforeEach(async () => {
  await testDb.clear();
  externalSearch.reset();
  Object.assign(config.externalSearch, original.externalSearch, {
    provider: 'parallel',
    fallback: false
  });
  Object.assign(config.parallel, original.parallel, {
    enabled: true,
    verticals: false,
    apiKey: 'load-more-test-key-NOT-REAL',
    mode: 'fast',
    maxResults: 10,
    dailyLimit: 0,
    cacheTtlMs: 60000
  });
  Object.assign(config.serpapi, original.serpapi, { enabled: false, minInternalResults: 0 });
  parallelSearch = jest
    .spyOn(parallelClient, 'search')
    .mockResolvedValue({ results: external(15) });
  jest
    .spyOn(serpApiClient, 'searchEngine')
    .mockRejectedValue(new Error('SerpApi must not be asked'));
  jest
    .spyOn(serpApiClient, 'searchGoogle')
    .mockRejectedValue(new Error('SerpApi must not be asked'));
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const search = params => request(app).get('/api/search').query(params);
const urls = res => res.body.data.results.map(r => r.url);

/** Every batch of a search, following the cursor to the end (bounded). */
async function everyBatch(params) {
  const batches = [(await search(params)).body.data];
  for (let i = 0; i < 20 && batches[batches.length - 1].hasMore; i += 1) {
    const { nextCursor } = batches[batches.length - 1];
    // Load more asks for the default batch, as the browser does.
    const { limit: _firstPageSize, ...rest } = params;
    batches.push((await search({ ...rest, cursor: nextCursor })).body.data);
  }
  return batches;
}

describe('All tab', () => {
  beforeEach(() => seedManyPages(25, { keyword: 'loadmore' }));

  it('the first page is as it was, and says there is more', async () => {
    const res = await search({ q: 'loadmore' });
    expect(res.status).toBe(200);
    const { data } = res.body;
    // Ten of each source, ranked as one list.
    expect(data.results.filter(r => r.source === 'index')).toHaveLength(10);
    expect(data.results.filter(r => r.source === 'parallel')).toHaveLength(10);
    expect(data.external).toMatchObject({ placement: 'ranked' });
    expect(data.pagination).toMatchObject({ page: 1, limit: 10, totalResults: 25, totalPages: 3 });
    expect(data.total).toBe(35);
    expect(data.hasMore).toBe(true);
    expect(typeof data.nextCursor).toBe('string');
  });

  it('Load more continues both sources: the provider’s next results and the index’s, ranked together', async () => {
    const first = (await search({ q: 'loadmore' })).body.data;
    const res = await search({ q: 'loadmore', cursor: first.nextCursor });
    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data.results).toHaveLength(10);
    // Half from the provider's answer while it has results left; the index fills the rest,
    // continuing exactly where the first page stopped.
    const fromIndex = data.results.filter(r => r.source === 'index');
    const fromProvider = data.results.filter(r => r.source === 'parallel');
    expect(fromProvider.map(r => r.url)).toEqual(
      external(15)
        .slice(10)
        .map(r => r.url)
    );
    expect(fromIndex.map(r => r.sourceRank).sort((a, b) => a - b)).toEqual([11, 12, 13, 14, 15]);
    // The index's next results are the same ones the numbered pages give.
    const page2 = (await search({ q: 'loadmore', page: 2 })).body.data;
    expect(fromIndex.map(r => r.url).sort()).toEqual(
      page2.results
        .filter(r => r.source === 'index')
        .slice(0, 5)
        .map(r => r.url)
        .sort()
    );
    // Nothing shown before is shown again.
    expect(urls(res).some(url => urls({ body: { data: first } }).includes(url))).toBe(false);
    expect(data.hasMore).toBe(true);
  });

  it('every result of the search is shown once, across all the batches, and then it stops', async () => {
    const batches = await everyBatch({ q: 'loadmore' });
    const all = batches.flatMap(batch => batch.results.map(r => r.url));
    expect(all).toHaveLength(25 + 15);
    expect(new Set(all).size).toBe(all.length);
    // 20 first (10 + 10 external), then the last 5 of the external answer with
    // 5 of the index, then the index's last 10.
    expect(batches.map(b => b.results.length)).toEqual([20, 10, 10]);
    expect(batches[1].results.filter(r => r.source === 'parallel')).toHaveLength(5);
    expect(batches[2].results.every(r => r.source === 'index')).toBe(true);
    const last = batches[batches.length - 1];
    expect(last.hasMore).toBe(false);
    expect(last.nextCursor).toBeNull();
    // One Parallel request served all of it: the batches continue the same answer.
    expect(parallelSearch).toHaveBeenCalledTimes(1);
  });

  it('a batch size can be asked for, within the server’s limit', async () => {
    const first = (await search({ q: 'loadmore' })).body.data;
    const res = await search({ q: 'loadmore', cursor: first.nextCursor, limit: 3 });
    expect(res.body.data.results).toHaveLength(3);
    // Two from the provider's answer (half, rounded up), one from the index.
    expect(res.body.data.results.filter(r => r.source === 'index').map(r => r.sourceRank)).toEqual([
      11
    ]);
    const tooMany = await search({ q: 'loadmore', cursor: first.nextCursor, limit: 51 });
    expect(tooMany.status).toBe(400);
  });

  it('a provider that fails during Load more leaves the index’s results in the batch', async () => {
    const first = (await search({ q: 'loadmore' })).body.data;
    // The cached answer has gone, and Parallel is down.
    externalSearch.reset();
    parallelSearch.mockRejectedValue(
      new ExternalSearchError('unavailable', 'Parallel answered 503')
    );
    const res = await search({ q: 'loadmore', cursor: first.nextCursor });
    expect(res.status).toBe(200);
    const { data } = res.body;
    // The index fills the batch.
    expect(data.results.map(r => r.sourceRank)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(data.results.every(r => r.source === 'index')).toBe(true);
    expect(data.external).toMatchObject({ provider: 'parallel', status: 'unavailable' });
    // The external results not yet shown are still there to try again.
    expect(data.hasMore).toBe(true);
    parallelSearch.mockResolvedValue({ results: external(15) });
    const retry = (await search({ q: 'loadmore', cursor: data.nextCursor })).body.data;
    expect(retry.results.filter(r => r.source === 'parallel').map(r => r.url)).toEqual(
      external(15)
        .slice(10)
        .map(r => r.url)
    );
    expect(retry.results.filter(r => r.source === 'index').map(r => r.sourceRank)).toEqual([
      21, 22, 23, 24, 25
    ]);
    expect(retry.hasMore).toBe(false);
  });

  it('where the index did not answer the query, Load more takes the provider’s remaining results first', async () => {
    // As a first page with a weak index leaves it: 10 of each shown, the
    // provider's answer leading the continuation.
    const cursor = encodeCursor(
      {
        query: 'loadmore',
        category: 'all',
        sort: 'relevance',
        domain: '',
        dateWindow: 'any',
        language: ''
      },
      { offset: 10, externalOffset: 10, placement: 'external', externalMore: true }
    );
    const { data } = (await search({ q: 'loadmore', cursor })).body;
    expect(data.results).toHaveLength(10);
    // The provider's last five, then the index fills the batch.
    expect(data.results.filter(r => r.source === 'parallel').map(r => r.url)).toEqual(
      external(15)
        .slice(10)
        .map(r => r.url)
    );
    expect(data.results.filter(r => r.source === 'index').map(r => r.sourceRank)).toEqual([
      11, 12, 13, 14, 15
    ]);
  });

  it('when Parallel fails on the first page, Load more continues the index alone', async () => {
    parallelSearch.mockRejectedValue(new ExternalSearchError('timeout', 'Parallel did not answer'));
    const batches = await everyBatch({ q: 'loadmore' });
    expect(batches.map(b => b.results.length)).toEqual([10, 10, 5]);
    expect(batches.flatMap(b => b.results).every(r => r.source === 'index')).toBe(true);
    expect(batches[2].hasMore).toBe(false);
  });

  it('with nothing more anywhere, there is no cursor', async () => {
    parallelSearch.mockResolvedValue({ results: [] });
    await testDb.clear();
    await seedManyPages(4, { keyword: 'short' });
    const { data } = (await search({ q: 'short' })).body;
    expect(data.results).toHaveLength(4);
    expect(data.hasMore).toBe(false);
    expect(data.nextCursor).toBeNull();
  });

  it('an empty search is not a cursor search', async () => {
    const { data } = (await search({ q: 'nothingmatchesthis' })).body;
    expect(data.results.filter(r => r.source === 'index')).toEqual([]);
  });
});

describe('cursors are checked', () => {
  beforeEach(() => seedManyPages(12, { keyword: 'loadmore' }));

  it.each([
    ['garbage', 'not-a-cursor!'],
    [
      'a cursor for another query',
      () =>
        encodeCursor(
          {
            query: 'other',
            category: 'all',
            sort: 'relevance',
            domain: '',
            dateWindow: 'any',
            language: ''
          },
          { offset: 10 }
        )
    ],
    [
      'a cursor for another tab',
      () =>
        encodeCursor(
          {
            query: 'loadmore',
            category: 'images',
            sort: 'relevance',
            domain: '',
            dateWindow: 'any',
            language: ''
          },
          { offset: 10 }
        )
    ],
    [
      'a cursor for other filters',
      () =>
        encodeCursor(
          {
            query: 'loadmore',
            category: 'all',
            sort: 'newest',
            domain: '',
            dateWindow: 'any',
            language: ''
          },
          { offset: 10 }
        )
    ]
  ])('%s: 400, and nothing is searched', async (_label, make) => {
    const cursor = typeof make === 'function' ? make() : make;
    const res = await search({ q: 'loadmore', cursor });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(parallelSearch).not.toHaveBeenCalled();
  });
});

describe('Videos tab (Parallel, confirmed by the platform)', () => {
  const yt = i => `https://www.youtube.com/watch?v=${String(i).padStart(11, 'v')}`;

  beforeEach(() => {
    config.parallel.verticals = true;
    parallelSearch.mockImplementation(async ({ searchQueries }) => ({
      // Each way of asking finds its own videos.
      results: Array.from({ length: 8 }, (_, i) => ({
        url: yt(`${searchQueries[0].length}${i}`),
        title: `Load more video ${i}`,
        publish_date: null,
        excerpts: ['A video about load more.']
      }))
    }));
    jest.spyOn(videoPlatforms, 'lookup').mockImplementation(async video => ({
      ok: true,
      title: `Load more video ${video.id}`,
      channel: 'Channel',
      thumbnailUrl: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`
    }));
  });

  it('pages through the verified list, then asks Parallel again in other words, round by round, then stops', async () => {
    const batches = await everyBatch({ q: 'load more', category: 'videos', limit: 12 });
    const all = batches.flatMap(batch => batch.results.map(r => r.videoUrl));
    // Every video once, across every batch, with positions continuing.
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(batches[batches.length - 1].total);
    expect(batches.flatMap(b => b.results.map(r => r.position))).toEqual(all.map((_, i) => i + 1));
    // The first batch is the tab's own page size; Load more defaults to 10.
    expect(batches[0].results).toHaveLength(12);
    for (const batch of batches.slice(1)) expect(batch.results.length).toBeLessThanOrEqual(10);
    // More than the first answer held: later rounds were asked for.
    expect(all.length).toBeGreaterThan(batches[0].total);
    expect(batches[batches.length - 1].hasMore).toBe(false);
    expect(batches[batches.length - 1].nextCursor).toBeNull();

    // Three rounds of three requests, each asked in words no earlier one used.
    const asked = parallelSearch.mock.calls.map(([request]) => request.searchQueries[0]);
    expect(asked).toHaveLength(9);
    expect(new Set(asked.map(q => q.toLowerCase())).size).toBe(9);
    expect(asked.slice(0, 3)).toEqual(['load more video', 'load more', 'best load more']);
    expect(asked.slice(3, 6)).toEqual(['load more videos', 'load more youtube', 'watch load more']);
  });

  it('the first page asks one round only; later rounds wait for Load more', async () => {
    const res = await search({ q: 'load more', category: 'videos', limit: 12 });
    expect(res.body.data.hasMore).toBe(true);
    expect(parallelSearch).toHaveBeenCalledTimes(3);
  });

  it('a round that finds nothing new ends the list — the same batch is never shown as new', async () => {
    // Whatever it is asked, Parallel finds the same eight videos.
    parallelSearch.mockImplementation(async () => ({
      results: Array.from({ length: 8 }, (_, i) => ({
        url: yt(`same${i}`),
        title: `Load more video ${i}`,
        publish_date: null,
        excerpts: ['A video about load more.']
      }))
    }));
    const first = (await search({ q: 'load more', category: 'videos', limit: 12 })).body.data;
    expect(first.results).toHaveLength(8);
    // Fewer than a page, but another round may still find more.
    expect(first.hasMore).toBe(true);

    const more = (await search({ q: 'load more', category: 'videos', cursor: first.nextCursor }))
      .body.data;
    expect(more.results).toEqual([]);
    expect(more.hasMore).toBe(false);
    expect(more.nextCursor).toBeNull();
    expect(parallelSearch).toHaveBeenCalledTimes(6);
  });

  it('a round that fails is an error to retry — not the end — and retrying the same cursor gets it', async () => {
    // The whole first round on one page: the next batch needs a new round.
    const first = (await search({ q: 'load more', category: 'videos', limit: 24 })).body.data;
    expect(first.results).toHaveLength(24);
    expect(first.hasMore).toBe(true);

    // The next round's requests fail once.
    const working = parallelSearch.getMockImplementation();
    parallelSearch.mockImplementation(async () => {
      throw new ExternalSearchError('timeout', 'Parallel timed out');
    });
    const failed = await search({ q: 'load more', category: 'videos', cursor: first.nextCursor });
    expect(failed.status).toBe(503);
    expect(failed.body.success).toBe(false);
    expect(failed.body.message).toMatch(/could not be loaded right now/i);

    parallelSearch.mockImplementation(working);
    const retried = await search({ q: 'load more', category: 'videos', cursor: first.nextCursor });
    expect(retried.status).toBe(200);
    expect(retried.body.data.results.length).toBeGreaterThan(0);
    const shown = first.results.map(r => r.videoUrl);
    for (const video of retried.body.data.results) expect(shown).not.toContain(video.videoUrl);
  });

  it('the day’s request limit stops Load more with a message, not a silent end', async () => {
    config.parallel.dailyLimit = 3; // the first page's round uses all three
    const first = (await search({ q: 'load more', category: 'videos', limit: 24 })).body.data;
    const res = await search({ q: 'load more', category: 'videos', cursor: first.nextCursor });
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/daily search limit/i);
    expect(parallelSearch).toHaveBeenCalledTimes(3);
  });

  it('a new search starts again from the first round', async () => {
    await everyBatch({ q: 'load more', category: 'videos', limit: 12 });
    parallelSearch.mockClear();
    const res = await search({ q: 'other subject', category: 'videos', limit: 12 });
    expect(res.status).toBe(200);
    expect(parallelSearch).toHaveBeenCalledTimes(3);
    expect(parallelSearch.mock.calls[0][0].searchQueries[0]).toBe('other subject video');
  });
});

describe('Images tab (Parallel, checked pictures)', () => {
  /** A verified picture, as the Images round would return it. */
  const picture = (key, n) => ({
    id: `parallel-image:${key}-${n}`,
    title: `Load more picture ${key} ${n}`,
    imageUrl: `https://pics.example/${key}/${n}.jpg`,
    thumbnailUrl: `https://pics.example/${key}/${n}.jpg`,
    sourceUrl: `https://pics.example/${key}/page-${n}`,
    sourceDomain: 'pics.example',
    sourceName: '',
    width: 800,
    height: 600,
    downloadToken: 'sig',
    dedupeKey: `https://pics.example/${key}/${n}.jpg`,
    source: 'parallel'
  });
  const ROUND_OF = {
    'load more photos': 0,
    'load more pictures': 1,
    'load more photo gallery': 2,
    'load more hd pictures': 3,
    'load more pics': 4,
    'best load more photos': 5
  };
  let asked; // every round sent, in order, with repeats (the cache is mocked away)
  /** Each round's pictures stand for what checking its pages found. */
  const rounds = (fresh, { repeatsIn = {}, fail = () => false } = {}) =>
    jest.spyOn(externalSearch, 'fetchCached').mockImplementation(async (_c, request) => {
      const round = ROUND_OF[request.searchQueries[0]];
      asked.push(round);
      if (fail(round)) return { status: 'unavailable', reason: 'timeout' };
      const count = fresh[round] ?? 0;
      const repeats = (repeatsIn[round] || []).map(n => picture('r0', n));
      return {
        status: 'ok',
        cached: false,
        results: [...Array.from({ length: count }, (_, n) => picture(`r${round}`, n)), ...repeats]
      };
    });
  const firstPage = () => search({ q: 'load more', category: 'images', limit: 60 });
  const more = cursor => search({ q: 'load more', category: 'images', cursor, limit: 20 });
  const urls = batch => batch.results.map(r => r.imageUrl);

  beforeEach(() => {
    config.parallel.verticals = true;
    asked = [];
  });

  it('the first page gathers up to 60 pictures from as many rounds as it takes, two at a time', async () => {
    // 18, then 13 new (+3 repeats), 15, 12, 10, then nothing new.
    rounds([18, 13, 15, 12, 10, 0], { repeatsIn: { 1: [0, 1, 2] } });
    const res = await firstPage();
    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data.results).toHaveLength(60);
    expect(new Set(urls(data)).size).toBe(60);
    // Round 0 first; then two at once; then only as many as the shortfall needs.
    expect(asked).toEqual([0, 1, 2, 3, 4]);
    expect(data.total).toBe(68);
    expect(data.hasMore).toBe(true);
    expect(data.external).toMatchObject({ status: 'ok', rounds: 5 });

    // Load more: the 8 left over, then the last round finds nothing new: the end.
    asked = [];
    const next = (await more(data.nextCursor)).body.data;
    expect(urls(next)).toHaveLength(8);
    for (const url of urls(next)) expect(urls(data)).not.toContain(url);
    expect(next.hasMore).toBe(false);
    expect(next.nextCursor).toBeNull();
    expect(asked).toEqual([0, 1, 2, 3, 4, 5]); // 0–4 from the cache in real use, 5 new
  });

  it('Load more appends 20 new pictures a click, from the next round, until the last', async () => {
    rounds([20, 20, 20, 20, 20, 20]);
    // As the browser asks: 60 first, then 20 a click.
    const batches = [(await firstPage()).body.data];
    while (batches[batches.length - 1].hasMore && batches.length < 10) {
      batches.push((await more(batches[batches.length - 1].nextCursor)).body.data);
    }
    expect(batches.map(b => b.results.length)).toEqual([60, 20, 20, 20]);
    const all = batches.flatMap(urls);
    expect(new Set(all).size).toBe(120);
    expect(batches.map(b => b.hasMore)).toEqual([true, true, true, false]);
    expect(batches.flatMap(b => b.results.map(r => r.position))).toEqual(all.map((_, i) => i + 1));
  });

  it('when the provider has fewer than 60, the first page shows what there is and no Load more', async () => {
    rounds([6, 6, 6, 6, 6, 6]);
    const { data } = (await firstPage()).body;
    expect(data.results).toHaveLength(36);
    expect(data.hasMore).toBe(false);
    expect(data.nextCursor).toBeNull();
    // Every round, and not one more: there is no round after the last.
    expect(asked.sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('a round that finds nothing new stops the gathering early', async () => {
    rounds([18, 0, 0, 30, 30, 30]);
    const { data } = (await firstPage()).body;
    expect(data.results).toHaveLength(18);
    expect(data.hasMore).toBe(false);
    expect(asked).toEqual([0, 1, 2]);
  });

  it('one empty round of two sent together does not end the list; two empty in a row do', async () => {
    rounds([18, 0, 14, 12, 0, 0]);
    const { data } = (await firstPage()).body;
    expect(data.results).toHaveLength(44);
    expect(asked).toEqual([0, 1, 2, 3, 4, 5]);
    expect(data.hasMore).toBe(false);
  });

  it('a round that fails keeps what was found, offers Load more, and Load more retries that round', async () => {
    let down = true;
    rounds([18, 13, 15, 12, 10, 8], { fail: round => down && round >= 2 });
    const { data } = (await firstPage()).body;
    expect(data.results).toHaveLength(31);
    expect(data.hasMore).toBe(true);

    // Still failing: an error to retry, and nothing shown twice.
    const failed = await more(data.nextCursor);
    expect(failed.status).toBe(503);
    expect(failed.body.message).toMatch(/could not be loaded right now/i);

    down = false;
    const retried = (await more(data.nextCursor)).body.data;
    expect(retried.results).toHaveLength(20);
    for (const url of urls(retried)) expect(urls(data)).not.toContain(url);
    expect(retried.hasMore).toBe(true);
  });

  it('the Images page may be 60; other tabs keep the server maximum', async () => {
    rounds([1, 0]);
    expect((await search({ q: 'load more', category: 'images', limit: 60 })).status).toBe(200);
    expect((await search({ q: 'load more', category: 'images', limit: 61 })).status).toBe(400);
    expect((await search({ q: 'load more', category: 'videos', limit: 60 })).status).toBe(400);
    expect((await search({ q: 'load more', limit: 60 })).status).toBe(400);
  });
});

describe('the crawler’s own verticals (no provider)', () => {
  it('an empty vertical says there is no more', async () => {
    const res = await search({ q: 'loadmore', category: 'images', limit: 24 });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.nextCursor).toBeNull();
  });
});
