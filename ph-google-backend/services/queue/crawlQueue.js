const { Queue, Worker } = require('bullmq');
const { getConnection, ensureConnected, checkHealth } = require('./connection');
const { config } = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * The crawl queue.
 *
 * Two kinds of job:
 *
 *   HOST_JOB         crawl one host for one slice. The BullMQ job id *is*
 *                    the hostname, which is what gives "one request at a
 *                    time per host": BullMQ will not hold two jobs with the
 *                    same id, so a second attempt to enqueue a host that is
 *                    already queued or running is silently a no-op.
 *
 *   MAINTENANCE_JOB  a repeating sweep — reclaim abandoned leases, re-queue
 *                    pages due for a re-crawl, close out finished jobs, and
 *                    enqueue hosts that have work waiting.
 *
 * The queue is created lazily so that importing this module never opens a
 * socket. The API must start, and its health endpoint must answer, when
 * Redis is down.
 */

const QUEUE_NAME = 'crawl-hosts';
const HOST_JOB = 'crawl-host';
const MAINTENANCE_JOB = 'crawl-maintenance';
const MAINTENANCE_REPEAT_KEY = 'crawl-maintenance-schedule';

// The sweep has a queue of its own. On the crawl queue it was just another
// job for the host worker's four slots: a sweep slowed by a MongoDB outage
// did not stop the scheduler starting the next one a minute later in a
// second slot, sweeps piled up beside the crawl, and each one inherited the
// crawl queue's three attempts — so a sweep that lost its lock (a paused
// machine lets every lock expire) was retried on top of the next one.
const MAINTENANCE_QUEUE_NAME = 'crawl-maintenance';

// Longer than any sweep, including one stuck waiting out MongoDB server
// selection on every step. The 30s default is sized for renewals every 15s;
// a sweep is short and rare enough that a stale lock costs nothing.
const MAINTENANCE_LOCK_MS = 5 * 60 * 1000;

let queue = null;
let maintenanceQueue = null;

/** @returns {Queue} */
function getQueue() {
  if (queue) return queue;

  queue = new Queue(QUEUE_NAME, {
    connection: getConnection(),
    prefix: config.redis.queuePrefix,
    defaultJobOptions: {
      // A host slice is retried twice, then left alone: the frontier rows
      // keep their own per-URL attempt counts, so a lost slice costs a
      // delay rather than the work.
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      // Bounded history, so the admin view has something to show without
      // Redis growing without limit.
      removeOnComplete: { count: config.redis.keepCompletedJobs },
      removeOnFail: { count: config.redis.keepFailedJobs }
    }
  });

  return queue;
}

/** @returns {Queue} */
function getMaintenanceQueue() {
  if (maintenanceQueue) return maintenanceQueue;

  maintenanceQueue = new Queue(MAINTENANCE_QUEUE_NAME, {
    connection: getConnection(),
    prefix: config.redis.queuePrefix
  });

  return maintenanceQueue;
}

/**
 * The queue job id for a host.
 *
 * BullMQ refuses custom ids containing ":" (it uses the colon to build its
 * own Redis keys), so "host:example.com" made every enqueue throw and no
 * crawl ever reached the worker. A colon inside the host itself — an IPv6
 * literal — is replaced for the same reason.
 */
function hostJobId(host) {
  return `host-${String(host).replace(/:/g, '_')}`;
}

/**
 * Enqueues a host for crawling.
 *
 * Passing the hostname as the job id is the whole politeness mechanism. If
 * the host is already waiting or being crawled, BullMQ keeps the existing
 * job and this call does nothing — which is exactly what should happen when
 * fifty freshly discovered links all point at the same site.
 *
 * @param {string} host
 * @param {Object} [options]
 * @param {number} [options.delayMs] wait before the slice may start
 * @returns {Promise<boolean>} true when a new job was created
 */
async function enqueueHost(host, { delayMs = 0 } = {}) {
  if (!host) return false;

  try {
    // The producer connection refuses commands while the socket is down
    // rather than buffering them, so it has to be open before the first add.
    await ensureConnected('producer');

    const job = await getQueue().add(
      HOST_JOB,
      { host },
      {
        jobId: hostJobId(host),
        delay: Math.max(0, Number(delayMs) || 0),
        // A finished host job must not linger: BullMQ refuses a new job
        // whose id is still held by a *completed* one, so a retained job
        // stopped its host from ever getting a second slice. The id exists
        // to keep two slices of one host from running at once; once a slice
        // is over it has done its job. Outcomes are in the worker log.
        removeOnComplete: true,
        removeOnFail: true
      }
    );
    // BullMQ returns the existing job when the id is taken, so an unchanged
    // timestamp is how we tell "created" from "already there".
    return Boolean(job);
  } catch (error) {
    logger.error('Could not enqueue host', { host, message: error.message });
    throw error;
  }
}

