/**
 * The modifiedAt field on an index created before it existed — as every
 * index in use is. Adding it must touch nothing else: no reindex, no
 * document changed, and pages with and without the date both index.
 *
 * Skipped (not passed) when no cluster is reachable. Uses its own index.
 */

const previousEngine = process.env.SEARCH_ENGINE;
const previousIndex = process.env.OPENSEARCH_INDEX;
const INDEX_NAME = 'ph-google-pages-modified-test';
process.env.SEARCH_ENGINE = 'opensearch';
process.env.OPENSEARCH_INDEX = INDEX_NAME;

const {
  checkHealth,
  closeClient,
  resetClient,
  getClient
} = require('../../services/opensearch/client');
const {
  ensureIndex,
  refreshIndex,
  addMissingFields
} = require('../../services/opensearch/indexManager');
const { buildIndexDefinition } = require('../../services/opensearch/indexSettings');
const {
  bulkIndexPages,
  resetIndexReadyFlag
} = require('../../services/opensearch/indexingService');
const openSearch = require('../../services/opensearch/searchService');
const { config } = require('../../config/env');

const available = process.env.OPENSEARCH_AVAILABLE === 'true';
const describeLive = available ? describe : describe.skip;

const page = (id, extra = {}) => ({
  _id: id,
  url: `https://lighthouse.example.org/${id}`,
  domain: 'lighthouse.example.org',
  title: `Lighthouse ${id}`,
  content: 'Lighthouse keepers trimmed wicks and polished lenses every night.',
  language: 'en',
  lastCrawledAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  ...extra
});

describeLive('modifiedAt on an existing index', () => {
  const mappingOf = async () => {
    const res = await getClient().indices.getMapping({ index: INDEX_NAME });
    return res.body[INDEX_NAME].mappings.properties;
  };

  beforeAll(async () => {
    if (config.searchEngine !== 'opensearch') throw new Error('needs SEARCH_ENGINE=opensearch');
    resetClient();
    const health = await checkHealth(true);
    if (!health.ok) throw new Error(`OpenSearch unreachable at ${health.node}`);

    // The index as it was created before the field existed.
    try {
      await getClient().indices.delete({ index: INDEX_NAME });
    } catch {
      /* not there */
    }
    // A copy: the definition shares its mapping object with the code under test.
    const old = JSON.parse(JSON.stringify(buildIndexDefinition()));
    delete old.mappings.properties.modifiedAt;
    await getClient().indices.create({ index: INDEX_NAME, body: old });
    // A page stored then, without the field.
    await getClient().index({
      index: INDEX_NAME,
      id: 'before',
      body: {
        url: 'https://lighthouse.example.org/before',
        title: 'Lighthouse before',
        content: 'Lighthouse keepers.'
      },
      refresh: true
    });
  }, 120000);

  afterAll(async () => {
    try {
      await getClient().indices.delete({ index: INDEX_NAME });
    } catch {
      /* already gone */
    }
    await closeClient();
    process.env.SEARCH_ENGINE = previousEngine;
    process.env.OPENSEARCH_INDEX = previousIndex;
  });

  it('starts without the field, and refuses a document carrying it (strict mapping)', async () => {
    expect((await mappingOf()).modifiedAt).toBeUndefined();
    await expect(
      getClient().index({
        index: INDEX_NAME,
        id: 'too-early',
        body: { url: 'https://x.example/', modifiedAt: '2026-10-01T00:00:00Z' }
      })
    ).rejects.toThrow(/strict/);
  });

  it('ensureIndex adds it — and only it — without touching what is stored', async () => {
    const before = await mappingOf();
    await ensureIndex(INDEX_NAME);
    const after = await mappingOf();
    expect(after.modifiedAt).toEqual({ type: 'date' });
    const { modifiedAt: _added, ...rest } = after;
    expect(rest).toEqual(before);
    // The page stored before is still there, unchanged.
    const stored = await getClient().get({ index: INDEX_NAME, id: 'before' });
    expect(stored.body._source).toEqual({
      url: 'https://lighthouse.example.org/before',
      title: 'Lighthouse before',
      content: 'Lighthouse keepers.'
    });
    // A second run adds nothing.
    expect(await addMissingFields(INDEX_NAME)).toEqual([]);
  });

  it('pages with and without the date then index, and search shows the date only where there is one', async () => {
    resetIndexReadyFlag();
    const summary = await bulkIndexPages([
      page('dated', { modifiedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }),
      page('undated')
    ]);
    expect(summary.errors || []).toEqual([]);
    await refreshIndex(INDEX_NAME);

    const outcome = await openSearch.search({ query: 'lighthouse keepers', limit: 10 });
    const byUrl = Object.fromEntries(outcome.results.map(r => [r.url, r]));
    const dated = byUrl['https://lighthouse.example.org/dated'];
    const undated = byUrl['https://lighthouse.example.org/undated'];
    expect(dated.modifiedLabel).toMatchObject({ text: 'Modified 3 days ago' });
    expect(undated.modifiedAt).toBeNull();
    expect(undated.modifiedLabel).toBeNull();
    // The crawl date is shown as before, for both.
    expect(dated.dateLabel.kind).toBe('crawled');
    expect(undated.dateLabel.kind).toBe('crawled');
  });
});
