const mongoose = require('mongoose');
const testDb = require('../helpers/testDb');
const { startFixtureSite, ROBOTS, urlsetXml, sitemapIndexXml } = require('../helpers/fixtureSite');
const { clearRobotsCache } = require('../../crawler/robotsChecker');
const { clearHostPolicyCache } = require('../../crawler/hostPolicy');
const { discover, urlCap } = require('../../services/sitemapDiscoveryService');
const frontier = require('../../services/frontierService');
const CrawlFrontier = require('../../models/CrawlFrontier');
const SitemapDiscovery = require('../../models/SitemapDiscovery');
const { config } = require('../../config/env');

/**
 * Sitemap discovery against a local fixture site and an in-memory MongoDB.
 * Nothing here reaches a real website, and nothing calls the crawler.
 */

let site;
let host;
const saved = {};
const SETTINGS = [
  'sitemapMaxFiles',
  'sitemapMaxDepth',
  'sitemapMaxUrls',
  'sitemapMaxUrlsPerFile',
  'sitemapFallback',
  'continuous',
  'continuousMaxContinuations'
];

beforeAll(async () => {
  await testDb.connect();
  site = await startFixtureSite({ sitemaps: true });
  host = frontier.hostOf(site.url);
  for (const key of SETTINGS) saved[key] = config.crawler[key];
});

afterAll(async () => {
  for (const key of SETTINGS) config.crawler[key] = saved[key];
  if (site) await site.close();
  await testDb.disconnect();
});

beforeEach(async () => {
  await testDb.clear();
  clearRobotsCache();
  clearHostPolicyCache();
  site.requestLog.length = 0;
  for (const key of SETTINGS) config.crawler[key] = saved[key];
  config.crawler.continuous = false;
  // Fresh files each test: a robots.txt naming /sitemap.xml, and that sitemap.
  site.robots = `${ROBOTS}Sitemap: ${site.url}/sitemap.xml\n`;
  site.files = {
    '/sitemap.xml': { body: urlsetXml(['/', '/about', '/blog/indexing'].map(abs)) }
  };
});

const abs = path => `${site.url}${path}`;

/** A job as discover() receives it: what the worker holds for a claimed URL. */
function makeJob(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    seedUrl: site.url,
    maxPages: 100,
    maxDepth: 3,
    sameDomainOnly: true,
    allowedDomains: [],
    excludePatterns: [],
    crawlDelayMs: 0,
    ...overrides
  };
}

const sitemapRequests = () =>
  site.requestLog.filter(r => r.path !== '/robots.txt').map(r => r.path);

const frontierUrls = async job =>
  (await CrawlFrontier.find({ crawlJobId: job._id }).sort({ _id: 1 }).lean()).map(r => r.url);

