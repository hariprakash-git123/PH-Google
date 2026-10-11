/**
 * Jest global setup.
 *
 * Forces a test environment before any application module is required, so
 * config/env.js never picks up real credentials from .env and rate limiting
 * stays disabled for the whole run.
 */

process.env.NODE_ENV = 'test';

// A throwaway signing key: the tests must never depend on the real secret.
process.env.JWT_SECRET = 'test-jwt-secret-value-not-used-anywhere-else-0123456789';
process.env.JWT_EXPIRES_IN = '1h';
process.env.LOG_LEVEL = 'error';
process.env.DISABLE_RATE_LIMIT = 'true';

// Keep crawler tests fast: no politeness delay against the local fixture server.
process.env.CRAWLER_DELAY_MS = '0';
process.env.CRAWLER_TIMEOUT_MS = '4000';

// The provider stand-ins return placeholder titles ("Google result 1"), which
// no query's words appear in. The check that a provider's answer covers the
// query is therefore off by default here and switched on by the tests that
// are about it (tests/unit/resultValidation.test.js).
process.env.EXTERNAL_RESULT_VALIDATION = 'false';

// A developer's .env may choose Parallel exclusively and hold a real key; no
// test may ever send a request with it. So the override is cleared (the
// provider is then SEARCH_PROVIDER, as before), fallback is the default "on",
// and Parallel is off with no key. The tests that are about Parallel switch
// it on themselves, against a local stand-in.
process.env.EXTERNAL_SEARCH_PROVIDER = '';
process.env.SEARCH_PROVIDER_FALLBACK = 'true';
process.env.PARALLEL_ENABLED = 'false';
process.env.PARALLEL_API_KEY = '';

// Never let a test read the developer's real database.
delete process.env.MONGO_URI;

// The default suite runs entirely on an in-memory MongoDB, so it must not
// require a live OpenSearch cluster. These tests therefore exercise the
// legacy engine and every non-search feature.
//
// The OpenSearch tests (tests/opensearch/) set SEARCH_ENGINE=opensearch
// themselves and skip cleanly when no cluster is reachable, so `npm test`
// works with or without `docker compose up`.
process.env.SEARCH_ENGINE = 'mongo';
process.env.OPENSEARCH_NODE = process.env.OPENSEARCH_NODE || 'http://localhost:9200';
process.env.OPENSEARCH_INDEX = process.env.OPENSEARCH_INDEX || 'ph-google-pages-test';

// Redis carries the crawl queue. The default suite has none, and must not
// need one: the crawl worker is exercised by calling its processor directly
// (tests/integration/crawlWorker.test.js), so nothing here talks to a queue.
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

jest.setTimeout(60000);

// Release any Redis socket a test opened. Without this a connection left
// retrying in the background keeps a timer alive and Jest never exits —
// which looks exactly like a hung test.
afterAll(async () => {
  const { closeConnection } = require('../../services/queue/connection');
  const { closeQueue } = require('../../services/queue/crawlQueue');
  await closeQueue().catch(() => {});
  await closeConnection().catch(() => {});
});
