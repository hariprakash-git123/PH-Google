const { getClient } = require('./client');
const { buildIndexDefinition, MAPPINGS } = require('./indexSettings');
const { config } = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * Index lifecycle: create, inspect, refresh, recreate.
 *
 * `ensureIndex` is idempotent and is called on startup and before any
 * indexing operation, so a fresh cluster becomes usable without a manual
 * setup step.
 */

const INDEX = () => config.opensearch.index;

/** True when the index exists. */
async function indexExists(name = INDEX()) {
  const response = await getClient().indices.exists({ index: name });
  // The client reports existence through the status code.
  return response.statusCode === 200 || response.body === true;
}

/**
 * Fields added to the mapping after indexes were already created with it.
 * Adding a field is safe on a live index — no reindex, no document touched:
 * existing documents simply lack it, as documents without one always will.
 * Nothing else about an existing mapping is ever changed here.
 */
const ADDITIVE_FIELDS = ['modifiedAt'];

/**
 * Adds any ADDITIVE_FIELDS an existing index's mapping lacks.
 * @returns {Promise<string[]>} the fields added
 */
async function addMissingFields(name = INDEX()) {
  const response = await getClient().indices.getMapping({ index: name });
  const body = response?.body || {};
  const mapping = (body[name] || Object.values(body)[0] || {}).mappings || {};
  const present = mapping.properties || {};
  const missing = ADDITIVE_FIELDS.filter(field => !present[field] && MAPPINGS.properties[field]);
  if (missing.length === 0) return [];
  await getClient().indices.putMapping({
    index: name,
    body: { properties: Object.fromEntries(missing.map(f => [f, MAPPINGS.properties[f]])) }
  });
  logger.info('OpenSearch mapping extended', { index: name, fields: missing });
  return missing;
}

/**
 * Creates the index with its mappings if it is not already there; on one
 * that is, adds the fields introduced since (addMissingFields).
 * @returns {Promise<{created: boolean, index: string}>}
 */
async function ensureIndex(name = INDEX()) {
  if (await indexExists(name)) {
    try {
      await addMissingFields(name);
    } catch (error) {
      // Documents without the new fields still index; only those carrying
      // one would be refused, and that is reported where it happens.
      logger.warn('OpenSearch mapping could not be extended', {
        index: name,
        message: error.message
      });
    }
    return { created: false, index: name };
  }

  try {
    await getClient().indices.create({
      index: name,
      body: buildIndexDefinition()
    });
    logger.info('OpenSearch index created', { index: name });
    return { created: true, index: name };
  } catch (error) {
    // Another process (or a parallel test) may have created it first.
    const type = error?.meta?.body?.error?.type;
    if (type === 'resource_already_exists_exception') {
      return { created: false, index: name };
    }
    logger.error('Failed to create OpenSearch index', { index: name, message: error.message });
    throw error;
  }
}

/**
 * Drops and recreates the index. Destructive — only reachable from the
 * explicit admin reindex path, never from normal crawling.
 */
async function recreateIndex(name = INDEX()) {
  if (await indexExists(name)) {
    await getClient().indices.delete({ index: name });
    logger.warn('OpenSearch index deleted for rebuild', { index: name });
  }
  await ensureIndex(name);
  return { index: name, recreated: true };
}

/** Makes recent writes visible to search. Used by tests and after a reindex. */
async function refreshIndex(name = INDEX()) {
  try {
    await getClient().indices.refresh({ index: name });
  } catch (error) {
    // A refresh on a missing index is not worth failing a request over.
    logger.debug('Index refresh skipped', { index: name, message: error.message });
  }
}

/**
 * Document count, size and health for the admin dashboard.
 * Returns a shape that is safe to render even when the cluster is down.
 */
async function getIndexStats(name = INDEX()) {
  const base = {
    index: name,
    exists: false,
    documentCount: 0,
    sizeInBytes: 0,
    health: 'unavailable'
  };

  try {
    if (!(await indexExists(name))) return base;

    const [countRes, statsRes, healthRes] = await Promise.all([
      getClient().count({ index: name }),
      getClient().indices.stats({ index: name, metric: 'store' }),
      getClient().cluster.health({ index: name, timeout: '3s' })
    ]);

    const store = statsRes?.body?._all?.primaries?.store || {};

    return {
      index: name,
      exists: true,
      documentCount: countRes?.body?.count || 0,
      sizeInBytes: store.size_in_bytes || 0,
      health: healthRes?.body?.status || 'unknown'
    };
  } catch (error) {
    logger.debug('Could not read index stats', { index: name, message: error.message });
    return { ...base, error: error.message };
  }
}

/**
 * Applies analyzer/synonym changes that do not need a reindex.
 *
 * Search-time synonyms live in the index settings, so updating them means
 * briefly closing the index. Mapping changes still require a full reindex.
 */
async function updateSearchTimeSettings(name = INDEX()) {
  const { buildSettings } = require('./indexSettings');
  const settings = buildSettings();

  await getClient().indices.close({ index: name });
  try {
    await getClient().indices.putSettings({
      index: name,
      body: { analysis: settings.analysis }
    });
    logger.info('OpenSearch analysis settings updated', { index: name });
  } finally {
    // The index must be reopened even if the update failed.
    await getClient().indices.open({ index: name });
  }
}

/**
 * Runs text through an analyzer — used by the debug endpoint to show how a
 * query is tokenised.
 */
async function analyzeText(text, analyzer = 'ph_search', name = INDEX()) {
  const response = await getClient().indices.analyze({
    index: name,
    body: { analyzer, text }
  });
  return (response?.body?.tokens || []).map(t => t.token);
}

module.exports = {
  indexExists,
  ensureIndex,
  addMissingFields,
  ADDITIVE_FIELDS,
  recreateIndex,
  refreshIndex,
  getIndexStats,
  updateSearchTimeSettings,
  analyzeText,
  INDEX
};
