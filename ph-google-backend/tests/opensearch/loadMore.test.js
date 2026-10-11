/**
 * "Load more" against the real engine, over a small fixture index, with the
 * providers mocked: batch boundaries are stable even where many pages score
 * the same, nothing appears twice across the index and the external answer,
 * and the existing protections — the topical filter for a weak index, and
 * one copy of an article and its web.archive.org copy — hold in every batch.
 *
 * Skipped (not passed) when no cluster is reachable. Uses its own index.
 */

const previousEngine = process.env.SEARCH_ENGINE;
const previousIndex = process.env.OPENSEARCH_INDEX;
const INDEX_NAME = 'ph-google-pages-load-more-test';
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
const { config } = require('../../config/env');
const externalSearch = require('../../services/externalSearch');
const parallelClient = require('../../services/external/parallelClient');
const serpApiClient = require('../../services/external/serpApiClient');
const logger = require('../../utils/logger');

const available = process.env.OPENSEARCH_AVAILABLE === 'true';
const describeLive = available ? describe : describe.skip;

const doc = (id, url, title, content, extra = {}) => ({
  _id: id,
  url,
  domain: new URL(url).hostname,
  title,
  description: `${title}.`,
  content,
  language: 'en',
  lastCrawledAt: new Date(Date.now() - 3600 * 1000),
  ...extra
});

// 23 pages that score exactly alike for "tiebreak": the boundaries between
// batches fall inside a run of equal scores.
const TIES = Array.from({ length: 23 }, (_, i) =>
  doc(`tie-${i}`, `https://ties.example/page-${i}`, 'Tiebreak page', 'tiebreak tiebreak words')
);

// A query the index has no page about, and pages that only share its words.
const WEAK = [
  doc(
    'junk-1',
    'https://travel.example/albania',
    'Albania guide',
    'The best restaurants are in Tirana.'
  ),
  doc(
    'junk-2',
    'https://travel.example/old-towns',
    'Old towns',
    'Good restaurants are the best in old towns.'
  ),
  ...Array.from({ length: 4 }, (_, i) =>
    doc(
      `cbe-${i}`,
      `https://food.example/coimbatore-${i}`,
      `Eating in Coimbatore ${i}`,
      'The restaurants of Coimbatore serve idli and dosa.'
    )
  )
];

// An article and its archived copy, among other articles on the subject.
const ARTICLE_TEXT = 'Chip makers expanded quantum research this quarter with new funding.';
const NEWS = [
  doc(
    'q-original',
    'https://www.magazine.example/quantum-chips',
    'Quantum chips grow up',
    ARTICLE_TEXT,
    {
      isArticle: true,
      publishedAt: new Date(Date.UTC(2026, 8, 20))
    }
  ),
  doc(
    'q-archived',
    'https://web.archive.org/web/20260921000000/https://www.magazine.example/quantum-chips',
    'Quantum chips grow up',
    `The Wayback Machine - captured. ${ARTICLE_TEXT}`,
    { isArticle: true, publishedAt: new Date(Date.UTC(2026, 8, 20)) }
  ),
  ...Array.from({ length: 5 }, (_, i) =>
    doc(
      `q-${i}`,
      `https://news.example/quantum-${i}`,
      `Quantum computing news ${i}`,
      `Quantum chips and quantum research, part ${i}.`,
      { isArticle: true, publishedAt: new Date(Date.UTC(2026, 8, 10 - i)) }
    )
  )
];

