require('dotenv').config();
const mongoose = require('mongoose');
const Page = require('../models/Page');
const Term = require('../models/Term');
const { config } = require('../config/env');

/**
 * Additive, non-destructive migration.
 *
 * 1. Fills in the `domain` field for pages crawled before it existed, by
 *    deriving it from the page's own url.
 * 2. Promotes `status: 'crawled'` to `'indexed'` for pages that genuinely
 *    have postings in the inverted index. The original indexer never set
 *    'indexed', so those pages under-report index health on the admin
 *    dashboard even though they are fully searchable.
 *
 * Nothing is ever deleted and no existing value is overwritten.
 *
 * Run with:  npm run migrate
 *            npm run migrate -- --dry-run
 */
async function run({ dryRun = false } = {}) {
  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 20000 });
  console.log(`Connected to database "${mongoose.connection.name}"`);
  if (dryRun) console.log('DRY RUN — nothing will be written.\n');

  const domains = await backfillDomains(dryRun);
  const statuses = await backfillIndexedStatus(dryRun);

  if (!dryRun) {
    console.log('\nSynchronising indexes...');
    await Promise.all([Page.syncIndexes(), Term.syncIndexes()]);
    console.log('Indexes up to date.');
  }

  console.log('\nSummary');
  console.log(
    `  domain backfilled:  ${domains.updated} page(s)${domains.wouldUpdate ? ` (would update ${domains.wouldUpdate})` : ''}`
  );
  console.log(
    `  status -> indexed:  ${statuses.updated} page(s)${statuses.wouldUpdate ? ` (would update ${statuses.wouldUpdate})` : ''}`
  );

  await mongoose.disconnect();
  return { domains, statuses };
}

/** Step 1 — derive `domain` from `url` where it is missing. */
async function backfillDomains(dryRun) {
  const needsDomain = await Page.find({
    $or: [{ domain: { $exists: false } }, { domain: '' }, { domain: null }]
  })
    .select('_id url')
    .lean();

  console.log(`Step 1: pages missing a domain value: ${needsDomain.length}`);

  if (needsDomain.length === 0) return { updated: 0, skipped: 0 };

  const operations = [];
  let skipped = 0;

  for (const page of needsDomain) {
    let domain = '';
    try {
      domain = new URL(page.url).hostname.toLowerCase();
    } catch {
      skipped += 1;
      console.warn(`  Skipped (unparseable url): ${page.url}`);
      continue;
    }
    // $set on one additive field only — no other data is touched.
    operations.push({ updateOne: { filter: { _id: page._id }, update: { $set: { domain } } } });
  }

  if (dryRun) {
    console.log(`  Would set a domain on ${operations.length} page(s); ${skipped} unparseable.`);
    operations.slice(0, 5).forEach(op => {
      console.log(`    ${op.updateOne.filter._id} -> ${op.updateOne.update.$set.domain}`);
    });
    if (operations.length > 5) console.log(`    ...and ${operations.length - 5} more`);
    return { updated: 0, skipped, wouldUpdate: operations.length };
  }

  const result =
    operations.length > 0
      ? await Page.bulkWrite(operations, { ordered: false })
      : { modifiedCount: 0 };

  console.log(`  Updated ${result.modifiedCount} page(s); ${skipped} skipped.`);
  return { updated: result.modifiedCount, skipped };
}

/**
 * Step 2 — mark pages that have inverted-index postings as 'indexed'.
 *
 * A page only qualifies when at least one Term document actually references
 * it, so this records a fact about the index rather than assuming one.
 */
async function backfillIndexedStatus(dryRun) {
  const candidates = await Page.find({ status: 'crawled' }).select('_id url').lean();
  console.log(`\nStep 2: pages with status "crawled": ${candidates.length}`);

  if (candidates.length === 0) return { updated: 0, withoutPostings: 0 };

  const indexedIds = [];
  const missing = [];

  for (const page of candidates) {
    // countDocuments with a limit of 1: we only need to know "any postings?".
    const hasPostings = await Term.countDocuments({ 'documents.pageId': page._id }).limit(1);
    if (hasPostings > 0) indexedIds.push(page._id);
    else missing.push(page.url);
  }

  console.log(`  With index postings: ${indexedIds.length}`);
  console.log(`  Without postings (left as "crawled"): ${missing.length}`);
  missing.slice(0, 5).forEach(u => console.log(`    ${u}`));

  if (dryRun) {
    return { updated: 0, withoutPostings: missing.length, wouldUpdate: indexedIds.length };
  }

  if (indexedIds.length === 0) return { updated: 0, withoutPostings: missing.length };

  const result = await Page.updateMany(
    { _id: { $in: indexedIds }, status: 'crawled' },
    { $set: { status: 'indexed' } }
  );

  console.log(`  Promoted ${result.modifiedCount} page(s) to "indexed".`);
  return { updated: result.modifiedCount, withoutPostings: missing.length };
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  run({ dryRun })
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Backfill failed:', error.message);
      process.exit(1);
    });
}

module.exports = { run, backfillDomains, backfillIndexedStatus };
