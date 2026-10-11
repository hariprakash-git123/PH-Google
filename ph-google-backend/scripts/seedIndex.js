require('dotenv').config();
const mongoose = require('mongoose');
const Page = require('../models/Page');
const Media = require('../models/Media');
const Place = require('../models/Place');
const { fetchPageDetailed } = require('../crawler/pageFetcher');
const { parseLastModified } = require('../utils/httpDate');
const { isAllowed, getCrawlDelayMs } = require('../crawler/robotsChecker');
const { extractMetadata } = require('../crawler/linkExtractor');
const { indexPage } = require('../crawler/indexer');
const { config } = require('../config/env');

/**
 * Seeds the index with a curated, diverse set of pages so every vertical
 * (web, images, videos, news, maps) has real content to search.
 *
 * Each URL is fetched once — no link following — so the crawl is precise and
 * small. robots.txt is honoured and a delay is applied between requests.
 * Nothing is deleted; pages that already exist are simply refreshed.
 *
 * Usage:
 *   npm run seed-index                       # the default set
 *   npm run seed-index -- --group places     # one group only
 *   npm run seed-index -- --url https://...  # a single page
 *   npm run seed-index -- --dry-run
 *   npm run seed-index -- --delay 1500
 */

const SEEDS = {
  // Landmarks and cities: rich in photographs and geo coordinates.
  places: [
    'https://en.wikipedia.org/wiki/Mumbai',
    'https://en.wikipedia.org/wiki/Delhi',
    'https://en.wikipedia.org/wiki/Bengaluru',
    'https://en.wikipedia.org/wiki/Chennai',
    'https://en.wikipedia.org/wiki/Kolkata',
    'https://en.wikipedia.org/wiki/Paris',
    'https://en.wikipedia.org/wiki/London',
    'https://en.wikipedia.org/wiki/Tokyo',
    'https://en.wikipedia.org/wiki/New_York_City',
    'https://en.wikipedia.org/wiki/Sydney',
    'https://en.wikipedia.org/wiki/Rome',
    'https://en.wikipedia.org/wiki/Cairo',
    'https://en.wikipedia.org/wiki/Eiffel_Tower',
    'https://en.wikipedia.org/wiki/Taj_Mahal',
    'https://en.wikipedia.org/wiki/Statue_of_Liberty',
    'https://en.wikipedia.org/wiki/Great_Wall_of_China',
    'https://en.wikipedia.org/wiki/Sydney_Opera_House',
    'https://en.wikipedia.org/wiki/Machu_Picchu',
    'https://en.wikipedia.org/wiki/Colosseum',
    'https://en.wikipedia.org/wiki/Golden_Gate_Bridge',
    'https://en.wikipedia.org/wiki/Burj_Khalifa',
    'https://en.wikipedia.org/wiki/Gateway_of_India',
    'https://en.wikipedia.org/wiki/Hagia_Sophia',
    'https://en.wikipedia.org/wiki/Petra',
    'https://en.wikipedia.org/wiki/Grand_Canyon'
  ],

  // Nature and science: heavily illustrated, and Wikipedia hosts Commons
  // video files on several of these.
  nature: [
    'https://en.wikipedia.org/wiki/Tiger',
    'https://en.wikipedia.org/wiki/Elephant',
    'https://en.wikipedia.org/wiki/Lion',
    'https://en.wikipedia.org/wiki/Bird',
    'https://en.wikipedia.org/wiki/Butterfly',
    'https://en.wikipedia.org/wiki/Volcano',
    'https://en.wikipedia.org/wiki/Solar_System',
    'https://en.wikipedia.org/wiki/Moon',
    'https://en.wikipedia.org/wiki/Photosynthesis',
    'https://en.wikipedia.org/wiki/Hurricane',
    'https://en.wikipedia.org/wiki/Waterfall',
    'https://en.wikipedia.org/wiki/Coral_reef'
  ],

  // Technology topics, for general web search coverage.
  technology: [
    'https://en.wikipedia.org/wiki/Python_(programming_language)',
    'https://en.wikipedia.org/wiki/JavaScript',
    'https://en.wikipedia.org/wiki/React_(software)',
    'https://en.wikipedia.org/wiki/Node.js',
    'https://en.wikipedia.org/wiki/MongoDB',
    'https://en.wikipedia.org/wiki/Machine_learning',
    'https://en.wikipedia.org/wiki/Web_search_engine',
    'https://en.wikipedia.org/wiki/Search_engine_indexing',
    'https://en.wikipedia.org/wiki/Web_crawler',
    'https://en.wikipedia.org/wiki/PageRank',
    'https://en.wikipedia.org/wiki/Inverted_index',
    'https://en.wikipedia.org/wiki/Cloud_computing',
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript',
    'https://nodejs.org/en/about',
    'https://react.dev/learn'
  ],

  // Sport and culture: photographs, and some pages carry video.
  culture: [
    'https://en.wikipedia.org/wiki/Cricket',
    'https://en.wikipedia.org/wiki/Association_football',
    'https://en.wikipedia.org/wiki/Olympic_Games',
    'https://en.wikipedia.org/wiki/Guitar',
    'https://en.wikipedia.org/wiki/Painting',
    'https://en.wikipedia.org/wiki/Cinema_of_India'
  ]
};

/**
 * News sources are crawled rather than fetched one page at a time: a blog's
 * home page is a listing, so the articles themselves are one link away.
 * Each entry stays on its own domain and is capped at `maxPages`.
 */
