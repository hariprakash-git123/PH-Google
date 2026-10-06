const testDb = require('../helpers/testDb');
const { startHardeningSite } = require('../helpers/hardeningSite');
const {
  fetchPageDetailed,
  isRetryableStatus,
  parseRetryAfter,
  MAX_REDIRECTS
} = require('../../crawler/pageFetcher');
const {
  isAllowed,
  checkAccess,
  clearRobotsCache,
  ROBOTS_CACHE_TTL_MS,
  ROBOTS_UNAVAILABLE_TTL_MS,
  ROBOTS_MAX_BYTES
} = require('../../crawler/robotsChecker');
const { resolveDelayMs, clearHostPolicyCache } = require('../../crawler/hostPolicy');
const { processHost, crawlOne, planRedirect } = require('../../crawler/crawlWorker');
const frontier = require('../../services/frontierService');
const CrawlFrontier = require('../../models/CrawlFrontier');
const CrawlJob = require('../../models/CrawlJob');
const Page = require('../../models/Page');
const { normalizeUrl, canonicalKey } = require('../../utils/urlNormalizer');
const { config } = require('../../config/env');

/**
 * Crawler quality and discovery hardening (Phase 6C).
 *
 * Redirects, error classification, robots.txt availability, page-level
 * robots directives, canonical links and content types — each against a
 * local site that gives the awkward answer on purpose.
 *
 * Local fixture and in-memory MongoDB only. The second "host" in the
 * cross-host cases is `localhost`, the same server under another name, and
 * the point of those cases is that it is never requested.
 */

let site;
let host;

beforeAll(async () => {
  await testDb.connect();
  site = await startHardeningSite();
  host = frontier.hostOf(site.url);
});

afterAll(async () => {
  if (site) await site.close();
  await testDb.disconnect();
});

