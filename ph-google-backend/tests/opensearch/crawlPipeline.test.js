/**
 * Crawl -> text processing -> OpenSearch -> search, against a real cluster.
 *
 * The relevance suite indexes a hand-built corpus directly. This one proves
 * the other half: that pages the crawler fetches actually land in
 * OpenSearch, with the fields search needs, exactly once, and can be found.
 *
 * Skipped (not passed) when no cluster is reachable, like the relevance
 * suite. Uses its own index so the two never disturb each other.
 */

const previousEngine = process.env.SEARCH_ENGINE;
const previousIndex = process.env.OPENSEARCH_INDEX;
process.env.SEARCH_ENGINE = 'opensearch';
process.env.OPENSEARCH_INDEX = 'ph-google-pages-crawl-test';

const testDb = require('../helpers/testDb');
const { startFixtureSite } = require('../helpers/fixtureSite');
const { drainCrawlQueue } = require('../helpers/crawlRunner');
const { clearRobotsCache } = require('../../crawler/robotsChecker');
const { clearHostPolicyCache } = require('../../crawler/hostPolicy');
const frontier = require('../../services/frontierService');
const CrawlJob = require('../../models/CrawlJob');
const CrawlFrontier = require('../../models/CrawlFrontier');
const Page = require('../../models/Page');
const {
  checkHealth,
  closeClient,
  resetClient,
  getClient
} = require('../../services/opensearch/client');
const {
  recreateIndex,
  refreshIndex,
  getIndexStats
} = require('../../services/opensearch/indexManager');
const { resetIndexReadyFlag, getDocument } = require('../../services/opensearch/indexingService');
const openSearch = require('../../services/opensearch/searchService');
const { normalizeUrl } = require('../../utils/urlNormalizer');
const { config } = require('../../config/env');

const available = process.env.OPENSEARCH_AVAILABLE === 'true';
const describeLive = available ? describe : describe.skip;

let site;

/** A topic-style job: explicit allowed domain and an exclude pattern. */
async function crawlFixture({ maxPages = 10 } = {}) {
  const seedUrl = normalizeUrl(site.url);
  const job = await CrawlJob.create({
    seedUrl,
    maxPages,
    maxDepth: 2,
    sameDomainOnly: true,
    allowedDomains: ['127.0.0.1'],
    excludePatterns: ['/private/'],
    crawlDelayMs: 0,
    topic: 'fixture',
    status: 'running',
    lastHeartbeatAt: new Date()
  });
  await frontier.addUrls([{ url: seedUrl, depth: 0, priority: 1000 }], { crawlJobId: job._id });
  await CrawlFrontier.updateOne(
    { url: seedUrl },
    { $set: { status: 'pending', crawlJobId: job._id, nextCrawlAt: new Date(), attempts: 0 } }
  );
  await drainCrawlQueue();
  await refreshIndex();
  return CrawlJob.findById(job._id).lean();
}

describeLive('crawl to OpenSearch pipeline', () => {
  beforeAll(async () => {
    if (config.searchEngine !== 'opensearch') {
      throw new Error('This suite must run with SEARCH_ENGINE=opensearch');
    }
    resetClient();
    const health = await checkHealth(true);
    if (!health.ok) throw new Error(`OpenSearch unreachable: ${health.error || ''}`);

    resetIndexReadyFlag();
    await recreateIndex();
    await testDb.connect();
    site = await startFixtureSite();
  }, 120000);

  afterAll(async () => {
    if (site) await site.close();
    await testDb.disconnect();
    try {
      await getClient().indices.delete({ index: 'ph-google-pages-crawl-test' });
    } catch {
      /* already gone */
    }
    await closeClient();
    process.env.SEARCH_ENGINE = previousEngine;
    process.env.OPENSEARCH_INDEX = previousIndex;
  });

  beforeEach(async () => {
    await testDb.clear();
    clearRobotsCache();
    clearHostPolicyCache();
  });

  it('indexes every crawled page in OpenSearch, and only those', async () => {
    // The job itself may still be open: the fixture's 404 page waits out a
    // retry backoff. Every page that could be fetched has been.
    const job = await crawlFixture();
    expect(job.pagesIndexed).toBeGreaterThan(1);

    const pages = await Page.countDocuments();
    expect(pages).toBeGreaterThan(1);
    expect((await getIndexStats()).documentCount).toBe(pages);
  });

  it('stores the fields search needs', async () => {
    await crawlFixture();
    const doc = await getDocument(`${site.url}/blog/indexing`);

    expect(doc).toBeTruthy();
    expect(doc.title).toBe('How Indexing Works');
    expect(doc.url).toBe(`${site.url}/blog/indexing`);
    expect(doc.domain).toBe('127.0.0.1');
    expect(doc.description).toMatch(/inverted indexes/);
    expect(doc.content).toMatch(/inverted index maps each term/);
    expect(doc.content).not.toMatch(/should never be indexed/);
    expect(doc.crawledAt).toBeTruthy();
  });

  it('makes crawled pages findable through search', async () => {
    await crawlFixture();
    const outcome = await openSearch.search({ query: 'inverted index' });

    expect(outcome.totalResults).toBeGreaterThan(0);
    expect(outcome.results[0].url).toBe(`${site.url}/blog/indexing`);
    expect(outcome.results[0].title).toBe('How Indexing Works');
  });

  it('keeps excluded and robots-blocked pages out of the index', async () => {
    await crawlFixture();
    expect(await getDocument(`${site.url}/private/secret`)).toBeNull();
    const outcome = await openSearch.search({ query: 'robots disallows' });
    expect(outcome.results.map(r => r.url)).not.toContain(`${site.url}/private/secret`);
  });

  it('does not duplicate documents when the same pages are crawled again', async () => {
    await crawlFixture();
    const first = (await getIndexStats()).documentCount;

    // Force every row back to pending, as a re-crawl would.
    await CrawlFrontier.updateMany({}, { $set: { status: 'pending', nextCrawlAt: new Date() } });
    await crawlFixture();

    expect((await getIndexStats()).documentCount).toBe(first);
  });
});
