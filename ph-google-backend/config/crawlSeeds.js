const fs = require('fs');
const path = require('path');
const { config } = require('./env');
const { normalizeUrl, canonicalKey, hostnameOf } = require('../utils/urlNormalizer');
const { parseSeedUrl } = require('../utils/validators');
const { compilePattern, isOnDomain } = require('../crawler/crawlScope');

/**
 * The seed catalog: which topics the crawler knows about, where each one
 * starts, and how far each seed may wander.
 *
 * It is data, not code. Adding a topic or a source means editing
 * config/crawlSeeds.json (or the file CRAWLER_SEEDS_FILE names) — nothing
 * in the crawler changes. Crawl *sizes* stay in the environment, next to
 * every other crawler limit.
 *
 * The file is validated in full when loaded. A catalog with a typo should
 * fail loudly at the moment someone asks for a topic crawl, not quietly
 * crawl the wrong thing — an unparseable exclude pattern or a seed outside
 * its own allowed domains is exactly how a crawl ends up somewhere nobody
 * meant it to go.
 *
 * Shape:
 *
 *   {
 *     "defaultExcludePatterns": ["regex", ...],        applied to every seed
 *     "sources": {
 *       "<name>": { "allowedDomains": [...], "excludePatterns": [...] }
 *     },
 *     "topics": [
 *       { "id": "science", "label": "Science", "seeds": [
 *           { "url": "https://...", "source": "<name>",       source is optional
 *             "allowedDomains": [...], "excludePatterns": [...], "maxDepth": 1,
 *             "sitemaps": true }                               optional, default false
 *       ] }
 *     ]
 *   }
 *
 * A seed's allowed domains come from the seed, else its source, else the
 * seed's own host — so a seed can never be unrestricted by accident.
 *
 * `sitemaps: true` opts a seed's crawls in to sitemap discovery. It only
 * takes effect while CRAWLER_SITEMAPS is on; a seed without it is opted out.
 */

const DEFAULT_FILE = path.join(__dirname, 'crawlSeeds.json');
const TOPIC_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

let cached = null;
let cachedFile = null;

function fail(file, message) {
  throw new Error(`Seed catalog ${path.basename(file)}: ${message}`);
}

function stringList(value, file, where) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) {
    fail(file, `${where} must be an array of non-empty strings.`);
  }
  return value.map(v => v.trim());
}

function checkPatterns(patterns, file, where) {
  for (const pattern of patterns || []) {
    try {
      compilePattern(pattern);
    } catch (error) {
      fail(file, `${where}: ${error.message}`);
    }
  }
}

/**
 * Reads and validates a catalog file.
 *
 * @param {string} [file] defaults to CRAWLER_SEEDS_FILE, then the bundled catalog
 * @returns {{file: string, topics: Array<Object>}} topics with fully resolved seeds
 */
