/**
 * The search API over HTTP, with OpenSearch as the engine.
 *
 * The default suite forces SEARCH_ENGINE=mongo, so tests/integration/ proves
 * the API contract on the superseded engine only. This suite sends the same
 * kind of requests through the same controller with the production engine
 * behind it: filters, validation, page bounds, /api/search/config, the
 * lang: operator, symbol-only words and suggestions.
 *
 * Skipped (not passed) when no cluster is reachable. Uses its own index.
 */

const previousEngine = process.env.SEARCH_ENGINE;
const previousIndex = process.env.OPENSEARCH_INDEX;
const INDEX_NAME = 'ph-google-pages-api-test';
process.env.SEARCH_ENGINE = 'opensearch';
process.env.OPENSEARCH_INDEX = INDEX_NAME;

const request = require('supertest');
const mongoose = require('mongoose');
const testDb = require('../helpers/testDb');
const SearchLog = require('../../models/SearchLog');
const Term = require('../../models/Term');
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
const { parseQuery } = require('../../services/opensearch/queryParser');
const { config } = require('../../config/env');

const available = process.env.OPENSEARCH_AVAILABLE === 'true';
const describeLive = available ? describe : describe.skip;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = ms => new Date(Date.now() - ms);

const page = (id, url, title, content, extra = {}) => ({
  _id: id,
  url,
  domain: new URL(url).hostname,
  title,
  description: `${title}.`,
  content,
  language: 'en',
  lastCrawledAt: ago(HOUR),
  ...extra
});

const PAGES = [
  // --- "python" in four languages, at five ages -------------------------
  // py-en (crawled an hour ago) and py-unknown state no publication date;
  // the others do. A date window holds only pages published inside it.
  page(
    'py-en',
    'https://python.example.com/about',
    'Python',
    'Python is a programming language used for scripting and data science.'
  ),
  page(
    'py-old',
    'https://archive.example.org/python-history',
    'Python History',
    'The history of python begins in the late 1980s with its first release.',
    { lastCrawledAt: ago(2 * 365 * DAY), publishedAt: ago(2 * 365 * DAY) }
  ),
  page(
    'py-fr',
    'https://fr.example.com/python',
    'Python en français',
    'Python est un langage de programmation interprété.',
    { language: 'fr', lastCrawledAt: ago(3 * DAY), publishedAt: ago(3 * DAY) }
  ),
  page(
    'py-de',
    'https://de.example.net/python',
    'Python auf Deutsch',
    'Python ist eine universelle Programmiersprache.',
    { language: 'de', lastCrawledAt: ago(10 * DAY), publishedAt: ago(10 * DAY) }
  ),
  page(
    'py-unknown',
    'https://misc.example.net/python-notes',
    'Python Notes',
    'Loose notes about python collected over the years.',
    { language: '', lastCrawledAt: ago(20 * DAY) }
  ),
  page(
    'py-news',
    'https://news.example.com/python-release',
    'Python Release Announced',
    'A new python release was announced today by the core team.',
    {
      isArticle: true,
      publishedAt: ago(2 * DAY),
      siteName: 'Example News',
      lastCrawledAt: ago(DAY)
    }
  ),

  // --- a small site, for site: and symbol-only words ----------------------
  page('cats', 'https://pets.example.com/cats', 'Cats', 'Cats are small carnivorous mammals.'),
  page('dogs', 'https://pets.example.com/dogs', 'Dogs', 'Dogs are loyal companions.'),

  // --- one article published at two addresses -----------------------------
  page(
    'dup-a',
    'https://news.example.com/quokka',
    'The Quokka Report',
    'The quokka is a small marsupial found on islands off the coast of Western Australia.'
  ),
  page(
    'dup-b',
    'https://mirror.example.org/quokka-copy',
    'The Quokka Report',
    'The quokka is a small marsupial found on islands off the coast of Western Australia.'
  ),

  // --- the same topic on a live page and on one that no longer answers 200 --
  page(
    'zebra-ok',
    'https://fish.example.com/zebrafish',
    'Zebrafish Care',
    'Zebrafish are small freshwater fish kept in home aquariums.',
    { language: '' }
  ),
  page(
    'zebra-gone',
    'https://fish.example.com/zebrafish-old',
    'Zebrafish Care (old)',
    'Zebrafish are small freshwater fish. This page has moved.',
    { language: '', statusCode: 404 }
  )
];

