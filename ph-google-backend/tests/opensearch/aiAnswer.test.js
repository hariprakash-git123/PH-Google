/**
 * AI answers with OpenSearch as the engine.
 *
 * The default suite proves the endpoint on the superseded engine. This one
 * runs the same request with the production engine behind it, to prove the
 * retrieval step: candidates come from the real ranked search, and the text
 * the answer is written from is read back out of the index for exactly those
 * documents. The model is still a stub — the only test double.
 *
 * Skipped (not passed) when no cluster is reachable. Uses its own index.
 */

const previousEngine = process.env.SEARCH_ENGINE;
const previousIndex = process.env.OPENSEARCH_INDEX;
const INDEX_NAME = 'ph-google-pages-ai-test';
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
const { buildDocumentId } = require('../../services/opensearch/documentMapper');
const retrievalService = require('../../services/ai/retrievalService');
const aiAnswerService = require('../../services/ai/aiAnswerService');
const llm = require('../../services/ai/llm');
const { config } = require('../../config/env');

const available = process.env.OPENSEARCH_AVAILABLE === 'true';
const describeLive = available ? describe : describe.skip;

const page = (id, url, title, content, extra = {}) => ({
  _id: id,
  url,
  domain: new URL(url).hostname,
  title,
  description: `${title}.`,
  content,
  language: 'en',
  lastCrawledAt: new Date(Date.now() - 60 * 60 * 1000),
  ...extra
});

const FILLER =
  'The project publishes regular releases and maintains documentation for administrators. ';

const PAGES = [
  page(
    'os-docs',
    'https://opensearch.org/docs/latest/about',
    'About OpenSearch',
    'Skip to main content. We use cookies to improve your experience on this site. ' +
      FILLER.repeat(6) +
      'OpenSearch is an open-source search and analytics suite that provides distributed full-text search. ' +
      'An OpenSearch cluster stores each index as shards spread across nodes. ' +
      FILLER.repeat(6) +
      'Copyright 2026 OpenSearch contributors. All rights reserved.'
  ),
  page(
    'os-wiki',
    'https://en.wikipedia.org/wiki/OpenSearch_(software)',
    'OpenSearch (software) - Wikipedia',
    'OpenSearch is a family of software consisting of a search engine and OpenSearch Dashboards. ' +
      'It was created in 2021 as a fork of Elasticsearch and Kibana and is licensed under Apache 2.0.'
  ),
  // The same article at a second address: one source, not two.
  page(
    'os-mirror',
    'https://mirror.example.net/opensearch-software',
    'OpenSearch (software) mirror',
    'OpenSearch is a family of software consisting of a search engine and OpenSearch Dashboards. ' +
      'It was created in 2021 as a fork of Elasticsearch and Kibana and is licensed under Apache 2.0.'
  ),
  page(
    'crawler',
    'https://example.org/how-web-crawlers-work',
    'How web crawlers work',
    'A web crawler starts from seed pages, downloads them, and follows the links it finds. ' +
      'It keeps a frontier of pages still to visit and obeys the rules in robots.txt. ' +
      'Crawled pages are parsed and added to a search index.'
  ),
  page(
    'gardening',
    'https://example.com/tomatoes',
    'Growing tomatoes',
    'Tomatoes need warmth, regular watering and plenty of sunlight to produce fruit in summer.'
  )
];