/**
 * Enqueues several hosts, tolerating individual failures.
 * @returns {Promise<number>} how many were enqueued
 */
async function enqueueHosts(hosts, { delayMs = 0 } = {}) {
  let enqueued = 0;
  for (const host of hosts) {
    try {
      if (await enqueueHost(host, { delayMs })) enqueued += 1;
    } catch {
      // Already logged; one bad host must not stop the rest.
    }
  }
  return enqueued;
}

/**
 * Installs the repeating maintenance job.
 *
 * Called by the worker at startup. Upserting is idempotent — the scheduler
 * is keyed by id — so a restart replaces the schedule rather than adding a
 * second one.
 *
 * BullMQ 6 no longer accepts `repeat` on `Queue.add`; passing it there
 * silently registered nothing, so the sweep never ran.
 */
async function scheduleMaintenance() {
  await ensureConnected('producer');
  const every = config.crawler.maintenanceIntervalMs;

  await getMaintenanceQueue().upsertJobScheduler(
    MAINTENANCE_REPEAT_KEY,
    { every },
    {
      name: MAINTENANCE_JOB,
      data: {},
      opts: {
        // Never retried: the next scheduled sweep does the same work, and a
        // retry would only run beside it.
        attempts: 1,
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 20 }
      }
    }
  );

  // Where the schedule used to live. Removing it also deletes its next
  // pending sweep, so an upgraded worker does not run one on the old queue.
  await getQueue().removeJobScheduler(MAINTENANCE_REPEAT_KEY);

  logger.info('Crawl maintenance scheduled', { everyMs: every });
}

/**
 * The worker that runs the sweep: one at a time, never beside another.
 *
 * @param {(job: import('bullmq').Job) => Promise<unknown>} processor
 * @param {Object} [overrides] extra Worker options; tests shorten timers
 * @returns {Worker}
 */
function createMaintenanceWorker(processor, overrides = {}) {
  return new Worker(MAINTENANCE_QUEUE_NAME, processor, {
    connection: getConnection('maintenance-worker'),
    prefix: config.redis.queuePrefix,
    concurrency: 1,
    // A sweep whose lock expires anyway — the process was frozen for longer
    // than this — is re-run once by BullMQ's stalled-job check, which always
    // recovers repeatable jobs. Harmless: a sweep is idempotent, and with one
    // slot the re-run cannot overlap another sweep.
    lockDuration: MAINTENANCE_LOCK_MS,
    ...overrides
  });
}

const EMPTY_COUNTS = { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };

/**
 * Queue depth by state, for the crawler status endpoint.
 *
 * Reports zeros and `available: false` rather than throwing when Redis is
 * unreachable: a status page that 500s because one of its numbers is missing
 * tells an administrator less than one that says the queue is down.
 *
 * The health probe comes first so that a missing Redis does not create a
 * BullMQ queue whose connection would then retry in the background for the
 * life of the process.
 */
async function getQueueCounts() {
  const health = await checkHealth();
  if (!health.ok) {
    return { available: false, ...EMPTY_COUNTS, error: health.error };
  }

  try {
    const counts = await getQueue().getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
      'completed'
    );
    return { available: true, ...counts };
  } catch (error) {
    return { available: false, ...EMPTY_COUNTS, error: error.message };
  }
}

/**
 * Removes a host's queued slice, if it has not started.
 * Used when a crawl is stopped, so the queue does not keep feeding it.
 */
async function removeHost(host) {
  try {
    await ensureConnected('producer');
    const job = await getQueue().getJob(hostJobId(host));
    if (!job) return false;
    const state = await job.getState();
    // An active slice is not cancelled here; it notices `stopRequested`
    // between pages and unwinds on its own.
    if (state === 'active') return false;
    await job.remove();
    return true;
  } catch (error) {
    logger.warn('Could not remove host job', { host, message: error.message });
    return false;
  }
}

/** Closes the queue. Used on shutdown and between test runs. */
async function closeQueue() {
  if (queue) await queue.close();
  if (maintenanceQueue) await maintenanceQueue.close();
  queue = null;
  maintenanceQueue = null;
}

/** Test seam. */
function resetQueue() {
  queue = null;
  maintenanceQueue = null;
}

module.exports = {
  getQueue,
  getMaintenanceQueue,
  enqueueHost,
  enqueueHosts,
  scheduleMaintenance,
  createMaintenanceWorker,
  getQueueCounts,
  removeHost,
  closeQueue,
  resetQueue,
  QUEUE_NAME,
  HOST_JOB,
  MAINTENANCE_JOB,
  MAINTENANCE_QUEUE_NAME,
  MAINTENANCE_LOCK_MS
};
