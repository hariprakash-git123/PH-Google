const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const testDb = require('../helpers/testDb');
const { startFixtureSite, ROBOTS, urlsetXml } = require('../helpers/fixtureSite');
const { clearRobotsCache } = require('../../crawler/robotsChecker');
const { clearHostPolicyCache } = require('../../crawler/hostPolicy');
const { processHost } = require('../../crawler/crawlWorker');
const crawlerJobService = require('../../services/crawlerJobService');
const crawlQueue = require('../../services/queue/crawlQueue');
const frontier = require('../../services/frontierService');
const maintenance = require('../../services/crawlMaintenanceService');
const { loadSeedCatalog, clearSeedCatalogCache, DEFAULT_FILE } = require('../../config/crawlSeeds');
const CrawlJob = require('../../models/CrawlJob');
const SitemapDiscovery = require('../../models/SitemapDiscovery');
const { normalizeUrl } = require('../../utils/urlNormalizer');
const { config } = require('../../config/env');

/**
 * Per-seed sitemap opt-in (Step 6B Phase D).
 *
 * A seed opts in with `"sitemaps": true`; leaving it out opts out. The crawl
 * job carries the choice, every continuation of the chain copies it, and the
 * worker reads a host's sitemaps only when the global CRAWLER_SITEMAPS switch
 * AND the job both say yes.
 *
 * Local fixture site, in-memory MongoDB, and a stubbed queue: nothing here
 * talks to Redis or to any real website.
 */

let site;
let host;
let tmpDir;
const saved = {};
const SETTINGS = ['sitemaps', 'continuous', 'continuousMaxContinuations', 'seedsFile'];

beforeAll(async () => {
  await testDb.connect();
  site = await startFixtureSite({ sitemaps: true });
  host = frontier.hostOf(site.url);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-sitemap-optin-'));
  for (const key of SETTINGS) saved[key] = config.crawler[key];
});

afterAll(async () => {
  for (const key of SETTINGS) config.crawler[key] = saved[key];
  clearSeedCatalogCache();
  if (site) await site.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await testDb.disconnect();
});