const NEWS_CRAWLS = [
  { url: 'https://github.blog/', maxPages: 12 },
  { url: 'https://stackoverflow.blog/', maxPages: 10 },
  { url: 'https://engineering.fb.com/', maxPages: 10 },
  { url: 'https://blog.mozilla.org/en/', maxPages: 10 },
  { url: 'https://techcrunch.com/', maxPages: 10 }
];

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

const sleep = ms =>
  new Promise(r => {
    setTimeout(r, ms);
  });

async function run() {
  const args = readArgs(process.argv.slice(2));
  const dryRun = Boolean(args['dry-run']);

  // The news group crawls listings to reach the articles behind them.
  if (args.group === 'news') {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 20000 });
    console.log(`Connected to "${mongoose.connection.name}"\n`);
    await seedNews({ dryRun, delay: Number(args.delay) || undefined });
    await mongoose.disconnect();
    return;
  }

  let urls;
  if (args.url) {
    urls = [String(args.url)];
  } else if (args.group) {
    const group = SEEDS[String(args.group)];
    if (!group) {
      console.error(`Unknown group "${args.group}". Available: ${Object.keys(SEEDS).join(', ')}`);
      process.exit(1);
    }
    urls = group;
  } else {
    urls = Object.values(SEEDS).flat();
  }

  if (args.limit) urls = urls.slice(0, parseInt(args.limit, 10));

  console.log(`Seed pages: ${urls.length}${dryRun ? ' (dry run)' : ''}`);
  if (dryRun) {
    urls.forEach(u => console.log(`  ${u}`));
    return;
  }

  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 20000 });
  console.log(`Connected to "${mongoose.connection.name}"\n`);

  const totals = { ok: 0, failed: 0, skipped: 0, images: 0, videos: 0, places: 0, articles: 0 };
  // Per-host delay, so we stay polite to each site independently.
  const delayByHost = new Map();

  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    const label = `[${i + 1}/${urls.length}]`;
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      /* reported below */
    }

    if (!(await isAllowed(url))) {
      totals.skipped += 1;
      console.log(`${label} SKIP (robots.txt)  ${url}`);
      continue;
    }

    // Honour the host's declared crawl delay, else the configured default.
    if (!delayByHost.has(host)) {
      const declared = await getCrawlDelayMs(url);
      delayByHost.set(host, Number(args.delay) || declared || config.crawler.defaultDelayMs);
    }

    const fetched = await fetchPageDetailed(url);
    if (!fetched.ok) {
      totals.failed += 1;
      console.log(`${label} FAIL (${fetched.reason})  ${url}`);
      await sleep(delayByHost.get(host));
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
        `${label} OK  ${String(result.images || 0).padStart(3)} img, ` +
          `${String(result.videos || 0).padStart(2)} vid, ` +
          `${String(result.places || 0).padStart(2)} place  ${metadata.title.slice(0, 48)}`
      );
    } else {
      totals.failed += 1;
      console.log(`${label} FAIL (index)  ${url}`);
    }

    if (i < urls.length - 1) await sleep(delayByHost.get(host));
  }

  console.log('\n===== SEED COMPLETE =====');
  console.log(`  indexed: ${totals.ok}   failed: ${totals.failed}   skipped: ${totals.skipped}`);
  console.log(
    `  found -> images ${totals.images}, videos ${totals.videos}, places ${totals.places}, articles ${totals.articles}`
  );

  const [pages, images, videos, places, articles] = await Promise.all([
    Page.countDocuments(),
    Media.countDocuments({ type: 'image' }),
    Media.countDocuments({ type: 'video' }),
    Place.countDocuments(),
    Page.countDocuments({ isArticle: true })
  ]);

  console.log('\n  index totals now:');
  console.log(
    `    pages ${pages} | images ${images} | videos ${videos} | places ${places} | articles ${articles}`
  );

  await Promise.all([Page.syncIndexes(), Media.syncIndexes(), Place.syncIndexes()]);
  await mongoose.disconnect();
}

/**
 * Crawls each news source so its article pages (not just its listing page)
 * reach the index. Uses the normal crawler, so robots.txt, the page cap and
 * the politeness delay all apply.
 */
async function seedNews({ dryRun = false, delay } = {}) {
  const { startCrawler } = require('../crawler/crawler');

  console.log(`News sources: ${NEWS_CRAWLS.length}${dryRun ? ' (dry run)' : ''}`);
  if (dryRun) {
    NEWS_CRAWLS.forEach(s => console.log(`  ${s.url} (max ${s.maxPages} pages)`));
    return;
  }

  for (const source of NEWS_CRAWLS) {
    console.log(`\nCrawling ${source.url} (max ${source.maxPages})`);
    try {
      const stats = await startCrawler(source.url, source.maxPages, {
        sameDomainOnly: true,
        maxDepth: 1,
        crawlDelayMs: delay
      });
      console.log(
        `  crawled ${stats.pagesCrawled}, indexed ${stats.pagesIndexed}, ` +
          `failed ${stats.failedPages}, robots-skipped ${stats.skippedByRobots}`
      );
    } catch (error) {
      console.log(`  FAILED: ${error.message}`);
    }
  }

  const articles = await Page.countDocuments({ isArticle: true });
  const pages = await Page.countDocuments();
  console.log(`\n  index totals now: pages ${pages} | articles ${articles}`);
  await Page.syncIndexes();
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Seed failed:', error.message);
      process.exit(1);
    });
}

module.exports = { run, seedNews, SEEDS, NEWS_CRAWLS };