describe('finding sitemaps', () => {
  it('A. reads the sitemap robots.txt names and adds its URLs to the frontier', async () => {
    const job = makeJob();
    const result = await discover({ job, host });

    expect(result).toMatchObject({ status: 'done', filesFetched: 1, urlsFound: 3, urlsAdded: 3 });
    expect(sitemapRequests()).toEqual(['/sitemap.xml']);

    const rows = await CrawlFrontier.find({ crawlJobId: job._id }).lean();
    expect(rows.map(r => r.url).sort()).toEqual(
      [site.url, abs('/about'), abs('/blog/indexing')].sort()
    );
    // Ordinary frontier work: pending, depth 1, priority of a seed's link.
    for (const row of rows) {
      expect(row).toMatchObject({ status: 'pending', depth: 1, priority: -1, host });
      expect(row.referrerUrl).toBe(abs('/sitemap.xml'));
    }
  });

  it('B. falls back to /sitemap.xml when robots.txt names none', async () => {
    site.robots = ROBOTS;

    const result = await discover({ job: makeJob(), host });

    expect(sitemapRequests()).toEqual(['/sitemap.xml']);
    expect(result.urlsAdded).toBe(3);
  });

  it('B. tries nothing when there is no sitemap listed and the fallback is off', async () => {
    site.robots = ROBOTS;
    config.crawler.sitemapFallback = false;

    const result = await discover({ job: makeJob(), host });

    expect(sitemapRequests()).toEqual([]);
    expect(result).toMatchObject({ status: 'done', urlsAdded: 0 });
  });

  it('C. follows a sitemap index to its sitemaps', async () => {
    site.robots = `${ROBOTS}Sitemap: ${abs('/index.xml')}\n`;
    site.files['/index.xml'] = { body: sitemapIndexXml([abs('/s1.xml')]) };
    site.files['/s1.xml'] = { body: urlsetXml([abs('/about'), abs('/one')]) };

    const job = makeJob();
    const result = await discover({ job, host });

    expect(sitemapRequests()).toEqual(['/index.xml', '/s1.xml']);
    expect(result).toMatchObject({ filesFetched: 2, urlsAdded: 2 });
    expect((await frontierUrls(job)).sort()).toEqual([abs('/about'), abs('/one')].sort());
  });

  it('D. follows nested indexes down to the depth limit and no further', async () => {
    site.robots = `${ROBOTS}Sitemap: ${abs('/index.xml')}\n`;
    site.files['/index.xml'] = { body: sitemapIndexXml([abs('/nested.xml')]) };
    site.files['/nested.xml'] = { body: sitemapIndexXml([abs('/leaf.xml')]) };
    site.files['/leaf.xml'] = { body: urlsetXml([abs('/deep')]) };

    const job = makeJob();
    expect((await discover({ job, host })).urlsAdded).toBe(1);
    expect(sitemapRequests()).toEqual(['/index.xml', '/nested.xml', '/leaf.xml']);

    // One level less: the second index is read, the urlset under it is not.
    config.crawler.sitemapMaxDepth = 1;
    site.requestLog.length = 0;
    const shallow = await discover({ job: makeJob(), host });
    expect(sitemapRequests()).toEqual(['/index.xml', '/nested.xml']);
    expect(shallow.urlsAdded).toBe(0);
  });

  it('E. reads several listed sitemaps, but no more than the file limit', async () => {
    config.crawler.sitemapMaxFiles = 2;
    site.robots = `${ROBOTS}${['/m1.xml', '/m2.xml', '/m3.xml', '/m4.xml']
      .map(p => `Sitemap: ${abs(p)}`)
      .join('\n')}\n`;
    for (const name of ['m1', 'm2', 'm3', 'm4']) {
      site.files[`/${name}.xml`] = { body: urlsetXml([abs(`/${name}-page`)]) };
    }

    const result = await discover({ job: makeJob(), host });

    expect(sitemapRequests()).toEqual(['/m1.xml', '/m2.xml']);
    expect(result).toMatchObject({ filesFetched: 2, urlsAdded: 2 });
  });

  it('F. ends a sitemap loop instead of following it forever', async () => {
    site.robots = `${ROBOTS}Sitemap: ${abs('/a.xml')}\n`;
    site.files['/a.xml'] = { body: sitemapIndexXml([abs('/b.xml')]) };
    site.files['/b.xml'] = { body: sitemapIndexXml([abs('/a.xml'), abs('/b.xml')]) };

    const result = await discover({ job: makeJob(), host });

    expect(sitemapRequests()).toEqual(['/a.xml', '/b.xml']);
    expect(result).toMatchObject({ status: 'done', filesFetched: 2, urlsAdded: 0 });
  });

  it('G. stops at the file limit however many sitemaps an index lists', async () => {
    config.crawler.sitemapMaxFiles = 3;
    const parts = Array.from({ length: 10 }, (_, i) => `/part${i}.xml`);
    site.robots = `${ROBOTS}Sitemap: ${abs('/index.xml')}\n`;
    site.files['/index.xml'] = { body: sitemapIndexXml(parts.map(abs)) };
    for (const part of parts) {
      site.files[part] = { body: urlsetXml([abs(`${part}-page`)]) };
    }

    const result = await discover({ job: makeJob(), host });

    // The index plus two of its sitemaps.
    expect(sitemapRequests()).toEqual(['/index.xml', '/part0.xml', '/part1.xml']);
    expect(result.urlsAdded).toBe(2);
  });

  it('R. does not fetch a sitemap robots.txt lists on another host', async () => {
    config.crawler.sitemapFallback = false;
    // localhost is this server, but not the crawl host 127.0.0.1.
    site.robots = `${ROBOTS}Sitemap: http://localhost:${site.port}/sitemap.xml\n`;

    const result = await discover({ job: makeJob(), host });

    expect(site.requestLog.some(r => r.host.startsWith('localhost'))).toBe(false);
    expect(sitemapRequests()).toEqual([]);
    expect(result.urlsAdded).toBe(0);
  });
});

