const request = require('supertest');
const testDb = require('../helpers/testDb');
const { startFixtureSite } = require('../helpers/fixtureSite');
const { createUserWithToken, seedPage, auth, crawlerRunningFor } = require('../helpers/factories');
const { clearRobotsCache } = require('../../crawler/robotsChecker');
const crawlerJobService = require('../../services/crawlerJobService');
const { runCrawlToCompletion, runOneSlice } = require('../helpers/crawlRunner');
const { failOrphanedJobs } = require('../../services/crawlMaintenanceService');
const CrawlJob = require('../../models/CrawlJob');
const CrawlFrontier = require('../../models/CrawlFrontier');
const Page = require('../../models/Page');
const { config } = require('../../config/env');
const { normalizeUrl } = require('../../utils/urlNormalizer');

let app;
let site;
let admin;
let normalUser;

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
  site.requestLog.length = 0;

  admin = await createUserWithToken(app, {
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin'
  });
  normalUser = await createUserWithToken(app, {
    email: 'user@example.com',
    name: 'User',
    role: 'user'
  });
});

/**
 * Crawls used to run inside this process, so a test could start one through
 * the API and poll the database until it finished. They run in the worker
 * now, and polling would just time out. `runCrawlToCompletion` takes the
 * worker's part instead — see tests/helpers/crawlRunner.js.
 */

describe('GET /api/admin/metrics', () => {
  it('derives every number from the database, with nothing hardcoded', async () => {
    await seedPage({ url: 'https://a.example.com/1', title: 'one', text: 'alpha beta' });
    await seedPage({ url: 'https://b.example.com/2', title: 'two', text: 'gamma delta' });

    const res = await request(app).get('/api/admin/metrics').set(auth(admin.token));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      totalPages: 2,
      totalWebsites: 2,
      totalUsers: 2,
      activeCrawlerJobs: 0,
      failedCrawls: 0
    });
    expect(res.body.data.totalTerms).toBeGreaterThan(0);

    // The old mock values must be gone.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('12.4M');
    expect(body).not.toContain('85K');
    expect(body).not.toContain('2.1M');
  });

  it('counts searches that actually happened', async () => {
    await seedPage({ url: 'https://a.example.com/1', title: 'metrics', text: 'metrics test' });
    await request(app).get('/api/search').query({ q: 'metrics' });
    await request(app).get('/api/search').query({ q: 'metrics' });

    const res = await request(app).get('/api/admin/metrics').set(auth(admin.token));
    expect(res.body.data.totalSearches).toBe(2);
    expect(res.body.data.searchesToday).toBe(2);
  });

  it('reports zeroes on an empty index instead of inventing figures', async () => {
    const res = await request(app).get('/api/admin/metrics').set(auth(admin.token));
    expect(res.body.data.totalPages).toBe(0);
    expect(res.body.data.totalSearches).toBe(0);
    expect(res.body.data.avgResponseTimeMs).toBe(0);
  });
});

describe('GET /api/admin/dashboard', () => {
  beforeEach(async () => {
    await seedPage({ url: 'https://a.example.com/1', title: 'dash one', text: 'alpha' });
    await seedPage({ url: 'https://a.example.com/2', title: 'dash two', text: 'beta' });
    await request(app).get('/api/search').query({ q: 'dash' });
  });

  it('returns the shape the existing dashboard UI renders', async () => {
    const res = await request(app).get('/api/admin/dashboard').set(auth(admin.token));

    expect(res.status).toBe(200);
    expect(res.body.data.overview).toHaveLength(6);
    expect(res.body.data.overview[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        label: expect.any(String),
        value: expect.any(String),
        change: expect.any(String),
        status: expect.any(String),
        subtext: expect.any(String)
      })
    );
    expect(Array.isArray(res.body.data.indexHealth)).toBe(true);
    expect(Array.isArray(res.body.data.crawlerActivity24h)).toBe(true);
  });

  it('reports the real page count in the stat cards', async () => {
    const res = await request(app).get('/api/admin/dashboard').set(auth(admin.token));
    const indexedCard = res.body.data.overview.find(c => c.label === 'Indexed pages');
    expect(indexedCard.value).toBe('2');
    expect(res.body.data.raw.totalPages).toBe(2);
  });

  it('returns a complete 24-point crawl activity series with real counts', async () => {
    const res = await request(app).get('/api/admin/dashboard').set(auth(admin.token));
    const series = res.body.data.crawlerActivity24h;

    expect(series).toHaveLength(24);
    expect(series[0]).toEqual(
      expect.objectContaining({ hour: expect.any(String), pages: expect.any(Number) })
    );
    // The two pages were crawled just now.
    expect(series.reduce((sum, p) => sum + p.pages, 0)).toBe(2);
  });

  it('computes index-health percentages from measured values', async () => {
    const res = await request(app).get('/api/admin/dashboard').set(auth(admin.token));
    const titled = res.body.data.indexHealth.find(r => r.label === 'Pages with a title');
    expect(titled.percentage).toBe(100);

    const described = res.body.data.indexHealth.find(r => r.label === 'Pages with a description');
    expect(described.percentage).toBe(0); // the seeded pages have no description
  });

  it('lists the top domains', async () => {
    const res = await request(app).get('/api/admin/dashboard').set(auth(admin.token));
    expect(res.body.data.topDomains[0]).toMatchObject({ domain: 'a.example.com', pages: 2 });
  });
});

