const IORedis = require('ioredis');
const { config } = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * The Redis connection BullMQ runs on.
 *
 * One lazily-created connection shared by the queue and the worker in a given
 * process. BullMQ needs `maxRetriesPerRequest: null`: its blocking commands
 * sit on a connection for many seconds at a time, and ioredis's default retry
 * limit would abort them as failures.
 *
 * Redis holds scheduling only. The frontier, every crawl job and all crawl
 * results are in MongoDB, so losing Redis loses the queue's position — not
 * the crawl.
 */

/** role -> IORedis. Two, deliberately; see createConnection. */
const connections = new Map();
let lastError = '';

/**
 * Builds a connection for one role.
 *
 * Producer and worker get separate sockets, for two reasons. BullMQ's worker
 * uses blocking commands that occupy a connection for seconds at a time, so
 * sharing one would stall every `add` behind a poll. And the two want
 * opposite failure behaviour:
 *
 *   producer  enableOfflineQueue: false — an API request that enqueues a
 *             crawl must get an answer. Buffering the command until Redis
 *             returns would hang the HTTP request instead.
 *   worker    enableOfflineQueue: true — a worker has nobody waiting on it
 *             and should ride out a brief outage rather than fall over.
 *             The same goes for 'maintenance-worker', which has a socket of
 *             its own because each BullMQ worker blocks on its connection.
 *
 * @param {'producer'|'worker'|'maintenance-worker'} role
 */
function createConnection(role) {
  const client = new IORedis(config.redis.url, {
    // Required by BullMQ: its blocking commands sit on a connection for many
    // seconds, and ioredis's default retry limit would abort them.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    enableOfflineQueue: role !== 'producer',
    // Don't connect at require() time; a module import should not open a
    // socket, and the API must still start when Redis is down.
    lazyConnect: true,
    connectTimeout: 5000,
    retryStrategy(times) {
      // Back off to 5s and keep trying, so a process reconnects by itself
      // when Redis comes back rather than needing a restart.
      const delay = Math.min(times * 500, 5000);
      if (times === 1 || times % 20 === 0) {
        logger.warn('Redis connection retrying', { role, attempt: times, url: redactedUrl() });
      }
      return delay;
    }
  });

  // ioredis emits 'error' on every retry. The retryStrategy above already
  // logs at a sane rate; this records the reason and, importantly, stops an
  // unhandled 'error' event from crashing the process.
  client.on('error', error => {
    lastError = error.message;
  });

  client.on('ready', () => {
    lastError = '';
    logger.info('Redis connected', { role, url: redactedUrl() });
  });

  return client;
}

/**
 * @param {'producer'|'worker'|'maintenance-worker'} [role]
 * @returns {IORedis} the shared connection for that role, created on first use
 */
function getConnection(role = 'producer') {
  if (!connections.has(role)) {
    connections.set(role, createConnection(role));
  }
  return connections.get(role);
}

