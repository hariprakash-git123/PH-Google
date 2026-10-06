const { Worker } = require('bullmq');

const {
  getConnection,
  closeConnection,
  resetConnection,
  checkHealth
} = require('../../services/queue/connection');
const crawlQueue = require('../../services/queue/crawlQueue');
const { config } = require('../../config/env');

/**
 * The queue transport — the one layer the rest of the crawler tests cannot
 * reach.
 *
 * Everything else about crawling (the frontier, the drain loop, politeness,
 * depth limits, budgets, stop handling) runs against an in-memory MongoDB in
 * tests/integration/. What is left is BullMQ itself: that enqueueing a host
 * really reaches a worker, and that the hostname-as-job-id trick really does
 * stop two slices of the same site existing at once. Neither can be faked —
 * `ioredis-mock` does not implement the Lua scripts BullMQ runs — so this
 * suite needs a real Redis.
 *
 * Start one with `docker compose up -d redis`. Without it the suite is
 * reported as SKIPPED, never as passed; `REDIS_REQUIRED=true` turns that
 * skip into a failure, which is what CI sets.
 */

const available = process.env.REDIS_AVAILABLE === 'true';
const describeLive = available ? describe : describe.skip;

// A prefix of its own, so a test run can never disturb a real queue that
// happens to be on the same Redis.
const TEST_PREFIX = `ph-google-test-${process.pid}`;

