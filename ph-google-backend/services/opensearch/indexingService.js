const { getClient } = require('./client');
const { ensureIndex, refreshIndex, INDEX } = require('./indexManager');
const { toSearchDocument, buildDocumentId } = require('./documentMapper');
const { config } = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Writing documents into OpenSearch.
 *
 * Single-document indexing is used by the crawler as pages arrive; bulk
 * indexing is used by the reindex job. Document IDs are derived from the
 * canonical URL, so re-crawling a page updates it in place instead of
 * creating a second copy.
 *
 * Nothing here throws on a failed write: the crawler must keep going when
 * one page cannot be indexed, and the caller gets a result it can record.
 */

// Index creation is checked once per process rather than on every write.
let indexReady = false;

async function ensureReady() {
  if (indexReady) return true;
  await ensureIndex();
  indexReady = true;
  return true;
}

/** Test seam — forces the next write to re-check that the index exists. */
function resetIndexReadyFlag() {
  indexReady = false;
}

/**
 * Indexes one crawled page.
 *
 * @param {Object} page   Page document or crawl result (needs at least `url`)
 * @param {Object} [extra] headings, statusCode, outboundLinkCount, …
 * @returns {Promise<{ok: boolean, id?: string, result?: string, error?: string}>}
 */
async function indexPage(page, extra = {}) {
  const mapped = toSearchDocument(page, extra);
  if (!mapped) {
    return { ok: false, error: 'Page has no usable URL' };
  }

  try {
    await ensureReady();

    const response = await getClient().index({
      index: INDEX(),
      id: mapped.id,
      body: mapped.document,
      // The crawler indexes continuously; letting OpenSearch refresh on its
      // own schedule keeps throughput up.
      refresh: false
    });

    return { ok: true, id: mapped.id, result: response?.body?.result || 'indexed' };
  } catch (error) {
    logger.error('OpenSearch index failed', { url: page.url, message: error.message });
    return { ok: false, id: mapped.id, error: error.message };
  }
}

/**
 * Bulk-indexes many pages.
 *
 * Splits the input into batches so one oversized request cannot exhaust
 * memory or hit the cluster's payload limit, and reports per-item failures
 * rather than failing the whole batch.
 *
 * @param {Array<Object>} pages
 * @param {Object} [options]
 * @param {number} [options.batchSize]
 * @param {Function} [options.onProgress] ({indexed, failed, total}) => void
 * @returns {Promise<{indexed, failed, total, errors: Array}>}
 */
async function bulkIndexPages(pages, { batchSize, onProgress } = {}) {
  const size = batchSize || config.opensearch.bulkBatchSize;
  const total = pages.length;
  const summary = { indexed: 0, failed: 0, total, errors: [] };

  if (total === 0) return summary;

  await ensureReady();

  for (let offset = 0; offset < total; offset += size) {
    const batch = pages.slice(offset, offset + size);
    const operations = [];

    for (const page of batch) {
      const mapped = toSearchDocument(page);
      if (!mapped) {
        summary.failed += 1;
        if (summary.errors.length < 50) {
          summary.errors.push({ url: page && page.url, reason: 'unusable_url' });
        }
        continue;
      }
      // Bulk format: an action line followed by the document.
      operations.push({ index: { _index: INDEX(), _id: mapped.id } });
      operations.push(mapped.document);
    }

    if (operations.length === 0) continue;

    try {
      const response = await getClient().bulk({ body: operations, refresh: false });
      const body = response.body || {};

      if (body.errors) {
        // A bulk response is partially successful: walk the items and count
        // only the ones that actually failed.
        for (const item of body.items || []) {
          const op = item.index || item.create || item.update;
          if (op && op.error) {
            summary.failed += 1;
            if (summary.errors.length < 50) {
              summary.errors.push({ id: op._id, reason: op.error.type, detail: op.error.reason });
            }
          } else {
            summary.indexed += 1;
          }
        }
      } else {
        summary.indexed += (body.items || []).length;
      }
    } catch (error) {
      // The whole batch failed — usually the cluster went away mid-run.
      summary.failed += batch.length;
      if (summary.errors.length < 50) {
        summary.errors.push({ reason: 'bulk_request_failed', detail: error.message });
      }
      logger.error('Bulk index request failed', { message: error.message, batchStart: offset });
    }

    if (onProgress) {
      try {
        await onProgress({ ...summary, processed: Math.min(offset + size, total) });
      } catch {
        /* progress reporting must never break indexing */
      }
    }
  }

  // Make the whole batch visible in one refresh rather than per document.
  await refreshIndex();

  logger.info('Bulk indexing complete', {
    indexed: summary.indexed,
    failed: summary.failed,
    total
  });
  return summary;
}

/**
 * Removes a page from the search index.
 * A missing document is a success: the desired end state is "not indexed".
 */
async function deletePage(url) {
  const id = buildDocumentId(url);
  if (!id) return { ok: false, error: 'Page has no usable URL' };

  try {
    await getClient().delete({ index: INDEX(), id, refresh: false });
    return { ok: true, id };
  } catch (error) {
    if (error?.meta?.statusCode === 404) return { ok: true, id, result: 'not_found' };
    logger.error('OpenSearch delete failed', { url, message: error.message });
    return { ok: false, id, error: error.message };
  }
}

/** Removes every document for a domain — used when a site is de-listed. */
async function deleteByDomain(domain) {
  try {
    const response = await getClient().deleteByQuery({
      index: INDEX(),
      body: {
        query: {
          bool: {
            should: [{ term: { domain } }, { term: { rootDomain: domain } }],
            minimum_should_match: 1
          }
        }
      },
      refresh: true
    });
    return { ok: true, deleted: response?.body?.deleted || 0 };
  } catch (error) {
    logger.error('OpenSearch deleteByQuery failed', { domain, message: error.message });
    return { ok: false, error: error.message };
  }
}

/** Fetches one indexed document — used by the debug endpoint. */
async function getDocument(url) {
  const id = buildDocumentId(url);
  if (!id) return null;
  try {
    const response = await getClient().get({ index: INDEX(), id });
    return response?.body?._source || null;
  } catch (error) {
    if (error?.meta?.statusCode === 404) return null;
    throw error;
  }
}

module.exports = {
  indexPage,
  bulkIndexPages,
  deletePage,
  deleteByDomain,
  getDocument,
  ensureReady,
  resetIndexReadyFlag
};
