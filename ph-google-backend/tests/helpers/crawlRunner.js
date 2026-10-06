const CrawlJob = require('../../models/CrawlJob');
const frontier = require('../../services/frontierService');
const { processHost } = require('../../crawler/crawlWorker');
const { finaliseCompletedJobs } = require('../../services/crawlMaintenanceService');

/**
 * Runs a crawl to completion without Redis or a worker process.
 *
 * The API no longer crawls: it writes a CrawlJob, seeds the frontier and puts
 * the host on a queue. A test that wants to see pages in the database has to
 * take the worker's part, which is what this does — the same loop
 * `worker.js` runs, minus BullMQ:
 *
 *     find hosts with work -> processHost() -> finalise finished jobs
 *
 * That means these tests exercise the real drain logic, the real frontier and
 * the real politeness rules. Only the transport is missing, and the transport
 * is covered separately in tests/queue/ against a live Redis.
 *
 * @param {Object} [options]
 * @param {number} [options.maxSlices]  give up after this many host slices
 * @param {number} [options.slicePages] pages per slice
 * @returns {Promise<{slices: number, processed: number, indexed: number}>}
 */
async function drainCrawlQueue({ maxSlices = 40, slicePages = 10 } = {}) {
  const totals = { slices: 0, processed: 0, indexed: 0 };

  for (let i = 0; i < maxSlices; i += 1) {
    const hosts = await frontier.hostsWithPendingWork({ limit: 20 });
    if (hosts.length === 0) break;

    for (const { host } of hosts) {
      const summary = await processHost({ host, maxPages: slicePages });
      totals.slices += 1;
      totals.processed += summary.processed;
      totals.indexed += summary.indexed;
    }

    await finaliseCompletedJobs();
  }

  // One last pass: the final slice may have emptied the frontier after the
  // loop's own finalise call.
  await finaliseCompletedJobs();
  return totals;
}

/**
 * Drives the crawl until one job reaches a terminal state.
 *
 * @param {string} jobId
 * @returns {Promise<Object>} the job document, terminal or not
 */
async function runCrawlToCompletion(jobId, { maxSlices = 40, slicePages = 10 } = {}) {
  const terminal = ['completed', 'failed', 'stopped'];

  for (let i = 0; i < maxSlices; i += 1) {
    const job = await CrawlJob.findById(jobId).lean();
    if (job && terminal.includes(job.status)) return job;

    const hosts = await frontier.hostsWithPendingWork({ limit: 20 });
    if (hosts.length === 0) {
      // Nothing left to fetch; let maintenance close the job out.
      await finaliseCompletedJobs();
      return CrawlJob.findById(jobId).lean();
    }

    for (const { host } of hosts) {
      await processHost({ host, maxPages: slicePages });
    }
    await finaliseCompletedJobs();
  }

  return CrawlJob.findById(jobId).lean();
}

/**
 * Runs exactly one slice for the host a URL belongs to.
 * For tests that want to observe a crawl mid-flight — a stop request, say.
 */
async function runOneSlice(seedUrl, { slicePages = 1 } = {}) {
  const host = frontier.hostOf(seedUrl);
  return processHost({ host, maxPages: slicePages });
}

module.exports = { drainCrawlQueue, runCrawlToCompletion, runOneSlice };