describe('URL caps', () => {
  const manyPages = n => urlsetXml(Array.from({ length: n }, (_, i) => abs(`/p${i}`)));

  it('H. adds no more than CRAWLER_SITEMAP_MAX_URLS', async () => {
    config.crawler.sitemapMaxUrls = 10;
    site.files['/sitemap.xml'] = { body: manyPages(50) };
    const job = makeJob();

    const result = await discover({ job, host });

    expect(result.urlsAdded).toBe(10);
    expect(await CrawlFrontier.countDocuments({ crawlJobId: job._id })).toBe(10);
  });

  it('H. adds no more than the chain could ever crawl', async () => {
    site.files['/sitemap.xml'] = { body: manyPages(50) };

    const single = makeJob({ maxPages: 2 });
    expect((await discover({ job: single, host })).urlsAdded).toBe(2);

    // Continuous: two pages for the job and for each of two continuations.
    // (Fresh frontier, or the first job's two rows would already be known.)
    await CrawlFrontier.deleteMany({});
    config.crawler.continuous = true;
    config.crawler.continuousMaxContinuations = 2;
    const chain = makeJob({ maxPages: 2 });
    expect(urlCap(chain)).toBe(6);
    expect((await discover({ job: chain, host })).urlsAdded).toBe(6);
  });

  it('H. adds nothing to a crawl whose depth limit keeps it on the seed', async () => {
    const job = makeJob({ maxDepth: 0 });
    const result = await discover({ job, host });

    expect(result.urlsAdded).toBe(0);
    expect(sitemapRequests()).toEqual([]);
  });

  it('reads each file only up to the per-file limit', async () => {
    config.crawler.sitemapMaxUrlsPerFile = 5;
    site.files['/sitemap.xml'] = { body: manyPages(50) };

    const result = await discover({ job: makeJob(), host });

    expect(result).toMatchObject({ urlsFound: 5, urlsAdded: 5 });
  });
});