/** The Redis URL with any password removed, safe to log. */
function redactedUrl() {
  try {
    const parsed = new URL(config.redis.url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return 'redis://<unparseable>';
  }
}

/** How long a health probe waits before calling Redis unreachable. */
const HEALTH_TIMEOUT_MS = 1500;

/**
 * Is Redis reachable?
 *
 * Deliberately uses a throwaway client rather than the shared one. The shared
 * connection is configured the way BullMQ needs it — unlimited retries, an
 * offline command queue — which is right for a worker that should reconnect
 * by itself, and exactly wrong for a health check: `ping()` on it would sit
 * in the offline queue and never resolve while Redis was down. A health
 * endpoint that hangs is worse than one that reports a failure.
 *
 * @returns {Promise<{ok: boolean, url: string, status?: string, error?: string}>}
 */
async function checkHealth() {
  const url = redactedUrl();
  let probe = null;

  try {
    probe = new IORedis(config.redis.url, {
      lazyConnect: true,
      connectTimeout: HEALTH_TIMEOUT_MS,
      commandTimeout: HEALTH_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      // Fail the command immediately instead of buffering it until a
      // connection that may never arrive.
      enableOfflineQueue: false,
      // One attempt. `null` tells ioredis to stop rather than retry.
      retryStrategy: () => null
    });

    // Swallow the error event: the rejection below is how the failure is
    // reported, and an unhandled 'error' would crash the process.
    probe.on('error', () => {});

    await probe.connect();
    const pong = await probe.ping();
    return { ok: pong === 'PONG', url, status: 'ready' };
  } catch (error) {
    return { ok: false, url, status: 'unavailable', error: describeConnectionError(error) };
  } finally {
    if (probe) probe.disconnect();
  }
}

/** True once a connection has been opened in this process. */
function isConnected(role = 'producer') {
  const client = connections.get(role);
  return Boolean(client && client.status === 'ready');
}

/**
 * Opens the connection for a role if it is not open already.
 *
 * `lazyConnect` means the socket is not opened at require() time, which is
 * what lets the API boot with Redis down. The catch is that the producer has
 * `enableOfflineQueue: false`, so the *first* command on an unopened client
 * would be rejected outright rather than triggering a connect. Callers go
 * through here first so that first command finds a live socket.
 *
 * @throws when Redis cannot be reached within the timeout
 */
async function ensureConnected(role = 'producer', timeoutMs = 3000) {
  const client = getConnection(role);
  if (client.status === 'ready') return client;

  try {
    if (client.status === 'wait' || client.status === 'end') {
      await withTimeout(client.connect(), timeoutMs, 'Redis connection timed out');
    } else {
      // 'connecting' or 'reconnecting': wait for it to settle rather than
      // starting a second attempt.
      await withTimeout(
        new Promise((resolve, reject) => {
          client.once('ready', resolve);
          client.once('error', reject);
        }),
        timeoutMs,
        'Redis connection timed out'
      );
    }
    return client;
  } catch (error) {
    // Throw the client away rather than leaving it retrying in the
    // background. ioredis's retryStrategy would otherwise keep a timer alive
    // for the life of the process for a connection nothing is waiting on —
    // which in a test run means the process never exits. The next call
    // builds a fresh client and tries again, so nothing is lost.
    client.disconnect();
    connections.delete(role);
    throw error;
  }
}

/** Rejects if `promise` has not settled in time. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      // Never hold the process open just for this timer.
      if (timer.unref) timer.unref();
    })
  ]);
}

/** Turns a Redis error into something that tells you what to do about it. */
function describeConnectionError(error) {
  const code = error && error.code;
  if (code === 'ECONNREFUSED') {
    return `Cannot reach Redis at ${redactedUrl()}. Start it with: docker compose up -d redis`;
  }
  if (code === 'ENOTFOUND') {
    return `Redis host in REDIS_URL does not resolve (${redactedUrl()}).`;
  }
  if (error && /NOAUTH|WRONGPASS/i.test(error.message || '')) {
    return 'Redis rejected the credentials in REDIS_URL.';
  }
  return (error && error.message) || lastError || 'Unknown Redis error.';
}

/** Closes every connection. Used on shutdown and between test runs. */
async function closeConnection() {
  for (const client of connections.values()) {
    try {
      await client.quit();
    } catch {
      // quit() fails when the socket is already gone; disconnect is
      // unconditional and is what actually releases the handle.
      client.disconnect();
    }
  }
  connections.clear();
}

/** Test seam: forces the next getConnection() to build a fresh client. */
function resetConnection() {
  for (const client of connections.values()) client.disconnect();
  connections.clear();
  lastError = '';
}

module.exports = {
  getConnection,
  ensureConnected,
  checkHealth,
  isConnected,
  closeConnection,
  resetConnection,
  describeConnectionError,
  redactedUrl
};