beforeEach(async () => {
  await testDb.clear();
  clearRobotsCache();
  clearHostPolicyCache();
  clearSeedCatalogCache();
  site.requestLog.length = 0;
  for (const key of SETTINGS) config.crawler[key] = saved[key];
  config.crawler.continuous = false;
  site.robots = `${ROBOTS}Sitemap: ${abs('/sitemap.xml')}\n`;
  site.files = { '/sitemap.xml': { body: urlsetXml(SITEMAP_ONLY.map(abs)) } };
  // Job creation queues the seed's host; no queue is needed to test that.
  jest.spyOn(crawlQueue, 'enqueueHost').mockResolvedValue(undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const SITEMAP_ONLY = ['/nofollow', '/redirect-target'];
const abs = p => normalizeUrl(`${site.url}${p}`);
const sitemapRequests = () => site.requestLog.filter(r => r.path === '/sitemap.xml').length;

/** Writes a catalog file and points the crawler at it. */
function useCatalog(seeds) {
  const file = path.join(tmpDir, `catalog-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(file, JSON.stringify({ topics: [{ id: 'test', label: 'Test', seeds }] }));
  config.crawler.seedsFile = file;
  clearSeedCatalogCache();
  return file;
}

/** A running job with its seed in the frontier, as createJob makes one. */
async function runningJob({ maxPages = 10, ...fields } = {}) {
  const job = await CrawlJob.create({
    seedUrl: normalizeUrl(site.url),
    maxPages,
    maxDepth: 3,
    sameDomainOnly: true,
    crawlDelayMs: 0,
    status: 'running',
    lastHeartbeatAt: new Date(),
    ...fields
  });
  await frontier.addUrls([{ url: abs(''), depth: 0, priority: 1000 }], { crawlJobId: job._id });
  return job;
}

/** A job stored before the field existed: the document has no `sitemaps`. */
async function legacyJob() {
  const _id = new mongoose.Types.ObjectId();
  await CrawlJob.collection.insertOne({
    _id,
    seedUrl: normalizeUrl(site.url),
    maxPages: 10,
    maxDepth: 3,
    sameDomainOnly: true,
    allowedDomains: [],
    excludePatterns: [],
    crawlDelayMs: 0,
    status: 'running',
    lastHeartbeatAt: new Date(),
    pagesCrawled: 0,
    pagesIndexed: 0,
    failedPages: 0
  });
  await frontier.addUrls([{ url: abs(''), depth: 0, priority: 1000 }], { crawlJobId: _id });
  return CrawlJob.findById(_id).lean();
}

/** The job-handling steps of a maintenance pass; enqueueing needs Redis. */
async function sweep() {
  await frontier.reclaimStaleLeases();
  await maintenance.finaliseCompletedJobs();
  await maintenance.skipRowsOfClosedJobs();
}

// ----------------------------------------------------------------------
describe('the seed catalog', () => {
  it('reads "sitemaps": true', () => {
    const file = useCatalog([{ url: 'https://example.org/a', sitemaps: true }]);
    const [seed] = loadSeedCatalog(file).topics[0].seeds;
    expect(seed.sitemaps).toBe(true);
  });

  it('opts a seed out when the flag is left out', () => {
    const file = useCatalog([{ url: 'https://example.org/a' }]);
    const [seed] = loadSeedCatalog(file).topics[0].seeds;
    expect(seed.sitemaps).toBe(false);
  });

  it('reads an explicit "sitemaps": false', () => {
    const file = useCatalog([{ url: 'https://example.org/a', sitemaps: false }]);
    expect(loadSeedCatalog(file).topics[0].seeds[0].sitemaps).toBe(false);
  });

  it.each([['yes'], [1], ['true'], [null]])('rejects a non-boolean value %j', value => {
    const file = useCatalog([{ url: 'https://example.org/a', sitemaps: value }]);
    expect(() => loadSeedCatalog(file)).toThrow(/sitemaps must be true or false/);
  });

  it('opts no seed of the bundled catalog in', () => {
    const seeds = loadSeedCatalog(DEFAULT_FILE).topics.flatMap(t => t.seeds);
    expect(seeds.length).toBeGreaterThan(0);
    expect(seeds.filter(seed => seed.sitemaps)).toEqual([]);
  });
});

// ----------------------------------------------------------------------
describe('crawl job creation', () => {
  it('sets the job from the seed it was made for', async () => {
    useCatalog([
      { url: 'https://example.org/in', sitemaps: true },
      { url: 'https://example.org/out' },
      { url: 'https://example.org/explicit-out', sitemaps: false }
    ]);

    const { jobs } = await crawlerJobService.startSeedCrawl({
      topics: ['test'],
      maxPagesPerSeed: 1
    });

    const bySeed = Object.fromEntries(jobs.map(job => [job.seedUrl, job.sitemaps]));
    expect(bySeed).toEqual({
      'https://example.org/in': true,
      'https://example.org/out': false,
      'https://example.org/explicit-out': false
    });
    // What was stored, not only what was returned.
    const stored = await CrawlJob.find().lean();
    expect(stored.filter(job => job.sitemaps === true).map(job => job.seedUrl)).toEqual([
      'https://example.org/in'
    ]);
  });

  it('opts a single-URL crawl, which has no seed, out', async () => {
    const { job } = await crawlerJobService.startJob({ seedUrl: 'https://example.org/one' });
    expect(job.sitemaps).toBe(false);
    expect((await CrawlJob.findById(job._id).lean()).sitemaps).toBe(false);
  });

  it('does not take the setting from the global switch', async () => {
    config.crawler.sitemaps = true;
    useCatalog([{ url: 'https://example.org/out' }]);
    const { jobs } = await crawlerJobService.startSeedCrawl({
      topics: ['test'],
      maxPagesPerSeed: 1
    });
    expect(jobs[0].sitemaps).toBe(false);
  });
});

// ----------------------------------------------------------------------
describe('continuations', () => {
  /** Runs the root over its one-page budget, then sweeps until `count` continuations exist. */
  async function chainOf(root, count) {
    for (let i = 0; i < count; i += 1) {
      await processHost({ host, maxPages: 10 });
      await sweep();
    }
    return CrawlJob.find({ chainId: root._id }).sort({ continuationIndex: 1 }).lean();
  }

  beforeEach(() => {
    config.crawler.continuous = true;
  });

  it('keeps sitemaps: true through the whole chain', async () => {
    config.crawler.sitemaps = true;
    const root = await runningJob({ maxPages: 1, sitemaps: true });

    const chain = await chainOf(root, 2);

    expect(chain.length).toBeGreaterThanOrEqual(2);
    for (const job of chain) expect(job.sitemaps).toBe(true);
  });

  it('keeps sitemaps: false through the whole chain, with the global switch on', async () => {
    config.crawler.sitemaps = true;
    const root = await runningJob({ maxPages: 1, sitemaps: false });

    const chain = await chainOf(root, 2);

    expect(chain.length).toBeGreaterThanOrEqual(2);
    for (const job of chain) expect(job.sitemaps).toBe(false);
  });

  it('keeps sitemaps: true with the global switch off', async () => {
    config.crawler.sitemaps = false;
    const root = await runningJob({ maxPages: 1, sitemaps: true });

    const chain = await chainOf(root, 1);

    expect(chain).toHaveLength(1);
    expect(chain[0].sitemaps).toBe(true);
  });

  it('opts out the continuation of a job stored before the field existed', async () => {
    config.crawler.sitemaps = true;
    const root = await legacyJob();
    await CrawlJob.updateOne({ _id: root._id }, { $set: { maxPages: 1 } });

    const chain = await chainOf(root, 1);

    expect(chain).toHaveLength(1);
    expect(chain[0].sitemaps).toBe(false);
  });
});

// ----------------------------------------------------------------------
describe('the worker', () => {
  it('global off, job opted in: reads no sitemap', async () => {
    config.crawler.sitemaps = false;
    await runningJob({ sitemaps: true });

    await processHost({ host, maxPages: 5 });

    expect(sitemapRequests()).toBe(0);
    expect(await SitemapDiscovery.countDocuments()).toBe(0);
  });

  it('global on, job opted out: reads no sitemap', async () => {
    config.crawler.sitemaps = true;
    await runningJob({ sitemaps: false });

    await processHost({ host, maxPages: 5 });

    expect(sitemapRequests()).toBe(0);
    expect(await SitemapDiscovery.countDocuments()).toBe(0);
  });

  it('global on, job stored before the field existed: reads no sitemap', async () => {
    config.crawler.sitemaps = true;
    await legacyJob();

    await processHost({ host, maxPages: 5 });

    expect(sitemapRequests()).toBe(0);
    expect(await SitemapDiscovery.countDocuments()).toBe(0);
  });

  it('global on, job opted in: discovers the sitemap after the first indexed page', async () => {
    config.crawler.sitemaps = true;
    const job = await runningJob({ sitemaps: true });

    await processHost({ host, maxPages: 1 });

    const paths = site.requestLog.map(r => r.path).filter(p => p !== '/robots.txt');
    expect(paths).toEqual(['/', '/sitemap.xml']);
    const record = await SitemapDiscovery.findOne({ chainId: job._id, host }).lean();
    expect(record).toMatchObject({ status: 'done', urlsAdded: 2 });
  });

  it('opted-in chain: discovers once per chain and host, continuations included', async () => {
    config.crawler.sitemaps = true;
    config.crawler.continuous = true;
    const root = await runningJob({ maxPages: 1, sitemaps: true });

    for (let i = 0; i < 3; i += 1) {
      await processHost({ host, maxPages: 10 });
      await sweep();
    }

    expect(await CrawlJob.countDocuments({ chainId: root._id })).toBeGreaterThanOrEqual(1);
    expect(sitemapRequests()).toBe(1);
    const records = await SitemapDiscovery.find().lean();
    expect(records).toHaveLength(1);
    expect(String(records[0].chainId)).toBe(String(root._id));
  });

  it('two chains on one host: only the opted-in one discovers', async () => {
    config.crawler.sitemaps = true;
    const opted = await runningJob({ sitemaps: true, maxPages: 1 });
    await processHost({ host, maxPages: 1 });
    expect(sitemapRequests()).toBe(1);

    await CrawlJob.updateOne({ _id: opted._id }, { $set: { status: 'completed' } });
    await testDb.clear();
    site.requestLog.length = 0;
    await runningJob({ sitemaps: false, maxPages: 1 });
    await processHost({ host, maxPages: 1 });

    expect(sitemapRequests()).toBe(0);
  });
});
