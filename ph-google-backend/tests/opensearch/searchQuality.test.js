/**
 * Search quality regressions on the OpenSearch engine, from fixed pages:
 * the order results come in, the date each one shows, and which pages an AI
 * answer is written from.
 *
 *   python, learn python, python tutorial for beginners,
 *   Python official documentation, chicken biryani recipe, a news query,
 *   and an English query that a Japanese page must not answer first.
 *
 * No provider is asked (setupTests switches them off), no query or site is
 * named in the code under test: the pages below are ordinary fixtures.
 *
 * Skipped (not passed) when no cluster is reachable. Uses its own index.
 */

const previousEngine = process.env.SEARCH_ENGINE;
const previousIndex = process.env.OPENSEARCH_INDEX;
const INDEX_NAME = 'ph-google-pages-quality-test';
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
const retrievalService = require('../../services/ai/retrievalService');
const aiAnswerService = require('../../services/ai/aiAnswerService');
const llm = require('../../services/ai/llm');
const { config } = require('../../config/env');

const available = process.env.OPENSEARCH_AVAILABLE === 'true';
const describeLive = available ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;
/** The index keeps addresses without a trailing slash. */
const bare = url => String(url).replace(/\/$/, '');
const ago = ms => new Date(Date.now() - ms);

const page = (id, url, title, content, extra = {}) => ({
  _id: id,
  url,
  domain: new URL(url).hostname,
  title,
  description: extra.description || '',
  content,
  language: 'en',
  lastCrawledAt: ago(3 * DAY),
  ...extra
});

const PAGES = [
  page(
    'py-wiki',
    'https://en.wikipedia.org/wiki/Python_(programming_language)',
    'Python (programming language) - Wikipedia',
    'Python is a high-level, general-purpose programming language. Its design philosophy emphasizes code readability. Python is dynamically typed and garbage-collected. It supports multiple programming paradigms, including structured, object-oriented and functional programming. Python was conceived in the late 1980s by Guido van Rossum.',
    {
      description: 'Python is a high-level programming language.',
      publishedAt: new Date('2001-10-29T18:24:39Z')
    }
  ),
  page(
    'py-ja',
    'https://ja.wikipedia.org/wiki/Python',
    'Python - Wikipedia',
    'Python（パイソン）は、汎用のプログラミング言語である。Python はコードの可読性を重視した設計になっている。Python Python Python の標準ライブラリは豊富で、科学技術計算や機械学習で広く使われている。',
    { language: 'ja', description: 'Python はプログラミング言語。' }
  ),
  page(
    'py-docs',
    'https://docs.python.org/3/',
    'Python 3 documentation',
    'Welcome to the official Python documentation. The Python tutorial: start here for a tour of Python syntax and features. Library reference, language reference, Python setup and usage, Python HOWTOs and installing Python modules. Official documentation for the Python programming language.',
    { description: 'The official Python documentation.' }
  ),
  page(
    'py-tutorial',
    'https://docs.python.org/3/tutorial/',
    'The Python Tutorial — Python 3 documentation',
    'Python is an easy to learn, powerful programming language. This tutorial introduces the reader informally to the basic concepts and features of the Python language. Learn Python step by step: using the Python interpreter, an informal introduction to Python, control flow tools, data structures, modules.',
    { description: 'The official Python tutorial for beginners and experienced programmers.' }
  ),
  page(
    'py-beginners',
    'https://www.w3schools.com/python/',
    'Python Tutorial for Beginners',
    'Learn Python. Python is a popular programming language. This Python tutorial for beginners teaches Python from the basics: Python syntax, variables, data types, loops and functions, with an example for every chapter. Start learning Python now.',
    { description: 'Learn Python with a tutorial for beginners.' }
  ),
  page(
    'py-functional',
    'https://en.wikipedia.org/wiki/Functional_programming',
    'Functional programming - Wikipedia',
    'In computer science, functional programming is a programming paradigm where programs are constructed by applying and composing functions. Many languages support it, among them Lisp, Haskell, Scala and Python.',
    { publishedAt: new Date('2001-10-14T13:58:27Z') }
  ),
  page(
    'biryani',
    'https://recipes.example.com/chicken-biryani',
    'Chicken Biryani Recipe',
    'This chicken biryani recipe layers marinated chicken with fragrant basmati rice, fried onions, mint and saffron. Cook the chicken in yogurt and spices, par-boil the rice, then layer and steam. Chicken biryani serves six.',
    { description: 'A step-by-step chicken biryani recipe.' }
  ),
  page(
    'curry',
    'https://recipes.example.com/chicken-curry',
    'Easy Chicken Curry',
    'A quick chicken curry with tomatoes, onions and garam masala. Serve with rice or naan. Not a biryani, but a weeknight favourite.',
    { description: 'A quick chicken curry recipe.' }
  ),
  page(
    'news-release',
    'https://news.example.com/python-3-14-released',
    'Python 3.14 released with free-threaded mode',
    'The Python core team announced the release of Python 3.14 today. The release news includes an official free-threaded build and a new interpreter. Python developers can download the release now.',
    {
      isArticle: true,
      publishedAt: ago(2 * DAY),
      siteName: 'Example News',
      description: 'Python 3.14 release news.'
    }
  ),
  page(
    'news-undated',
    'https://news.example.com/python-community',
    'Python community news roundup',
    'News from the Python community: conferences, release news and user groups.',
    { isArticle: true, description: 'Python community news.' }
  )
];

