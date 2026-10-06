/**
 * The 10,000-result window when duplicates are among the matches.
 *
 * Only the first 10,000 ranked hits can be fetched. A copy inside them takes
 * a place, so fewer distinct results can be paged through than `total`
 * counts. `totalPages` must count only those, so the last page it advertises
 * is never empty — while `total` stays the exact number of matches.
 *
 * Four cases, the last three positioned exactly with sort=newest:
 *   pair      5,300 pairs of identical articles (10,600 matches), relevance
 *   early     50 pairs at raw positions 0-99, before 10,010 distinct pages
 *   boundary  10 pairs at raw positions 9,995-10,014, across the window edge
 *   late      50 pairs after raw position 10,010, outside the window
 *
 * Skipped (not passed) when no cluster is reachable. Uses its own index.
 */

const previousEngine = process.env.SEARCH_ENGINE;
const previousIndex = process.env.OPENSEARCH_INDEX;
const INDEX_NAME = 'ph-google-pages-window-dupes-test';
process.env.SEARCH_ENGINE = 'opensearch';
process.env.OPENSEARCH_INDEX = INDEX_NAME;

const request = require('supertest');
const testDb = require('../helpers/testDb');
const {
  checkHealth,
  closeClient,
  resetClient,
  getClient
} = require('../../services/opensearch/client');
const { recreateIndex, refreshIndex } = require('../../services/opensearch/indexManager');
const {
  bulkIndexPages,
  resetIndexReadyFlag
} = require('../../services/opensearch/indexingService');
const openSearch = require('../../services/opensearch/searchService');
const { maxPageFor } = require('../../utils/validators');
const { config } = require('../../config/env');

const available = process.env.OPENSEARCH_AVAILABLE === 'true';
const describeLive = available ? describe : describe.skip;

const BASE = 10010;
const START = Date.parse('2026-09-01T00:00:00Z');

/** The corpus. Crawl times are seconds before START, so newest-first order is exact. */
function buildPages() {
  const pages = [];
  const page = (id, url, title, content, secondsAgo) => ({
    _id: id,
    url,
    domain: new URL(url).hostname,
    title,
    description: '',
    content,
    language: 'en',
    lastCrawledAt: new Date(START - secondsAgo * 1000)
  });

  // Twelve or more words, so two identical bodies count as duplicates.
  for (let i = 0; i < 5300; i += 1) {
    const content = `pair syndicated article number ${i} that two different sites both publish word for word`;
    for (const host of ['a', 'b']) {
      pages.push(
        page(
          `pair-${host}-${i}`,
          `https://${host}.pairs.example.org/${i}`,
          `Pair article ${i}`,
          content,
          50000
        )
      );
    }
  }

  // Four words: never collapsed. Ten seconds apart, newest first by index.
  for (let i = 0; i < BASE; i += 1) {
    pages.push(
      page(
        `base-${i}`,
        `https://base.example.com/${i}`,
        `Base page ${i}`,
        `early boundary late ${i}`,
        100 + i * 10
      )
    );
  }

  const pair = (word, i, secondsAgo) => {
    const content = `${word} duplicated story number ${i} copied by two sites word for word here`;
    for (const host of ['x', 'y']) {
      pages.push(
        page(
          `${word}-${host}-${i}`,
          `https://${host}.${word}.example.net/${i}`,
          `${word} story ${i}`,
          content,
          secondsAgo
        )
      );
    }
  };
  // Newer than every base page: raw positions 0-99.
  for (let i = 0; i < 50; i += 1) pair('early', i, i);
  // Between base pages 9,994 and 9,995: raw positions 9,995-10,014.
  for (let i = 0; i < 10; i += 1) pair('boundary', i, 100 + 9994 * 10 + 1 + i * 0.5);
  // Older than every base page: raw positions 10,010 onwards.
  for (let i = 0; i < 50; i += 1) pair('late', i, 100 + BASE * 10 + 1000 + i);

  return pages;
}

