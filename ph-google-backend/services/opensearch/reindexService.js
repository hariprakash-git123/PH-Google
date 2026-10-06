const Page = require('../../models/Page');
const { bulkIndexPages } = require('./indexingService');
const { recreateIndex, ensureIndex, refreshIndex, getIndexStats } = require('./indexManager');
const { checkHealth } = require('./client');
const { config } = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Rebuilds the OpenSearch index from the pages already stored in MongoDB.
 *
 *   MongoDB pages -> transform -> bulk index -> OpenSearch
 *
 * MongoDB remains the durable record of what has been crawled, so the search
 * index can always be rebuilt from it — that is what makes it safe to treat
 * OpenSearch as a derived store.
 *
 * Runs in the background with progress tracked in memory, following the same
 * pattern as the existing crawler jobs.
 */

/** In-memory state for the currently running (or last finished) reindex. */
let currentJob = null;

function newJob(total, { recreate }) {
  return {
    id: `reindex-${Date.now()}`,
    status: 'running',
    recreate,
    total,
    processed: 0,
    indexed: 0,
    failed: 0,
    startedAt: new Date(),
    completedAt: null,
    error: '',
    errors: []
  };
}

/** Snapshot of the current/last reindex, for the admin dashboard. */
function getStatus() {
  if (!currentJob) return { running: false, lastJob: null };
  return {
    running: currentJob.status === 'running',
    lastJob: {
      ...currentJob,
      // Keep the payload small; the full list is only useful while debugging.
      errors: currentJob.errors.slice(0, 10)
    }
  };
}

function isRunning() {
  return Boolean(currentJob && currentJob.status === 'running');
}

/**
 * Streams pages out of MongoDB in batches and bulk-indexes them.
 *
 * A cursor is used rather than loading every page into memory, so the job
 * works the same on a laptop with 100 pages or 100,000.
 *
 * @param {Object} [options]
 * @param {boolean} [options.recreate] drop and rebuild the index first
 * @param {number} [options.batchSize]
 * @returns {Promise<Object>} the finished job record
 */
async function runReindex({ recreate = false, batchSize } = {}) {
  if (isRunning()) {
    throw new Error('A reindex is already running.');
  }

  const health = await checkHealth(true);
  if (!health.ok) {
    throw new Error(health.error || 'OpenSearch is unavailable.');
  }

  const size = batchSize || config.opensearch.bulkBatchSize;
  const total = await Page.countDocuments();
  currentJob = newJob(total, { recreate });

  logger.info('Reindex started', { total, recreate, batchSize: size });

  try {
    if (recreate) {
      await recreateIndex();
    } else {
      await ensureIndex();
    }

    const cursor = Page.find()
      .select(
        '_id url domain title description content keywords language status lastCrawledAt publishedAt updatedAt isArticle author section siteName imageUrl imageCount videoCount'
      )
      .lean()
      .cursor({ batchSize: size });

    let batch = [];

    for await (const page of cursor) {
      batch.push(page);

      if (batch.length >= size) {
        await indexBatch(batch);
        batch = [];
      }
    }

    if (batch.length > 0) await indexBatch(batch);

    await refreshIndex();

    currentJob.status = 'completed';
    currentJob.completedAt = new Date();
    logger.info('Reindex complete', {
      indexed: currentJob.indexed,
      failed: currentJob.failed,
      total
    });
  } catch (error) {
    currentJob.status = 'failed';
    currentJob.completedAt = new Date();
    currentJob.error = String(error.message).slice(0, 300);
    logger.error('Reindex failed', { message: error.message });
    throw error;
  }

  return currentJob;
}

async function indexBatch(batch) {
  const result = await bulkIndexPages(batch, { batchSize: batch.length });

  currentJob.processed += batch.length;
  currentJob.indexed += result.indexed;
  currentJob.failed += result.failed;

  for (const err of result.errors) {
    if (currentJob.errors.length < 50) currentJob.errors.push(err);
  }
}

/**
 * Starts a reindex without waiting for it, so the HTTP request returns
 * immediately. Progress is read back through getStatus().
 */
function startReindexInBackground(options = {}) {
  if (isRunning()) {
    throw new Error('A reindex is already running.');
  }

  // Deliberately not awaited.
  void runReindex(options).catch(() => {
    // runReindex already records the failure on the job record.
  });

  // Give the job record a moment to exist before the caller reads it.
  return { started: true, startedAt: new Date() };
}

/**
 * Compares MongoDB and OpenSearch document counts, so the dashboard can show
 * whether the index has drifted out of step with the crawl store.
 */
async function getIndexSyncStatus() {
  const [mongoCount, stats] = await Promise.all([
    Page.countDocuments().catch(() => 0),
    getIndexStats()
  ]);

  // Pages crawled before the migration may not be indexed yet; a small
  // difference is normal because near-duplicate URLs collapse to one doc.
  const drift = mongoCount - stats.documentCount;

  return {
    mongoPages: mongoCount,
    indexedDocuments: stats.documentCount,
    drift,
    inSync: stats.exists && Math.abs(drift) <= Math.max(5, Math.ceil(mongoCount * 0.05)),
    index: stats
  };
}

/** Test seam. */
function resetJob() {
  currentJob = null;
}

module.exports = {
  runReindex,
  startReindexInBackground,
  getStatus,
  isRunning,
  getIndexSyncStatus,
  resetJob
};
