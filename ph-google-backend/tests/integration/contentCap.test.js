/**
 * Page.content storage cap.
 *
 * MongoDB stores at most MAX_CONTENT_CHARS of extracted text per page — the
 * same bound OpenSearch already indexed — so the search document must come
 * out identical with or without the cap, and a reindex must still read
 * Page.content (including rows written before the cap existed).
 *
 * The OpenSearch transport is mocked: these tests cover what the crawler and
 * reindex job hand to OpenSearch, not the cluster itself.
 */

jest.mock('../../services/opensearch/indexingService', () => ({
  indexPage: jest.fn(async () => ({ ok: true })),
  bulkIndexPages: jest.fn(async pages => ({
    indexed: pages.length,
    failed: 0,
    total: pages.length,
    errors: []
  })),
  deletePage: jest.fn(async () => ({ ok: true }))
}));
jest.mock('../../services/opensearch/client', () => ({
  checkHealth: jest.fn(async () => ({ ok: true }))
}));
jest.mock('../../services/opensearch/indexManager', () => ({
  recreateIndex: jest.fn(async () => {}),
  ensureIndex: jest.fn(async () => {}),
  refreshIndex: jest.fn(async () => {}),
  getIndexStats: jest.fn(async () => ({ exists: true, documentCount: 0 }))
}));

const testDb = require('../helpers/testDb');
const { indexPage, capStoredContent } = require('../../crawler/indexer');
const openSearchIndexing = require('../../services/opensearch/indexingService');
const reindexService = require('../../services/opensearch/reindexService');
const { toSearchDocument, MAX_CONTENT_CHARS } = require('../../services/opensearch/documentMapper');
const Page = require('../../models/Page');
const Website = require('../../models/Website');
const { config } = require('../../config/env');

const BASE = 'http://content-cap.test';

/**
 * Body text of exactly `length` characters that extractText returns
 * verbatim: single spaces, no leading or trailing whitespace.
 */
function textOfLength(length, tail = '') {
  const filler = 'alpha beta gamma delta epsilon zeta '.repeat(Math.ceil(length / 36) + 1);
  const body = filler.slice(0, length - tail.length - 1).trimEnd();
  const padded = body + 'x'.repeat(length - tail.length - body.length);
  return padded + tail;
}

const htmlFor = text => `<html><body><p>${text}</p></body></html>`;

beforeAll(async () => {
  await testDb.connect();
});

afterAll(async () => {
  await testDb.disconnect();
});

beforeEach(async () => {
  await testDb.clear();
  jest.clearAllMocks();
  reindexService.resetJob();
});

describe('capStoredContent', () => {
  it('uses the same bound as the OpenSearch mapper', () => {
    expect(MAX_CONTENT_CHARS).toBe(60000);
  });

  it('leaves shorter content unchanged', () => {
    const text = textOfLength(59999);
    expect(capStoredContent(text)).toBe(text);
  });

  it('leaves content of exactly the limit unchanged', () => {
    const text = textOfLength(60000);
    expect(capStoredContent(text)).toBe(text);
  });

  it('caps longer content to the limit', () => {
    const text = textOfLength(60001);
    expect(capStoredContent(text)).toBe(text.slice(0, 60000));
  });

  it('treats missing content as empty', () => {
    expect(capStoredContent(undefined)).toBe('');
    expect(capStoredContent(null)).toBe('');
  });
});

