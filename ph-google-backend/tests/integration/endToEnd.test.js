const request = require('supertest');
const testDb = require('../helpers/testDb');
const { startFixtureSite } = require('../helpers/fixtureSite');
const { auth } = require('../helpers/factories');
const { clearRobotsCache } = require('../../crawler/robotsChecker');
const crawlerJobService = require('../../services/crawlerJobService');
const { runCrawlToCompletion, runOneSlice } = require('../helpers/crawlRunner');
const Page = require('../../models/Page');
const Term = require('../../models/Term');
const Website = require('../../models/Website');
const SearchLog = require('../../models/SearchLog');
const History = require('../../models/History');
const User = require('../../models/User');

/**
 * The acceptance test for the whole product.
 *
 *   admin login -> start crawl -> fetch pages -> process text -> build index
 *   -> MongoDB -> user login -> search -> ranking -> filters -> pagination
 *   -> results -> history + analytics -> admin dashboard reflects it all
 *
 * Every step runs through the real HTTP API against a local fixture site.
 */

let app;
let site;

beforeAll(async () => {
  await testDb.connect();
  app = require('../../app').createApp();
  site = await startFixtureSite();
});

afterAll(async () => {
  crawlerJobService.cancelAllRunners();
  if (site) await site.close();
  await testDb.disconnect();
});

beforeEach(async () => {
  crawlerJobService.cancelAllRunners();
  await testDb.clear();
  clearRobotsCache();
});

/**
 * Crawling moved out of the API into a worker process, so starting a crawl
 * through the API and then polling would poll forever. These tests take the
 * worker's part instead: `runCrawlToCompletion` runs the same drain loop
 * `worker.js` runs, against the real frontier, without BullMQ.
 *
 * That keeps this an end-to-end test of the pipeline rather than of the
 * queue transport, which is covered separately in tests/queue/.
 */
const waitForJob = jobId => runCrawlToCompletion(jobId);