describe('GET /api/admin/pages', () => {
  beforeEach(async () => {
    await seedPage({ url: 'https://a.example.com/1', title: 'First page', text: 'alpha' });
    await seedPage({ url: 'https://b.example.com/2', title: 'Second page', text: 'beta' });
  });

  it('returns a paginated list', async () => {
    const res = await request(app)
      .get('/api/admin/pages')
      .query({ limit: 1 })
      .set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.pages).toHaveLength(1);
    expect(res.body.data.pagination).toMatchObject({
      totalResults: 2,
      totalPages: 2,
      hasNextPage: true
    });
  });

  it('never returns page bodies, which would be huge', async () => {
    const res = await request(app).get('/api/admin/pages').set(auth(admin.token));
    expect(res.body.data.pages[0].content).toBeUndefined();
  });

  it('filters by domain', async () => {
    const res = await request(app)
      .get('/api/admin/pages')
      .query({ domain: 'a.example.com' })
      .set(auth(admin.token));
    expect(res.body.data.pagination.totalResults).toBe(1);
  });

  it('filters by status', async () => {
    const res = await request(app)
      .get('/api/admin/pages')
      .query({ status: 'indexed' })
      .set(auth(admin.token));
    expect(res.body.data.pagination.totalResults).toBe(2);
  });

  it('searches by title or url without treating input as a regex', async () => {
    const byTitle = await request(app)
      .get('/api/admin/pages')
      .query({ q: 'First' })
      .set(auth(admin.token));
    expect(byTitle.body.data.pagination.totalResults).toBe(1);

    const regexy = await request(app)
      .get('/api/admin/pages')
      .query({ q: '.*' })
      .set(auth(admin.token));
    expect(regexy.body.data.pagination.totalResults).toBe(0);
  });

  it('rejects an invalid status', async () => {
    const res = await request(app)
      .get('/api/admin/pages')
      .query({ status: 'bogus' })
      .set(auth(admin.token));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/admin/websites', () => {
  it('lists domains with their real page counts', async () => {
    await seedPage({ url: 'https://a.example.com/1', title: 'one', text: 'alpha' });
    await seedPage({ url: 'https://a.example.com/2', title: 'two', text: 'beta' });
    await seedPage({ url: 'https://b.example.com/1', title: 'three', text: 'gamma' });

    const res = await request(app).get('/api/admin/websites').set(auth(admin.token));
    expect(res.status).toBe(200);

    const a = res.body.data.websites.find(w => w.domain === 'a.example.com');
    expect(a).toMatchObject({ pages: 2, indexedPages: 2 });
  });
});

describe('GET /api/admin/users', () => {
  it('lists users without password hashes', async () => {
    const res = await request(app).get('/api/admin/users').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.users).toHaveLength(2);
    expect(res.body.data.users[0].password).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('$2b$');
  });
});