describeLive('AI answers on OpenSearch', () => {
  let app;
  let generate;
  const savedAi = { ...config.ai };
  const ask = params => request(app).get('/api/ai-answer').query(params);

  const reply = (overrides = {}) => ({
    text: JSON.stringify({
      sufficient_evidence: true,
      answer:
        'OpenSearch is an open-source search and analytics suite [1]. It began as a fork of Elasticsearch [2].',
      key_points: ['Distributed full-text search [1]'],
      cited_sources: [1, 2],
      ...overrides
    }),
    model: 'stub-model-1',
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1 }
  });

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
  }, 120000);

  afterAll(async () => {
    Object.assign(config.ai, savedAi);
    llm.resetProvider();
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
    Object.assign(config.ai, savedAi, { enabled: true });
    aiAnswerService.clearCache();
    generate = jest.fn().mockResolvedValue(reply());
    llm.setProvider({ name: 'stub', model: 'stub-model-1', isConfigured: () => true, generate });
  });

  describe('retrieval', () => {
    it('returns the ranked search results with the page text read from the index', async () => {
      const outcome = await retrievalService.retrieve({ query: 'What is OpenSearch?' });

      expect(outcome.engine).toBe('opensearch');
      expect(outcome.documents.length).toBeGreaterThanOrEqual(2);
      const docs = Object.fromEntries(outcome.documents.map(d => [d.url, d]));
      const about = docs['https://opensearch.org/docs/latest/about'];

      expect(about).toBeDefined();
      expect(about.id).toBe(buildDocumentId('https://opensearch.org/docs/latest/about'));
      // The full stored text, not the 300-character snippet.
      expect(about.content.length).toBeGreaterThan(600);
      expect(about.content).toMatch(/stores each index as shards spread across nodes/);
      expect(about.title).toBe('About OpenSearch');
      expect(about.domain).toBe('opensearch.org');
      expect(about.score).toBeGreaterThan(0);
      expect(about.contentHash).toMatch(/^[0-9a-f]{40}$/);
    });

    it('does not hand over documents that are not about the query', async () => {
      const outcome = await retrievalService.retrieve({ query: 'opensearch' });
      const urls = outcome.documents.map(d => d.url);
      expect(urls).not.toContain('https://example.com/tomatoes');
      expect(urls).not.toContain('https://example.org/how-web-crawlers-work');
    });

    it('applies the same filters as search', async () => {
      const outcome = await retrievalService.retrieve({
        query: 'opensearch',
        domain: 'en.wikipedia.org'
      });
      expect(outcome.documents.map(d => d.domain)).toEqual(['en.wikipedia.org']);
    });

    it('returns nothing for a query that matches nothing', async () => {
      const outcome = await retrievalService.retrieve({ query: 'xylophone zeppelin quasar' });
      expect(outcome.documents).toEqual([]);
      expect(outcome.totalResults).toBe(0);
    });
  });

  describe('GET /api/ai-answer', () => {
    it('answers from the index, and every source is a document in it', async () => {
      const res = await ask({ q: 'What is OpenSearch?' });

      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.status).toBe('ok');
      expect(data.generated).toBe(true);
      expect(data.sources.length).toBeGreaterThanOrEqual(1);

      const indexed = new Set(PAGES.map(p => p.url));
      for (const source of data.sources) expect(indexed.has(source.url)).toBe(true);
    });

    it('gives the model cleaned page text: content in, page furniture out', async () => {
      await ask({ q: 'What is OpenSearch?' });
      const prompt = generate.mock.calls[0][0];

      expect(prompt.user).toMatch(/open-source search and analytics suite/);
      expect(prompt.user).not.toMatch(/We use cookies/);
      expect(prompt.user).not.toMatch(/Skip to main content/);
      expect(prompt.user).not.toMatch(/All rights reserved/);
    });

    it('keeps the evidence within the configured budget', async () => {
      config.ai.maxCharsPerSource = 300;
      config.ai.maxContextChars = 500;
      await ask({ q: 'What is OpenSearch?' });

      const prompt = generate.mock.calls[0][0];
      const blocks = [...prompt.user.matchAll(/<content>\n([\s\S]*?)\n<\/content>/g)].map(
        m => m[1]
      );
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      for (const block of blocks) expect(block.length).toBeLessThanOrEqual(300);
      expect(blocks.reduce((sum, b) => sum + b.length, 0)).toBeLessThanOrEqual(500);
    });

    it('the mirrored article is one source', async () => {
      await ask({ q: 'opensearch fork of elasticsearch' });
      const prompt = generate.mock.calls[0][0];
      const mentions = prompt.user.match(/created in 2021 as a fork of Elasticsearch/g) || [];
      expect(mentions).toHaveLength(1);
    });

    it('nothing in the index for the query: no results, model not called', async () => {
      const res = await ask({ q: 'xylophone zeppelin quasar' });
      expect(res.body.data.status).toBe('no_results');
      expect(generate).not.toHaveBeenCalled();
    });

    it('search results are the same documents the answer was built from', async () => {
      const [answer, search] = await Promise.all([
        ask({ q: 'how do web crawlers work' }),
        request(app).get('/api/search').query({ q: 'how do web crawlers work' })
      ]);
      generate.mockClear();

      expect(search.status).toBe(200);
      const searchUrls = search.body.data.results.map(r => r.url);
      expect(searchUrls).toContain('https://example.org/how-web-crawlers-work');
      expect(answer.body.data.intent).toBe('how-to');
      for (const source of answer.body.data.sources) expect(searchUrls).toContain(source.url);
    });
  });
});