describeLive('crawl queue (live Redis)', () => {
  let workers = [];

  beforeAll(() => {
    config.redis.queuePrefix = TEST_PREFIX;
    resetConnection();
    crawlQueue.resetQueue();
  });

  afterEach(async () => {
    await Promise.all(workers.map(w => w.close()));
    workers = [];
    // obliterate removes every key this queue owns — safe because the
    // prefix above is unique to this process.
    for (const q of [crawlQueue.getQueue(), crawlQueue.getMaintenanceQueue()]) {
      try {
        await q.obliterate({ force: true });
      } catch {
        // Nothing to remove.
      }
    }
  });

  afterAll(async () => {
    await crawlQueue.closeQueue();
    await closeConnection();
  });

  /** Starts a worker that records the hosts it is handed. */
  function startRecordingWorker(seen, { concurrency = 1, holdMs = 0 } = {}) {
    const worker = new Worker(
      crawlQueue.QUEUE_NAME,
      async job => {
        if (job.name !== crawlQueue.HOST_JOB) return null;
        seen.push(job.data.host);
        if (holdMs) {
          await new Promise(resolve => {
            setTimeout(resolve, holdMs);
          });
        }
        return { host: job.data.host };
      },
      { connection: getConnection('worker'), prefix: TEST_PREFIX, concurrency }
    );
    workers.push(worker);
    return worker;
  }

  /** Waits for a condition, or gives up. */
  async function until(predicate, { timeoutMs = 8000, everyMs = 50 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await new Promise(resolve => {
        setTimeout(resolve, everyMs);
      });
    }
    return false;
  }

  it('reaches Redis', async () => {
    const health = await checkHealth();
    expect(health.ok).toBe(true);
  });

  it('delivers an enqueued host to a worker', async () => {
    const seen = [];
    startRecordingWorker(seen);

    await crawlQueue.enqueueHost('example.com');

    expect(await until(() => seen.includes('example.com'))).toBe(true);
  });

  it('keeps one job per host, however many times it is enqueued', async () => {
    // This is the politeness mechanism. Fifty freshly discovered links all
    // pointing at one site must not become fifty slices of that site.
    for (let i = 0; i < 10; i += 1) {
      await crawlQueue.enqueueHost('crowded.example.com');
    }

    const counts = await crawlQueue.getQueueCounts();
    expect(counts.available).toBe(true);
    expect(counts.waiting + counts.delayed + counts.active).toBe(1);
  });

  it('does not start a second slice while one is running for that host', async () => {
    const seen = [];
    startRecordingWorker(seen, { concurrency: 4, holdMs: 700 });

    await crawlQueue.enqueueHost('slow.example.com');
    // Give the worker time to pick it up, then try to queue it again.
    await until(() => seen.length === 1, { timeoutMs: 3000 });
    await crawlQueue.enqueueHost('slow.example.com');

    // Still exactly one delivery: the id is taken while the job is active.
    await new Promise(resolve => {
      setTimeout(resolve, 400);
    });
    expect(seen.filter(h => h === 'slow.example.com')).toHaveLength(1);
  });

  it('runs different hosts in parallel', async () => {
    const seen = [];
    startRecordingWorker(seen, { concurrency: 4, holdMs: 400 });

    const hosts = ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com'];
    const startedAt = Date.now();
    await crawlQueue.enqueueHosts(hosts);

    expect(await until(() => seen.length === 4, { timeoutMs: 6000 })).toBe(true);
    // Four 400ms jobs in parallel finish well inside the 1600ms they would
    // take one after another.
    expect(Date.now() - startedAt).toBeLessThan(1400);
  });

  it('honours a delay, so a politeness interval is respected between slices', async () => {
    const seen = [];
    startRecordingWorker(seen);

    await crawlQueue.enqueueHost('delayed.example.com', { delayMs: 600 });

    await new Promise(resolve => {
      setTimeout(resolve, 200);
    });
    expect(seen).toHaveLength(0);

    expect(await until(() => seen.length === 1, { timeoutMs: 4000 })).toBe(true);
  });

  it('removes a queued host when a crawl is stopped', async () => {
    await crawlQueue.enqueueHost('cancelled.example.com', { delayMs: 30_000 });
    expect(await crawlQueue.removeHost('cancelled.example.com')).toBe(true);

    const counts = await crawlQueue.getQueueCounts();
    expect(counts.waiting + counts.delayed).toBe(0);
  });

  it('reports removing a host it does not have', async () => {
    expect(await crawlQueue.removeHost('never-queued.example.com')).toBe(false);
  });

  it('gives a host another slice once the previous one has finished', async () => {
    // How worker.js continues a large site: a slice that reports more work
    // re-queues its host from the 'completed' event. That only works if a
    // finished job releases its id — a retained completed job used to block
    // the host from ever being queued again, so every site got one slice.
    const seen = [];
    const worker = startRecordingWorker(seen);
    worker.on('completed', job => {
      if (seen.length < 3) crawlQueue.enqueueHost(job.data.host).catch(() => {});
    });

    await crawlQueue.enqueueHost('big-site.example.com');

    expect(await until(() => seen.length >= 3)).toBe(true);
    expect(seen).toEqual(Array(3).fill('big-site.example.com'));
  });

  it('can queue a host again after its job completed, as the sweep does', async () => {
    const seen = [];
    startRecordingWorker(seen);

    await crawlQueue.enqueueHost('again.example.com');
    expect(await until(() => seen.length === 1)).toBe(true);
    // Let BullMQ finish moving the job to completed.
    await until(async () => (await crawlQueue.getQueue().getJob('host-again.example.com')) == null);

    await crawlQueue.enqueueHost('again.example.com');
    expect(await until(() => seen.length === 2)).toBe(true);
  });

  describe('maintenance schedule', () => {
    /**
     * The worker logged, again and again:
     *
     *   could not renew lock for job repeat:crawl-maintenance-schedule:…
     *   Missing lock for job repeat:crawl-maintenance-schedule:…. moveToFinished
     *   Missing lock for job repeat:crawl-maintenance-schedule:…. moveToDelayed
     *
     * The sweep ran on the crawl queue, in the crawl worker's four slots,
     * with the crawl queue's three attempts. A sweep slowed by a MongoDB
     * outage did not stop the next one starting a minute later beside it;
     * when the machine paused, every sweep in flight lost its lock, and each
     * was then retried (moveToDelayed) and re-run as stalled on top of the
     * next scheduled one.
     */
    const originalInterval = config.crawler.maintenanceIntervalMs;
    const maintenanceWorkers = [];

    afterEach(async () => {
      config.crawler.maintenanceIntervalMs = originalInterval;
      await Promise.all(maintenanceWorkers.splice(0).map(w => w.close(true)));
    });

    /** A maintenance worker exactly as worker.js builds it, plus overrides. */
    function startMaintenanceWorker(processor, overrides) {
      const worker = crawlQueue.createMaintenanceWorker(processor, overrides);
      worker.on('error', () => {
        // Asserted on where it matters; unhandled, it would crash the run.
      });
      maintenanceWorkers.push(worker);
      return worker;
    }

    const sleep = ms =>
      new Promise(resolve => {
        setTimeout(resolve, ms);
      });

    it('registers one schedule, on its own queue, however often the worker starts', async () => {
      await crawlQueue.scheduleMaintenance();
      await crawlQueue.scheduleMaintenance();

      const schedulers = await crawlQueue.getMaintenanceQueue().getJobSchedulers();
      expect(schedulers).toHaveLength(1);
      expect(schedulers[0]).toMatchObject({ name: crawlQueue.MAINTENANCE_JOB });
      expect(await crawlQueue.getQueue().getJobSchedulers()).toHaveLength(0);

      // The sweep it produces is never retried: a retry would only run
      // beside the next scheduled sweep.
      const [next] = await crawlQueue.getMaintenanceQueue().getJobs(['delayed', 'waiting']);
      expect(next).toBeTruthy();
      expect(next.opts.attempts).toBe(1);
    });

    it('moves a schedule an older worker left on the crawl queue', async () => {
      // What the previous version registered.
      await crawlQueue
        .getQueue()
        .upsertJobScheduler(
          'crawl-maintenance-schedule',
          { every: 60_000 },
          { name: crawlQueue.MAINTENANCE_JOB, data: {} }
        );
      expect(await crawlQueue.getQueue().getJobSchedulers()).toHaveLength(1);

      await crawlQueue.scheduleMaintenance();

      expect(await crawlQueue.getQueue().getJobSchedulers()).toHaveLength(0);
      // No future sweep left behind on the crawl queue. (One already due is
      // run once by the crawl worker's fallback handler.)
      const leftover = await crawlQueue.getQueue().getJobs(['delayed']);
      expect(leftover.filter(j => j.name === crawlQueue.MAINTENANCE_JOB)).toHaveLength(0);
    });

    it('never runs a slow sweep beside the next one, nor in a crawl slot', async () => {
      // Sweeps due every 200ms, each taking 700ms — a sweep stuck on a slow
      // database. On the shared four-slot worker these overlapped.
      config.crawler.maintenanceIntervalMs = 200;
      let running = 0;
      let maxRunning = 0;
      let runs = 0;
      startMaintenanceWorker(async () => {
        running += 1;
        runs += 1;
        maxRunning = Math.max(maxRunning, running);
        await sleep(700);
        running -= 1;
      });
      const crawlJobs = [];
      startRecordingWorker(crawlJobs, { concurrency: 4 });
      const onCrawlQueue = [];
      workers[workers.length - 1].on('active', job => onCrawlQueue.push(job.name));

      await crawlQueue.scheduleMaintenance();

      expect(await until(() => runs >= 3, { timeoutMs: 10_000 })).toBe(true);
      expect(maxRunning).toBe(1);
      expect(onCrawlQueue).not.toContain(crawlQueue.MAINTENANCE_JOB);
    });

    it('leaves every crawl slot free while a sweep is stuck', async () => {
      startMaintenanceWorker(async () => {
        await sleep(3000);
      });
      await crawlQueue.scheduleMaintenance();

      // Four hosts, four slots, all crawled while the sweep is still running.
      const seen = [];
      startRecordingWorker(seen, { concurrency: 4, holdMs: 500 });
      for (const h of ['a.example', 'b.example', 'c.example', 'd.example']) {
        await crawlQueue.enqueueHost(h);
      }

      expect(await until(() => seen.length === 4, { timeoutMs: 2500 })).toBe(true);
    });

    it('recovers a sweep whose lock expired mid-run without retrying or overlapping it', async () => {
      // A machine that sleeps mid-sweep wakes to find the lock expired. That
      // is simulated by deleting it — which is all expiry amounts to — and
      // reproduces the logged "Missing lock … moveToFinished".
      const { getConnection: redis } = require('../../services/queue/connection');
      const runs = [];
      const errors = [];
      let running = 0;
      let maxRunning = 0;
      const worker = startMaintenanceWorker(
        async job => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          runs.push(job.id);
          if (runs.length === 1) {
            await redis('producer').del(
              `${TEST_PREFIX}:${crawlQueue.MAINTENANCE_QUEUE_NAME}:${job.id}:lock`
            );
          }
          running -= 1;
          return null;
        },
        // Check for stalled jobs often, so the recovery shows up quickly.
        { stalledInterval: 300 }
      );
      worker.on('error', error => errors.push(error.message));
      const completed = [];
      worker.on('completed', job => completed.push(job.id));

      await crawlQueue.scheduleMaintenance();

      expect(await until(() => errors.some(m => /Missing lock/.test(m)))).toBe(true);
      const [lost] = runs;
      // BullMQ's stalled check recovers it once, and it then completes.
      expect(await until(() => completed.includes(lost))).toBe(true);
      await sleep(1000);

      // Before the fix each loss also went to a retry — the logged
      // "Missing lock … moveToDelayed" — to run beside the next sweep.
      expect(errors.some(m => /moveToDelayed/.test(m))).toBe(false);
      expect(runs.filter(id => id === lost)).toHaveLength(2);
      expect(maxRunning).toBe(1);
      expect(await crawlQueue.getMaintenanceQueue().getJobCounts('failed')).toMatchObject({
        failed: 0
      });
    });
  });

  it('reports queue depth by state', async () => {
    await crawlQueue.enqueueHost('counted.example.com', { delayMs: 30_000 });

    const counts = await crawlQueue.getQueueCounts();
    expect(counts).toMatchObject({
      available: true,
      delayed: 1,
      active: 0
    });
  });

  it('ignores an enqueue with no host', async () => {
    expect(await crawlQueue.enqueueHost('')).toBe(false);
    expect(await crawlQueue.enqueueHost(null)).toBe(false);
  });
});