const idOf = url => {
  const found = PAGES.find(p => bare(p.url) === bare(url));
  if (!found) throw new Error(`not a fixture: ${url}`);
  return found._id;
};

describeLive('search quality on the OpenSearch engine', () => {
  let app;
  const get = params => request(app).get('/api/search').query(params);
  const idsOf = res => res.body.data.results.map(r => idOf(r.url));
  const position = (ids, id) => ids.indexOf(id);

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
  });

  // ------------------------------------------------------------------
  describe('an English query is answered in English first', () => {
    it('"python": the Japanese article comes after every English page about Python', async () => {
      const ids = idsOf(await get({ q: 'python', limit: 20 }));
      expect(ids).toContain('py-ja'); // still found: nothing is hidden
      for (const id of ['py-wiki', 'py-docs', 'py-tutorial', 'py-beginners', 'news-release']) {
        expect(position(ids, id)).toBeLessThan(position(ids, 'py-ja'));
      }
      // A page that only mentions Python is not above the pages about it.
      expect(position(ids, 'py-functional')).toBeGreaterThan(position(ids, 'py-wiki'));
    });

    it('asked for Japanese, the Japanese article is the answer', async () => {
      const ids = idsOf(await get({ q: 'python', language: 'ja' }));
      expect(ids).toEqual(['py-ja']);
      const viaOperator = idsOf(await get({ q: 'python lang:ja' }));
      expect(viaOperator).toEqual(['py-ja']);
    });

    it('the language weight lowers the Japanese page and leaves English scores as they were', async () => {
      const english = await get({ q: 'python', limit: 20 });
      const japaneseOnly = await get({ q: 'python', language: 'ja' });
      const weighted = english.body.data.results.find(r => r.url.includes('ja.wikipedia'));
      const unweighted = japaneseOnly.body.data.results[0];
      expect(weighted.score).toBeCloseTo(unweighted.score * 0.2, 1);
    });
  });

  describe('learning queries surface tutorials and documentation', () => {
    it('"learn python": the tutorials lead, ahead of reference and paradigm pages', async () => {
      const ids = idsOf(await get({ q: 'learn python' }));
      expect(ids.slice(0, 2).sort()).toEqual(['py-beginners', 'py-tutorial']);
      // The paradigm page never mentions learning: not among the tutorials.
      expect(ids.slice(0, 2)).not.toContain('py-functional');
      expect(ids).not.toContain('py-ja');
    });

    it('"python tutorial for beginners": the beginners’ tutorial first, then the official tutorial', async () => {
      const ids = idsOf(await get({ q: 'python tutorial for beginners' }));
      expect(ids.slice(0, 2)).toEqual(['py-beginners', 'py-tutorial']);
      expect(ids).not.toContain('biryani');
    });

    it('"Python official documentation": the official documentation first', async () => {
      const ids = idsOf(await get({ q: 'Python official documentation' }));
      expect(ids[0]).toBe('py-docs');
      expect(ids.slice(0, 3)).toContain('py-tutorial');
    });
  });

  describe('other topics are untouched by any of this', () => {
    it('"chicken biryani recipe": the biryani recipe, then the curry; nothing about Python', async () => {
      const ids = idsOf(await get({ q: 'chicken biryani recipe' }));
      expect(ids[0]).toBe('biryani');
      expect(ids.filter(id => id.startsWith('py-') || id.startsWith('news-'))).toEqual([]);
    });

    it('a news query on the News tab: dated articles, newest first, labelled "Published"', async () => {
      const res = await get({ q: 'python release news', category: 'news' });
      const ids = res.body.data.results.map(r => idOf(r.url));
      expect(ids[0]).toBe('news-release');
      expect(res.body.data.appliedSort).toBe('newest');
    });
  });

  describe('the date each result shows', () => {
    const byId = async (q, params = {}) => {
      const res = await get({ q, limit: 20, ...params });
      return Object.fromEntries(res.body.data.results.map(r => [idOf(r.url), r]));
    };

    it('a reference page created in 2001: when it was crawled, said so — not "24 years ago"', async () => {
      const results = await byId('python');
      expect(results['py-wiki'].publishedAt).toBe('2001-10-29T18:24:39.000Z'); // kept as data
      expect(results['py-wiki'].publishedAgo).toBeNull();
      expect(results['py-wiki'].dateLabel).toMatchObject({
        kind: 'crawled',
        text: 'Crawled 3 days ago'
      });
    });

    it('an article: its publication date, said so', async () => {
      const results = await byId('python release');
      expect(results['news-release'].dateLabel).toMatchObject({
        kind: 'published',
        text: 'Published 2 days ago'
      });
      expect(results['news-release'].publishedAgo).toBe('2 days ago');
    });

    it('an article with no publication date: the crawl date, labelled as one', async () => {
      const results = await byId('python community');
      expect(results['news-undated'].publishedAt).toBeNull();
      expect(results['news-undated'].dateLabel).toMatchObject({
        kind: 'crawled',
        text: 'Crawled 3 days ago'
      });
    });
  });

  describe('the AI answer is written from the most relevant pages it retrieved', () => {
    const savedAi = { ...config.ai };
    let generate;

    beforeEach(() => {
      Object.assign(config.ai, savedAi, { enabled: true });
      aiAnswerService.clearCache();
      generate = jest.fn().mockResolvedValue({
        text: JSON.stringify({
          sufficient_evidence: true,
          answer: 'Python is a high-level programming language [1].',
          key_points: ['Emphasises readability [1]'],
          cited_sources: [1]
        }),
        model: 'stub-model-1',
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 }
      });
      llm.setProvider({ name: 'stub', model: 'stub-model-1', isConfigured: () => true, generate });
    });
    afterAll(() => {
      Object.assign(config.ai, savedAi);
      llm.resetProvider();
    });

    it('retrieval ranks the pages about the query first and leaves out the Japanese one', async () => {
      const { documents } = await retrievalService.retrieve({ query: 'python' });
      const ids = documents.map(d => idOf(d.url));
      expect(ids).not.toContain('py-ja');
      expect(ids).not.toContain('biryani');
      expect(ids.length).toBeGreaterThan(0);
      // Each one is about Python: its title says so.
      for (const doc of documents) expect(doc.title).toMatch(/python/i);
    });

    it('asked in Japanese, the Japanese page is evidence', async () => {
      const { documents } = await retrievalService.retrieve({ query: 'python', language: 'ja' });
      expect(documents.map(d => idOf(d.url))).toEqual(['py-ja']);
    });

    it('the answer cites a retrieved page, given to the model as numbered evidence', async () => {
      const res = await request(app)
        .get('/api/ai-answer')
        .query({ q: 'python tutorial for beginners' });
      expect(res.status).toBe(200);
      const { data } = res.body;
      expect(data.status).toBe('ok');
      // The cited source [1] is the best-matching page, not the first indexed.
      expect(bare(data.sources[0].url)).toBe('https://www.w3schools.com/python');
      expect(data.sources.map(s => s.url)).not.toContain('https://ja.wikipedia.org/wiki/Python');
      const prompt = JSON.stringify(generate.mock.calls[0]);
      expect(prompt).toContain('Python Tutorial for Beginners');
      expect(prompt).not.toContain('パイソン');
    });
  });
});
