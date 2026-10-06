require('dotenv').config();
const mongoose = require('mongoose');
const { config } = require('../config/env');
const { waitForCluster, closeClient } = require('../services/opensearch/client');
const { getIndexStats } = require('../services/opensearch/indexManager');
const reindexService = require('../services/opensearch/reindexService');

/**
 * Rebuilds the OpenSearch index from the pages stored in MongoDB.
 *
 *   MongoDB pages -> transform -> bulk index -> OpenSearch
 *
 * Run this after starting OpenSearch for the first time, or after changing
 * the index mappings (which needs --recreate to take effect).
 *
 * Usage:
 *   npm run search:reindex
 *   npm run search:reindex -- --recreate      # drop and rebuild the index
 *   npm run search:reindex -- --batch 500
 */
function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[name] = next;
      i += 1;
    } else args[name] = true;
  }
  return args;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const recreate = Boolean(args.recreate);
  const batchSize = args.batch ? parseInt(args.batch, 10) : undefined;

  console.log(`OpenSearch: ${config.opensearch.node}`);
  console.log(`Index:      ${config.opensearch.index}`);
  console.log(`Mode:       ${recreate ? 'recreate (drops the index first)' : 'in place'}\n`);

  process.stdout.write('Waiting for OpenSearch... ');
  const health = await waitForCluster({ attempts: 15, intervalMs: 2000 });
  if (!health.ok) {
    console.error('unreachable.\n');
    console.error(health.error || 'OpenSearch did not respond.');
    console.error('\nStart it from the repository root with:  docker compose up -d\n');
    process.exit(1);
  }
  console.log(`${health.status}.`);

  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 20000 });
  console.log(`MongoDB:    connected to "${mongoose.connection.name}"\n`);

  const before = await getIndexStats();
  console.log(`Documents in the index before: ${before.documentCount}\n`);

  const startedAt = Date.now();
  let lastReported = 0;

  // Progress is polled from the service rather than passed through a
  // callback, so the CLI and the admin API read exactly the same state.
  const ticker = setInterval(() => {
    const { lastJob } = reindexService.getStatus();
    if (lastJob && lastJob.processed !== lastReported) {
      lastReported = lastJob.processed;
      process.stdout.write(
        `\r  ${lastJob.processed}/${lastJob.total} processed, ` +
          `${lastJob.indexed} indexed, ${lastJob.failed} failed   `
      );
    }
  }, 400);

  try {
    const job = await reindexService.runReindex({ recreate, batchSize });
    clearInterval(ticker);

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `\r  ${job.processed}/${job.total} processed, ${job.indexed} indexed, ${job.failed} failed   `
    );
    console.log(`\nStatus: ${job.status} in ${seconds}s`);

    if (job.errors.length > 0) {
      console.log('\nFirst errors:');
      job.errors.slice(0, 5).forEach(e => console.log(`  ${JSON.stringify(e)}`));
    }

    const after = await getIndexStats();
    console.log(
      `\nIndex now: ${after.documentCount} documents, ` +
        `${(after.sizeInBytes / 1024 / 1024).toFixed(2)} MB, health ${after.health}`
    );

    const sync = await reindexService.getIndexSyncStatus();
    console.log(
      `MongoDB pages: ${sync.mongoPages} | indexed: ${sync.indexedDocuments} | in sync: ${sync.inSync}`
    );
    if (sync.drift > 0) {
      console.log(`\nNote: ${sync.drift} more pages in MongoDB than documents in the index.`);
      console.log(
        'That is expected when near-duplicate URLs collapse onto one canonical document.'
      );
    }
  } catch (error) {
    clearInterval(ticker);
    console.error(`\nReindex failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    await closeClient();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(process.exitCode || 0))
    .catch(error => {
      console.error('Reindex failed:', error.message);
      process.exit(1);
    });
}

module.exports = { main };