describe('END TO END: crawl -> index -> rank -> search -> analytics', () => {
  it('runs the complete pipeline through the public API', async () => {
    // ---------------------------------------------------------------
    // 1. ADMIN REGISTERS AND SIGNS IN
    //    (signing up makes a normal user; the operator then grants the
    //    admin role, as `npm run create-admin -- --promote` does)
    // ---------------------------------------------------------------
    const registered = await request(app).post('/api/auth/register').send({
      name: 'Ops Admin',
      email: 'ops@example.com',
      password: 'adminpass123'
    });
    expect(registered.status).toBe(201);
    expect(registered.body.data.user.role).toBe('user');
    await User.updateOne({ email: 'ops@example.com' }, { role: 'admin' });

    const adminLogin = await request(app).post('/api/auth/login').send({
      email: 'ops@example.com',
      password: 'adminpass123'
    });
    expect(adminLogin.status).toBe(200);
    const adminToken = adminLogin.body.data.token;

    // ---------------------------------------------------------------
    // 2. THE INDEX STARTS EMPTY — no invented figures
    // ---------------------------------------------------------------
    const before = await request(app).get('/api/admin/metrics').set(auth(adminToken));
    expect(before.body.data).toMatchObject({ totalPages: 0, totalWebsites: 0, totalTerms: 0 });

    const emptySearch = await request(app).get('/api/search').query({ q: 'indexing' });
    expect(emptySearch.body.data.results).toEqual([]);
    expect(emptySearch.body.data.total).toBe(0);

    // ---------------------------------------------------------------
    // 3. ADMIN STARTS A CRAWL FROM THE DASHBOARD
    // ---------------------------------------------------------------
    const started = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(adminToken))
      .send({ seedUrl: site.url, maxPages: 4, sameDomainOnly: true });

    expect(started.status).toBe(202);
    const jobId = started.body.data.jobId;
    expect(jobId).toMatch(/^[a-f0-9]{24}$/);

    // ---------------------------------------------------------------
    // 4. CRAWLER: robots.txt -> fetch -> extract links -> extract content
    // ---------------------------------------------------------------
    const job = await waitForJob(jobId);
    expect(job.status).toBe('completed');
    expect(job.pagesCrawled).toBe(4);
    expect(job.pagesIndexed).toBe(4);
    expect(job.pagesDiscovered).toBeGreaterThan(job.pagesCrawled);

    // robots.txt was honoured.
    expect(await Page.countDocuments({ url: `${site.url}/private/secret` })).toBe(0);

    // ---------------------------------------------------------------
    // 5. PAGES STORED IN MONGODB
    // ---------------------------------------------------------------
    const pages = await Page.find().lean();
    expect(pages).toHaveLength(4);
    expect(pages.every(p => p.status === 'indexed')).toBe(true);
    expect(pages.every(p => p.domain === '127.0.0.1')).toBe(true);
    expect(pages.every(p => p.lastCrawledAt)).toBe(true);

    const website = await Website.findOne({ domain: '127.0.0.1' });
    expect(website.status).toBe('completed');

    // ---------------------------------------------------------------
    // 6. TEXT PROCESSED: body text stored, markup and scripts stripped
    // ---------------------------------------------------------------
    // Pages are stored under their canonical URL (no trailing slash).
    const home = await Page.findOne({ url: site.url }).lean();
    expect(home).toBeTruthy();
    expect(home.title).toBe('Fixture Home - Search Engine Testing');
    expect(home.description).toContain('crawler fixture site');
    expect(home.language).toBe('en');
    expect(home.content).not.toContain('<');
    expect(home.content).not.toContain('should never be indexed'); // <script> removed

    // ---------------------------------------------------------------
    // 7. TERMS INDEXED IN THE INVERTED INDEX
    // ---------------------------------------------------------------
    expect(await Term.countDocuments()).toBeGreaterThan(10);

    const indexingTerm = await Term.findOne({ word: 'indexing' });
    expect(indexingTerm).toBeTruthy();
    expect(indexingTerm.documents.length).toBeGreaterThan(0);

    // Stop words are never indexed.
    expect(await Term.findOne({ word: 'the' })).toBeNull();

    // ---------------------------------------------------------------
    // 8. A USER SIGNS UP AND SEARCHES
    // ---------------------------------------------------------------
    const signup = await request(app).post('/api/auth/register').send({
      name: 'Searcher',
      email: 'searcher@example.com',
      password: 'userpass123'
    });
    expect(signup.status).toBe(201);
    expect(signup.body.data.user.role).toBe('user');
    const userToken = signup.body.data.token;

    const searchRes = await request(app)
      .get('/api/search')
      .query({ q: 'indexing' })
      .set(auth(userToken));

    expect(searchRes.status).toBe(200);
    expect(searchRes.body.data.results.length).toBeGreaterThan(0);
    expect(searchRes.body.data.total).toBeGreaterThan(0);

    // ---------------------------------------------------------------
    // 9. RESULTS ARE RANKED, WITH REAL SNIPPETS AND METADATA
    // ---------------------------------------------------------------
    const top = searchRes.body.data.results[0];
    // The dedicated indexing page outranks the home page that merely links to it.
    expect(top.url).toBe(`${site.url}/blog/indexing`);
    expect(top.title).toBe('How Indexing Works');
    expect(top.snippet.length).toBeGreaterThan(0);
    expect(top.domain).toBe('127.0.0.1');
    expect(top.score).toBeGreaterThan(0);

    const scores = searchRes.body.data.results.map(r => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    // ---------------------------------------------------------------
    // 10. FILTERS AND SORT ACTUALLY CHANGE THE RESULT SET
    // ---------------------------------------------------------------
    const wrongDomain = await request(app)
      .get('/api/search')
      .query({ q: 'indexing', domain: 'nowhere.test' });
    expect(wrongDomain.body.data.total).toBe(0);

    const rightDomain = await request(app)
      .get('/api/search')
      .query({ q: 'indexing', domain: '127.0.0.1' });
    expect(rightDomain.body.data.total).toBe(searchRes.body.data.total);

    const byLanguage = await request(app)
      .get('/api/search')
      .query({ q: 'fixture', language: 'en' });
    expect(byLanguage.body.data.total).toBeGreaterThan(0);

    const lastHour = await request(app).get('/api/search').query({ q: 'fixture', date: 'hour' });
    // The fixture pages state no publication date. Crawled seconds ago or
    // not, an undated page is in no date window.
    expect(lastHour.status).toBe(200);
    expect(lastHour.body.data.total).toBe(0);

    // ---------------------------------------------------------------
    // 11. PAGINATION
    // ---------------------------------------------------------------
    const page1 = await request(app).get('/api/search').query({ q: 'fixture', page: 1, limit: 1 });
    expect(page1.body.data.results).toHaveLength(1);
    expect(page1.body.data.pagination).toMatchObject({
      page: 1,
      limit: 1,
      hasPreviousPage: false
    });

    if (page1.body.data.pagination.totalPages > 1) {
      const page2 = await request(app)
        .get('/api/search')
        .query({ q: 'fixture', page: 2, limit: 1 });
      expect(page2.body.data.results[0].id).not.toBe(page1.body.data.results[0].id);
      expect(page2.body.data.pagination.hasPreviousPage).toBe(true);
      // The total is stable and real across pages.
      expect(page2.body.data.total).toBe(page1.body.data.total);
    }

    // ---------------------------------------------------------------
    // 12. SEARCH HISTORY RECORDED FOR THE SIGNED-IN USER ONLY
    // ---------------------------------------------------------------
    const historyRes = await request(app).get('/api/history').set(auth(userToken));
    expect(historyRes.status).toBe(200);
    expect(historyRes.body.data.history.map(h => h.query)).toContain('indexing');

    // The anonymous searches above created no history for anyone.
    const allHistory = await History.find().lean();
    expect(allHistory.every(h => h.userId)).toBe(true);

    // The admin's own history does not contain the user's search.
    const adminHistory = await request(app).get('/api/history').set(auth(adminToken));
    expect(adminHistory.body.data.history).toHaveLength(0);

    // ---------------------------------------------------------------
    // 13. ANALYTICS RECORDED FOR EVERY SEARCH
    // ---------------------------------------------------------------
    const logs = await SearchLog.find().lean();
    expect(logs.length).toBeGreaterThanOrEqual(7);
    expect(logs.every(l => typeof l.responseTimeMs === 'number')).toBe(true);
    // No identifying metadata is stored.
    expect(logs.every(l => !('ip' in l) && !('userAgent' in l))).toBe(true);

    const analytics = await request(app).get('/api/analytics/overview').set(auth(adminToken));
    expect(analytics.status).toBe(200);
    expect(analytics.body.data.totalSearches).toBe(logs.length);
    expect(analytics.body.data.searchesToday).toBe(logs.length);
    expect(analytics.body.data.topQueries.length).toBeGreaterThan(0);

    // The two deliberate zero-result searches are reported.
    const zero = await request(app).get('/api/analytics/zero-result-queries').set(auth(adminToken));
    expect(zero.body.data.zeroResultQueries.length).toBeGreaterThan(0);

    // ---------------------------------------------------------------
    // 14. ADMIN DASHBOARD REFLECTS THE REAL STATE
    // ---------------------------------------------------------------
    const metrics = await request(app).get('/api/admin/metrics').set(auth(adminToken));
    expect(metrics.body.data).toMatchObject({
      totalPages: 4,
      totalWebsites: 1,
      totalUsers: 2,
      activeCrawlerJobs: 0
    });
    expect(metrics.body.data.totalTerms).toBe(await Term.countDocuments());
    expect(metrics.body.data.totalSearches).toBe(logs.length);

    const dashboard = await request(app).get('/api/admin/dashboard').set(auth(adminToken));
    const indexedCard = dashboard.body.data.overview.find(c => c.label === 'Indexed pages');
    expect(indexedCard.value).toBe('4');
    expect(dashboard.body.data.crawlerActivity24h.reduce((s, h) => s + h.pages, 0)).toBe(4);
    expect(dashboard.body.data.recentJobs[0].status).toBe('completed');

    // The index browser sees the crawled pages.
    const adminPages = await request(app).get('/api/admin/pages').set(auth(adminToken));
    expect(adminPages.body.data.pagination.totalResults).toBe(4);

    // ---------------------------------------------------------------
    // 15. AUTHORIZATION HOLDS THROUGHOUT
    // ---------------------------------------------------------------
    expect((await request(app).get('/api/admin/metrics').set(auth(userToken))).status).toBe(403);
    expect((await request(app).get('/api/admin/dashboard')).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/admin/crawler/start')
          .set(auth(userToken))
          .send({ seedUrl: site.url, maxPages: 1 })
      ).status
    ).toBe(403);

    // ---------------------------------------------------------------
    // 16. THE FRONTIER DOES NOT RE-FETCH WHAT IT JUST CRAWLED
    // ---------------------------------------------------------------
    // The frontier is durable and shared across jobs, so a second crawl of
    // the same site finds those URLs already `done` and skips them until
    // their re-crawl falls due. This is the behaviour that makes crawling
    // cheap at scale, and it is worth asserting rather than assuming.
    //
    // What a repeat crawl *may* do is pick up links the first crawl ran out
    // of budget for — that is how re-running a crawl grows the index. So the
    // assertion is about pages already crawled: none is fetched again.
    const alreadyCrawled = new Set(
      (await Page.find().select('url').lean()).map(p => new URL(p.url).pathname || '/')
    );
    const requestsBefore = site.requestLog.length;

    const repeat = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(adminToken))
      .send({ seedUrl: site.url, maxPages: 4 });
    const repeatJob = await waitForJob(repeat.body.data.jobId);

    // Open only if a revived link is waiting out a retry backoff (the 404).
    expect(['completed', 'running']).toContain(repeatJob.status);
    const refetched = site.requestLog
      .slice(requestsBefore)
      .map(r => r.path)
      // The seed is re-fetched on purpose: an explicit crawl always starts there.
      .filter(p => p !== '/' && p !== '/robots.txt' && alreadyCrawled.has(p));
    expect(refetched).toEqual([]);
    const pagesAfterRepeat = await Page.countDocuments();
    expect(pagesAfterRepeat).toBeGreaterThanOrEqual(4);
    // Close the repeat job out so the forced crawl below has a free slot.
    await request(app)
      .post('/api/admin/crawler/stop')
      .set(auth(adminToken))
      .send({})
      .catch(() => {});
    await waitForJob(repeat.body.data.jobId);

    // ---------------------------------------------------------------
    // 17. A FORCED RE-CRAWL UPDATES RATHER THAN DUPLICATES
    // ---------------------------------------------------------------
    // `force` is how an administrator says "now" instead of "when stale".
    const second = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(adminToken))
      .send({ seedUrl: site.url, maxPages: 4, force: true });
    const secondJob = await waitForJob(second.body.data.jobId);

    expect(secondJob.status).toBe('completed');
    expect(secondJob.pagesCrawled).toBe(4);
    // No new pages: the same URLs were refreshed, not duplicated.
    expect(await Page.countDocuments()).toBe(pagesAfterRepeat);

    // And search still works after re-indexing.
    const afterRecrawl = await request(app).get('/api/search').query({ q: 'indexing' });
    expect(afterRecrawl.body.data.results.length).toBeGreaterThan(0);
    expect(afterRecrawl.body.data.results[0].url).toBe(`${site.url}/blog/indexing`);
  }, 120000);
});

