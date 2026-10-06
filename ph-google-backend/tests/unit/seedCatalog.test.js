const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSeedCatalog, resolveSeeds, DEFAULT_FILE } = require('../../config/crawlSeeds');
const { isInScope } = require('../../crawler/crawlScope');
const { canonicalKey } = require('../../utils/urlNormalizer');
const { config } = require('../../config/env');

/**
 * The seed catalog is configuration an operator edits by hand, so the
 * loader has to catch mistakes before they become a crawl.
 */

const REQUIRED_TOPICS = [
  'technology',
  'science',
  'mathematics',
  'education',
  'history',
  'geography',
  'health',
  'business',
  'finance',
  'sports',
  'arts',
  'music',
  'literature',
  'film',
  'travel',
  'environment',
  'reference'
];

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-seeds-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Writes a catalog to a temp file and loads it. */
function load(catalog) {
  const file = path.join(tmpDir, `catalog-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, typeof catalog === 'string' ? catalog : JSON.stringify(catalog));
  return loadSeedCatalog(file);
}

const minimal = (seed = {}) => ({
  topics: [{ id: 'science', label: 'Science', seeds: [{ url: 'https://example.com/a', ...seed }] }]
});

describe('the bundled catalog', () => {
  const catalog = loadSeedCatalog(DEFAULT_FILE);
  const seeds = catalog.topics.flatMap(t => t.seeds);

  it('covers every required category', () => {
    const ids = catalog.topics.map(t => t.id);
    for (const id of REQUIRED_TOPICS) expect(ids).toContain(id);
  });

  it('is a modest starting set, not hundreds of URLs', () => {
    expect(seeds.length).toBeGreaterThanOrEqual(REQUIRED_TOPICS.length);
    expect(seeds.length).toBeLessThanOrEqual(80);
  });

  it('gives every seed an explicit domain restriction that contains it', () => {
    for (const seed of seeds) {
      expect(seed.allowedDomains.length).toBeGreaterThan(0);
      expect(isInScope(seed.url, { seedUrl: seed.url, allowedDomains: seed.allowedDomains })).toBe(
        true
      );
    }
  });

  it('lists no page twice', () => {
    const keys = seeds.map(s => canonicalKey(s.url));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('draws on more than one website', () => {
    const hosts = new Set(seeds.map(s => new URL(s.url).hostname));
    expect(hosts.size).toBeGreaterThan(3);
  });

  it('keeps Wikipedia crawls on articles', () => {
    const physics = seeds.find(s => s.url.endsWith('/wiki/Physics'));
    const scope = { seedUrl: physics.url, ...physics };
    expect(isInScope('https://en.wikipedia.org/wiki/Energy', scope)).toBe(true);
    for (const url of [
      'https://en.wikipedia.org/wiki/Talk:Physics',
      'https://en.wikipedia.org/wiki/Special:Random',
      'https://en.wikipedia.org/wiki/Category:Physics',
      'https://en.wikipedia.org/wiki/File:Atom.png',
      'https://en.wikipedia.org/wiki/Main_Page',
      'https://en.wikipedia.org/w/index.php?title=Physics&action=edit',
      'https://de.wikipedia.org/wiki/Physik',
      'https://wikimediafoundation.org/'
    ]) {
      expect(isInScope(url, scope)).toBe(false);
    }
  });
});

describe('loading a catalog', () => {
  it('defaults a seed with no source to its own host', () => {
    const [seed] = load(minimal()).topics[0].seeds;
    expect(seed.allowedDomains).toEqual(['example.com']);
    expect(seed.maxDepth).toBeNull();
  });

  it('merges default, source and seed exclude patterns', () => {
    const catalog = load({
      defaultExcludePatterns: ['/login'],
      sources: { site: { allowedDomains: ['example.com'], excludePatterns: ['/talk/'] } },
      topics: [
        {
          id: 'science',
          seeds: [{ url: 'https://example.com/a', source: 'site', excludePatterns: ['/draft/'] }]
        }
      ]
    });
    expect(catalog.topics[0].seeds[0].excludePatterns).toEqual(['/login', '/talk/', '/draft/']);
  });

  it('rejects a file that is not JSON', () => {
    expect(() => load('{ not json')).toThrow(/could not be read as JSON/);
  });

  it('rejects a catalog with no topics', () => {
    expect(() => load({ topics: [] })).toThrow(/non-empty array/);
  });

  it('rejects a malformed topic id', () => {
    expect(() => load({ topics: [{ id: 'Bad Id', seeds: [{ url: 'https://a.com' }] }] })).toThrow(
      /lowercase/
    );
  });

  it('rejects a duplicate topic', () => {
    const topic = { id: 'science', seeds: [{ url: 'https://a.com/1' }] };
    const other = { id: 'science', seeds: [{ url: 'https://a.com/2' }] };
    expect(() => load({ topics: [topic, other] })).toThrow(/listed twice/);
  });

  it('rejects the same page seeded twice, even spelled differently', () => {
    expect(() =>
      load({
        topics: [
          { id: 'a', seeds: [{ url: 'https://example.com/page' }] },
          { id: 'b', seeds: [{ url: 'https://www.example.com/page/?utm_source=x' }] }
        ]
      })
    ).toThrow(/already a seed/);
  });

  it('rejects an unknown source', () => {
    expect(() => load(minimal({ source: 'nope' }))).toThrow(/unknown source/);
  });

  it('rejects a seed outside its own allowed domains', () => {
    expect(() => load(minimal({ allowedDomains: ['other.org'] }))).toThrow(/outside its own/);
  });

  it('rejects an invalid exclude pattern', () => {
    expect(() => load(minimal({ excludePatterns: ['([bad'] }))).toThrow(/Invalid exclude pattern/);
  });

  it('rejects a non-http seed', () => {
    expect(() => load(minimal({ url: 'ftp://example.com/a' }))).toThrow(/http/);
  });

  it('rejects a depth beyond the configured ceiling', () => {
    expect(() => load(minimal({ maxDepth: config.crawler.maxDepthLimit + 1 }))).toThrow(/maxDepth/);
  });
});

describe('resolveSeeds', () => {
  const catalog = {
    topics: [
      { id: 'a', seeds: [{ url: 'https://a.com/1' }, { url: 'https://a.com/2' }] },
      { id: 'b', seeds: [{ url: 'https://b.com/1' }] }
    ]
  };

  it('returns the seeds of the chosen topics', () => {
    expect(resolveSeeds(['b'], catalog).map(s => s.url)).toEqual(['https://b.com/1']);
  });

  it('returns every seed for "all"', () => {
    expect(resolveSeeds('all', catalog)).toHaveLength(3);
  });

  it('names unknown topics', () => {
    expect(() => resolveSeeds(['a', 'zzz'], catalog)).toThrow(/zzz/);
  });
});

describe('crawler identity', () => {
  it('never presents itself as Googlebot', () => {
    // Sites block apparent Googlebot impersonation; Wikipedia returns 403.
    expect(config.crawler.userAgent.toLowerCase()).not.toContain('googlebot');
  });
});
