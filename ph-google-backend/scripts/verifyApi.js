#!/usr/bin/env node
/**
 * Live API smoke test.
 *
 * Exercises every endpoint against a running server and prints a pass/fail
 * table. Read-only apart from the account it registers and the history it
 * creates for that account; it never deletes existing data.
 *
 * Usage:
 *   npm start                 # in one terminal
 *   npm run verify            # in another
 *
 *   BASE_URL=http://localhost:5000 npm run verify
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run verify   # use an existing admin
 */

const BASE = process.env.BASE_URL || 'http://localhost:5000';

let passed = 0;
let failed = 0;
const failures = [];

function record(ok, name, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, body: json };
}

/** Asserts the status code, and optionally runs an extra check on the body. */
function check(name, res, expectedStatus, extra) {
  if (res.status !== expectedStatus) {
    return record(
      false,
      name,
      `expected ${expectedStatus}, got ${res.status}: ${JSON.stringify(res.body).slice(0, 160)}`
    );
  }
  if (extra) {
    const problem = extra(res.body);
    if (problem) return record(false, name, problem);
  }
  return record(true, name);
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

async function main() {
  console.log(`\nVerifying PH-Google API at ${BASE}\n${'='.repeat(46)}`);

  // -----------------------------------------------------------------
  section('Health');
  const health = await call('GET', '/api/health');
  check('GET /api/health returns ok', health, 200, b =>
    b?.data?.status === 'ok' ? null : `status was "${b?.data?.status}"`
  );
  check('health reports a connected database', health, 200, b =>
    b?.data?.database?.state === 'connected' ? null : `db state "${b?.data?.database?.state}"`
  );

  const root = await call('GET', '/');
  check('GET / responds', root, 200);

  // -----------------------------------------------------------------
  section('Authentication');
  const stamp = Date.now();
  const testEmail = `verify-${stamp}@example.test`;
  const testPassword = 'verifyPassword123';

  const register = await call('POST', '/api/auth/register', {
    body: { name: 'Verify User', email: testEmail, password: testPassword }
  });
  check('POST /api/auth/register creates an account', register, 201, b =>
    b?.data?.token ? null : 'no token returned'
  );

  const userToken = register.body?.data?.token;

  check(
    'register rejects a duplicate email',
    await call('POST', '/api/auth/register', {
      body: { name: 'Dup', email: testEmail, password: testPassword }
    }),
    409
  );

  check(
    'register rejects a short password',
    await call('POST', '/api/auth/register', {
      body: { name: 'X', email: `b${stamp}@example.test`, password: '12' }
    }),
    400
  );

  const login = await call('POST', '/api/auth/login', {
    body: { email: testEmail, password: testPassword }
  });
  check('POST /api/auth/login succeeds', login, 200, b => (b?.data?.token ? null : 'no token'));

  check(
    'login rejects a wrong password',
    await call('POST', '/api/auth/login', {
      body: { email: testEmail, password: 'wrong-password' }
    }),
    401
  );

  check(
    'GET /api/auth/me with a token',
    await call('GET', '/api/auth/me', { token: userToken }),
    200
  );
  check('GET /api/auth/me without a token', await call('GET', '/api/auth/me'), 401);
  check(
    'GET /api/auth/me with a bad token',
    await call('GET', '/api/auth/me', { token: 'not.a.token' }),
    401
  );

  // -----------------------------------------------------------------
  section('Search');
  const config = await call('GET', '/api/search/config');
  check('GET /api/search/config', config, 200, b => (b?.data?.maxLimit ? null : 'no maxLimit'));

  // Pick a term that is genuinely in this index.
  const probe = await call('GET', '/api/suggestions?q=a');
  const liveTerm = probe.body?.data?.[0]?.text || 'the';

  const search = await call('GET', `/api/search?q=${encodeURIComponent(liveTerm)}`);
  check(`GET /api/search?q=${liveTerm}`, search, 200, b =>
    Array.isArray(b?.data?.results) ? null : 'results is not an array'
  );
  check('search returns a pagination block', search, 200, b =>
    b?.data?.pagination && typeof b.data.pagination.totalResults === 'number'
      ? null
      : 'pagination missing'
  );

  const total = search.body?.data?.total ?? 0;
  const resultCount = search.body?.data?.results?.length ?? 0;
  console.log(
    `        (indexed matches for "${liveTerm}": ${total}, returned on page 1: ${resultCount})`
  );

  check('search total matches the pagination total', search, 200, b =>
    b.data.total === b.data.pagination.totalResults ? null : 'total and pagination disagree'
  );

  check('search with an empty query', await call('GET', '/api/search?q='), 200);
  check(
    'search paginates',
    await call('GET', `/api/search?q=${encodeURIComponent(liveTerm)}&page=1&limit=3`),
    200,
    b => (b.data.results.length <= 3 ? null : 'limit not applied')
  );
  check(
    'search sorts by newest',
    await call('GET', `/api/search?q=${encodeURIComponent(liveTerm)}&sort=newest`),
    200
  );
  check(
    'search filters by domain',
    await call('GET', `/api/search?q=${encodeURIComponent(liveTerm)}&domain=example.com`),
    200
  );
  check(
    'search filters by date',
    await call('GET', `/api/search?q=${encodeURIComponent(liveTerm)}&date=year`),
    200
  );

  check('search rejects page=0', await call('GET', '/api/search?q=test&page=0'), 400);
  check('search rejects a huge limit', await call('GET', '/api/search?q=test&limit=99999'), 400);
  check('search rejects an unknown sort', await call('GET', '/api/search?q=test&sort=bogus'), 400);
  check(
    'search rejects a malformed domain',
    await call('GET', '/api/search?q=test&domain=!!!'),
    400
  );

  check('GET /api/suggestions', await call('GET', '/api/suggestions?q=se'), 200, b =>
    Array.isArray(b?.data) ? null : 'not an array'
  );

  // -----------------------------------------------------------------
  section('History (per-user)');
  check('GET /api/history without a token', await call('GET', '/api/history'), 401);

  check(
    'POST /api/history',
    await call('POST', '/api/history', {
      token: userToken,
      body: { query: 'verification query' }
    }),
    201
  );

  const history = await call('GET', '/api/history', { token: userToken });
  check('GET /api/history returns the caller entries', history, 200, b =>
    b?.data?.history?.some(h => h.query === 'verification query') ? null : 'entry missing'
  );

  const entryId = history.body?.data?.history?.[0]?.id;
  if (entryId) {
    check(
      'DELETE /api/history/:id',
      await call('DELETE', `/api/history/${entryId}`, { token: userToken }),
      200
    );
  }
  check(
    'DELETE /api/history/:id rejects a bad id',
    await call('DELETE', '/api/history/not-an-id', { token: userToken }),
    400
  );

  // -----------------------------------------------------------------
  section('Admin authorization');
  check('GET /api/admin/metrics anonymous', await call('GET', '/api/admin/metrics'), 401);
  check(
    'GET /api/admin/metrics as a normal user',
    await call('GET', '/api/admin/metrics', { token: userToken }),
    403
  );
  check(
    'GET /api/analytics/overview as a normal user',
    await call('GET', '/api/analytics/overview', { token: userToken }),
    403
  );
  check(
    'POST /api/admin/crawler/start as a normal user',
    await call('POST', '/api/admin/crawler/start', {
      token: userToken,
      body: { seedUrl: 'https://example.com' }
    }),
    403
  );
  check(
    'GET /api/analytics/me as a normal user',
    await call('GET', '/api/analytics/me', { token: userToken }),
    200
  );

  // -----------------------------------------------------------------
  section('Admin endpoints');
  let adminToken = null;

  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const adminLogin = await call('POST', '/api/auth/login', {
      body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }
    });
    if (adminLogin.status === 200) {
      adminToken = adminLogin.body.data.token;
      if (adminLogin.body.data.user.role !== 'admin') {
        record(
          false,
          'ADMIN_EMAIL account has the admin role',
          `role is "${adminLogin.body.data.user.role}"`
        );
        adminToken = null;
      } else {
        record(true, 'signed in as the configured admin');
      }
    } else {
      record(false, 'admin login', `status ${adminLogin.status}`);
    }
  }

  if (!adminToken) {
    console.log('  SKIP  admin endpoint checks — set ADMIN_EMAIL and ADMIN_PASSWORD to run them');
    console.log(
      '        (create one with: npm run create-admin -- --email you@example.com --password ...)'
    );
  } else {
    const metrics = await call('GET', '/api/admin/metrics', { token: adminToken });
    check('GET /api/admin/metrics', metrics, 200, b => {
      const d = b?.data;
      if (!d) return 'no data';
      for (const key of [
        'totalPages',
        'totalWebsites',
        'totalTerms',
        'totalSearches',
        'totalUsers'
      ]) {
        if (typeof d[key] !== 'number') return `${key} is not a number`;
      }
      return null;
    });
    const m = metrics.body?.data || {};
    console.log(
      `        (pages ${m.totalPages}, websites ${m.totalWebsites}, terms ${m.totalTerms}, searches ${m.totalSearches}, users ${m.totalUsers})`
    );

    check('metrics contain no hardcoded mock values', metrics, 200, b => {
      const s = JSON.stringify(b);
      const mock = ['12.4M', '85K', '2.1M', '124ms', '"18"'].find(v => s.includes(v));
      return mock ? `found mock value ${mock}` : null;
    });

    const dashboard = await call('GET', '/api/admin/dashboard', { token: adminToken });
    check('GET /api/admin/dashboard', dashboard, 200, b => {
      if (!Array.isArray(b?.data?.overview)) return 'overview missing';
      if (!Array.isArray(b?.data?.crawlerActivity24h)) return 'crawlerActivity24h missing';
      if (b.data.crawlerActivity24h.length !== 24) return 'activity series is not 24 points';
      return null;
    });

    check(
      'GET /api/admin/pages',
      await call('GET', '/api/admin/pages?limit=5', { token: adminToken }),
      200,
      b => (Array.isArray(b?.data?.pages) ? null : 'pages missing')
    );
    check(
      'GET /api/admin/websites',
      await call('GET', '/api/admin/websites', { token: adminToken }),
      200
    );
    check(
      'GET /api/admin/users',
      await call('GET', '/api/admin/users', { token: adminToken }),
      200,
      b => (JSON.stringify(b).includes('$2b$') ? 'password hash leaked' : null)
    );

    section('Crawler controls');
    check(
      'GET /api/admin/crawler/status',
      await call('GET', '/api/admin/crawler/status', { token: adminToken }),
      200,
      b => (typeof b?.data?.activeJobs === 'number' ? null : 'activeJobs missing')
    );
    check(
      'GET /api/admin/crawler/jobs',
      await call('GET', '/api/admin/crawler/jobs', { token: adminToken }),
      200
    );

    check(
      'crawler/start rejects a missing seedUrl',
      await call('POST', '/api/admin/crawler/start', { token: adminToken, body: {} }),
      400
    );
    check(
      'crawler/start rejects a bad seedUrl',
      await call('POST', '/api/admin/crawler/start', {
        token: adminToken,
        body: { seedUrl: 'not-a-url' }
      }),
      400
    );
    check(
      'crawler/start rejects an excessive maxPages',
      await call('POST', '/api/admin/crawler/start', {
        token: adminToken,
        body: { seedUrl: 'https://example.com', maxPages: 999999 }
      }),
      400
    );
    check(
      'crawler/start rejects a localhost target',
      await call('POST', '/api/admin/crawler/start', {
        token: adminToken,
        body: { seedUrl: 'http://localhost:5000' }
      }),
      400
    );

    if (process.env.RUN_LIVE_CRAWL === 'true') {
      const seed = process.env.CRAWL_SEED_URL || 'https://example.com';
      console.log(`        starting a real 2-page crawl of ${seed} ...`);
      const start = await call('POST', '/api/admin/crawler/start', {
        token: adminToken,
        body: { seedUrl: seed, maxPages: 2 }
      });
      check('POST /api/admin/crawler/start', start, 202, b => (b?.data?.jobId ? null : 'no jobId'));

      const jobId = start.body?.data?.jobId;
      if (jobId) {
        let job = null;
        for (let i = 0; i < 60; i += 1) {
          await new Promise(r => {
            setTimeout(r, 1000);
          });
          const res = await call('GET', `/api/admin/crawler/jobs/${jobId}`, { token: adminToken });
          job = res.body?.data;
          if (job && ['completed', 'failed', 'stopped'].includes(job.status)) break;
        }
        check('crawl job reaches a terminal state', { status: 200, body: { job } }, 200, () =>
          job && ['completed', 'stopped'].includes(job.status)
            ? null
            : `status "${job?.status}" error "${job?.error}"`
        );
        console.log(
          `        (crawled ${job?.pagesCrawled}, indexed ${job?.pagesIndexed}, failed ${job?.failedPages})`
        );
      }
    } else {
      console.log('  SKIP  live crawl — set RUN_LIVE_CRAWL=true to crawl a real site');
    }

    check(
      'POST /api/admin/crawler/stop',
      await call('POST', '/api/admin/crawler/stop', { token: adminToken, body: {} }),
      200
    );

    section('Analytics');
    const overview = await call('GET', '/api/analytics/overview', { token: adminToken });
    check('GET /api/analytics/overview', overview, 200, b => {
      const d = b?.data;
      if (!d) return 'no data';
      if (typeof d.totalSearches !== 'number') return 'totalSearches missing';
      if (!Array.isArray(d.topQueries)) return 'topQueries missing';
      return null;
    });
    const o = overview.body?.data || {};
    console.log(
      `        (searches today ${o.searchesToday}, total ${o.totalSearches}, avg ${o.avgResponseTimeMs}ms, zero-result ${o.zeroResultSearches})`
    );

    check(
      'GET /api/analytics/top-queries',
      await call('GET', '/api/analytics/top-queries', { token: adminToken }),
      200
    );
    check(
      'GET /api/analytics/zero-result-queries',
      await call('GET', '/api/analytics/zero-result-queries', { token: adminToken }),
      200
    );
    check(
      'GET /api/analytics/searches',
      await call('GET', '/api/analytics/searches?limit=5', { token: adminToken }),
      200
    );
  }

  // -----------------------------------------------------------------
  section('Error handling');
  check(
    'unknown route returns 404 in the standard envelope',
    await call('GET', '/api/no-such-route'),
    404,
    b => (b?.success === false && b?.message ? null : 'unexpected error shape')
  );

  const res404 = await call('GET', '/api/no-such-route');
  check('error responses never include a stack trace', res404, 404, b =>
    b.stack ? 'stack trace exposed' : null
  );

  // -----------------------------------------------------------------
  console.log(`\n${'='.repeat(46)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.detail || ''}`);
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(`\nVerification could not run: ${error.message}`);
  console.error(`Is the server running at ${BASE}?  Start it with: npm start\n`);
  process.exit(1);
});