describe('GET /api/admin/crawler/status', () => {
  it('reports an idle crawler on a fresh install', async () => {
    const res = await request(app).get('/api/admin/crawler/status').set(auth(admin.token));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ activeJobs: 0, isIdle: true, totalJobs: 0 });
    expect(res.body.data.byStatus).toEqual({
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      stopped: 0
    });
  });

  it('publishes the crawl limits so they are not guessed by the UI', async () => {
    const res = await request(app).get('/api/admin/crawler/status').set(auth(admin.token));
    expect(res.body.data.limits).toMatchObject({
      maxPagesPerJob: expect.any(Number),
      workerConcurrency: expect.any(Number),
      // Against config rather than a literal: the user agent now carries a
      // version and, when configured, a contact URL.
      userAgent: config.crawler.userAgent
    });
  });

  it('reports the frontier and the queue, not just the jobs', async () => {
    const res = await request(app).get('/api/admin/crawler/status').set(auth(admin.token));

    expect(res.body.data.frontier).toMatchObject({
      pending: expect.any(Number),
      done: expect.any(Number),
      total: expect.any(Number)
    });
    // Redis is not running in the default suite, and the status endpoint has
    // to say so rather than failing or pretending the queue is empty.
    expect(res.body.data.queue).toMatchObject({ available: expect.any(Boolean) });
  });
});

describe('POST /api/admin/crawler/start', () => {
  it('starts a real crawl job and returns a job id', async () => {
    const res = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(admin.token))
      .send({ seedUrl: site.url, maxPages: 2 });

    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({
      jobId: expect.stringMatching(/^[a-f0-9]{24}$/),
      status: expect.stringMatching(/queued|running/),
      maxPages: 2
    });

    // The API no longer crawls — it records the job and seeds the frontier,
    // and a worker does the fetching. So the seed URL must be waiting, and
    // nothing can have been fetched yet.
    expect(await CrawlFrontier.countDocuments({ status: 'pending' })).toBe(1);
    expect(await Page.countDocuments()).toBe(0);

    // Take the worker's part. This runs the real drain loop, frontier and
    // politeness rules; only BullMQ is absent.
    const job = await runCrawlToCompletion(res.body.data.jobId);

    expect(job.status).toBe('completed');
    expect(job.pagesCrawled).toBe(2);
    expect(job.pagesIndexed).toBe(2);
    expect(job.startedAt).toBeTruthy();
    expect(job.completedAt).toBeTruthy();

    // The crawl really wrote to the database.
    expect(await Page.countDocuments()).toBe(2);
  });

  it('seeds the frontier so the crawl survives a restart', async () => {
    const res = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(admin.token))
      .send({ seedUrl: site.url, maxPages: 5 });

    const row = await CrawlFrontier.findOne({ status: 'pending' }).lean();
    expect(row).toBeTruthy();
    expect(row.depth).toBe(0);
    expect(row.crawlJobId.toString()).toBe(res.body.data.jobId);
    // Seeds outrank what they discover, so the crawl starts where it was
    // pointed rather than wherever the frontier happens to sort.
    expect(row.priority).toBeGreaterThan(0);
  });

  it('records who started the job', async () => {
    const res = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(admin.token))
      .send({ seedUrl: site.url, maxPages: 1 });

    await runCrawlToCompletion(res.body.data.jobId);
    const job = await CrawlJob.findById(res.body.data.jobId);
    expect(job.startedBy.toString()).toBe(admin.user._id.toString());
  });

  it('defaults to staying on the seed domain', async () => {
    const res = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(admin.token))
      .send({ seedUrl: site.url, maxPages: 1 });

    expect(res.body.data.sameDomainOnly).toBe(true);
    await runCrawlToCompletion(res.body.data.jobId);
  });

  it.each([
    ['a missing seedUrl', {}, /seedUrl/i],
    ['a relative seedUrl', { seedUrl: '/relative' }, /seedUrl/i],
    ['a non-http scheme', { seedUrl: 'ftp://example.com' }, /http/i],
    ['maxPages of 0', { seedUrl: 'https://example.com', maxPages: 0 }, /maxPages/i],
    ['a negative maxPages', { seedUrl: 'https://example.com', maxPages: -5 }, /maxPages/i],
    ['a non-integer maxPages', { seedUrl: 'https://example.com', maxPages: 'lots' }, /maxPages/i],
    [
      'maxPages above the hard cap',
      { seedUrl: 'https://example.com', maxPages: 100000 },
      /cannot exceed/i
    ],
    ['an out-of-range maxDepth', { seedUrl: 'https://example.com', maxDepth: 99 }, /maxDepth/i]
  ])('rejects %s', async (_label, body, pattern) => {
    const res = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(admin.token))
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(pattern);
    expect(await CrawlJob.countDocuments()).toBe(0);
  });

  it('refuses to start an uncontrolled crawl with no page limit', async () => {
    // Omitting maxPages must fall back to the configured default, never unlimited.
    const res = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(admin.token))
      .send({ seedUrl: site.url });

    expect(res.status).toBe(202);
    expect(res.body.data.maxPages).toBeGreaterThan(0);
    expect(res.body.data.maxPages).toBeLessThanOrEqual(200);

    await request(app).post('/api/admin/crawler/stop').set(auth(admin.token)).send({});
    await runCrawlToCompletion(res.body.data.jobId);
  });

  it('is blocked for a normal user', async () => {
    const res = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(normalUser.token))
      .send({ seedUrl: site.url, maxPages: 1 });

    expect(res.status).toBe(403);
    expect(await CrawlJob.countDocuments()).toBe(0);
  });
});