describeLive('Load more against the engine', () => {
  let app;
  let parallelSearch;
  const original = {
    parallel: { ...config.parallel },
    serpapi: { ...config.serpapi },
    externalSearch: { ...config.externalSearch }
  };

  const search = params => request(app).get('/api/search').query(params);
  async function everyBatch(params) {
    const batches = [(await search(params)).body.data];
    for (let i = 0; i < 30 && batches[batches.length - 1].hasMore; i += 1) {
      const { limit: _size, ...rest } = params;
      batches.push(
        (
          await search({
            ...rest,
            limit: params.batch || 10,
            cursor: batches[batches.length - 1].nextCursor
          })
        ).body.data
      );
    }
    return batches;
  }

  beforeAll(async () => {
    resetClient();
    const health = await checkHealth(true);
    if (!health.ok) throw new Error(`OpenSearch became unreachable at ${health.node}`);
    resetIndexReadyFlag();
    await recreateIndex();
    await bulkIndexPages([...TIES, ...WEAK, ...NEWS]);
    await refreshIndex();
    await testDb.connect();
    app = require('../../app').createApp();
  }, 120000);

  afterAll(async () => {
    Object.assign(config.parallel, original.parallel);
    Object.assign(config.serpapi, original.serpapi);
    Object.assign(config.externalSearch, original.externalSearch);
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

  beforeEach(async () => {
    await testDb.clear();
    externalSearch.reset();
    Object.assign(config.externalSearch, original.externalSearch, {
      provider: 'parallel',
      fallback: false,
      relevanceGate: true,
      validateResults: true
    });
    Object.assign(config.parallel, original.parallel, {
      enabled: true,
      verticals: false,
      apiKey: 'load-more-engine-key-NOT-REAL',
      mode: 'fast',
      maxResults: 10,
      dailyLimit: 0,
      cacheTtlMs: 60000
    });
    Object.assign(config.serpapi, original.serpapi, { enabled: false, minInternalResults: 3 });
    parallelSearch = jest.spyOn(parallelClient, 'search').mockResolvedValue({ results: [] });
    jest.spyOn(serpApiClient, 'searchGoogle').mockRejectedValue(new Error('not asked'));
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('batches over a run of equal scores give every page once, in the numbered pages’ order', async () => {
    const batches = await everyBatch({ q: 'tiebreak', limit: 10, batch: 7 });
    const loaded = batches.flatMap(b => b.results.map(r => r.url));
    expect(loaded).toHaveLength(23);
    expect(new Set(loaded).size).toBe(23);
    // The same order as reading the numbered pages one after another.
    const paged = [];
    for (let page = 1; page <= 3; page += 1) {
      paged.push(...(await search({ q: 'tiebreak', page })).body.data.results.map(r => r.url));
    }
    expect(loaded).toEqual(paged);
    expect(batches.map(b => b.results.length)).toEqual([10, 7, 6]);
    expect(batches[batches.length - 1].hasMore).toBe(false);
  });

  it('an external result for a page the index holds is never shown, in any batch', async () => {
    // A weak query: Parallel is asked, and part of its answer is pages the index has.
    parallelSearch.mockResolvedValue({
      results: [
        ...[0, 1, 2, 3].map(i => ({
          url: `https://food.example/coimbatore-${i}`,
          title: `Coimbatore restaurants ${i}`,
          excerpts: ['Restaurants in Coimbatore.']
        })),
        ...Array.from({ length: 14 }, (_, i) => ({
          url: `https://guide.example/coimbatore-restaurants-${i}`,
          title: `Best restaurants in Coimbatore ${i}`,
          excerpts: ['Restaurants in Coimbatore, reviewed.']
        }))
      ]
    });
    const batches = await everyBatch({ q: 'best restaurants in coimbatore' });
    const shown = batches.flatMap(b => b.results);
    const byUrl = new Map();
    shown.forEach(r => byUrl.set(r.url, (byUrl.get(r.url) || 0) + 1));
    expect([...byUrl.values()].every(n => n === 1)).toBe(true);
    // The four indexed pages appear once, as the index's own results.
    for (let i = 0; i < 4; i += 1) {
      const url = `https://food.example/coimbatore-${i}`;
      expect(shown.filter(r => r.url === url).map(r => r.source)).toEqual(['index']);
    }
    // All 14 external pages the index does not hold are shown, across batches.
    expect(shown.filter(r => r.source === 'parallel')).toHaveLength(14);
    // External results lead, as the first page placed them (no page is about the query).
    expect(batches[0].results[0].source).toBe('parallel');
    expect(batches[batches.length - 1].hasMore).toBe(false);
  });

  it('the topical filter for a weak index holds in every batch: no page that merely shares a word', async () => {
    const batches = await everyBatch({ q: 'best restaurants in coimbatore', limit: 10, batch: 2 });
    const fromIndex = batches.flatMap(b => b.results).filter(r => r.source === 'index');
    expect(fromIndex.map(r => r.url).sort()).toEqual(
      [0, 1, 2, 3].map(i => `https://food.example/coimbatore-${i}`)
    );
    expect(fromIndex.some(r => /travel\.example/.test(r.url))).toBe(false);
  });

  it('News: an article and its archived copy appear once, across every batch', async () => {
    const batches = await everyBatch({ q: 'quantum chips', category: 'news', limit: 2, batch: 2 });
    const shown = batches.flatMap(b => b.results.map(r => r.url));
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown).toContain('https://www.magazine.example/quantum-chips');
    expect(shown.some(url => url.startsWith('https://web.archive.org/'))).toBe(false);
    expect(shown).toHaveLength(batches[0].total);
    expect(batches[batches.length - 1].hasMore).toBe(false);
    // News is the index's alone.
    expect(parallelSearch).not.toHaveBeenCalled();
  });
});
