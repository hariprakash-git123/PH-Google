const testDb = require('../helpers/testDb');
const frontier = require('../../services/frontierService');
const CrawlFrontier = require('../../models/CrawlFrontier');
const CrawlJob = require('../../models/CrawlJob');
const { config } = require('../../config/env');

/**
 * The crawl frontier.
 *
 * This replaced an in-memory queue that lived for one crawl run, so the
 * properties worth testing are the ones that in-memory queue could not have:
 * that it survives a restart, that it is shared between jobs, and that two
 * workers racing for the same URL cannot both get it.
 */

beforeAll(async () => {
  await testDb.connect();
});

afterAll(async () => {
  await testDb.disconnect();
});

beforeEach(async () => {
  await testDb.clear();
});

describe('adding URLs', () => {
  it('stores a URL with its host, depth and priority', async () => {
    const { added } = await frontier.addUrls([
      { url: 'https://example.com/a', depth: 2, priority: 5 }
    ]);

    expect(added).toBe(1);
    const row = await CrawlFrontier.findOne().lean();
    expect(row).toMatchObject({
      url: 'https://example.com/a',
      host: 'example.com',
      depth: 2,
      priority: 5,
      status: 'pending'
    });
  });

  it('canonicalises before storing, so one page is one row', async () => {
    await frontier.addUrls([
      { url: 'https://example.com/a' },
      { url: 'https://example.com/a?utm_source=twitter' },
      { url: 'https://example.com/a#section' }
    ]);

    expect(await CrawlFrontier.countDocuments()).toBe(1);
  });

  it('ignores a URL it already knows', async () => {
    await frontier.addUrls([{ url: 'https://example.com/a' }]);
    const second = await frontier.addUrls([{ url: 'https://example.com/a' }]);

    expect(second.added).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await CrawlFrontier.countDocuments()).toBe(1);
  });

  it('does not resurrect a finished row when the URL is rediscovered', async () => {
    await frontier.addUrls([{ url: 'https://example.com/a' }]);
    await frontier.markDone('https://example.com/a');

    await frontier.addUrls([{ url: 'https://example.com/a', depth: 9 }]);

    const row = await CrawlFrontier.findOne().lean();
    expect(row.status).toBe('done');
    expect(row.depth).toBe(0);
  });

  it('handles a batch containing the same URL twice', async () => {
    // An unordered bulk write would report this as a duplicate-key error.
    const { added } = await frontier.addUrls([
      { url: 'https://example.com/a' },
      { url: 'https://example.com/a' },
      { url: 'https://example.com/b' }
    ]);

    expect(added).toBe(2);
  });

  it('drops anything that is not a usable URL', async () => {
    const { added } = await frontier.addUrls([
      { url: 'not a url' },
      { url: 'javascript:void(0)' },
      { url: '' },
      { url: null }
    ]);

    expect(added).toBe(0);
    expect(await CrawlFrontier.countDocuments()).toBe(0);
  });

  it('accepts an empty batch without touching the database', async () => {
    expect(await frontier.addUrls([])).toEqual({ added: 0, skipped: 0 });
  });
});

describe('claiming work', () => {
  it('claims a pending URL and marks it fetching', async () => {
    await frontier.addUrls([{ url: 'https://example.com/a' }]);

    const claimed = await frontier.claimNext('example.com');

    expect(claimed.url).toBe('https://example.com/a');
    expect(claimed.status).toBe('fetching');
    expect(claimed.attempts).toBe(1);
    expect(claimed.leasedAt).toBeTruthy();
  });

  it('never hands the same URL to two workers', async () => {
    await frontier.addUrls([{ url: 'https://example.com/a' }]);

    // Both claims race, as two workers on the same host would.
    const [first, second] = await Promise.all([
      frontier.claimNext('example.com'),
      frontier.claimNext('example.com')
    ]);

    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
  });

  it('claims only from the host asked for', async () => {
    await frontier.addUrls([
      { url: 'https://a.example.com/1' },
      { url: 'https://b.example.com/1' }
    ]);

    const claimed = await frontier.claimNext('a.example.com');
    expect(claimed.host).toBe('a.example.com');
  });

  it('prefers higher priority, then shallower depth', async () => {
    await frontier.addUrls([
      { url: 'https://example.com/deep', depth: 5, priority: 0 },
      { url: 'https://example.com/shallow', depth: 1, priority: 0 },
      { url: 'https://example.com/seed', depth: 0, priority: 1000 }
    ]);

    expect((await frontier.claimNext('example.com')).url).toBe('https://example.com/seed');
    expect((await frontier.claimNext('example.com')).url).toBe('https://example.com/shallow');
    expect((await frontier.claimNext('example.com')).url).toBe('https://example.com/deep');
  });

  it('does not claim a URL whose next-crawl time is in the future', async () => {
    await frontier.addUrls([{ url: 'https://example.com/a' }]);
    await CrawlFrontier.updateOne(
      { url: 'https://example.com/a' },
      { $set: { nextCrawlAt: new Date(Date.now() + 60_000) } }
    );

    expect(await frontier.claimNext('example.com')).toBeNull();
  });

  it('returns null when a host has nothing waiting', async () => {
    expect(await frontier.claimNext('nothing.example.com')).toBeNull();
  });
});