describe('GET /api/admin/crawler/jobs', () => {
  it('lists jobs newest-first with progress', async () => {
    const started = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(admin.token))
      .send({ seedUrl: site.url, maxPages: 2 });
    await runCrawlToCompletion(started.body.data.jobId);

    const res = await request(app).get('/api/admin/crawler/jobs').set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.data.jobs).toHaveLength(1);
    expect(res.body.data.jobs[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        // The job now stores the canonical form, the same one the frontier
        // keys URLs by, so the two can never disagree about what was
        // crawled. normalizeUrl drops the trailing slash on a bare origin.
        seedUrl: normalizeUrl(site.url),
        status: 'completed',
        pagesCrawled: 2,
        pagesIndexed: 2,
        progressPercent: 100
      })
    );
  });

  it('filters by status', async () => {
    const started = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(admin.token))
      .send({ seedUrl: site.url, maxPages: 1 });
    await runCrawlToCompletion(started.body.data.jobId);

    const completed = await request(app)
      .get('/api/admin/crawler/jobs')
      .query({ status: 'completed' })
      .set(auth(admin.token));
    expect(completed.body.data.jobs).toHaveLength(1);

    const failed = await request(app)
      .get('/api/admin/crawler/jobs')
      .query({ status: 'failed' })
      .set(auth(admin.token));
    expect(failed.body.data.jobs).toHaveLength(0);
  });

  it('returns one job by id', async () => {
    const started = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(admin.token))
      .send({ seedUrl: site.url, maxPages: 1 });
    await runCrawlToCompletion(started.body.data.jobId);

    const res = await request(app)
      .get(`/api/admin/crawler/jobs/${started.body.data.jobId}`)
      .set(auth(admin.token));

    expect(res.status).toBe(200);
    expect(res.body.data.jobId).toBe(started.body.data.jobId);
  });

  it('returns 404 for an unknown job and 400 for a malformed id', async () => {
    expect(
      (
        await request(app)
          .get('/api/admin/crawler/jobs/6aabc623cb678866868d115e')
          .set(auth(admin.token))
      ).status
    ).toBe(404);
    expect(
      (await request(app).get('/api/admin/crawler/jobs/nonsense').set(auth(admin.token))).status
    ).toBe(400);
  });
});