beforeEach(async () => {
  await testDb.clear();
  clearRobotsCache();
  clearHostPolicyCache();
  site.reset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

const abs = path => normalizeUrl(`${site.url}${path}`);
const hits = path => site.hits[path] || 0;
const row = path => CrawlFrontier.findOne({ canonicalKey: canonicalKey(abs(path)) }).lean();

/** A running job with its seed in the frontier, as startJob creates one. */
async function seedJob({ path = '', maxPages = 10, maxDepth = 3, ...scope } = {}) {
  const job = await CrawlJob.create({
    seedUrl: normalizeUrl(site.url),
    maxPages,
    maxDepth,
    sameDomainOnly: true,
    crawlDelayMs: 0,
    status: 'running',
    lastHeartbeatAt: new Date(),
    ...scope
  });
  await frontier.addUrls([{ url: abs(path), depth: 0, priority: 1000 }], { crawlJobId: job._id });
  return job;
}

const reload = job => CrawlJob.findById(job._id).lean();

async function drain(rounds = 10) {
  let summary;
  for (let i = 0; i < rounds; i += 1) {
    summary = await processHost({ host, maxPages: 10 });
    if (!summary.hasMore || summary.hostBackoff) break;
  }
  return summary;
}

// ---------------------------------------------------------------------------
describe('redirects in the fetcher', () => {
  it('follows a redirect on the same host and reports where it ended', async () => {
    const res = await fetchPageDetailed(`${site.url}/redir/same`);
    expect(res.ok).toBe(true);
    expect(res.finalUrl).toBe(`${site.url}/final`);
    expect(res.redirects).toEqual([`${site.url}/final`]);
    expect(res.html).toContain('Final Page');
  });

  it('follows an absolute redirect to its own host', async () => {
    const res = await fetchPageDetailed(`${site.url}/redir/absolute`);
    expect(res.ok).toBe(true);
    expect(res.finalUrl).toBe(`${site.url}/final`);
  });

  it('follows a chain of 302, 307 and 308', async () => {
    const res = await fetchPageDetailed(`${site.url}/redir/chain1`);
    expect(res.ok).toBe(true);
    expect(res.redirects).toHaveLength(3);
    expect(res.finalUrl).toBe(`${site.url}/final`);
  });

  it('detects a loop between two URLs', async () => {
    const res = await fetchPageDetailed(`${site.url}/redir/loop-a`);
    expect(res).toMatchObject({ ok: false, reason: 'redirect_loop', retryable: false });
    // a -> b -> a: two requests, and the third is never made.
    expect(hits('/redir/loop-a') + hits('/redir/loop-b')).toBe(2);
  });

  it('detects a URL that redirects to itself', async () => {
    const res = await fetchPageDetailed(`${site.url}/redir/self`);
    expect(res).toMatchObject({ ok: false, reason: 'redirect_loop', retryable: false });
    expect(hits('/redir/self')).toBe(1);
  });

  it('gives up on a chain longer than the limit', async () => {
    const res = await fetchPageDetailed(`${site.url}/redir/many/0`);
    expect(res).toMatchObject({ ok: false, reason: 'too_many_redirects', retryable: false });
    expect(site.requestLog).toHaveLength(MAX_REDIRECTS + 1);
  });

  it('does not follow a redirect to another host, and says where it pointed', async () => {
    const res = await fetchPageDetailed(`${site.url}/redir/cross`);
    expect(res).toMatchObject({
      ok: false,
      reason: 'cross_host_redirect',
      redirectTo: `${site.otherHostUrl}/elsewhere`,
      retryable: false
    });
    expect(hits('/elsewhere')).toBe(0);
  });

  it('reports a redirect with no usable target as invalid', async () => {
    for (const path of ['/redir/no-location', '/redir/mailto']) {
      const res = await fetchPageDetailed(`${site.url}${path}`);
      expect(res).toMatchObject({ ok: false, reason: 'invalid_redirect', retryable: false });
    }
  });

  it('asks before each hop and never requests a refused target', async () => {
    const asked = [];
    const res = await fetchPageDetailed(`${site.url}/redir/same`, {
      allowHop: async next => {
        asked.push(next);
        return 'robots';
      }
    });
    expect(res).toMatchObject({ ok: false, reason: 'redirect_disallowed', blockedBy: 'robots' });
    expect(asked).toEqual([`${site.url}/final`]);
    expect(hits('/final')).toBe(0);
  });

  it('applies the content-type rule to where a redirect ends', async () => {
    const res = await fetchPageDetailed(`${site.url}/redir/to-pdf`);
    expect(res).toMatchObject({ ok: false, reason: 'unsupported_content_type' });
    expect(res.finalUrl).toBe(`${site.url}/bin/pdf`);
  });

  it('classifies an error at the end of a redirect', async () => {
    const res = await fetchPageDetailed(`${site.url}/redir/to-404`);
    expect(res).toMatchObject({ ok: false, reason: 'http_error', status: 404, retryable: false });
  });
});

// ---------------------------------------------------------------------------
describe('content types', () => {
  it.each([
    ['PDF', '/bin/pdf'],
    ['image', '/bin/image'],
    ['video', '/bin/video'],
    ['audio', '/bin/audio'],
    ['archive', '/bin/zip'],
    ['JSON', '/bin/json'],
    ['plain text', '/bin/text'],
    ['XML', '/bin/xml']
  ])('refuses a %s response without downloading it', async (_, path) => {
    const res = await fetchPageDetailed(`${site.url}${path}`);
    expect(res).toMatchObject({ ok: false, reason: 'unsupported_content_type', retryable: false });
    expect(res.html).toBeUndefined();

    // The server offered 40 MB. The fetch hung up after the headers, so only
    // what was already in flight left the server.
    await new Promise(resolve => {
      setTimeout(resolve, 50);
    });
    expect(site.sent[path]).toBeLessThan(site.BINARY_BYTES / 4);
  });

  it('refuses a response that names no content type', async () => {
    const res = await fetchPageDetailed(`${site.url}/no-content-type`);
    expect(res).toMatchObject({ ok: false, reason: 'unsupported_content_type' });
  });

  it('accepts XHTML', async () => {
    const res = await fetchPageDetailed(`${site.url}/xhtml`);
    expect(res.ok).toBe(true);
    expect(res.html).toContain('XHTML Page');
  });

  it('reads the content type whatever its case', async () => {
    expect((await fetchPageDetailed(`${site.url}/upper-type`)).ok).toBe(true);
  });

  it('refuses a page that declares itself larger than the limit, unread', async () => {
    const res = await fetchPageDetailed(`${site.url}/huge-declared`);
    expect(res).toMatchObject({ ok: false, reason: 'too_large', retryable: false });
  });

  it('stops reading an HTML page that runs past the limit', async () => {
    const res = await fetchPageDetailed(`${site.url}/huge-html`);
    expect(res).toMatchObject({ ok: false, reason: 'too_large', retryable: false });
    await new Promise(resolve => {
      setTimeout(resolve, 50);
    });
    expect(site.sent['/huge-html']).toBeLessThan(site.BINARY_BYTES);
  });

  it('reports an empty or blank page as such, and not worth retrying', async () => {
    for (const path of ['/empty', '/blank']) {
      const res = await fetchPageDetailed(`${site.url}${path}`);
      expect(res).toMatchObject({ ok: false, reason: 'empty_body', retryable: false });
    }
  });

  it('decodes a page in the charset its header names', async () => {
    const res = await fetchPageDetailed(`${site.url}/latin1`);
    expect(res.ok).toBe(true);
    expect(res.html).toContain('Café crème');
  });

  it('decodes a page in the charset its own markup declares', async () => {
    const res = await fetchPageDetailed(`${site.url}/meta-charset`);
    expect(res.ok).toBe(true);
    expect(res.html).toContain('Straße');
  });

  it('falls back to UTF-8 for a charset it does not know', async () => {
    const res = await fetchPageDetailed(`${site.url}/bad-charset`);
    expect(res.ok).toBe(true);
    expect(res.html).toContain('Bad Charset');
  });
});

// ---------------------------------------------------------------------------
describe('error classification', () => {
  it.each([400, 401, 403, 404, 410, 451])('does not retry HTTP %i', async status => {
    const res = await fetchPageDetailed(`${site.url}/status/${status}`);
    expect(res).toMatchObject({ ok: false, reason: 'http_error', status, retryable: false });
  });

  it.each([408, 429, 500, 502, 503, 504])('retries HTTP %i', async status => {
    const res = await fetchPageDetailed(`${site.url}/status/${status}`);
    expect(res).toMatchObject({ ok: false, reason: 'http_error', status, retryable: true });
  });

  it('retries a connection failure', async () => {
    const res = await fetchPageDetailed('http://127.0.0.1:1/nothing');
    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(true);
  });

  it('reads Retry-After in seconds', async () => {
    expect((await fetchPageDetailed(`${site.url}/status/429`)).retryAfterMs).toBe(7000);
    expect((await fetchPageDetailed(`${site.url}/status/503`)).retryAfterMs).toBe(120000);
  });

  it('reads Retry-After as a date', async () => {
    const res = await fetchPageDetailed(`${site.url}/retry-after-date`);
    expect(res.retryAfterMs).toBeGreaterThan(80 * 1000);
    expect(res.retryAfterMs).toBeLessThanOrEqual(90 * 1000);
  });

  it('caps Retry-After at an hour', async () => {
    const res = await fetchPageDetailed(`${site.url}/retry-after-huge`);
    expect(res.retryAfterMs).toBe(60 * 60 * 1000);
  });

  it('parseRetryAfter ignores what it cannot read', () => {
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('0')).toBe(0);
    // A date already past means "now".
    expect(parseRetryAfter(new Date(Date.now() - 60000).toUTCString())).toBe(0);
  });

  it('isRetryableStatus separates overload from refusal', () => {
    expect([408, 425, 429, 500, 503, 599].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 405, 410, 451].some(isRetryableStatus)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('robots.txt availability', () => {
  it('treats a missing robots.txt as no rules', async () => {
    site.robots = { status: 404, body: 'Not found' };
    await expect(checkAccess(`${site.url}/private/secret`)).resolves.toBe('allowed');
  });

  it('treats a forbidden robots.txt as no rules', async () => {
    site.robots = { status: 403, body: 'Forbidden' };
    await expect(checkAccess(`${site.url}/anything`)).resolves.toBe('allowed');
  });

  it.each([500, 503, 429])('treats robots.txt answering %i as unavailable', async status => {
    site.robots = { status, body: 'Oops' };
    await expect(checkAccess(`${site.url}/final`)).resolves.toBe('unavailable');
    await expect(isAllowed(`${site.url}/final`)).resolves.toBe(false);
  });

  it('treats an unreachable robots.txt as unavailable', async () => {
    await expect(checkAccess('http://127.0.0.1:1/page')).resolves.toBe('unavailable');
  });

  it('still tells disallowed from allowed when robots.txt is readable', async () => {
    await expect(checkAccess(`${site.url}/private/secret`)).resolves.toBe('disallowed');
    await expect(checkAccess(`${site.url}/final`)).resolves.toBe('allowed');
  });

  it('keeps a robots.txt for a day, then reads it again', async () => {
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now');

    clock.mockReturnValue(start);
    await isAllowed(`${site.url}/a`);
    clock.mockReturnValue(start + ROBOTS_CACHE_TTL_MS - 1000);
    await isAllowed(`${site.url}/b`);
    expect(hits('/robots.txt')).toBe(1);

    // The site changes its mind; a day later the crawler notices.
    site.robots = { status: 200, body: 'User-agent: *\nDisallow: /final\n' };
    clock.mockReturnValue(start + ROBOTS_CACHE_TTL_MS + 1000);
    await expect(isAllowed(`${site.url}/final`)).resolves.toBe(false);
    expect(hits('/robots.txt')).toBe(2);
  });

  it('asks again for an unavailable robots.txt after a few minutes', async () => {
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now');
    clock.mockReturnValue(start);

    site.robots = { status: 503, body: 'Oops' };
    await expect(checkAccess(`${site.url}/final`)).resolves.toBe('unavailable');
    await expect(checkAccess(`${site.url}/final`)).resolves.toBe('unavailable');
    expect(hits('/robots.txt')).toBe(1);

    site.robots = { status: 200, body: site.DEFAULT_ROBOTS };
    clock.mockReturnValue(start + ROBOTS_UNAVAILABLE_TTL_MS + 1000);
    await expect(checkAccess(`${site.url}/final`)).resolves.toBe('allowed');
    expect(hits('/robots.txt')).toBe(2);
  });

  it('reads only the first 500 KiB of an oversized robots.txt', async () => {
    const padding = `# ${'x'.repeat(98)}\n`.repeat(Math.ceil(ROBOTS_MAX_BYTES / 100) + 50);
    site.robots = {
      status: 200,
      body: `User-agent: *\nDisallow: /early/\n${padding}Disallow: /late/\n`
    };
    await expect(isAllowed(`${site.url}/early/x`)).resolves.toBe(false);
    await expect(isAllowed(`${site.url}/late/x`)).resolves.toBe(true);
  });

  it('refreshes a cached Crawl-delay with the robots.txt it came from', async () => {
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now');
    clock.mockReturnValue(start);

    site.robots = { status: 200, body: 'User-agent: *\nCrawl-delay: 2\n' };
    await expect(resolveDelayMs(site.url)).resolves.toBe(2000);

    site.robots = { status: 200, body: 'User-agent: *\nCrawl-delay: 5\n' };
    await expect(resolveDelayMs(site.url)).resolves.toBe(2000);

    clock.mockReturnValue(start + ROBOTS_CACHE_TTL_MS + 1000);
    await expect(resolveDelayMs(site.url)).resolves.toBe(5000);
  });
});

// ---------------------------------------------------------------------------
describe('frontier: failures and redirects', () => {
  const url = 'https://example.com/page';

  async function claimed(target = url) {
    await frontier.addUrls([{ url: target, depth: 1 }]);
    return frontier.claimNext(frontier.hostOf(target));
  }

  it('abandons a URL at once when the failure will not improve', async () => {
    await claimed();
    const outcome = await frontier.markFailed(url, {
      reason: 'http_error',
      statusCode: 404,
      retryable: false
    });
    expect(outcome.retrying).toBe(false);
    expect(await CrawlFrontier.findOne({ url }).lean()).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastStatusCode: 404,
      lastError: 'http_error'
    });
  });

  it('still retries by default, with the usual backoff', async () => {
    await claimed();
    const before = Date.now();
    expect((await frontier.markFailed(url, { reason: 'timeout' })).retrying).toBe(true);
    const saved = await CrawlFrontier.findOne({ url }).lean();
    expect(saved.status).toBe('pending');
    const wait = saved.nextCrawlAt.getTime() - before;
    expect(wait).toBeGreaterThanOrEqual(59 * 1000);
    expect(wait).toBeLessThan(70 * 1000);
  });

  it('waits as long as the host asked when that is longer than the backoff', async () => {
    await claimed();
    const before = Date.now();
    await frontier.markFailed(url, { reason: 'http_error', statusCode: 503, retryAfterMs: 600000 });
    const saved = await CrawlFrontier.findOne({ url }).lean();
    expect(saved.nextCrawlAt.getTime() - before).toBeGreaterThanOrEqual(599 * 1000);
  });

  it('never waits longer than an hour, whatever the host asked', async () => {
    await claimed();
    const before = Date.now();
    await frontier.markFailed(url, { reason: 'http_error', retryAfterMs: 10 * 60 * 60 * 1000 });
    const saved = await CrawlFrontier.findOne({ url }).lean();
    expect(saved.nextCrawlAt.getTime() - before).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
  });

  it('still gives up after the configured attempts on a retryable failure', async () => {
    await claimed();
    for (let i = 1; i < config.crawler.maxAttemptsPerUrl; i += 1) {
      await frontier.markFailed(url, { reason: 'timeout' });
      await CrawlFrontier.updateOne({ url }, { $set: { nextCrawlAt: new Date() } });
      await frontier.claimNext('example.com');
    }
    expect((await frontier.markFailed(url, { reason: 'timeout' })).retrying).toBe(false);
    expect((await CrawlFrontier.findOne({ url }).lean()).status).toBe('failed');
  });

  it('moves a row to the same page on another host', async () => {
    const claim = await claimed('http://example.com/page');
    const moved = await frontier.rehome(claim._id, 'https://www.example.com/page');

    expect(moved).toBe(true);
    const rows = await CrawlFrontier.find().lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      url: 'https://www.example.com/page',
      host: 'www.example.com',
      status: 'pending',
      canonicalKey: claim.canonicalKey,
      attempts: 1,
      leasedAt: null
    });
    // Claimable in the new host's slot, not the old one's.
    expect(await frontier.claimNext('example.com')).toBeNull();
    expect(await frontier.claimNext('www.example.com')).toBeTruthy();
  });

  it('refuses to move a row to a different page', async () => {
    const claim = await claimed('http://example.com/page');
    expect(await frontier.rehome(claim._id, 'https://www.example.com/other')).toBe(false);
    expect((await CrawlFrontier.findById(claim._id).lean()).status).toBe('fetching');
  });

  it('records the address a page was fetched under, creating its row', async () => {
    await frontier.markFetchedAs('https://example.com/final', {
      depth: 2,
      referrerUrl: 'https://example.com/old'
    });
    const saved = await CrawlFrontier.findOne({ url: 'https://example.com/final' }).lean();
    expect(saved).toMatchObject({
      status: 'done',
      host: 'example.com',
      depth: 2,
      referrerUrl: 'https://example.com/old'
    });
    expect(saved.nextCrawlAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('marks an existing row done rather than adding a second one', async () => {
    await frontier.addUrls([{ url: 'https://example.com/final', depth: 1 }]);
    await frontier.markFetchedAs('https://www.example.com/final/?utm_source=x');

    const rows = await CrawlFrontier.find().lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'done', depth: 1, url: 'https://example.com/final' });
  });

  it('notes why a fetched page was not indexed', async () => {
    await claimed();
    await frontier.markDone(url, { note: 'noindex' });
    expect(await CrawlFrontier.findOne({ url }).lean()).toMatchObject({
      status: 'done',
      lastError: 'noindex'
    });
  });
});

// ---------------------------------------------------------------------------
describe('planning a cross-host redirect', () => {
  const job = {
    _id: 'job',
    seedUrl: 'https://example.com',
    sameDomainOnly: true,
    allowedDomains: [],
    excludePatterns: [],
    maxDepth: 3
  };
  const claimed = { url: 'http://example.com/a', depth: 1, attempts: 1 };

  it('moves the row when the target is the same page on another host', () => {
    const plan = planRedirect({ claimed, job, redirectTo: 'https://www.example.com/a' });
    expect(plan).toMatchObject({ action: 'rehome', url: 'https://www.example.com/a' });
  });

  it('stops moving a row that has used its attempts — two hosts redirecting to each other', () => {
    const tired = { ...claimed, attempts: config.crawler.maxAttemptsPerUrl };
    const plan = planRedirect({ claimed: tired, job, redirectTo: 'https://www.example.com/a' });
    expect(plan).toMatchObject({ action: 'fail', reason: 'redirect_loop' });
  });

  it('enqueues a different page one level deeper, with the redirect as referrer', () => {
    const open = { ...job, sameDomainOnly: false };
    const plan = planRedirect({ claimed, job: open, redirectTo: 'https://other.test/b' });
    expect(plan.action).toBe('enqueue');
    expect(plan.entries).toEqual([
      { url: 'https://other.test/b', depth: 2, priority: -2, referrerUrl: 'http://example.com/a' }
    ]);
  });

  it('skips a target outside the crawl scope', () => {
    const plan = planRedirect({ claimed, job, redirectTo: 'https://other.test/b' });
    expect(plan).toEqual({ action: 'skip', reason: 'redirect_out_of_scope' });
  });

  it('skips a target the job excludes, even on an allowed host', () => {
    const picky = { ...job, sameDomainOnly: false, excludePatterns: ['/login'] };
    const plan = planRedirect({ claimed, job: picky, redirectTo: 'https://other.test/login' });
    expect(plan).toEqual({ action: 'skip', reason: 'redirect_out_of_scope' });
  });

  it('does not enqueue past the depth limit', () => {
    const shallow = { ...job, sameDomainOnly: false, maxDepth: 1 };
    const plan = planRedirect({ claimed, job: shallow, redirectTo: 'https://other.test/b' });
    expect(plan).toEqual({ action: 'skip', reason: 'redirect' });
  });

  it('discovers nothing for a re-crawl, which has no job', () => {
    const plan = planRedirect({ claimed, job: null, redirectTo: 'https://other.test/b' });
    expect(plan).toEqual({ action: 'skip', reason: 'redirect' });
  });

  it('skips a target that is a file, not a page', () => {
    const open = { ...job, sameDomainOnly: false };
    const plan = planRedirect({ claimed, job: open, redirectTo: 'https://other.test/file.pdf' });
    expect(plan).toEqual({ action: 'skip', reason: 'redirect' });
  });

  it('skips a target that is not a usable URL', () => {
    expect(planRedirect({ claimed, job, redirectTo: 'not a url' }).action).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
describe('redirects in a crawl', () => {
  it('fetches a redirected page once, and not again through a link to it', async () => {
    const job = await seedJob({ path: '/redir/same' });
    await frontier.addUrls([{ url: abs('/final'), depth: 1, priority: -1 }], {
      crawlJobId: job._id
    });

    await drain();

    expect(hits('/final')).toBe(1);
    expect(await Page.countDocuments({ url: abs('/final') })).toBe(1);
    expect(await Page.countDocuments()).toBe(1);
    expect(await row('/redir/same')).toMatchObject({ status: 'done' });
    expect(await row('/final')).toMatchObject({ status: 'done' });
    // One page fetched, one page charged.
    expect((await reload(job)).pagesCrawled).toBe(1);
  });

  it('records where the redirect ended, so a later link finds it done', async () => {
    const job = await seedJob({ path: '/redir/same' });
    await drain();

    expect(await row('/final')).toMatchObject({
      status: 'done',
      referrerUrl: abs('/redir/same'),
      host
    });
    const added = await frontier.addUrls([{ url: abs('/final'), depth: 1 }], {
      crawlJobId: job._id
    });
    expect(added.added).toBe(0);
  });

  it('does not fetch a redirect target the job excludes', async () => {
    const job = await seedJob({ path: '/redir/excluded', excludePatterns: ['/excluded/'] });
    const summary = await drain();

    expect(hits('/excluded/page')).toBe(0);
    expect(await Page.countDocuments()).toBe(0);
    expect(await row('/redir/excluded')).toMatchObject({
      status: 'skipped',
      lastError: 'redirect_out_of_scope'
    });
    expect(summary.reasons).toEqual({ redirect_out_of_scope: 1 });
    expect((await reload(job)).pagesCrawled).toBe(0);
  });

  it('does not fetch a redirect target robots.txt disallows', async () => {
    await seedJob({ path: '/redir/private' });
    await drain();

    expect(hits('/private/secret')).toBe(0);
    expect(await Page.countDocuments()).toBe(0);
    expect(await row('/redir/private')).toMatchObject({
      status: 'skipped',
      lastError: 'redirect_robots_txt'
    });
  });

  it('adds a cross-host target to the frontier instead of fetching it', async () => {
    const job = await seedJob({
      path: '/redir/cross',
      allowedDomains: ['127.0.0.1', 'localhost']
    });
    await drain();

    expect(hits('/elsewhere')).toBe(0);
    expect(await row('/redir/cross')).toMatchObject({ status: 'skipped', lastError: 'redirect' });

    const target = await CrawlFrontier.findOne({ host: 'localhost' }).lean();
    expect(target).toMatchObject({
      url: normalizeUrl(`${site.otherHostUrl}/elsewhere`),
      status: 'pending',
      depth: 1,
      referrerUrl: abs('/redir/cross')
    });
    expect(String(target.crawlJobId)).toBe(String(job._id));
    // Nothing was fetched, so nothing was charged.
    expect((await reload(job)).pagesCrawled).toBe(0);
  });

  it('drops a cross-host target outside the crawl scope', async () => {
    await seedJob({ path: '/redir/cross' });
    await drain();

    expect(hits('/elsewhere')).toBe(0);
    expect(await CrawlFrontier.countDocuments()).toBe(1);
    expect(await row('/redir/cross')).toMatchObject({
      status: 'skipped',
      lastError: 'redirect_out_of_scope'
    });
  });

  it('gives up on a redirect loop after one attempt', async () => {
    const job = await seedJob({ path: '/redir/loop-a' });
    await drain();

    expect(await row('/redir/loop-a')).toMatchObject({
      status: 'failed',
      lastError: 'redirect_loop',
      attempts: 1
    });
    expect((await reload(job)).failedPages).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('failures in a crawl', () => {
  it('requests a missing page once and does not retry it', async () => {
    const job = await seedJob({ path: '/status/404' });

    await drain();
    await CrawlFrontier.updateMany({}, { $set: { nextCrawlAt: new Date() } });
    await drain();

    expect(hits('/status/404')).toBe(1);
    expect(await row('/status/404')).toMatchObject({
      status: 'failed',
      lastStatusCode: 404,
      attempts: 1
    });
    expect((await reload(job)).failedPages).toBe(1);
  });

  it('retries a server error, and indexes the page when it recovers', async () => {
    const job = await seedJob({ path: '/flaky' });

    await drain();
    expect(await row('/flaky')).toMatchObject({ status: 'pending', lastStatusCode: 500 });
    // Not counted as a failed page while it is still being retried.
    expect((await reload(job)).failedPages).toBe(0);

    await CrawlFrontier.updateMany({}, { $set: { nextCrawlAt: new Date() } });
    await drain();

    expect(hits('/flaky')).toBe(2);
    expect(await row('/flaky')).toMatchObject({ status: 'done' });
    expect(await Page.countDocuments({ url: abs('/flaky') })).toBe(1);
    expect((await reload(job)).failedPages).toBe(0);
  });

  it('ends the slice when the host says it is unavailable, and waits as long as asked', async () => {
    const job = await seedJob({ path: '/status/503' });
    await frontier.addUrls([{ url: abs('/final'), depth: 1, priority: -1 }], {
      crawlJobId: job._id
    });

    const before = Date.now();
    const summary = await processHost({ host, maxPages: 10 });

    expect(summary).toMatchObject({ processed: 1, failed: 1, hostBackoff: 'http_error' });
    // Retry-After: 120 — the queue re-runs this host no sooner than that.
    expect(summary.delayMs).toBe(120000);
    expect(summary.hasMore).toBe(true);
    expect(hits('/final')).toBe(0);
    expect(await row('/final')).toMatchObject({ status: 'pending' });

    const failed = await row('/status/503');
    expect(failed).toMatchObject({ status: 'pending', lastStatusCode: 503 });
    expect(failed.nextCrawlAt.getTime() - before).toBeGreaterThanOrEqual(119 * 1000);
  });

  it('ends the slice on a 429 too', async () => {
    await seedJob({ path: '/status/429' });
    const summary = await processHost({ host, maxPages: 10 });
    expect(summary).toMatchObject({ hostBackoff: 'http_error', delayMs: 7000 });
  });

  it('fetches nothing while robots.txt is unavailable, and tries again later', async () => {
    site.robots = { status: 503, body: 'Oops' };
    const job = await seedJob({ path: '/final' });

    const summary = await processHost({ host, maxPages: 10 });

    expect(hits('/final')).toBe(0);
    expect(summary).toMatchObject({ failed: 1, hostBackoff: 'robots_unavailable' });
    expect(summary.reasons).toEqual({ robots_unavailable: 1 });
    expect(await row('/final')).toMatchObject({
      status: 'pending',
      lastError: 'robots_unavailable'
    });
    expect((await reload(job)).pagesCrawled).toBe(0);

    // robots.txt comes back; the page is crawled as usual.
    site.robots = { status: 200, body: site.DEFAULT_ROBOTS };
    clearRobotsCache();
    await CrawlFrontier.updateMany({}, { $set: { nextCrawlAt: new Date() } });
    await drain();
    expect(await row('/final')).toMatchObject({ status: 'done' });
  });

  it('skips a file that is not a page, once, at no cost to the budget', async () => {
    const job = await seedJob({ path: '/bin/pdf' });

    await drain();
    await CrawlFrontier.updateMany({}, { $set: { nextCrawlAt: new Date() } });
    await drain();

    expect(hits('/bin/pdf')).toBe(1);
    expect(await row('/bin/pdf')).toMatchObject({
      status: 'skipped',
      lastError: 'unsupported_content_type'
    });
    expect((await reload(job)).pagesCrawled).toBe(0);
  });

  it('skips an oversized page instead of retrying it', async () => {
    await seedJob({ path: '/huge-html' });
    await drain();
    expect(await row('/huge-html')).toMatchObject({ status: 'skipped', lastError: 'too_large' });
    expect(hits('/huge-html')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('page robots directives in a crawl', () => {
  it('does not index a noindex page, but follows its links', async () => {
    const job = await seedJob({ path: '/noindex' });
    const summary = await processHost({ host, maxPages: 1 });

    expect(await Page.countDocuments({ url: abs('/noindex') })).toBe(0);
    expect(await row('/noindex')).toMatchObject({ status: 'done', lastError: 'noindex' });
    expect(await row('/from-noindex')).toMatchObject({
      status: 'pending',
      referrerUrl: abs('/noindex')
    });
    expect(summary.reasons).toEqual({ noindex: 1 });

    // It was fetched, so it cost a page of budget — but it is not an indexed page.
    expect(await reload(job)).toMatchObject({ pagesCrawled: 1, pagesIndexed: 0 });
  });

  it('indexes a nofollow page, but adds none of its links', async () => {
    await seedJob({ path: '/nofollow-page' });
    await drain();

    expect(await Page.countDocuments({ url: abs('/nofollow-page') })).toBe(1);
    expect(await row('/hidden')).toBeNull();
    expect(hits('/hidden')).toBe(0);
  });

  it('neither indexes nor follows a page that says none', async () => {
    await seedJob({ path: '/none' });
    await drain();

    expect(await Page.countDocuments()).toBe(0);
    expect(await row('/hidden')).toBeNull();
    expect(await row('/none')).toMatchObject({ status: 'done', lastError: 'noindex' });
  });

  it('obeys X-Robots-Tag: noindex', async () => {
    await seedJob({ path: '/header-noindex' });
    await processHost({ host, maxPages: 1 });

    expect(await Page.countDocuments()).toBe(0);
    expect(await row('/from-noindex')).toMatchObject({ status: 'pending' });
  });

  it('obeys a header addressed to this crawler', async () => {
    await seedJob({ path: '/header-our-bot' });
    await drain();
    expect(await Page.countDocuments()).toBe(0);
  });

  it('ignores a header addressed to another crawler', async () => {
    await seedJob({ path: '/header-other-bot' });
    await drain();
    expect(await Page.countDocuments({ url: abs('/header-other-bot') })).toBe(1);
  });

  it('reads two X-Robots-Tag headers separately', async () => {
    // "googlebot: noindex" is not for us; "nofollow" is for everyone.
    await seedJob({ path: '/header-two' });
    await drain();

    expect(await Page.countDocuments({ url: abs('/header-two') })).toBe(1);
    expect(await row('/hidden')).toBeNull();
  });

  it('reports noindex from crawlOne with the links still attached', async () => {
    const result = await crawlOne(`${site.url}/noindex`);
    expect(result).toMatchObject({ outcome: 'noindex', url: `${site.url}/noindex` });
    expect(result.links).toEqual([`${site.url}/from-noindex`]);
  });
});

// ---------------------------------------------------------------------------
describe('canonical links in a crawl', () => {
  const stored = async path => (await Page.findOne({ url: abs(path) }).lean()) || {};

  it('records an absolute canonical and queues the page it names', async () => {
    await seedJob({ path: '/canon/abs' });
    await processHost({ host, maxPages: 1 });

    // Indexed under the address it was fetched from: the canonical is a hint.
    expect(await stored('/canon/abs')).toMatchObject({
      url: abs('/canon/abs'),
      canonicalUrl: abs('/canon/target')
    });
    expect(await row('/canon/target')).toMatchObject({
      status: 'pending',
      depth: 1,
      referrerUrl: abs('/canon/abs')
    });
  });

  it('resolves a relative canonical', async () => {
    await seedJob({ path: '/canon/rel' });
    await processHost({ host, maxPages: 1 });

    expect((await stored('/canon/rel')).canonicalUrl).toBe(abs('/canon/target'));
    expect(await row('/canon/target')).toBeTruthy();
  });

  it('adds no frontier row for a page that is its own canonical', async () => {
    await seedJob({ path: '/canon/self' });
    await drain();

    expect((await stored('/canon/self')).canonicalUrl).toBe(abs('/canon/self'));
    expect(await CrawlFrontier.countDocuments()).toBe(1);
  });

  it('adds one row when the canonical is declared twice', async () => {
    await seedJob({ path: '/canon/dup' });
    await processHost({ host, maxPages: 1 });

    expect((await stored('/canon/dup')).canonicalUrl).toBe(abs('/canon/target'));
    expect(await CrawlFrontier.countDocuments()).toBe(2);
  });

  it('ignores a canonical outside the crawl scope', async () => {
    await seedJob({ path: '/canon/outside' });
    await drain();

    expect(await stored('/canon/outside')).toMatchObject({
      url: abs('/canon/outside'),
      canonicalUrl: ''
    });
    expect(await CrawlFrontier.countDocuments()).toBe(1);
    expect(await CrawlFrontier.countDocuments({ host: 'elsewhere.test' })).toBe(0);
  });

  it('ignores a canonical the job excludes', async () => {
    await seedJob({ path: '/canon/excluded', excludePatterns: ['/excluded/'] });
    await drain();

    expect((await stored('/canon/excluded')).canonicalUrl).toBe('');
    expect(await row('/excluded/page')).toBeNull();
    expect(hits('/excluded/page')).toBe(0);
  });

  it('ignores a malformed canonical and indexes the page as usual', async () => {
    await seedJob({ path: '/canon/malformed' });
    await drain();

    expect(await stored('/canon/malformed')).toMatchObject({
      url: abs('/canon/malformed'),
      canonicalUrl: ''
    });
    expect(await CrawlFrontier.countDocuments()).toBe(1);
  });

  it('ignores canonical tags that disagree', async () => {
    await seedJob({ path: '/canon/multi' });
    await drain();

    expect((await stored('/canon/multi')).canonicalUrl).toBe('');
    expect(await row('/canon/target')).toBeNull();
    expect(await row('/canon/other')).toBeNull();
  });

  it('reads a canonical from the Link header', async () => {
    await seedJob({ path: '/canon/header' });
    await processHost({ host, maxPages: 1 });
    expect((await stored('/canon/header')).canonicalUrl).toBe(abs('/canon/target'));
  });

  it("queues the canonical even from a nofollow page, but not that page's links", async () => {
    await seedJob({ path: '/canon/nofollow' });
    await processHost({ host, maxPages: 1 });

    expect(await row('/canon/target')).toBeTruthy();
    expect(await row('/hidden')).toBeNull();
  });

  it('does not queue the canonical past the depth limit', async () => {
    await seedJob({ path: '/canon/abs', maxDepth: 0 });
    await drain();

    expect((await stored('/canon/abs')).canonicalUrl).toBe(abs('/canon/target'));
    expect(await row('/canon/target')).toBeNull();
  });

  it('crawls the canonical page under the job budget like any link', async () => {
    const job = await seedJob({ path: '/canon/abs', maxPages: 2 });
    await drain();

    expect(await Page.countDocuments()).toBe(2);
    expect(hits('/canon/target')).toBe(1);
    expect((await reload(job)).pagesCrawled).toBe(2);
  });

  it("without a scope, accepts a canonical only on the page's own domain", async () => {
    const own = await crawlOne(`${site.url}/canon/abs`);
    expect(own.canonicalUrl).toBe(abs('/canon/target'));

    const other = await crawlOne(`${site.url}/canon/outside`);
    expect(other.outcome).toBe('indexed');
    expect(other.canonicalUrl).toBeNull();
  });
});
