const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const testDb = require('../helpers/testDb');
const { startFixtureSite } = require('../helpers/fixtureSite');
const { createUserWithToken, auth } = require('../helpers/factories');
const { clearRobotsCache } = require('../../crawler/robotsChecker');
const { clearHostPolicyCache } = require('../../crawler/hostPolicy');
const { drainCrawlQueue } = require('../helpers/crawlRunner');
const { clearSeedCatalogCache } = require('../../config/crawlSeeds');
const CrawlJob = require('../../models/CrawlJob');
const CrawlFrontier = require('../../models/CrawlFrontier');
const Page = require('../../models/Page');
const { config } = require('../../config/env');

/**
 * Topic crawls through the admin API: seed catalog -> one job per seed ->
 * the normal frontier/worker pipeline -> indexed pages.
 *
 * The catalog is a temporary file pointing at the local fixture site, so
 * nothing here touches a real website.
 */

let app;
let site;
let admin;
let normalUser;
let tmpDir;
const originalSeedsFile = config.crawler.seedsFile;

function writeCatalog(catalog) {
  const file = path.join(tmpDir, 'seeds.json');
  fs.writeFileSync(file, JSON.stringify(catalog));
  config.crawler.seedsFile = file;
  clearSeedCatalogCache();
}

beforeAll(async () => {
  await testDb.connect();
  app = require('../../app').createApp();
  site = await startFixtureSite();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-topic-'));
});

afterAll(async () => {
  config.crawler.seedsFile = originalSeedsFile;
  clearSeedCatalogCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (site) await site.close();
  await testDb.disconnect();
});