describeLive('search result window with duplicates', () => {
  let app;
  const get = params => request(app).get('/api/search').query(params);

  beforeAll(async () => {
    if (config.searchEngine !== 'opensearch') {
      throw new Error('This suite must run with SEARCH_ENGINE=opensearch');
    }
    resetClient();
    const health = await checkHealth(true);
    if (!health.ok) {
      throw new Error(`OpenSearch became unreachable at ${health.node}: ${health.error || ''}`);
    }

    resetIndexReadyFlag();
    await recreateIndex();
    await bulkIndexPages(buildPages());
    await refreshIndex();

    await testDb.connect();
    app = require('../../app').createApp();
  }, 600000);

  afterAll(async () => {
    await testDb.disconnect();
    try {
      await getClient().indices.delete({ index: INDEX_NAME });
    } catch {
      /* already gone */
    }
    await closeClient();
    process.env.SEARCH_ENGINE = previousEngine;
    process.env.OPENSEARCH_INDEX = previousIndex;
  });

  /**
   * Requests the last advertised page and the one after it, and checks that
   * the first holds results and the second is either empty or refused.
   */
  async function expectLastPageServed(params, limit) {
    const first = await get({ ...params, limit });
    const { totalPages } = first.body.data.pagination;

    const last = await get({ ...params, limit, page: totalPages });
    expect(last.status).toBe(200);
    expect(last.body.data.results.length).toBeGreaterThan(0);
    expect(last.body.data.pagination).toMatchObject({ page: totalPages, hasNextPage: false });

    const next = await get({ ...params, limit, page: totalPages + 1 });
    if (totalPages + 1 > maxPageFor(limit)) {
      expect(next.status).toBe(400);
    } else {
      // Inside the API's bounds but past the results: an empty page.
      expect(next.status).toBe(200);
      expect(next.body.data.results).toEqual([]);
      expect(next.body.data.pagination.hasNextPage).toBe(false);
    }
    return { first, last, totalPages };
  }

  // ------------------------------------------------------------------
  describe('the reported blocker: duplicates throughout, by relevance', () => {
    const params = { q: 'pair' };

    it('keeps the total exact', async () => {
      const res = await get(params);
      expect(res.body.data.total).toBe(5300);
      expect(res.body.data.pagination.totalResults).toBe(5300);
    });

    it('limit=20: the last advertised page holds results', async () => {
      const { totalPages, last } = await expectLastPageServed(params, 20);
      // Before the fix: 265 pages, the last of them empty.
      expect(totalPages).toBeLessThan(265);
      expect(last.body.data.results.length).toBeLessThanOrEqual(20);
    });

    it('limit=20: every page before the last is full', async () => {
      const { totalPages } = await expectLastPageServed(params, 20);
      const before = await get({ ...params, limit: 20, page: totalPages - 1 });
      expect(before.body.data.results).toHaveLength(20);
    });

    it('limit=50: the last advertised page holds results', async () => {
      const { totalPages } = await expectLastPageServed(params, 50);
      expect(totalPages).toBe(106);
    });

    it('limit=24: the last advertised page holds results', async () => {
      const { totalPages } = await expectLastPageServed(params, 24);
      expect(totalPages).toBe(220);
    });

    it('limit=10: unchanged, the configured maximum page comes first', async () => {
      const { totalPages, last } = await expectLastPageServed(params, 10);
      expect(totalPages).toBe(500);
      expect(last.body.data.results).toHaveLength(10);
      expect((await get({ ...params, limit: 10, page: 501 })).status).toBe(400);
    });

    it('agrees with the pages actually served', async () => {
      const res = await get({ ...params, limit: 50 });
      const { totalPages } = res.body.data.pagination;
      const last = await get({ ...params, limit: 50, page: totalPages });
      const reachable = (totalPages - 1) * 50 + last.body.data.results.length;

      const outcome = await openSearch.search({ query: 'pair', page: 1, limit: 50 });
      expect(outcome.reachableResults).toBe(reachable);
      expect(outcome.reachableResults).toBeLessThan(outcome.totalResults);
    });
  });

  // ------------------------------------------------------------------
  describe('where the duplicates sit', () => {
    it.each([
      // query, reachable distinct results inside the window, matches after collapsing
      ['early', 9950, 10060],
      ['boundary', 9998, 10020],
      ['late', 10000, 10060]
    ])('%s: counts exactly the results inside the window', async (q, reachable, total) => {
      const outcome = await openSearch.search({ query: q, page: 1, limit: 50, sort: 'newest' });
      expect(outcome.totalResults).toBe(total);
      expect(outcome.reachableResults).toBe(reachable);
    });

    it.each([
      ['early', 50, 199, 50],
      ['early', 20, 498, 10],
      ['early', 24, 415, 14],
      ['boundary', 50, 200, 48],
      ['boundary', 20, 500, 18],
      ['boundary', 24, 416, 24],
      ['late', 50, 200, 50],
      ['late', 20, 500, 20],
      ['late', 24, 416, 24],
      ['early', 10, 500, 10],
      ['late', 10, 500, 10]
    ])('%s, limit=%i: %i pages, the last holding %i', async (q, limit, pages, lastCount) => {
      const params = { q, sort: 'newest' };
      const { first, last, totalPages } = await expectLastPageServed(params, limit);
      expect(totalPages).toBe(pages);
      expect(last.body.data.results).toHaveLength(lastCount);
      expect(first.body.data.total).toBe(q === 'boundary' ? 10020 : 10060);
    });

    it('late: does not count copies that lie outside the window', async () => {
      // A bound that subtracted every duplicate would stop at 199 pages here.
      const res = await get({ q: 'late', sort: 'newest', limit: 50 });
      expect(res.body.data.pagination.totalPages).toBe(200);
      const last = await get({ q: 'late', sort: 'newest', limit: 50, page: 200 });
      expect(last.body.data.results).toHaveLength(50);
    });

    it('boundary: a copy just inside the window still takes a place', async () => {
      const last = await get({ q: 'boundary', sort: 'newest', limit: 50, page: 200 });
      expect(last.body.data.results).toHaveLength(48);
      const ids = last.body.data.results.map(r => r.id);
      expect(new Set(ids).size).toBe(48);
    });
  });

  // ------------------------------------------------------------------
  describe('what does not change', () => {
    it('serves the same documents, in the same order, with the same scores', async () => {
      // One page of 40 equals two pages of 20: the deeper walk changes no
      // position or score.
      const forty = await get({ q: 'pair', limit: 40, page: 3 });
      const a = await get({ q: 'pair', limit: 20, page: 5 });
      const b = await get({ q: 'pair', limit: 20, page: 6 });
      const pick = res => res.body.data.results.map(r => [r.id, r.score]);
      expect([...pick(a), ...pick(b)]).toEqual(pick(forty));
    });

    it('still collapses one copy of every pair', async () => {
      const page1 = await get({ q: 'early', sort: 'newest', limit: 50 });
      const urls = page1.body.data.results.map(r => r.url);
      // The 50 early pairs come first, one copy each: 50 stories, no repeats.
      const early = urls.filter(url => url.includes('.early.example.net/'));
      expect(early).toHaveLength(50);
      const stories = early.map(url => url.split('/').pop());
      expect(new Set(stories).size).toBe(50);
    });

    it('reports reachable = total when the matches fit in the window', async () => {
      const outcome = await openSearch.search({ query: 'early 5', page: 1, limit: 10 });
      expect(outcome.reachableResults).toBe(outcome.totalResults);
    });

    it('keeps adjacent pages disjoint at the end of the window', async () => {
      const a = await get({ q: 'pair', limit: 50, page: 104 });
      const b = await get({ q: 'pair', limit: 50, page: 105 });
      const ids = [...a.body.data.results, ...b.body.data.results].map(r => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(100);
    });
  });
});