describe('POST /api/admin/crawler/stop', () => {
  it('stops a running job gracefully and keeps the server alive', async () => {
    const started = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(admin.token))
      .send({ seedUrl: site.url, maxPages: 50, crawlDelayMs: 0 });

    const jobId = started.body.data.jobId;

    // Let a worker get one slice in, so there is a crawl in progress to
    // interrupt rather than an empty one.
    await runOneSlice(site.url, { slicePages: 1 });
    const midway = await CrawlJob.findById(jobId).lean();
    expect(midway.pagesCrawled).toBe(1);

    const stop = await request(app)
      .post('/api/admin/crawler/stop')
      .set(auth(admin.token))
      .send({ jobId });

    expect(stop.status).toBe(200);
    expect(stop.body.data.status).toMatch(/stopping|stopped/);

    // The request travels through the database, because the API cannot
    // reach into the worker process.
    expect((await CrawlJob.findById(jobId).lean()).stopRequested).toBe(true);

    const job = await runCrawlToCompletion(jobId);
    expect(job.status).toBe('stopped');
    // It stopped early rather than crawling all 50 pages, and it did crawl
    // something first — so this is a stop, not an empty run.
    expect(job.pagesCrawled).toBe(1);

    // The process is still serving requests.
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
  });

  it('stops every running job when no jobId is given', async () => {
    const started = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(admin.token))
      .send({ seedUrl: site.url, maxPages: 50, crawlDelayMs: 0 });

    const stop = await request(app).post('/api/admin/crawler/stop').set(auth(admin.token)).send({});
    expect(stop.status).toBe(200);
    expect(stop.body.data.stopped).toBe(1);

    const job = await runCrawlToCompletion(started.body.data.jobId);
    expect(job.status).toBe('stopped');
  });

  it('reports when there is nothing to stop', async () => {
    const res = await request(app).post('/api/admin/crawler/stop').set(auth(admin.token)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.stopped).toBe(0);
    expect(res.body.data.message).toMatch(/no crawl jobs/i);
  });

  it('refuses to stop an already-finished job', async () => {
    const started = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(admin.token))
      .send({ seedUrl: site.url, maxPages: 1 });
    await runCrawlToCompletion(started.body.data.jobId);

    const res = await request(app)
      .post('/api/admin/crawler/stop')
      .set(auth(admin.token))
      .send({ jobId: started.body.data.jobId });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already "completed"/i);
  });

  it('rejects a malformed jobId', async () => {
    const res = await request(app)
      .post('/api/admin/crawler/stop')
      .set(auth(admin.token))
      .send({ jobId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('is blocked for a normal user', async () => {
    expect(
      (await request(app).post('/api/admin/crawler/stop').set(auth(normalUser.token)).send({}))
        .status
    ).toBe(403);
  });
});

describe('crawler concurrency control', () => {
  it('refuses to start more than the allowed number of concurrent crawls', async () => {
    const jobs = [];
    for (let i = 0; i < config.crawler.maxConcurrentJobs; i += 1) {
      const res = await request(app)
        .post('/api/admin/crawler/start')
        .set(auth(admin.token))
        .send({ seedUrl: `${site.url}/page-${i}`, maxPages: 50, crawlDelayMs: 0 });
      expect(res.status).toBe(202);
      jobs.push(res.body.data.jobId);
    }

    const overflow = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(admin.token))
      .send({ seedUrl: site.url, maxPages: 5 });

    expect(overflow.status).toBe(409);
    expect(overflow.body.message).toMatch(/too many crawls/i);

    await request(app).post('/api/admin/crawler/stop').set(auth(admin.token)).send({});
    for (const id of jobs) await runCrawlToCompletion(id);
  });
});

describe('orphaned job detection', () => {
  /**
   * This replaces a test for `reconcileInterruptedJobs`, which failed every
   * running job whenever the API started up. That was right while the API
   * *was* the crawler; with a separate worker it would kill crawls that are
   * running perfectly well, so the trigger is now a silent heartbeat rather
   * than a process restart.
   */
  it('fails a job whose worker has gone quiet', async () => {
    await CrawlJob.create({
      seedUrl: 'https://example.com',
      maxPages: 10,
      status: 'running',
      lastHeartbeatAt: new Date(Date.now() - 60 * 60 * 1000)
    });
    // ...while the crawler itself has been running throughout.
    await crawlerRunningFor(2 * 60 * 60 * 1000);

    expect(await failOrphanedJobs()).toBe(1);

    const job = await CrawlJob.findOne();
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/abandoned/i);
  });

  it('leaves a job alone while its worker is still reporting', async () => {
    await CrawlJob.create({
      seedUrl: 'https://example.com',
      maxPages: 10,
      status: 'running',
      lastHeartbeatAt: new Date()
    });

    expect(await failOrphanedJobs()).toBe(0);
    expect((await CrawlJob.findOne()).status).toBe('running');
  });

  it('does not touch running jobs when the API restarts', async () => {
    // The old behaviour, asserted as absent: restarting the API must not
    // disturb a crawl a worker is part-way through.
    await CrawlJob.create({
      seedUrl: 'https://example.com',
      maxPages: 10,
      status: 'running',
      lastHeartbeatAt: new Date()
    });

    require('../../app').createApp();

    expect((await CrawlJob.findOne()).status).toBe('running');
  });
});
