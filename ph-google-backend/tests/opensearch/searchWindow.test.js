/**
 * The 10,000-result window — against a real cluster holding more matches
 * than can be paged through.
 *
 * With 10,050 matching pages the API must report the exact total, stop
 * `totalPages` at the last page it will serve, serve that page, and refuse
 * the next one. Nothing here raises index.max_result_window.
 *
 * Skipped (not passed) when no cluster is reachable. Uses its own index.
 */

const previousEngine = process.env.SEARCH_ENGINE;
const previousIndex = process.env.OPENSEARCH_INDEX;
const INDEX_NAME = 'ph-google-pages-window-test';
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
const { config } = require('../../config/env');

const available = process.env.OPENSEARCH_AVAILABLE === 'true';
const describeLive = available ? describe : describe.skip;

const MATCHES = 10050;
const CRAWLED = new Date('2026-09-01T00:00:00Z');

/** Short, distinct pages: every one matches "bulk" and none is a duplicate. */
const PAGES = Array.from({ length: MATCHES }, (_unused, i) => ({
  _id: `bulk-${i}`,
  url: `https://bulk.example.com/item/${i}`,
  domain: 'bulk.example.com',
  title: `Bulk item ${i}`,
  description: '',
  content: `bulk entry number ${i}`,
  language: 'en',
  lastCrawledAt: CRAWLED
}));

describeLive('search result window', () => {
  let app;
  const get = params => request(app).get('/api/search').query(params);
  const idsOf = res => res.body.data.results.map(r => r.id);

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
    await bulkIndexPages(PAGES);
    await refreshIndex();

    await testDb.connect();
    app = require('../../app').createApp();
  }, 300000);

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

  it('leaves the index window at the OpenSearch default', async () => {
    const response = await getClient().indices.getSettings({
      index: INDEX_NAME,
      include_defaults: true
    });
    const { settings, defaults } = response.body[INDEX_NAME];
    const window =
      (settings.index && settings.index.max_result_window) || defaults.index.max_result_window;
    expect(Number(window)).toBe(config.search.maxResultWindow);
  });

  it('reports the exact total, beyond the window', async () => {
    const res = await get({ q: 'bulk' });
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(MATCHES);
    expect(res.body.data.pagination.totalResults).toBe(MATCHES);
  });

  it.each([
    [50, 200],
    [20, 500],
    [10, 500]
  ])('limit=%i: advertises %i pages, never one it would refuse', async (limit, pages) => {
    const res = await get({ q: 'bulk', limit });
    expect(res.body.data.results).toHaveLength(limit);
    expect(res.body.data.pagination).toMatchObject({
      page: 1,
      limit,
      totalResults: MATCHES,
      totalPages: pages,
      hasNextPage: true,
      hasPreviousPage: false
    });
    expect(pages * limit).toBeLessThanOrEqual(config.search.maxResultWindow);
  });

  it('limit=50: serves page 200, the last one, in full', async () => {
    const res = await get({ q: 'bulk', limit: 50, page: 200 });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(50);
    expect(res.body.data.total).toBe(MATCHES);
    expect(res.body.data.pagination).toMatchObject({
      page: 200,
      totalPages: 200,
      hasNextPage: false,
      hasPreviousPage: true
    });
  });

  it('limit=50: refuses page 201 with a clear 400', async () => {
    const res = await get({ q: 'bulk', limit: 50, page: 201 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/maximum is 200 for a limit of 50/);
    expect(res.body.message).toMatch(/first 10,000 results/);
  });

  it('limit=20: serves page 500, exactly at the 10,000 boundary, and refuses 501', async () => {
    const last = await get({ q: 'bulk', limit: 20, page: 500 });
    expect(last.status).toBe(200);
    expect(last.body.data.results).toHaveLength(20);
    expect(last.body.data.pagination).toMatchObject({ totalPages: 500, hasNextPage: false });

    const beyond = await get({ q: 'bulk', limit: 20, page: 501 });
    expect(beyond.status).toBe(400);
  });

  it('limit=10: stops at the configured maximum page', async () => {
    const last = await get({ q: 'bulk', limit: 10, page: 500 });
    expect(last.status).toBe(200);
    expect(last.body.data.results).toHaveLength(10);
    expect(last.body.data.pagination).toMatchObject({ totalPages: 500, hasNextPage: false });
    expect((await get({ q: 'bulk', limit: 10, page: 501 })).status).toBe(400);
  });

  it('keeps adjacent pages disjoint up to the boundary', async () => {
    const first = await get({ q: 'bulk', limit: 50, page: 1 });
    const second = await get({ q: 'bulk', limit: 50, page: 2 });
    const beforeLast = await get({ q: 'bulk', limit: 50, page: 199 });
    const last = await get({ q: 'bulk', limit: 50, page: 200 });

    for (const [a, b] of [
      [first, second],
      [beforeLast, last]
    ]) {
      const ids = [...idsOf(a), ...idsOf(b)];
      expect(ids).toHaveLength(100);
      expect(new Set(ids).size).toBe(100);
    }
    // Each page holds only its own results.
    for (const res of [first, second, beforeLast, last]) {
      expect(new Set(idsOf(res)).size).toBe(50);
    }
  });

  it('returns the same page for the same request', async () => {
    const one = await get({ q: 'bulk', limit: 20, page: 37 });
    const two = await get({ q: 'bulk', limit: 20, page: 37 });
    expect(idsOf(one)).toEqual(idsOf(two));
  });

  it('still refuses a direct caller that asks past the window', async () => {
    await expect(openSearch.search({ query: 'bulk', page: 201, limit: 50 })).rejects.toMatchObject({
      statusCode: 400
    });
    await expect(openSearch.search({ query: 'bulk', page: 200, limit: 50 })).resolves.toMatchObject(
      { totalResults: MATCHES }
    );
  });
});