describe('which URLs may enter the frontier', () => {
  async function discoverLocs(locs, jobOverrides) {
    site.files['/sitemap.xml'] = { body: urlsetXml(locs) };
    const job = makeJob(jobOverrides);
    const result = await discover({ job, host });
    return { job, result, urls: await frontierUrls(job) };
  }

  it('I. adds one row for several spellings of the same page', async () => {
    const { urls, result } = await discoverLocs([
      abs('/about'),
      abs('/about/'),
      abs('/about#team'),
      `http://127.0.0.1:${site.port}/about`
    ]);
    expect(urls).toEqual([abs('/about')]);
    expect(result.urlsAdded).toBe(1);
  });

  it('J. treats tracking parameters as the same page', async () => {
    const { urls } = await discoverLocs([
      abs('/about?utm_source=newsletter&utm_medium=email'),
      abs('/about'),
      abs('/about?fbclid=abc')
    ]);
    expect(urls).toHaveLength(1);
  });

  it('J. still deduplicates against rows the frontier already has', async () => {
    const job = makeJob();
    await frontier.addUrls([{ url: abs('/about'), depth: 1 }], { crawlJobId: job._id });
    site.files['/sitemap.xml'] = { body: urlsetXml([abs('/about'), abs('/new')]) };

    const result = await discover({ job, host });

    expect(result.urlsAdded).toBe(1);
    expect(await CrawlFrontier.countDocuments()).toBe(2);
  });

  it('K. rejects pages on other domains', async () => {
    const { urls, result } = await discoverLocs([
      'https://other.example.org/page',
      'https://evil.test/',
      abs('/about')
    ]);
    expect(urls).toEqual([abs('/about')]);
    expect(result.urlsRejected).toBe(2);
  });

  it('L. accepts a subdomain only when the crawl scope allows it', async () => {
    const locs = ['https://blog.example.org/post', 'https://example.org/', 'https://evil.test/'];

    const sameDomain = await discoverLocs(locs);
    expect(sameDomain.urls).toEqual([]);

    const allowed = await discoverLocs(locs, { allowedDomains: ['example.org'] });
    expect(allowed.urls.sort()).toEqual(
      ['https://blog.example.org/post', 'https://example.org'].sort()
    );
  });

  it('M. rejects pages matching the exclude patterns', async () => {
    const { urls } = await discoverLocs([abs('/blog/indexing'), abs('/about')], {
      excludePatterns: ['/blog/']
    });
    expect(urls).toEqual([abs('/about')]);
  });

  it('N. rejects PDFs, images and other files', async () => {
    const { urls } = await discoverLocs([
      abs('/report.pdf'),
      abs('/photo.JPG'),
      abs('/data.json'),
      abs('/archive.zip?v=2'),
      abs('/about')
    ]);
    expect(urls).toEqual([abs('/about')]);
  });

  it('O. rejects pages robots.txt disallows', async () => {
    const { urls, result } = await discoverLocs([abs('/private/secret'), abs('/about')]);
    expect(urls).toEqual([abs('/about')]);
    expect(result.urlsRejected).toBe(1);
  });

  it('rejects entries that are not web URLs', async () => {
    const { urls } = await discoverLocs([
      'ftp://127.0.0.1/file',
      'javascript:alert(1)',
      'not a url',
      abs('/about')
    ]);
    expect(urls).toEqual([abs('/about')]);
  });
});