function loadSeedCatalog(file = config.crawler.seedsFile || DEFAULT_FILE) {
  const resolvedFile = path.resolve(file);

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolvedFile, 'utf8'));
  } catch (error) {
    fail(resolvedFile, `could not be read as JSON (${error.message}).`);
  }

  const defaults =
    stringList(raw.defaultExcludePatterns, resolvedFile, 'defaultExcludePatterns') || [];
  checkPatterns(defaults, resolvedFile, 'defaultExcludePatterns');

  const sources = raw.sources || {};
  if (typeof sources !== 'object' || Array.isArray(sources)) {
    fail(resolvedFile, '"sources" must be an object keyed by source name.');
  }
  for (const [name, source] of Object.entries(sources)) {
    stringList(source.allowedDomains, resolvedFile, `sources.${name}.allowedDomains`);
    const patterns = stringList(
      source.excludePatterns,
      resolvedFile,
      `sources.${name}.excludePatterns`
    );
    checkPatterns(patterns, resolvedFile, `sources.${name}`);
  }

  if (!Array.isArray(raw.topics) || raw.topics.length === 0) {
    fail(resolvedFile, '"topics" must be a non-empty array.');
  }

  const topicIds = new Set();
  const seedKeys = new Map();

  const topics = raw.topics.map((topic, t) => {
    const id = String(topic.id || '');
    if (!TOPIC_ID.test(id)) {
      fail(resolvedFile, `topics[${t}].id "${id}" must be lowercase letters, digits and dashes.`);
    }
    if (topicIds.has(id)) fail(resolvedFile, `topic "${id}" is listed twice.`);
    topicIds.add(id);

    if (!Array.isArray(topic.seeds) || topic.seeds.length === 0) {
      fail(resolvedFile, `topic "${id}" has no seeds.`);
    }

    const seeds = topic.seeds.map((seed, s) => {
      const where = `topic "${id}" seed ${s + 1}`;

      let url;
      try {
        url = normalizeUrl(parseSeedUrl(seed.url));
      } catch (error) {
        fail(resolvedFile, `${where}: ${error.message}`);
      }
      if (!url) fail(resolvedFile, `${where}: "${seed.url}" is not a crawlable URL.`);

      // The same page seeded twice would have two jobs fighting over one
      // frontier row, and the loser would finish having crawled nothing.
      const key = canonicalKey(url);
      if (seedKeys.has(key)) {
        fail(resolvedFile, `${where}: ${url} is already a seed of topic "${seedKeys.get(key)}".`);
      }
      seedKeys.set(key, id);

      let source = {};
      if (seed.source !== undefined) {
        source = sources[seed.source];
        if (!source) fail(resolvedFile, `${where}: unknown source "${seed.source}".`);
      }

      const allowedDomains = stringList(
        seed.allowedDomains,
        resolvedFile,
        `${where} allowedDomains`
      ) ||
        stringList(source.allowedDomains, resolvedFile, `source ${seed.source}`) || [
          hostnameOf(url)
        ];
      if (!allowedDomains.some(domain => isOnDomain(url, domain))) {
        fail(
          resolvedFile,
          `${where}: ${url} is outside its own allowedDomains (${allowedDomains.join(', ')}).`
        );
      }

      const ownPatterns =
        stringList(seed.excludePatterns, resolvedFile, `${where} excludePatterns`) || [];
      checkPatterns(ownPatterns, resolvedFile, where);
      const excludePatterns = [...defaults, ...(source.excludePatterns || []), ...ownPatterns];

      let maxDepth = null;
      if (seed.maxDepth !== undefined) {
        maxDepth = Number(seed.maxDepth);
        if (
          !Number.isInteger(maxDepth) ||
          maxDepth < 0 ||
          maxDepth > config.crawler.maxDepthLimit
        ) {
          fail(
            resolvedFile,
            `${where}: maxDepth must be an integer from 0 to ${config.crawler.maxDepthLimit}.`
          );
        }
      }

      if (seed.sitemaps !== undefined && typeof seed.sitemaps !== 'boolean') {
        fail(resolvedFile, `${where}: sitemaps must be true or false.`);
      }

      return {
        url,
        topic: id,
        source: seed.source || '',
        allowedDomains,
        excludePatterns,
        maxDepth,
        sitemaps: seed.sitemaps === true
      };
    });

    return {
      id,
      label: String(topic.label || id),
      description: String(topic.description || ''),
      seeds
    };
  });

  return { file: resolvedFile, topics };
}

/** The configured catalog, loaded once and cached for the process. */
function getSeedCatalog() {
  const file = config.crawler.seedsFile || DEFAULT_FILE;
  if (!cached || cachedFile !== file) {
    cached = loadSeedCatalog(file);
    cachedFile = file;
  }
  return cached;
}

/** Drops the cached catalog, so the next read picks up an edited file. */
function clearSeedCatalogCache() {
  cached = null;
  cachedFile = null;
}

/**
 * The seeds for a set of topics.
 *
 * @param {string[]|'all'} topics
 * @param {Object} [catalog]
 * @returns {Array<Object>} resolved seeds, in catalog order
 * @throws {Error & {unknownTopics: string[]}} when a topic id is not in the catalog
 */
function resolveSeeds(topics, catalog = getSeedCatalog()) {
  if (topics === 'all') return catalog.topics.flatMap(t => t.seeds);

  const wanted = new Set(topics);
  const known = new Set(catalog.topics.map(t => t.id));
  const unknownTopics = [...wanted].filter(id => !known.has(id));
  if (unknownTopics.length > 0) {
    const error = new Error(`Unknown topic(s): ${unknownTopics.join(', ')}`);
    error.unknownTopics = unknownTopics;
    throw error;
  }

  return catalog.topics.filter(t => wanted.has(t.id)).flatMap(t => t.seeds);
}

module.exports = {
  loadSeedCatalog,
  getSeedCatalog,
  clearSeedCatalogCache,
  resolveSeeds,
  DEFAULT_FILE
};
