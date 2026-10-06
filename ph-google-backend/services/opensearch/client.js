const { Client } = require('@opensearch-project/opensearch');
const { config } = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * The shared OpenSearch client.
 *
 * One client is reused for the whole process so connections are pooled rather
 * than re-established per request. Credentials come from the environment and
 * are never written into the source.
 */

let client = null;
// Cached so a health endpoint polled every few seconds does not ping the
// cluster on every call.
let lastHealth = { ok: false, checkedAt: 0, detail: null };
const HEALTH_CACHE_MS = 5000;

function buildClient() {
  const {
    node,
    username,
    password,
    requestTimeoutMs,
    pingTimeoutMs,
    maxRetries,
    rejectUnauthorized
  } = config.opensearch;

  const options = {
    node,
    requestTimeout: requestTimeoutMs,
    pingTimeout: pingTimeoutMs,
    maxRetries,
    // Retrying a timed-out read is safe and hides a slow first query after
    // the cluster warms up.
    resurrectStrategy: 'ping'
  };

  // Only send credentials when they are configured; the local development
  // container runs with the security plugin off and no auth at all.
  if (username && password) {
    options.auth = { username, password };
  }

  if (node.startsWith('https://')) {
    options.ssl = { rejectUnauthorized };
  }

  return new Client(options);
}

/** @returns {import('@opensearch-project/opensearch').Client} */
function getClient() {
  if (!client) {
    client = buildClient();
    logger.debug('OpenSearch client created', { node: config.opensearch.node });
  }
  return client;
}

/**
 * Checks that the cluster is reachable and queryable.
 *
 * Never throws: callers use it to report status, so a failure is a result,
 * not an exception.
 *
 * @param {boolean} [force] bypass the short-lived cache
 * @returns {Promise<{ok, status?, clusterName?, error?, node, index}>}
 */
async function checkHealth(force = false) {
  const now = Date.now();
  if (!force && now - lastHealth.checkedAt < HEALTH_CACHE_MS && lastHealth.detail) {
    return lastHealth.detail;
  }

  const base = { node: config.opensearch.node, index: config.opensearch.index };

  try {
    const response = await getClient().cluster.health({ timeout: '3s' });
    const body = response.body || {};

    const detail = {
      ...base,
      ok: true,
      status: body.status || 'unknown', // green | yellow | red
      clusterName: body.cluster_name || '',
      nodes: body.number_of_nodes || 0
    };
    lastHealth = { ok: true, checkedAt: now, detail };
    return detail;
  } catch (error) {
    const detail = {
      ...base,
      ok: false,
      status: 'unavailable',
      error: describeConnectionError(error)
    };
    lastHealth = { ok: false, checkedAt: now, detail };
    return detail;
  }
}

/**
 * Turns a client error into a message that tells the developer what to do,
 * rather than leaking a stack trace.
 */
function describeConnectionError(error) {
  const name = error && error.name;
  const code = error && (error.code || (error.meta && error.meta.statusCode));

  if (name === 'ConnectionError' || code === 'ECONNREFUSED') {
    return `Cannot reach OpenSearch at ${config.opensearch.node}. Start it with: docker compose up -d`;
  }
  if (name === 'TimeoutError') {
    return 'OpenSearch timed out. The cluster may still be starting up.';
  }
  if (code === 401 || code === 403) {
    return 'OpenSearch rejected the credentials. Check OPENSEARCH_USERNAME and OPENSEARCH_PASSWORD.';
  }
  return (error && error.message) || 'Unknown OpenSearch error.';
}

/** True when the last check (cached) saw a usable cluster. */
function isAvailable() {
  return lastHealth.ok;
}

/**
 * Waits for the cluster to become reachable — used by scripts that run right
 * after `docker compose up`, when the node is still booting.
 */
async function waitForCluster({ attempts = 30, intervalMs = 2000 } = {}) {
  for (let i = 1; i <= attempts; i += 1) {
    const health = await checkHealth(true);
    if (health.ok) return health;
    if (i < attempts) {
      logger.debug('Waiting for OpenSearch', { attempt: i, of: attempts });
      await new Promise(resolve => {
        setTimeout(resolve, intervalMs);
      });
    }
  }
  return checkHealth(true);
}

/** Closes the connection pool. Used on shutdown and between test runs. */
async function closeClient() {
  if (client) {
    await client.close().catch(() => {
      /* already closed */
    });
    client = null;
    lastHealth = { ok: false, checkedAt: 0, detail: null };
  }
}

/** Test seam: forces the next getClient() to build a fresh client. */
function resetClient() {
  client = null;
  lastHealth = { ok: false, checkedAt: 0, detail: null };
}

module.exports = {
  getClient,
  checkHealth,
  isAvailable,
  waitForCluster,
  closeClient,
  resetClient,
  describeConnectionError
};