const PYTHON_IDS = ['py-en', 'py-old', 'py-fr', 'py-de', 'py-unknown', 'py-news'];

describeLive('search API on the OpenSearch engine', () => {
  let app;
  let idOf;

  const get = params => request(app).get('/api/search').query(params);
  const urlsOf = res => res.body.data.results.map(r => r.url);
  const scoresOf = res => new Map(res.body.data.results.map(r => [r.id, r.score]));
  const urlOf = id => PAGES.find(p => p._id === id).url;

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
    idOf = url => PAGES.find(p => p.url === url)._id;
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
  describe('envelope', () => {
    it('answers from OpenSearch in the standard envelope', async () => {
      const res = await get({ q: 'python' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        query: 'python',
        category: 'all',
        sort: 'relevance',
        total: 6,
        filters: { domain: '', date: 'any', language: '', category: 'all', sort: 'relevance' }
      });
      expect(urlsOf(res).map(idOf).sort()).toEqual([...PYTHON_IDS].sort());
      expect(res.body.data.results[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          url: expect.any(String),
          title: expect.any(String),
          snippet: expect.any(String),
          domain: expect.any(String),
          score: expect.any(Number)
        })
      );
    });

    it('returns an empty result for an empty query without calling the engine', async () => {
      const res = await get({ q: '' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ query: '', results: [], total: 0 });
      await expect(SearchLog.countDocuments()).resolves.toBe(0);
    });

    it('accepts a query of the maximum length and rejects one beyond it', async () => {
      expect((await get({ q: 'a'.repeat(200) })).status).toBe(200);
      const res = await get({ q: 'a'.repeat(201) });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/200 characters or fewer/);
    });

    it('collapses the same article at two addresses, in the results and the total', async () => {
      const res = await get({ q: 'quokka' });
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.results).toHaveLength(1);
      expect(res.body.data.pagination.totalResults).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  describe('filters', () => {
    it('domain: restricts to a site and its subdomains', async () => {
      const res = await get({ q: 'python', domain: 'example.com' });
      expect(urlsOf(res).map(idOf).sort()).toEqual(['py-en', 'py-fr', 'py-news']);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.filters.domain).toBe('example.com');
    });

    it('domain: accepts a full URL', async () => {
      const res = await get({ q: 'python', domain: 'https://python.example.com/some/page' });
      expect(urlsOf(res)).toEqual([urlOf('py-en')]);
      expect(res.body.data.filters.domain).toBe('python.example.com');
    });

    it('domain: returns nothing for a site that is not indexed', async () => {
      const res = await get({ q: 'python', domain: 'nowhere.invalid' });
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(0);
    });

    it.each([
      // py-en was crawled an hour ago but states no publication date: it is
      // in no window. Neither is py-unknown.
      ['hour', []],
      ['day', []],
      ['week', ['py-fr', 'py-news']],
      ['month', ['py-de', 'py-fr', 'py-news']],
      ['year', ['py-de', 'py-fr', 'py-news']],
      ['any', [...PYTHON_IDS].sort()]
    ])('date=%s: keeps the pages published inside the window', async (date, ids) => {
      const res = await get({ q: 'python', date });
      expect(res.status).toBe(200);
      expect(urlsOf(res).map(idOf).sort()).toEqual(ids);
      expect(res.body.data.filters.date).toBe(date);
      // Every result shows a publication date inside the window.
      if (date !== 'any') {
        const cutoff = Date.now() - { hour: HOUR, day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY }[date];
        for (const result of res.body.data.results) {
          expect(Date.parse(result.publishedAt)).toBeGreaterThanOrEqual(cutoff);
        }
      }
    });

    it.each([
      ['fr', ['py-fr']],
      ['de', ['py-de']],
      ['en', ['py-en', 'py-news', 'py-old']],
      ['en-GB', ['py-en', 'py-news', 'py-old']],
      ['EN', ['py-en', 'py-news', 'py-old']]
    ])('language=%s: keeps the pages in that language', async (language, ids) => {
      const res = await get({ q: 'python', language });
      expect(urlsOf(res).map(idOf).sort()).toEqual(ids);
    });

    it('language=any: applies no language filter', async () => {
      const res = await get({ q: 'python', language: 'any' });
      expect(res.body.data.total).toBe(6);
      expect(res.body.data.filters.language).toBe('');
    });

    it('applies domain, date and language together', async () => {
      const res = await get({ q: 'python', domain: 'example.com', date: 'week', language: 'en' });
      // py-en is on example.com and in English, but states no publication date.
      expect(urlsOf(res).map(idOf).sort()).toEqual(['py-news']);

      const none = await get({ q: 'python', domain: 'example.com', language: 'de' });
      expect(none.body.data.total).toBe(0);
    });

    it('leaves the score of a surviving result unchanged', async () => {
      const full = scoresOf(await get({ q: 'python' }));
      for (const params of [{ language: 'en' }, { domain: 'example.com' }, { date: 'month' }]) {
        const res = await get({ q: 'python', ...params });
        expect(res.body.data.results.length).toBeGreaterThan(0);
        for (const result of res.body.data.results) {
          expect(result.score).toBe(full.get(result.id));
        }
      }
    });

    it.each([
      ['domain', { domain: 'not a domain' }, /domain/],
      ['language', { language: 'english' }, /language/],
      ['date', { date: 'yesterday' }, /date/],
      ['sort', { sort: 'best' }, /sort/],
      ['category', { category: 'books' }, /category/]
    ])('rejects an invalid %s with 400', async (_name, params, message) => {
      const res = await get({ q: 'python', ...params });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(message);
    });

    it('status: always leaves out a page that did not answer 200', async () => {
      const res = await get({ q: 'zebrafish' });
      expect(res.status).toBe(200);
      expect(urlsOf(res)).toEqual([urlOf('zebra-ok')]);
      expect(res.body.data.total).toBe(1);
      // Not even an exact title match brings it back.
      expect(urlsOf(await get({ q: 'zebrafish care old' }))).not.toContain(urlOf('zebra-gone'));
    });
  });

  // ------------------------------------------------------------------
  describe('sorting and categories', () => {
    it('sort=newest: dated pages newest first, then undated pages by crawl date', async () => {
      const res = await get({ q: 'python', sort: 'newest' });
      expect(urlsOf(res).map(idOf)).toEqual([
        'py-news',
        'py-fr',
        'py-de',
        'py-old',
        'py-en',
        'py-unknown'
      ]);
    });

    it('sort=oldest: dated pages oldest first; undated pages never lead', async () => {
      const res = await get({ q: 'python', sort: 'oldest' });
      expect(urlsOf(res).map(idOf)).toEqual([
        'py-old',
        'py-de',
        'py-fr',
        'py-news',
        'py-unknown',
        'py-en'
      ]);
      // An unknown date is not the oldest one: every dated page comes first.
      const dated = res.body.data.results.map(r => Boolean(r.publishedAt));
      expect(dated).toEqual([true, true, true, true, false, false]);
    });

    it('category=news: only articles', async () => {
      const res = await get({ q: 'python', category: 'news' });
      expect(res.status).toBe(200);
      expect(res.body.data.category).toBe('news');
      expect(urlsOf(res)).toEqual([urlOf('py-news')]);
    });
  });

  // ------------------------------------------------------------------
  describe('GET /api/search/config', () => {
    it('publishes limits that agree with what the API accepts', async () => {
      const res = await request(app).get('/api/search/config');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        defaultLimit: 10,
        maxLimit: 50,
        maxPage: 500,
        maxResultWindow: 10000,
        maxPageAtMaxLimit: 200,
        maxQueryLength: 200,
        sortOptions: ['relevance', 'newest', 'oldest'],
        dateOptions: ['any', 'hour', 'day', 'week', 'month', 'year'],
        categoryOptions: ['all', 'images', 'news', 'videos', 'maps']
      });

      const { maxLimit, maxPage, maxPageAtMaxLimit, maxResultWindow } = res.body.data;
      expect(maxPageAtMaxLimit * maxLimit).toBeLessThanOrEqual(maxResultWindow);

      // The published bounds are the real ones.
      expect((await get({ q: 'python', limit: maxLimit, page: maxPageAtMaxLimit })).status).toBe(
        200
      );
      expect(
        (await get({ q: 'python', limit: maxLimit, page: maxPageAtMaxLimit + 1 })).status
      ).toBe(400);
      expect((await get({ q: 'python', limit: maxLimit + 1 })).status).toBe(400);
      expect((await get({ q: 'python', limit: 10, page: maxPage })).status).toBe(200);
      expect((await get({ q: 'python', limit: 10, page: maxPage + 1 })).status).toBe(400);
    });
  });

  // ------------------------------------------------------------------
  describe('page bounds', () => {
    it.each([
      [10, 500],
      [20, 500],
      [24, 416],
      [50, 200]
    ])('limit=%i: accepts page %i, the last one inside the window', async (limit, lastPage) => {
      const res = await get({ q: 'python', limit, page: lastPage });
      expect(res.status).toBe(200);
      expect(res.body.data.results).toEqual([]);
      expect(res.body.data.pagination).toMatchObject({
        page: lastPage,
        limit,
        totalResults: 6,
        hasNextPage: false
      });
    });

    it.each([
      [10, 501, /maximum is 500\./],
      [20, 501, /maximum is 500\./],
      [24, 417, /maximum is 416 for a limit of 24/],
      [50, 201, /maximum is 200 for a limit of 50/],
      [50, 500, /maximum is 200 for a limit of 50/]
    ])('limit=%i: rejects page %i with a clear 400', async (limit, firstInvalid, message) => {
      const res = await get({ q: 'python', limit, page: firstInvalid });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(message);
    });

    it('explains the result window when that is the reason', async () => {
      const res = await get({ q: 'python', limit: 50, page: 201 });
      expect(res.body.message).toMatch(/first 10,000 results/);
    });

    it.each([
      ['page=0', { page: 0 }, /page/],
      ['page=-3', { page: -3 }, /page/],
      ['page=abc', { page: 'abc' }, /page/],
      ['page=1.5', { page: 1.5 }, /page/],
      ['limit=0', { limit: 0 }, /limit/],
      ['limit=51', { limit: 51 }, /maximum is 50/],
      ['limit=abc', { limit: 'abc' }, /limit/]
    ])('rejects %s with 400', async (_label, params, message) => {
      const res = await get({ q: 'python', ...params });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(message);
    });

    it('applies the same bounds to the news vertical', async () => {
      expect((await get({ q: 'python', category: 'news', limit: 50, page: 200 })).status).toBe(200);
      expect((await get({ q: 'python', category: 'news', limit: 50, page: 201 })).status).toBe(400);
    });

    it('does not log a refused request', async () => {
      await get({ q: 'python', limit: 50, page: 201 });
      await expect(SearchLog.countDocuments()).resolves.toBe(0);
    });
  });

  // ------------------------------------------------------------------
  describe('ordinary pagination', () => {
    it('returns adjacent pages with no overlap and one total', async () => {
      const one = await get({ q: 'python', limit: 2, page: 1 });
      const two = await get({ q: 'python', limit: 2, page: 2 });
      const three = await get({ q: 'python', limit: 2, page: 3 });

      const urls = [...urlsOf(one), ...urlsOf(two), ...urlsOf(three)];
      expect(urls).toHaveLength(6);
      expect(new Set(urls).size).toBe(6);
      for (const res of [one, two, three]) {
        expect(res.body.data.total).toBe(6);
        expect(res.body.data.pagination).toMatchObject({
          limit: 2,
          totalResults: 6,
          totalPages: 3
        });
      }
      expect(one.body.data.pagination).toMatchObject({ hasNextPage: true, hasPreviousPage: false });
      expect(two.body.data.pagination).toMatchObject({ hasNextPage: true, hasPreviousPage: true });
      expect(three.body.data.pagination).toMatchObject({
        hasNextPage: false,
        hasPreviousPage: true
      });
    });

    it('keeps the order of the full list', async () => {
      const all = urlsOf(await get({ q: 'python', limit: 10 }));
      const one = urlsOf(await get({ q: 'python', limit: 3, page: 1 }));
      const two = urlsOf(await get({ q: 'python', limit: 3, page: 2 }));
      expect([...one, ...two]).toEqual(all);
    });

    it.each([10, 20, 50])('limit=%i: page 1 holds everything, page 2 is empty', async limit => {
      const one = await get({ q: 'python', limit, page: 1 });
      expect(one.body.data.results).toHaveLength(6);
      expect(one.body.data.pagination).toMatchObject({ totalPages: 1, hasNextPage: false });

      const two = await get({ q: 'python', limit, page: 2 });
      expect(two.status).toBe(200);
      expect(two.body.data.results).toEqual([]);
      expect(two.body.data.pagination).toMatchObject({
        page: 2,
        totalResults: 6,
        totalPages: 1,
        hasNextPage: false
      });
    });
  });

  // ------------------------------------------------------------------
  describe('lang: operator', () => {
    it('restricts to a language, like the language parameter', async () => {
      const operator = await get({ q: 'python lang:fr' });
      const parameter = await get({ q: 'python', language: 'fr' });
      expect(urlsOf(operator)).toEqual([urlOf('py-fr')]);
      expect(operator.body.data.results).toEqual(parameter.body.data.results);
      expect(operator.body.data.total).toBe(1);
    });

    it('one with a value it cannot use restricts nothing, and the answer says so', async () => {
      const bad = await get({ q: 'python lang:english' });
      expect(bad.status).toBe(200);
      expect(bad.body.data.unusedOperators).toEqual(['lang:english']);
      // Read as its words, as always: no page holds "lang" and "english".
      expect(bad.body.data.results).toEqual([]);

      const good = await get({ q: 'python lang:fr' });
      expect(good.body.data.unusedOperators).toEqual([]);
      expect(urlsOf(good).map(idOf)).toEqual(['py-fr']);
      expect(good.body.data.results.every(r => r.language === 'fr')).toBe(true);
    });

    it('works anywhere in the query and in any case', async () => {
      for (const q of ['lang:en python', 'python lang:en', 'python Lang:EN', 'python lang:en-GB']) {
        expect(
          urlsOf(await get({ q }))
            .map(idOf)
            .sort()
        ).toEqual(['py-en', 'py-news', 'py-old']);
      }
    });

    it('leaves the scores and order of the surviving results unchanged', async () => {
      const full = await get({ q: 'python' });
      const filtered = await get({ q: 'python lang:en' });
      const reference = scoresOf(full);
      for (const result of filtered.body.data.results) {
        expect(result.score).toBe(reference.get(result.id));
      }
      const kept = new Set(filtered.body.data.results.map(r => r.id));
      expect(filtered.body.data.results.map(r => r.id)).toEqual(
        full.body.data.results.map(r => r.id).filter(id => kept.has(id))
      );
    });

    it('excludes a language with -lang:, keeping pages of unknown language', async () => {
      const res = await get({ q: 'python -lang:en' });
      expect(urlsOf(res).map(idOf).sort()).toEqual(['py-de', 'py-fr', 'py-unknown']);

      const reference = scoresOf(await get({ q: 'python' }));
      for (const result of res.body.data.results) {
        expect(result.score).toBe(reference.get(result.id));
      }
    });

    it('accepts any one of several languages', async () => {
      const res = await get({ q: 'python lang:fr lang:de' });
      expect(urlsOf(res).map(idOf).sort()).toEqual(['py-de', 'py-fr']);
    });

    it('lists the pages in a language when nothing else is asked for', async () => {
      expect(urlsOf(await get({ q: 'lang:de' }))).toEqual([urlOf('py-de')]);
      expect((await get({ q: 'lang:en' })).body.data.total).toBe(6);
    });

    it('narrows the language parameter rather than overriding it', async () => {
      const same = await get({ q: 'python lang:fr', language: 'fr' });
      expect(urlsOf(same)).toEqual([urlOf('py-fr')]);

      const disjoint = await get({ q: 'python lang:fr', language: 'en' });
      expect(disjoint.status).toBe(200);
      expect(disjoint.body.data.total).toBe(0);
      expect(disjoint.body.data.filters.language).toBe('en');
    });

    it('combines with site: and exclusions', async () => {
      const res = await get({ q: 'lang:en site:example.com python -release' });
      expect(urlsOf(res)).toEqual([urlOf('py-en')]);
    });

    it('reads "lang:any" and a malformed negative as no restriction', async () => {
      const plain = await get({ q: 'python' });
      for (const q of ['python lang:any', 'python -lang:', 'python -lang:english']) {
        const res = await get({ q });
        expect(res.status).toBe(200);
        expect(res.body.data.results).toEqual(plain.body.data.results);
      }
    });

    it('never fails on a malformed value', async () => {
      for (const q of ['lang:', 'lang:english python', 'lang:e1', '-lang:', 'lang:"" python']) {
        expect((await get({ q })).status).toBe(200);
      }
    });

    it('applies to the news vertical too', async () => {
      expect((await get({ q: 'python lang:fr', category: 'news' })).body.data.total).toBe(0);
      expect((await get({ q: 'python lang:en', category: 'news' })).body.data.total).toBe(1);
    });
  });

  // ------------------------------------------------------------------
  describe('symbol-only words', () => {
    it.each([
      ['site:pets.example.com *', 'site:pets.example.com', 2],
      ['site:pets.example.com &', 'site:pets.example.com', 2],
      ['site:pets.example.com +', 'site:pets.example.com', 2],
      ['cats OR dogs &', 'cats OR dogs', 2],
      ['cats OR dogs *', 'cats OR dogs', 2],
      ['cats OR &', 'cats', 1],
      ['intitle:python *', 'intitle:python', 6],
      ['inurl:python *', 'inurl:python', 6],
      ['lang:fr *', 'lang:fr', 1],
      ['"programming language" &', '"programming language"', 1]
    ])('"%s" returns what "%s" returns', async (q, equivalent, count) => {
      const plain = await get({ q: equivalent });
      expect(plain.body.data.results).toHaveLength(count);
      const res = await get({ q });
      expect(res.status).toBe(200);
      expect(res.body.data.results).toEqual(plain.body.data.results);
      expect(res.body.data.total).toBe(plain.body.data.total);
    });

    it.each(['*', '&', '+', 'the *', 'the -java *', '* OR &', '-*'])(
      '"%s" alone still finds nothing',
      async q => {
        const res = await get({ q });
        expect(res.status).toBe(200);
        expect(res.body.data.results).toEqual([]);
        expect(res.body.data.total).toBe(0);
      }
    );

    it('a real word beside a symbol is still found', async () => {
      expect((await get({ q: 'python *' })).body.data.total).toBe(6);
      expect((await get({ q: 'cats & dogs' })).status).toBe(200);
      expect(urlsOf(await get({ q: 'site:pets.example.com & cats' }))).toEqual([urlOf('cats')]);
    });

    it('an excluded symbol excludes nothing and requires nothing', async () => {
      const plain = await get({ q: 'python' });
      const res = await get({ q: 'python -* -&' });
      expect(res.body.data.results).toEqual(plain.body.data.results);
    });

    it('agrees with the analyzers about which words can be matched', async () => {
      const tokensOf = async (analyzer, text) => {
        const response = await getClient().indices.analyze({
          index: INDEX_NAME,
          body: { analyzer, text }
        });
        return response.body.tokens.map(t => t.token);
      };

      const words = ['*', '&', '@', '%', '$', '~', '^', '=', '→', '½', '§', '•'];
      const matchable = ['c++', 'c#', '.net', 'node.js', 'wi-fi', '2024', 'naïve', '日本'];

      for (const word of words) {
        await expect(tokensOf('ph_search', word)).resolves.toEqual([]);
        await expect(tokensOf('ph_exact', word)).resolves.toEqual([]);
        await expect(tokensOf('ph_url', word)).resolves.toEqual([]);
        // …so the parser drops it from beside an operator.
        expect(parseQuery(`site:pets.example.com ${word}`).ignoredWords).toEqual([word]);
      }
      for (const word of matchable) {
        expect((await tokensOf('ph_search', word)).length).toBeGreaterThan(0);
        // …so the parser keeps it.
        expect(parseQuery(`site:pets.example.com ${word}`).terms).toEqual([word]);
      }
    });
  });

  // ------------------------------------------------------------------
  describe('GET /api/suggestions', () => {
    const suggest = params => request(app).get('/api/suggestions').query(params);
    const seedTerm = (word, documents) =>
      Term.create({
        word,
        documents: Array.from({ length: documents }, () => ({
          pageId: new mongoose.Types.ObjectId(),
          frequency: 1
        }))
      });

    it('orders both sources before the limit and skips zero-result searches', async () => {
      await SearchLog.create([
        { query: 'python zzzz', normalizedQuery: 'python zzzz', resultCount: 0 },
        { query: 'python zzzz', normalizedQuery: 'python zzzz', resultCount: 0 },
        { query: 'python tutorial', normalizedQuery: 'python tutorial', resultCount: 4 }
      ]);
      for (let i = 1; i <= 12; i += 1) await seedTerm(`pythonword${String(i).padStart(2, '0')}`, i);

      const res = await suggest({ q: 'python', limit: 4 });
      expect(res.status).toBe(200);
      expect(res.body.data.map(s => s.text)).toEqual([
        'python tutorial',
        'pythonword12',
        'pythonword11',
        'pythonword10'
      ]);
    });

    it('is fed by the searches this API records, once they have found something', async () => {
      await get({ q: 'python' });
      await get({ q: 'pythonzzzzzz' });

      const res = await suggest({ q: 'pyth' });
      expect(res.body.data.map(s => s.text)).toEqual(['python']);
    });

    it('rejects a limit beyond its maximum', async () => {
      const res = await suggest({ q: 'python', limit: 21 });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/maximum is 20/);
    });

    it('completes the start of a query or word only', async () => {
      await SearchLog.create({
        query: 'learn python',
        normalizedQuery: 'learn python',
        resultCount: 3
      });
      await seedTerm('python', 2);

      expect((await suggest({ q: 'thon' })).body.data).toEqual([]);
      expect((await suggest({ q: 'python' })).body.data.map(s => s.text)).toEqual(['python']);
      expect((await suggest({ q: 'l' })).body.data.map(s => s.text)).toEqual(['learn python']);
    });

    it('returns an empty list when every source is empty', async () => {
      const res = await suggest({ q: 'python' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('uses the next source when the first has nothing', async () => {
      await seedTerm('pythonic', 1);
      const res = await suggest({ q: 'python' });
      expect(res.body.data).toEqual([
        { text: 'pythonic', category: 'indexed term', trending: false }
      ]);
    });
  });
});