describe('END TO END: crawl can be stopped mid-flight', () => {
  it('stops cleanly and leaves a consistent, searchable index', async () => {
    const admin = await request(app).post('/api/auth/register').send({
      name: 'Ops',
      email: 'ops2@example.com',
      password: 'adminpass123'
    });
    expect(admin.status).toBe(201);
    await User.updateOne({ email: 'ops2@example.com' }, { role: 'admin' });
    const token = admin.body.data.token;

    const started = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(token))
      .send({ seedUrl: site.url, maxPages: 50, crawlDelayMs: 0 });

    // Let a worker get two pages in, so the stop interrupts a crawl that is
    // genuinely under way.
    await runOneSlice(site.url, { slicePages: 2 });

    const stop = await request(app)
      .post('/api/admin/crawler/stop')
      .set(auth(token))
      .send({ jobId: started.body.data.jobId });
    expect(stop.status).toBe(200);

    const job = await waitForJob(started.body.data.jobId);
    expect(job.status).toBe('stopped');
    expect(job.pagesCrawled).toBeGreaterThan(0);
    expect(job.pagesCrawled).toBeLessThan(50);

    // Whatever was crawled before the stop is fully indexed and searchable.
    const pageCount = await Page.countDocuments();
    expect(pageCount).toBe(job.pagesIndexed);

    const res = await request(app).get('/api/search').query({ q: 'fixture' });
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBeGreaterThan(0);

    // The API is still healthy.
    expect((await request(app).get('/api/health')).body.data.status).toBe('ok');
  }, 60000);
});