beforeEach(async () => {
  await testDb.clear();
  clearRobotsCache();
  clearHostPolicyCache();
  site.requestLog.length = 0;

  writeCatalog({
    defaultExcludePatterns: ['/login'],
    sources: {
      fixture: { allowedDomains: ['127.0.0.1'], excludePatterns: ['/blog/'] }
    },
    topics: [
      { id: 'home', label: 'Home', seeds: [{ url: site.url, source: 'fixture' }] },
      { id: 'about', label: 'About', seeds: [{ url: `${site.url}/about`, source: 'fixture' }] }
    ]
  });

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

const startTopics = body =>
  request(app).post('/api/admin/crawler/start').set(auth(admin.token)).send(body);

describe('GET /api/admin/crawler/seeds', () => {
  it('lists the catalog topics with their seeds and limits', async () => {
    const res = await request(app).get('/api/admin/crawler/seeds').set(auth(admin.token));

    expect(res.status).toBe(200);
    expect(res.body.data.topics.map(t => t.id)).toEqual(['home', 'about']);
    expect(res.body.data.totalSeeds).toBe(2);
    expect(res.body.data.topics[0].seeds[0].allowedDomains).toEqual(['127.0.0.1']);
    expect(res.body.data.limits).toMatchObject({
      defaultPagesPerSeed: config.crawler.seedPagesPerSeed,
      maxPagesPerCrawl: config.crawler.maxPagesPerCrawl
    });
  });

  it('is admin-only', async () => {
    const res = await request(app).get('/api/admin/crawler/seeds').set(auth(normalUser.token));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/crawler/start with topics', () => {
  it('creates one job per seed, sharing a batch, carrying the seed scope', async () => {
    const res = await startTopics({ topics: 'all', maxPagesPerSeed: 2 });

    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ seeds: 2, maxPagesPerSeed: 2, totalPageBudget: 4 });

    const jobs = await CrawlJob.find().lean();
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map(j => j.batchId)).size).toBe(1);
    expect(jobs.map(j => j.topic).sort()).toEqual(['about', 'home']);
    for (const job of jobs) {
      expect(job.maxPages).toBe(2);
      expect(job.allowedDomains).toEqual(['127.0.0.1']);
      expect(job.excludePatterns).toEqual(['/login', '/blog/']);
    }
    await drainCrawlQueue();
  });

  it('crawls every seed through the normal pipeline within its own budget', async () => {
    await startTopics({ topics: ['home', 'about'], maxPagesPerSeed: 2 });
    await drainCrawlQueue();

    const jobs = await CrawlJob.find().lean();
    for (const job of jobs) {
      expect(job.status).toBe('completed');
      expect(job.pagesCrawled).toBeLessThanOrEqual(2);
    }
    expect(await Page.countDocuments({ url: site.url })).toBe(1);
    expect(await Page.countDocuments({ url: `${site.url}/about` })).toBe(1);

    // The source excludes /blog/, so it is neither queued nor fetched.
    expect(await CrawlFrontier.countDocuments({ url: `${site.url}/blog/indexing` })).toBe(0);
    expect(site.requestLog.some(r => r.path === '/blog/indexing')).toBe(false);

    // Nothing is left for a worker to pick up after the crawl closes.
    expect(await CrawlFrontier.countDocuments({ status: { $in: ['pending', 'fetching'] } })).toBe(
      0
    );
  });

  it('never stores a page twice', async () => {
    await startTopics({ topics: 'all', maxPagesPerSeed: 3 });
    await drainCrawlQueue();

    const urls = (await Page.find().select('url').lean()).map(p => p.url);
    expect(urls.length).toBeGreaterThan(1);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('counts a whole topic crawl as one crawl against the concurrency limit', async () => {
    await startTopics({ topics: 'all', maxPagesPerSeed: 1 });

    const status = await request(app).get('/api/admin/crawler/status').set(auth(admin.token));
    expect(status.body.data.activeJobs).toBe(2);
    expect(status.body.data.activeCrawls).toBe(1);

    await drainCrawlQueue();
  });

  it('refuses a crawl whose total page budget is over the limit', async () => {
    const perSeed = Math.floor(config.crawler.maxPagesPerCrawl / 2) + 1;
    expect(perSeed).toBeLessThanOrEqual(config.crawler.maxPagesHardLimit);

    const res = await startTopics({ topics: 'all', maxPagesPerSeed: perSeed });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/limit per crawl/);
    expect(await CrawlJob.countDocuments()).toBe(0);
  });

  it('rejects an unknown topic', async () => {
    const res = await startTopics({ topics: ['home', 'nonexistent'] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/nonexistent/);
  });

  it('rejects an empty topic list', async () => {
    expect((await startTopics({ topics: [] })).status).toBe(400);
  });

  it('rejects seedUrl and topics together', async () => {
    expect((await startTopics({ topics: 'all', seedUrl: site.url })).status).toBe(400);
  });

  it('rejects an invalid pages-per-seed value', async () => {
    expect((await startTopics({ topics: 'all', maxPagesPerSeed: 0 })).status).toBe(400);
  });

  it('is admin-only', async () => {
    const res = await request(app)
      .post('/api/admin/crawler/start')
      .set(auth(normalUser.token))
      .send({ topics: 'all' });
    expect(res.status).toBe(403);
  });

  it('leaves single-URL crawls working as before', async () => {
    const res = await startTopics({ seedUrl: site.url, maxPages: 2 });

    expect(res.status).toBe(202);
    const job = await CrawlJob.findById(res.body.data.jobId).lean();
    expect(job.batchId).toBeNull();
    expect(job.allowedDomains).toEqual([]);
    await drainCrawlQueue();
  });
});

describe('POST /api/admin/crawler/stop with batchId', () => {
  it('stops every job of the topic crawl', async () => {
    const started = await startTopics({ topics: 'all', maxPagesPerSeed: 5 });

    const res = await request(app)
      .post('/api/admin/crawler/stop')
      .set(auth(admin.token))
      .send({ batchId: started.body.data.batchId });

    expect(res.status).toBe(200);
    expect(res.body.data.stopped).toBe(2);

    await drainCrawlQueue();
    const jobs = await CrawlJob.find().lean();
    expect(jobs.every(j => j.status === 'stopped')).toBe(true);
  });

  it('returns 404 for an unknown batch', async () => {
    const res = await request(app)
      .post('/api/admin/crawler/stop')
      .set(auth(admin.token))
      .send({ batchId: 'no-such-batch' });
    expect(res.status).toBe(404);
  });
});
