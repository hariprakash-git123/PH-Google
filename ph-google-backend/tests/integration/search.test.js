const request = require('supertest');
const testDb = require('../helpers/testDb');
const { seedPage, seedManyPages, createUserWithToken, auth } = require('../helpers/factories');
const SearchLog = require('../../models/SearchLog');
const History = require('../../models/History');

let app;

beforeAll(async () => {
  await testDb.connect();
  app = require('../../app').createApp();
});
afterAll(async () => {
  await testDb.disconnect();
});
beforeEach(async () => {
  await testDb.clear();
});

const search = params => request(app).get('/api/search').query(params);

describe('GET /api/search — core behaviour', () => {
  beforeEach(async () => {
    await seedPage({
      url: 'https://python.org/about',
      title: 'About Python',
      description: 'Python is a programming language.',
      text: 'python python python programming language interpreted'
    });
    await seedPage({
      url: 'https://docs.example.com/python-guide',
      title: 'Python Guide',
      description: 'A guide to the python language.',
      text: 'python guide tutorial basics'
    });
    await seedPage({
      url: 'https://example.com/javascript',
      title: 'JavaScript Basics',
      description: 'Learn javascript.',
      text: 'javascript basics browser'
    });
  });

  it('returns matching results in the standard envelope', async () => {
    const res = await search({ q: 'python' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.results.length).toBe(2);
    expect(res.body.data.query).toBe('python');
  });

  it('returns a real total, not a fabricated estimate', async () => {
    const res = await search({ q: 'python' });
    // Two seeded pages contain "python" — total must be exactly 2.
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.pagination.totalResults).toBe(2);
  });

  it('shapes each result for the frontend', async () => {
    const res = await search({ q: 'python' });
    expect(res.body.data.results[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        title: expect.any(String),
        url: expect.any(String),
        domain: expect.any(String),
        snippet: expect.any(String),
        score: expect.any(Number),
        publishedAgo: expect.any(String)
      })
    );
  });

  it('reports latency and response time', async () => {
    const res = await search({ q: 'python' });
    expect(res.body.data.latency).toMatch(/^\d+\.\d{3}s$/);
    expect(res.body.data.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('returns an empty result set for a query with no matches', async () => {
    const res = await search({ q: 'kubernetes' });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.pagination.totalPages).toBe(0);
  });

  it('handles an empty query without error', async () => {
    const res = await search({ q: '' });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it('handles a missing q parameter', async () => {
    const res = await request(app).get('/api/search');
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
  });

  it('returns no results for a stop-word-only query', async () => {
    const res = await search({ q: 'the and of' });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
  });

  it('is case-insensitive', async () => {
    const lower = await search({ q: 'python' });
    const upper = await search({ q: 'PYTHON' });
    expect(upper.body.data.total).toBe(lower.body.data.total);
  });

  it('applies ranking: a title+url match outranks a body-only match', async () => {
    const res = await search({ q: 'python' });
    const urls = res.body.data.results.map(r => r.url);
    // python.org matches in title, description, url and body.
    expect(urls[0]).toBe('https://python.org/about');
    expect(res.body.data.results[0].score).toBeGreaterThan(res.body.data.results[1].score);
  });

  it('treats a multi-term query as matching any term, ranking full matches first', async () => {
    const res = await search({ q: 'python javascript' });
    expect(res.body.data.total).toBe(3);
  });

  it('does not execute a regular expression supplied as a query', async () => {
    const res = await search({ q: '.*' });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
  });
});

describe('GET /api/search — pagination', () => {
  beforeEach(async () => {
    await seedManyPages(25, { keyword: 'pagination' });
  });

  it('returns the default page size', async () => {
    const res = await search({ q: 'pagination' });
    expect(res.body.data.results).toHaveLength(10);
    expect(res.body.data.pagination).toEqual({
      page: 1,
      limit: 10,
      totalResults: 25,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: false
    });
  });

  it('honours an explicit limit', async () => {
    const res = await search({ q: 'pagination', limit: 5 });
    expect(res.body.data.results).toHaveLength(5);
    expect(res.body.data.pagination.totalPages).toBe(5);
  });

  it('returns a different, non-overlapping slice for page 2', async () => {
    const first = await search({ q: 'pagination', page: 1, limit: 10 });
    const second = await search({ q: 'pagination', page: 2, limit: 10 });

    const firstIds = first.body.data.results.map(r => r.id);
    const secondIds = second.body.data.results.map(r => r.id);

    expect(secondIds).toHaveLength(10);
    expect(firstIds.some(id => secondIds.includes(id))).toBe(false);
    expect(second.body.data.pagination).toMatchObject({
      page: 2,
      hasNextPage: true,
      hasPreviousPage: true
    });
  });

  it('marks the last page correctly', async () => {
    const res = await search({ q: 'pagination', page: 3, limit: 10 });
    expect(res.body.data.results).toHaveLength(5);
    expect(res.body.data.pagination).toMatchObject({ hasNextPage: false, hasPreviousPage: true });
  });

  it('returns an empty slice past the end without error', async () => {
    const res = await search({ q: 'pagination', page: 99, limit: 10 });
    expect(res.status).toBe(200);
    expect(res.body.data.results).toEqual([]);
    // The total still reports how many documents matched.
    expect(res.body.data.pagination.totalResults).toBe(25);
  });

  it('keeps the total stable across pages', async () => {
    const p1 = await search({ q: 'pagination', page: 1, limit: 7 });
    const p2 = await search({ q: 'pagination', page: 2, limit: 7 });
    expect(p1.body.data.total).toBe(p2.body.data.total);
  });

  it.each([
    ['page=0', { page: 0 }],
    ['page=-1', { page: -1 }],
    ['page=abc', { page: 'abc' }],
    ['page=1.5', { page: 1.5 }]
  ])('rejects %s with 400', async (_l, extra) => {
    const res = await search({ q: 'pagination', ...extra });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/page/i);
  });

  it.each([
    ['limit=0', { limit: 0 }],
    ['limit=-5', { limit: -5 }],
    ['limit=abc', { limit: 'abc' }]
  ])('rejects %s with 400', async (_l, extra) => {
    const res = await search({ q: 'pagination', ...extra });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/limit/i);
  });

  it('never allows an unlimited result request', async () => {
    const res = await search({ q: 'pagination', limit: 100000 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/maximum is 50/i);
  });

  it('rejects a page number beyond the configured maximum', async () => {
    const res = await search({ q: 'pagination', page: 100000 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/maximum is 500/i);
  });
});

describe('GET /api/search — sorting', () => {
  beforeEach(async () => {
    await seedPage({
      url: 'https://a.example.com/old-but-relevant',
      title: 'sorting sorting sorting',
      description: 'sorting is the topic',
      text: 'sorting '.repeat(30),
      lastCrawledAt: new Date('2024-01-01T00:00:00Z')
    });
    await seedPage({
      url: 'https://b.example.com/new-less-relevant',
      title: 'Unrelated title',
      description: '',
      text: 'sorting mentioned once',
      lastCrawledAt: new Date('2026-09-01T00:00:00Z')
    });
  });

  it('defaults to relevance', async () => {
    const res = await search({ q: 'sorting' });
    expect(res.body.data.sort).toBe('relevance');
    expect(res.body.data.results[0].url).toBe('https://a.example.com/old-but-relevant');
  });

  it('sorts newest first when sort=newest', async () => {
    const res = await search({ q: 'sorting', sort: 'newest' });
    expect(res.body.data.sort).toBe('newest');
    expect(res.body.data.results[0].url).toBe('https://b.example.com/new-less-relevant');
  });

  it('sorts oldest first when sort=oldest', async () => {
    const res = await search({ q: 'sorting', sort: 'oldest' });
    expect(res.body.data.results[0].url).toBe('https://a.example.com/old-but-relevant');
  });

  it('rejects an unknown sort value', async () => {
    const res = await search({ q: 'sorting', sort: 'cheapest' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sort/i);
  });
});

describe('GET /api/search — filters', () => {
  beforeEach(async () => {
    await seedPage({
      url: 'https://python.org/downloads',
      title: 'Download Python',
      description: 'Get python here.',
      text: 'python download release',
      language: 'en',
      lastCrawledAt: new Date()
    });
    await seedPage({
      url: 'https://realpython.com/tutorial',
      title: 'Python Tutorial',
      description: 'Learn python.',
      text: 'python tutorial learn',
      language: 'es',
      lastCrawledAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000)
    });
  });

  describe('domain', () => {
    it('restricts results to one domain and affects the total', async () => {
      const res = await search({ q: 'python', domain: 'python.org' });
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.results[0].domain).toBe('python.org');
    });

    it('accepts a full URL as the domain value', async () => {
      const res = await search({ q: 'python', domain: 'https://www.python.org/some/path' });
      expect(res.body.data.total).toBe(1);
    });

    it('returns nothing for a domain that is not indexed', async () => {
      const res = await search({ q: 'python', domain: 'nowhere.test' });
      expect(res.body.data.total).toBe(0);
    });

    it('rejects a malformed domain', async () => {
      const res = await search({ q: 'python', domain: 'not a domain!!' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/domain/i);
    });

    it('echoes the applied filters', async () => {
      const res = await search({ q: 'python', domain: 'python.org' });
      expect(res.body.data.filters).toMatchObject({ domain: 'python.org' });
    });
  });

  describe('date', () => {
    it('excludes older pages when filtering to the past week', async () => {
      const res = await search({ q: 'python', date: 'week' });
      expect(res.body.data.total).toBe(1);
      expect(res.body.data.results[0].url).toBe('https://python.org/downloads');
    });

    it('includes everything with date=any', async () => {
      const res = await search({ q: 'python', date: 'any' });
      expect(res.body.data.total).toBe(2);
    });

    it('includes the older page within a year window', async () => {
      const res = await search({ q: 'python', date: 'year' });
      expect(res.body.data.total).toBe(2);
    });

    it('rejects an unknown date window', async () => {
      const res = await search({ q: 'python', date: 'fortnight' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/date/i);
    });
  });

  describe('language', () => {
    it('filters by language code', async () => {
      const en = await search({ q: 'python', language: 'en' });
      const es = await search({ q: 'python', language: 'es' });
      expect(en.body.data.total).toBe(1);
      expect(es.body.data.total).toBe(1);
      expect(en.body.data.results[0].language).toBe('en');
    });

    it('normalizes a regional code', async () => {
      const res = await search({ q: 'python', language: 'en-GB' });
      expect(res.body.data.total).toBe(1);
    });

    it('treats language=any as no filter', async () => {
      const res = await search({ q: 'python', language: 'any' });
      expect(res.body.data.total).toBe(2);
    });

    it('rejects a non-language value', async () => {
      const res = await search({ q: 'python', language: '12345' });
      expect(res.status).toBe(400);
    });
  });

  describe('combined filters', () => {
    it('applies domain, date and language together', async () => {
      const res = await search({ q: 'python', domain: 'python.org', date: 'week', language: 'en' });
      expect(res.body.data.total).toBe(1);
    });

    it('returns nothing when filters are mutually exclusive', async () => {
      const res = await search({ q: 'python', domain: 'python.org', language: 'es' });
      expect(res.body.data.total).toBe(0);
    });
  });

  describe('category', () => {
    it('serves web results for category=all', async () => {
      const res = await search({ q: 'python', category: 'all' });
      expect(res.body.data.total).toBe(2);
    });

    it('serves the images vertical from its own index', async () => {
      // These fixtures carry no images, so the vertical is correctly empty
      // rather than falling back to web results or mock rows.
      const res = await search({ q: 'python', category: 'images' });
      expect(res.status).toBe(200);
      expect(res.body.data.indexed).toBe(true);
      expect(res.body.data.results).toEqual([]);
      expect(res.body.data.total).toBe(0);
    });

    it('rejects an unknown category', async () => {
      const res = await search({ q: 'python', category: 'podcasts' });
      expect(res.status).toBe(400);
    });
  });
});

describe('GET /api/search — analytics and history side effects', () => {
  beforeEach(async () => {
    await seedPage({
      url: 'https://example.com/a',
      title: 'analytics test',
      text: 'analytics recorded'
    });
  });

  it('records a search log for an anonymous search, with no user attached', async () => {
    await search({ q: 'analytics' });

    const logs = await SearchLog.find();
    expect(logs).toHaveLength(1);
    expect(logs[0].normalizedQuery).toBe('analytics');
    expect(logs[0].userId).toBeNull();
    expect(logs[0].resultCount).toBe(1);
    expect(logs[0].responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('records the applied filters in the log', async () => {
    await search({ q: 'analytics', sort: 'newest', domain: 'example.com', limit: 5 });
    const log = await SearchLog.findOne();
    expect(log.filters).toMatchObject({ sort: 'newest', domain: 'example.com' });
  });

  it('records a zero-result search so it can be reported', async () => {
    await search({ q: 'nothingmatchesthis' });
    const log = await SearchLog.findOne({ normalizedQuery: 'nothingmatchesthis' });
    expect(log.resultCount).toBe(0);
  });

  it('does not create history for an anonymous search', async () => {
    await search({ q: 'analytics' });
    expect(await History.countDocuments()).toBe(0);
  });

  it('creates history for a signed-in search, owned by that user', async () => {
    const { token, user } = await createUserWithToken(app, { email: 'searcher@example.com' });

    await request(app).get('/api/search').query({ q: 'analytics' }).set(auth(token));

    const history = await History.find();
    expect(history).toHaveLength(1);
    expect(history[0].userId.toString()).toBe(user._id.toString());
    expect(history[0].query).toBe('analytics');
  });

  it('attributes the search log to the signed-in user', async () => {
    const { token, user } = await createUserWithToken(app, { email: 'searcher@example.com' });
    await request(app).get('/api/search').query({ q: 'analytics' }).set(auth(token));

    const log = await SearchLog.findOne();
    expect(log.userId.toString()).toBe(user._id.toString());
  });

  it('does not duplicate history when the same query is repeated', async () => {
    const { token } = await createUserWithToken(app, { email: 'searcher@example.com' });
    for (let i = 0; i < 3; i += 1) {
      await request(app).get('/api/search').query({ q: 'analytics' }).set(auth(token));
    }
    expect(await History.countDocuments()).toBe(1);
    // Every search is still counted in analytics.
    expect(await SearchLog.countDocuments()).toBe(3);
  });

  it('only records history from page 1, not from paging through results', async () => {
    const { token } = await createUserWithToken(app, { email: 'searcher@example.com' });
    await request(app).get('/api/search').query({ q: 'analytics', page: 2 }).set(auth(token));
    expect(await History.countDocuments()).toBe(0);
  });

  it('treats an invalid token on search as an anonymous request rather than failing', async () => {
    const res = await request(app)
      .get('/api/search')
      .query({ q: 'analytics' })
      .set(auth('clearly.not.a.valid.token'));

    expect(res.status).toBe(200);
    expect(await History.countDocuments()).toBe(0);
  });
});

describe('GET /api/search/config', () => {
  it('publishes the limits and filter vocabulary', async () => {
    const res = await request(app).get('/api/search/config');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      defaultLimit: 10,
      maxLimit: 50,
      sortOptions: expect.arrayContaining(['relevance', 'newest']),
      indexedCategories: expect.arrayContaining(['all', 'images', 'videos', 'news', 'maps'])
    });
  });
});

describe('GET /api/suggestions', () => {
  beforeEach(async () => {
    await seedPage({
      url: 'https://example.com/python',
      title: 'Python programming',
      text: 'python programming pythonic'
    });
  });

  it('returns indexed terms matching the prefix', async () => {
    const res = await request(app).get('/api/suggestions').query({ q: 'pyth' });
    expect(res.status).toBe(200);
    expect(res.body.data.map(s => s.text)).toContain('python');
  });

  it('returns an empty array for an empty query', async () => {
    const res = await request(app).get('/api/suggestions').query({ q: '' });
    expect(res.body.data).toEqual([]);
  });

  it('returns an empty array rather than inventing suggestions', async () => {
    const res = await request(app).get('/api/suggestions').query({ q: 'zzzzqqqq' });
    expect(res.body.data).toEqual([]);
  });

  it('surfaces real past queries ahead of raw index terms', async () => {
    await SearchLog.create([
      { query: 'python tutorial', normalizedQuery: 'python tutorial', resultCount: 5 },
      { query: 'python tutorial', normalizedQuery: 'python tutorial', resultCount: 5 }
    ]);

    const res = await request(app).get('/api/suggestions').query({ q: 'python t' });
    expect(res.body.data[0]).toMatchObject({ text: 'python tutorial', category: 'recent search' });
  });

  it('does not treat the query as a regular expression', async () => {
    const res = await request(app).get('/api/suggestions').query({ q: '.*' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('respects the suggestion limit', async () => {
    const res = await request(app).get('/api/suggestions').query({ q: 'p', limit: 2 });
    expect(res.body.data.length).toBeLessThanOrEqual(2);
  });
});
