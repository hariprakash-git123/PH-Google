const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

/**
 * Jest globalSetup — runs once in the parent process, before any test file is
 * loaded.
 *
 * Its only job is to decide whether the live OpenSearch suite can run and to
 * record that in an environment variable the test workers inherit. Doing it
 * here rather than in a `beforeAll` is what makes the decision usable: at this
 * point no test file has been collected yet, so `tests/opensearch/` can pick
 * `describe.skip` and Jest reports those tests as *skipped*.
 *
 * The previous arrangement checked availability inside `beforeAll` and had
 * each test return early, which reported 40 assertion-free tests as *passed*.
 * A suite that goes green when the thing it tests is switched off is worse
 * than no suite at all.
 *
 * The same applies to Redis, which the crawl queue runs on.
 *
 * Environment:
 *   OPENSEARCH_NODE      cluster to probe (default http://localhost:9200)
 *   OPENSEARCH_REQUIRED  'true' fails the whole run when it is unreachable.
 *                        CI sets this, so a dead service container is a build
 *                        failure rather than a silently shortened test run.
 *   REDIS_URL            queue to probe (default redis://127.0.0.1:6379)
 *   REDIS_REQUIRED       same, for the crawl-queue suite.
 */

const DEFAULT_NODE = 'http://localhost:9200';
const DEFAULT_REDIS = 'redis://127.0.0.1:6379';
const PROBE_TIMEOUT_MS = 5000;

/**
 * Asks the cluster for its health. Resolves false for anything that is not a
 * usable answer — connection refused, timeout, auth failure, 5xx.
 *
 * Written against `node:http` rather than the application's OpenSearch client
 * so that globalSetup loads no application code, and therefore no config or
 * database module, before the tests have set their environment.
 *
 * @param {string} node
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
function probe(node) {
  return new Promise(resolve => {
    let target;
    try {
      target = new URL('/_cluster/health', node);
    } catch {
      resolve({ ok: false, detail: `OPENSEARCH_NODE is not a valid URL: ${node}` });
      return;
    }

    const transport = target.protocol === 'https:' ? https : http;
    const headers = {};

    const username = process.env.OPENSEARCH_USERNAME;
    const password = process.env.OPENSEARCH_PASSWORD;
    if (username) {
      const credentials = Buffer.from(`${username}:${password || ''}`).toString('base64');
      headers.Authorization = `Basic ${credentials}`;
    }

    const request = transport.request(
      target,
      {
        method: 'GET',
        headers,
        timeout: PROBE_TIMEOUT_MS,
        // A local secured cluster uses a self-signed certificate.
        rejectUnauthorized: process.env.OPENSEARCH_TLS_REJECT_UNAUTHORIZED !== 'false'
      },
      response => {
        // Drain the body so the socket can close.
        response.resume();
        const ok = response.statusCode >= 200 && response.statusCode < 300;
        resolve({ ok, detail: ok ? 'reachable' : `HTTP ${response.statusCode}` });
      }
    );

    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, detail: `no response within ${PROBE_TIMEOUT_MS}ms` });
    });
    // Not every socket error carries a message — on Windows a refused
    // connection can arrive with an empty one — and "not reachable ()" tells
    // nobody anything.
    request.on('error', error =>
      resolve({ ok: false, detail: error.message || error.code || 'connection failed' })
    );
    request.end();
  });
}

/**
 * Opens a bare TCP connection and speaks just enough RESP to send PING.
 *
 * Written by hand rather than with ioredis so globalSetup loads no
 * application code — and so a probe cannot leave a reconnecting client
 * behind, which in a test run means the process never exits.
 *
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
function probeRedis(url) {
  return new Promise(resolve => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, detail: `REDIS_URL is not a valid URL: ${url}` });
      return;
    }

    const socket = net.createConnection({
      host: target.hostname,
      port: Number(target.port) || 6379
    });

    const finish = result => {
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.on('timeout', () => finish({ ok: false, detail: 'no response in time' }));
    socket.on('error', error =>
      finish({ ok: false, detail: error.code || error.message || 'connection failed' })
    );
    socket.on('connect', () => socket.write('PING\r\n'));
    socket.on('data', data => {
      const reply = data.toString();
      // +PONG, or -NOAUTH when a password is required — either proves a
      // Redis is listening and answering.
      if (reply.startsWith('+PONG')) finish({ ok: true, detail: 'reachable' });
      else if (reply.startsWith('-NOAUTH'))
        finish({ ok: false, detail: 'authentication required' });
      else finish({ ok: false, detail: `unexpected reply: ${reply.trim().slice(0, 40)}` });
    });
  });
}

module.exports = async function globalSetup() {
  const failures = [];

  // --- OpenSearch, for the search-quality suite ------------------------
  const node = process.env.OPENSEARCH_NODE || DEFAULT_NODE;
  const search = await probe(node);
  process.env.OPENSEARCH_AVAILABLE = search.ok ? 'true' : 'false';

  if (!search.ok) {
    const message =
      `OpenSearch is not reachable at ${node} (${search.detail}).\n` +
      '  The search-quality suite will be SKIPPED — the rest of the tests still run.';
    if (process.env.OPENSEARCH_REQUIRED === 'true') {
      failures.push(
        `OPENSEARCH_REQUIRED=true but the cluster at ${node} is not usable (${search.detail}).`
      );
    } else {
      console.warn(`\n  ${message}\n  Start it with:  docker compose up -d opensearch\n`);
    }
  }

  // --- Redis, for the crawl-queue suite --------------------------------
  const redisUrl = process.env.REDIS_URL || DEFAULT_REDIS;
  const redis = await probeRedis(redisUrl);
  process.env.REDIS_AVAILABLE = redis.ok ? 'true' : 'false';

  if (!redis.ok) {
    const message =
      `Redis is not reachable at ${redisUrl} (${redis.detail}).\n` +
      '  The crawl-queue suite will be SKIPPED — the rest of the tests still run.';
    if (process.env.REDIS_REQUIRED === 'true') {
      failures.push(
        `REDIS_REQUIRED=true but Redis at ${redisUrl} is not usable (${redis.detail}).`
      );
    } else {
      console.warn(`\n  ${message}\n  Start it with:  docker compose up -d redis\n`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.join('\n')}\n` +
        'Those suites cannot run, and skipping them would hide that.\n' +
        'Start the dependencies with:  docker compose up -d'
    );
  }
};