describe('indexPage stores capped content in MongoDB', () => {
  it('stores content shorter than the limit unchanged', async () => {
    const text = textOfLength(1234);
    await indexPage(`${BASE}/short`, htmlFor(text), { title: 'Short' });

    const page = await Page.findOne({ url: `${BASE}/short` }).lean();
    expect(page.content).toBe(text);
  });

  it('stores content of exactly 60,000 characters unchanged', async () => {
    const text = textOfLength(60000);
    await indexPage(`${BASE}/exact`, htmlFor(text), { title: 'Exact' });

    const page = await Page.findOne({ url: `${BASE}/exact` }).lean();
    expect(page.content).toHaveLength(60000);
    expect(page.content).toBe(text);
  });

  it('caps content longer than 60,000 characters', async () => {
    const text = textOfLength(90000, ' overflowmarker');
    await indexPage(`${BASE}/long`, htmlFor(text), { title: 'Long' });

    const page = await Page.findOne({ url: `${BASE}/long` }).lean();
    expect(page.content).toHaveLength(60000);
    expect(page.content).toBe(text.slice(0, 60000));
    expect(page.content).not.toContain('overflowmarker');
  });

  it('caps content again when a page is re-crawled', async () => {
    await indexPage(`${BASE}/recrawl`, htmlFor(textOfLength(100)), {});
    await indexPage(`${BASE}/recrawl`, htmlFor(textOfLength(75000)), {});

    const pages = await Page.find({ url: `${BASE}/recrawl` }).lean();
    expect(pages).toHaveLength(1);
    expect(pages[0].content).toHaveLength(60000);
  });

  it('keeps the page indexed and its Website record intact', async () => {
    const result = await indexPage(`${BASE}/status`, htmlFor(textOfLength(70000)), {});

    expect(result.ok).toBe(true);
    const page = await Page.findOne({ url: `${BASE}/status` }).lean();
    expect(page.status).toBe('indexed');
    await expect(Website.countDocuments({ domain: 'content-cap.test' })).resolves.toBe(1);
  });
});

describe('OpenSearch receives the same searchable content', () => {
  let previousEngine;

  beforeEach(() => {
    previousEngine = config.searchEngine;
    config.searchEngine = 'opensearch';
  });

  afterEach(() => {
    config.searchEngine = previousEngine;
  });

  it.each([
    ['shorter than', 5000],
    ['exactly', 60000],
    ['longer than', 90000]
  ])('produces an unchanged search document for content %s the limit', async (_label, length) => {
    const text = textOfLength(length);
    const html = htmlFor(text);
    const metadata = { title: 'Mapped page', description: 'desc', statusCode: 200 };

    await indexPage(`${BASE}/os-${length}`, html, metadata);

    expect(openSearchIndexing.indexPage).toHaveBeenCalledTimes(1);
    const [sentPage, extra] = openSearchIndexing.indexPage.mock.calls[0];
    expect(sentPage.content).toBe(text.slice(0, 60000));

    // What OpenSearch would have indexed from the uncapped text before this
    // change must equal what it indexes now.
    const before = toSearchDocument({ ...sentPage, content: text }, extra);
    const after = toSearchDocument(sentPage, extra);
    expect(after.id).toBe(before.id);
    expect({ ...after.document, crawledAt: null }).toEqual({
      ...before.document,
      crawledAt: null
    });
    expect(after.document.content).toBe(text.slice(0, 60000));
  });
});

describe('reindexService reads Page.content', () => {
  it('passes stored content through to the bulk indexer', async () => {
    const text = textOfLength(90000);
    await indexPage(`${BASE}/reindex-new`, htmlFor(text), { title: 'New' });

    const job = await reindexService.runReindex({ batchSize: 10 });

    expect(job.status).toBe('completed');
    expect(job.indexed).toBe(1);
    const [pages] = openSearchIndexing.bulkIndexPages.mock.calls[0];
    expect(pages).toHaveLength(1);
    expect(pages[0].content).toBe(text.slice(0, 60000));
    expect(toSearchDocument(pages[0]).document.content).toBe(text.slice(0, 60000));
  });

  it('still reindexes pre-cap rows without rewriting them', async () => {
    // A row written before the cap: inserted directly, bypassing the indexer.
    const legacy = textOfLength(120000);
    const website = await Website.create({ domain: 'content-cap.test' });
    await Page.collection.insertOne({
      websiteId: website._id,
      url: `${BASE}/legacy`,
      domain: 'content-cap.test',
      title: 'Legacy',
      content: legacy,
      status: 'indexed'
    });

    const job = await reindexService.runReindex({ batchSize: 10 });

    expect(job.status).toBe('completed');
    const [pages] = openSearchIndexing.bulkIndexPages.mock.calls[0];
    expect(pages[0].content).toBe(legacy);
    // The mapper still bounds what OpenSearch indexes.
    expect(toSearchDocument(pages[0]).document.content).toBe(legacy.slice(0, 60000));

    // Reindexing reads MongoDB; it neither deletes nor rewrites the row.
    const stored = await Page.findOne({ url: `${BASE}/legacy` }).lean();
    expect(stored.content).toBe(legacy);
  });
});