describe('recording outcomes', () => {
  beforeEach(async () => {
    await frontier.addUrls([{ url: 'https://example.com/a' }]);
    await frontier.claimNext('example.com');
  });

  it('marks a page done and schedules its re-crawl', async () => {
    await frontier.markDone('https://example.com/a', { statusCode: 200 });

    const row = await CrawlFrontier.findOne().lean();
    expect(row.status).toBe('done');
    expect(row.lastStatusCode).toBe(200);
    expect(row.lastCrawledAt).toBeTruthy();
    expect(row.leasedAt).toBeNull();

    const daysAhead = (row.nextCrawlAt - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysAhead).toBeGreaterThan(config.crawler.recrawlAfterDays - 1);
  });

  it('retries a failure with a backoff instead of giving up', async () => {
    const { retrying } = await frontier.markFailed('https://example.com/a', { reason: 'timeout' });

    expect(retrying).toBe(true);
    const row = await CrawlFrontier.findOne().lean();
    expect(row.status).toBe('pending');
    expect(row.lastError).toBe('timeout');
    expect(row.nextCrawlAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('gives up after the configured number of attempts', async () => {
    await CrawlFrontier.updateOne(
      { url: 'https://example.com/a' },
      { $set: { attempts: config.crawler.maxAttemptsPerUrl } }
    );

    const { retrying } = await frontier.markFailed('https://example.com/a', { reason: 'timeout' });

    expect(retrying).toBe(false);
    expect((await CrawlFrontier.findOne().lean()).status).toBe('failed');
  });

  it('marks a skip without counting it as a failure', async () => {
    await frontier.markSkipped('https://example.com/a', 'robots_txt');

    const row = await CrawlFrontier.findOne().lean();
    expect(row.status).toBe('skipped');
    expect(row.lastError).toBe('robots_txt');
  });

  it('truncates a long error rather than storing a stack trace', async () => {
    await frontier.markFailed('https://example.com/a', { reason: 'x'.repeat(5000) });
    expect((await CrawlFrontier.findOne().lean()).lastError.length).toBeLessThanOrEqual(200);
  });
});

describe('recovering from a dead worker', () => {
  it('returns an abandoned claim to the frontier', async () => {
    await frontier.addUrls([{ url: 'https://example.com/a' }]);
    await frontier.claimNext('example.com');

    // As if the worker holding it was killed.
    await CrawlFrontier.updateOne(
      { url: 'https://example.com/a' },
      { $set: { leasedAt: new Date(Date.now() - config.crawler.leaseTimeoutMs - 1000) } }
    );

    expect(await frontier.reclaimStaleLeases()).toBe(1);
    expect((await CrawlFrontier.findOne().lean()).status).toBe('pending');
  });

  it('leaves a fresh claim alone', async () => {
    await frontier.addUrls([{ url: 'https://example.com/a' }]);
    await frontier.claimNext('example.com');

    expect(await frontier.reclaimStaleLeases()).toBe(0);
    expect((await CrawlFrontier.findOne().lean()).status).toBe('fetching');
  });
});

describe('re-crawling', () => {
  it('re-queues a page once its re-crawl time has passed', async () => {
    await frontier.addUrls([{ url: 'https://example.com/a' }]);
    await CrawlFrontier.updateOne(
      { url: 'https://example.com/a' },
      { $set: { status: 'done', nextCrawlAt: new Date(Date.now() - 1000), attempts: 2 } }
    );

    expect(await frontier.requeueDueForRecrawl()).toBe(1);

    const row = await CrawlFrontier.findOne().lean();
    expect(row.status).toBe('pending');
    // A page that failed twice months ago deserves a fair run at its
    // scheduled re-crawl.
    expect(row.attempts).toBe(0);
  });

  it('leaves a page that is not yet stale', async () => {
    await frontier.addUrls([{ url: 'https://example.com/a' }]);
    await frontier.markDone('https://example.com/a');

    expect(await frontier.requeueDueForRecrawl()).toBe(0);
  });
});

describe('reporting', () => {
  it('lists hosts with work waiting, busiest first', async () => {
    await frontier.addUrls([
      { url: 'https://busy.example.com/1' },
      { url: 'https://busy.example.com/2' },
      { url: 'https://busy.example.com/3' },
      { url: 'https://quiet.example.com/1' }
    ]);

    const hosts = await frontier.hostsWithPendingWork();
    expect(hosts[0]).toEqual({ host: 'busy.example.com', pending: 3 });
    expect(hosts[1]).toEqual({ host: 'quiet.example.com', pending: 1 });
  });

  it('says whether a host still has work', async () => {
    await frontier.addUrls([{ url: 'https://example.com/a' }]);
    expect(await frontier.hasPendingWork('example.com')).toBe(true);

    await frontier.claimNext('example.com');
    await frontier.markDone('https://example.com/a');
    expect(await frontier.hasPendingWork('example.com')).toBe(false);
  });

  it('still counts work that is only held back by a politeness delay', async () => {
    // "Not due this instant" is not the same as "finished" — treating it as
    // finished would end a crawl one page in.
    await frontier.addUrls([{ url: 'https://example.com/a' }]);
    await CrawlFrontier.updateOne(
      { url: 'https://example.com/a' },
      { $set: { nextCrawlAt: new Date(Date.now() + 2000) } }
    );

    expect(await frontier.claimNext('example.com')).toBeNull();
    expect(await frontier.hasPendingWork('example.com')).toBe(true);
  });

  it('counts the frontier of one job by status', async () => {
    const job = await CrawlJob.create({ seedUrl: 'https://example.com', maxPages: 10 });
    await frontier.addUrls(
      [
        { url: 'https://example.com/1' },
        { url: 'https://example.com/2' },
        { url: 'https://example.com/3' }
      ],
      { crawlJobId: job._id }
    );
    await frontier.claimNext('example.com');
    await frontier.markDone('https://example.com/1');

    const counts = await frontier.countsForJob(job._id);
    expect(counts).toMatchObject({ pending: 2, done: 1, total: 3 });
  });

  it('reports global counts and distinct hosts', async () => {
    await frontier.addUrls([
      { url: 'https://a.example.com/1' },
      { url: 'https://b.example.com/1' }
    ]);

    const counts = await frontier.globalCounts();
    expect(counts).toMatchObject({ pending: 2, total: 2, hosts: 2 });
  });
});

describe('sharing knowledge between crawls', () => {
  it('knows a URL crawled by an earlier job is not due again', async () => {
    await frontier.addUrls([{ url: 'https://example.com/a' }]);
    await frontier.markDone('https://example.com/a');

    expect(await frontier.isAlreadyCrawled('https://example.com/a')).toBe(true);
    // The same page, written differently.
    expect(await frontier.isAlreadyCrawled('https://example.com/a?utm_source=x')).toBe(true);
  });

  it('reports an unknown URL as not crawled', async () => {
    expect(await frontier.isAlreadyCrawled('https://example.com/never-seen')).toBe(false);
  });

  it('treats a page due for re-crawl as crawlable again', async () => {
    await frontier.addUrls([{ url: 'https://example.com/a' }]);
    await CrawlFrontier.updateOne(
      { url: 'https://example.com/a' },
      { $set: { status: 'done', nextCrawlAt: new Date(Date.now() - 1000) } }
    );

    expect(await frontier.isAlreadyCrawled('https://example.com/a')).toBe(false);
  });
});