describe('lastmod', () => {
  it('P. keeps the newest pages when there are more than the cap', async () => {
    config.crawler.sitemapMaxUrls = 2;
    site.files['/sitemap.xml'] = {
      body: urlsetXml([
        { loc: abs('/old'), lastmod: '2020-01-01' },
        { loc: abs('/newest'), lastmod: '2026-09-20' },
        { loc: abs('/undated') },
        { loc: abs('/middle'), lastmod: '2024-06-01' }
      ])
    };
    const job = makeJob();

    await discover({ job, host });

    expect((await frontierUrls(job)).sort()).toEqual([abs('/middle'), abs('/newest')].sort());
  });

  it('Q. falls back to document order when lastmod is invalid', async () => {
    config.crawler.sitemapMaxUrls = 2;
    site.files['/sitemap.xml'] = {
      body: urlsetXml([
        { loc: abs('/first'), lastmod: 'yesterday' },
        { loc: abs('/second'), lastmod: '2026-99-99' },
        { loc: abs('/third'), lastmod: 'soon' }
      ])
    };
    const job = makeJob();

    await discover({ job, host });

    expect((await frontierUrls(job)).sort()).toEqual([abs('/first'), abs('/second')].sort());
  });

  it('does not let lastmod change priority, depth or schedule', async () => {
    site.files['/sitemap.xml'] = {
      body: urlsetXml([{ loc: abs('/fresh'), lastmod: '2026-09-29' }])
    };
    const job = makeJob();
    const before = Date.now();

    await discover({ job, host });

    const row = await CrawlFrontier.findOne({ crawlJobId: job._id }).lean();
    expect(row).toMatchObject({ depth: 1, priority: -1, status: 'pending' });
    expect(row.nextCrawlAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.nextCrawlAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('failures', () => {
  it('S. records a failed discovery without touching the frontier', async () => {
    site.robots = `${ROBOTS}Sitemap: ${abs('/missing.xml')}\nSitemap: ${abs('/broken.xml')}\n`;
    site.files['/broken.xml'] = { status: 500, type: 'text/plain', body: 'Oops' };
    const job = makeJob();

    const result = await discover({ job, host });

    expect(result).toMatchObject({
      status: 'failed',
      filesFetched: 0,
      filesFailed: 2,
      urlsAdded: 0
    });
    expect(await CrawlFrontier.countDocuments()).toBe(0);

    const record = await SitemapDiscovery.findOne({ chainId: job._id, host }).lean();
    expect(record.status).toBe('failed');
    expect(record.completedAt).toBeInstanceOf(Date);
    expect(record.errors.join(' ')).toMatch(/http_error/);
  });

  it('S. keeps going past a broken sitemap to the ones that work', async () => {
    site.robots = `${ROBOTS}Sitemap: ${abs('/garbage.xml')}\nSitemap: ${abs('/sitemap.xml')}\n`;
    site.files['/garbage.xml'] = { type: 'text/html', body: '<html><body>Not here</body></html>' };

    const result = await discover({ job: makeJob(), host });

    expect(result).toMatchObject({ status: 'done', filesFailed: 1, filesFetched: 1, urlsAdded: 3 });
  });

  it('S. records malformed XML as a sitemap with nothing usable in it', async () => {
    site.files['/sitemap.xml'] = { body: '<urlset><url><loc>' };
    const result = await discover({ job: makeJob(), host });
    expect(result).toMatchObject({ status: 'done', urlsAdded: 0 });
  });

  it('keeps the stored record small: counts and a few short errors', async () => {
    config.crawler.sitemapMaxFiles = 10;
    site.robots = `${ROBOTS}${Array.from({ length: 10 }, (_, i) => `Sitemap: ${abs(`/gone${i}.xml`)}`).join('\n')}\n`;
    const job = makeJob();

    await discover({ job, host });

    const record = await SitemapDiscovery.findOne({ chainId: job._id }).lean();
    expect(record.errors.length).toBeLessThanOrEqual(5);
    expect(Object.keys(record)).not.toEqual(expect.arrayContaining(['urls', 'body']));
  });
});

describe('once per chain and host', () => {
  it('T. does not repeat a discovery that already ran', async () => {
    const job = makeJob();
    expect((await discover({ job, host })).status).toBe('done');
    const requests = site.requestLog.length;

    const again = await discover({ job, host });

    expect(again).toMatchObject({ status: 'skipped', reason: 'already_done', urlsAdded: 0 });
    expect(site.requestLog.length).toBe(requests);
  });

  it('T. treats a continuation as the same chain', async () => {
    const root = makeJob();
    await discover({ job: root, host });
    site.requestLog.length = 0;

    const continuation = makeJob({ chainId: root._id });
    const result = await discover({ job: continuation, host });

    expect(result.status).toBe('skipped');
    expect(sitemapRequests()).toEqual([]);
  });

  it('U. lets exactly one of several simultaneous attempts run', async () => {
    const job = makeJob();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => discover({ job: { ...job }, host }))
    );

    expect(results.filter(r => r.status === 'done')).toHaveLength(1);
    expect(results.filter(r => r.status === 'skipped')).toHaveLength(4);
    expect(sitemapRequests()).toEqual(['/sitemap.xml']);
    expect(await SitemapDiscovery.countDocuments()).toBe(1);
    expect(await CrawlFrontier.countDocuments()).toBe(3);
  });

  it('returns a result instead of throwing on bad arguments', async () => {
    expect(await discover({})).toMatchObject({ status: 'skipped', reason: 'invalid_arguments' });
    expect(await discover({ job: makeJob() })).toMatchObject({ status: 'skipped' });
  });
});
