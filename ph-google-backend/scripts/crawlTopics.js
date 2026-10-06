const mongoose = require('mongoose');
const { config } = require('../config/env');
const { getSeedCatalog, resolveSeeds } = require('../config/crawlSeeds');

/**
 * Topic crawls from the command line, using the seed catalog.
 *
 *   npm run crawl:topics -- --list                         topics and seed counts
 *   npm run crawl:topics -- --topics science --dry-run     what would be crawled
 *   npm run crawl:topics -- --topics all --check           robots.txt + fetch check per seed
 *   npm run crawl:topics -- --topics science,history       queue it (worker crawls)
 *   npm run crawl:topics -- --topics all --pages 5 --wait  queue it and watch until done
 *   npm run crawl:topics -- --topics science --inline      crawl in this process, no Redis
 *
 * Queueing goes through the same service as the admin dashboard, so the
 * crawl appears there, obeys the same limits and is crawled by the worker
 * (`npm run worker`). `--inline` is for a machine without Redis: it crawls
 * each seed in turn with the single-process crawler, same scope rules.
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

const sleep = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

function parseTopicsArg(value) {
  if (!value || value === true) return null;
  if (value === 'all') return 'all';
  return String(value)
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
}

function listTopics() {
  const catalog = getSeedCatalog();
  console.log(`Seed catalog: ${catalog.file}\n`);
  for (const topic of catalog.topics) {
    console.log(
      `  ${topic.id.padEnd(14)} ${String(topic.seeds.length).padStart(2)} seeds  ${topic.label}`
    );
  }
  const total = catalog.topics.reduce((n, t) => n + t.seeds.length, 0);
  console.log(`\n  ${catalog.topics.length} topics, ${total} seeds`);
}

async function checkSeeds(seeds) {
  const { isAllowed } = require('../crawler/robotsChecker');
  const { fetchPageDetailed } = require('../crawler/pageFetcher');
  const { extractLinks } = require('../crawler/linkExtractor');
  const { filterLinks } = require('../crawler/crawlScope');

  let problems = 0;
  for (const seed of seeds) {
    const allowed = await isAllowed(seed.url);
    if (!allowed) {
      problems += 1;
      console.log(`  ROBOTS  ${seed.url}`);
      continue;
    }
    const fetched = await fetchPageDetailed(seed.url);
    if (!fetched.ok) {
      problems += 1;
      console.log(
        `  FAIL    ${seed.url}  (${fetched.reason}${fetched.status ? ` ${fetched.status}` : ''})`
      );
    } else {
      const links = extractLinks(fetched.html, fetched.finalUrl || seed.url);
      const followed = filterLinks(links, { seedUrl: seed.url, ...seed });
      console.log(`  OK      ${seed.url}  (${links.length} links, ${followed.length} in scope)`);
    }
    await sleep(config.crawler.defaultDelayMs);
  }
  console.log(`\n${seeds.length - problems}/${seeds.length} seeds reachable`);
  return problems;
}

async function crawlInline(seeds, perSeed) {
  const { startCrawler } = require('../crawler/crawler');
  const totals = { crawled: 0, indexed: 0, failed: 0 };

  for (const [i, seed] of seeds.entries()) {
    console.log(`\n[${i + 1}/${seeds.length}] ${seed.topic}: ${seed.url}`);
    const stats = await startCrawler(seed.url, perSeed, {
      allowedDomains: seed.allowedDomains,
      excludePatterns: seed.excludePatterns,
      maxDepth: seed.maxDepth !== null ? seed.maxDepth : config.crawler.seedMaxDepth
    });
    totals.crawled += stats.pagesCrawled;
    totals.indexed += stats.pagesIndexed;
    totals.failed += stats.failedPages;
    console.log(
      `  crawled ${stats.pagesCrawled}, indexed ${stats.pagesIndexed}, failed ${stats.failedPages}, robots-skipped ${stats.skippedByRobots}`
    );
  }

  console.log(
    `\nDone: crawled ${totals.crawled}, indexed ${totals.indexed}, failed ${totals.failed}`
  );
}

async function waitForBatch(batchId) {
  const CrawlJob = require('../models/CrawlJob');
  const terminal = ['completed', 'failed', 'stopped'];
  let last = '';

  for (;;) {
    const jobs = await CrawlJob.find({ batchId }).lean();
    const done = jobs.filter(j => terminal.includes(j.status)).length;
    const crawled = jobs.reduce((n, j) => n + j.pagesCrawled, 0);
    const indexed = jobs.reduce((n, j) => n + j.pagesIndexed, 0);
    const failed = jobs.reduce((n, j) => n + j.failedPages, 0);
    const line = `  jobs ${done}/${jobs.length} finished · pages crawled ${crawled} · indexed ${indexed} · failed ${failed}`;
    if (line !== last) {
      console.log(`${new Date().toLocaleTimeString()} ${line}`);
      last = line;
    }
    if (done === jobs.length) return jobs;
    await sleep(5000);
  }
}

async function run() {
  const args = readArgs(process.argv.slice(2));

  if (args.list) {
    listTopics();
    return;
  }

  const topics = parseTopicsArg(args.topics);
  if (!topics) {
    console.error('Choose topics with --topics <id,id,...> or --topics all. See --list.');
    process.exitCode = 1;
    return;
  }

  const seeds = resolveSeeds(topics);
  const perSeed = Math.max(
    1,
    Math.min(
      Number(args.pages) || config.crawler.seedPagesPerSeed,
      config.crawler.maxPagesHardLimit
    )
  );
  const budget = seeds.length * perSeed;

  console.log(`Topics: ${topics === 'all' ? 'all' : topics.join(', ')}`);
  console.log(
    `Seeds: ${seeds.length} · pages per seed: ${perSeed} · page budget: ${budget} (limit ${config.crawler.maxPagesPerCrawl})`
  );

  if (args['dry-run']) {
    for (const seed of seeds) {
      console.log(`  ${seed.topic.padEnd(12)} ${seed.url}  [${seed.allowedDomains.join(', ')}]`);
    }
    return;
  }

  if (args.check) {
    if ((await checkSeeds(seeds)) > 0) process.exitCode = 1;
    return;
  }

  if (budget > config.crawler.maxPagesPerCrawl) {
    console.error(
      `Page budget ${budget} is over CRAWLER_MAX_PAGES_PER_CRAWL (${config.crawler.maxPagesPerCrawl}). Use fewer topics or --pages.`
    );
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 20000 });

  try {
    if (args.inline) {
      await crawlInline(seeds, perSeed);
      return;
    }

    const crawlerJobService = require('../services/crawlerJobService');
    const result = await crawlerJobService.startSeedCrawl({ topics, maxPagesPerSeed: perSeed });
    console.log(`\nQueued batch ${result.batchId}: ${result.jobs.length} jobs.`);
    if (!result.queued) {
      console.log('Redis was unreachable; the worker will pick the crawl up on its next sweep.');
    }
    console.log('The crawl runs in the worker (npm run worker) and shows in the admin dashboard.');

    if (args.wait) {
      console.log('Waiting for every job to finish (Ctrl+C stops watching, not the crawl)...');
      await waitForBatch(result.batchId);
    }
  } finally {
    const { closeQueue } = require('../services/queue/crawlQueue');
    const { closeConnection } = require('../services/queue/connection');
    await closeQueue().catch(() => {});
    await closeConnection().catch(() => {});
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  run()
    .then(() => process.exit(process.exitCode || 0))
    .catch(error => {
      console.error('Topic crawl failed:', error.message);
      process.exit(1);
    });
}

module.exports = { run };
