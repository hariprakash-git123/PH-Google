require('dotenv').config();
const mongoose = require('mongoose');
const Page = require('../models/Page');
const Media = require('../models/Media');
const Place = require('../models/Place');
const { fetchPageDetailed } = require('../crawler/pageFetcher');
const { parseLastModified } = require('../utils/httpDate');
const { isAllowed } = require('../crawler/robotsChecker');
const { extractMetadata } = require('../crawler/linkExtractor');
const { indexPage } = require('../crawler/indexer');
const { config } = require('../config/env');

/**
 * Re-fetches pages that are already in the index and re-indexes them, so the
 * image / video / news / maps verticals are populated for content crawled
 * before those verticals existed.
 *
 * Pages store extracted text rather than raw HTML, so the markup those
 * verticals need (img tags, embeds, JSON-LD) can only come from a fresh
 * fetch. robots.txt and the crawl delay are honoured exactly as in a normal
 * crawl; no page is added or removed, only refreshed.
 *
 * Usage:
 *   node scripts/reindexVerticals.js                 # all pages
 *   node scripts/reindexVerticals.js --limit 20
 *   node scripts/reindexVerticals.js --domain en.wikipedia.org
 *   node scripts/reindexVerticals.js --dry-run
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
    } else {
      args[name] = true;
    }
  }
  return args;
}

const sleep = ms =>
  new Promise(r => {
    setTimeout(r, ms);
  });

async function run() {
  const args = readArgs(process.argv.slice(2));
  const dryRun = Boolean(args['dry-run']);
  const delayMs = Number(args.delay) || config.crawler.defaultDelayMs;

  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 20000 });
  console.log(`Connected to "${mongoose.connection.name}"`);

  const filter = {};
  if (args.domain) filter.domain = String(args.domain).toLowerCase();

  let query = Page.find(filter).select('url domain').sort({ lastCrawledAt: 1 });
  if (args.limit) query = query.limit(parseInt(args.limit, 10));

  const pages = await query.lean();
  console.log(`Pages to re-index: ${pages.length}${dryRun ? ' (dry run)' : ''}\n`);

  if (dryRun) {
    pages.slice(0, 20).forEach(p => console.log(`  ${p.url}`));
    if (pages.length > 20) console.log(`  ...and ${pages.length - 20} more`);
    await mongoose.disconnect();
    return;
  }

  const totals = { ok: 0, failed: 0, skipped: 0, images: 0, videos: 0, places: 0, articles: 0 };

  for (let i = 0; i < pages.length; i += 1) {
    const { url } = pages[i];
    const label = `[${i + 1}/${pages.length}]`;

    const allowed = await isAllowed(url);
    if (!allowed) {
      totals.skipped += 1;
      console.log(`${label} SKIP (robots.txt) ${url}`);
      continue;
    }

    const fetched = await fetchPageDetailed(url);
    if (!fetched.ok) {
      totals.failed += 1;
      console.log(`${label} FAIL (${fetched.reason}) ${url}`);
      if (delayMs) await sleep(delayMs);
      continue;
    }

    const metadata = extractMetadata(fetched.html);
    // The server's Last-Modified, as the crawler reads it (utils/httpDate.js):
    // without it, re-indexing here would clear a date the page still has.
    metadata.lastModified = parseLastModified((fetched.headers || {})['last-modified']);
    const result = await indexPage(fetched.finalUrl || url, fetched.html, metadata);

    if (result.ok) {
      totals.ok += 1;
      totals.images += result.images || 0;
      totals.videos += result.videos || 0;
      totals.places += result.places || 0;
      if (result.isArticle) totals.articles += 1;
      console.log(
        `${label} OK  ${result.images || 0} img, ${result.videos || 0} vid, ` +
          `${result.places || 0} place${result.isArticle ? ', article' : ''}  ${url}`
      );
    } else {
      totals.failed += 1;
      console.log(`${label} FAIL (index) ${url}`);
    }

    if (delayMs && i < pages.length - 1) await sleep(delayMs);
  }

  console.log('\n===== RE-INDEX COMPLETE =====');
  console.log(`  pages re-indexed: ${totals.ok}`);
  console.log(`  failed:           ${totals.failed}`);
  console.log(`  skipped (robots): ${totals.skipped}`);
  console.log(`  images found:     ${totals.images}`);
  console.log(`  videos found:     ${totals.videos}`);
  console.log(`  places found:     ${totals.places}`);
  console.log(`  articles found:   ${totals.articles}`);

  const [images, videos, places, articles] = await Promise.all([
    Media.countDocuments({ type: 'image' }),
    Media.countDocuments({ type: 'video' }),
    Place.countDocuments(),
    Page.countDocuments({ isArticle: true })
  ]);
  console.log('\n  index totals now:');
  console.log(`    images: ${images}  videos: ${videos}  places: ${places}  articles: ${articles}`);

  await Promise.all([Media.syncIndexes(), Place.syncIndexes(), Page.syncIndexes()]);
  await mongoose.disconnect();
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Re-index failed:', error.message);
      process.exit(1);
    });
}

module.exports = { run };
