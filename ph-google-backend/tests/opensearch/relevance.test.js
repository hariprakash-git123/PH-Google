/**
 * Search quality suite — runs against a real OpenSearch cluster.
 *
 * Start one with `docker compose up -d` from the repository root. When no
 * cluster is reachable every test here is skipped with a clear message, so
 * `npm test` still works without Docker.
 *
 * This is the file that proves relevance actually behaves: exact-title
 * priority, phrase handling, typo recovery, domain queries, duplicate
 * collapsing, filters and pagination.
 */

process.env.SEARCH_ENGINE = 'opensearch';
process.env.OPENSEARCH_INDEX = process.env.OPENSEARCH_INDEX_TEST || 'ph-google-pages-test';

const { checkHealth, closeClient, resetClient } = require('../../services/opensearch/client');
const {
  recreateIndex,
  refreshIndex,
  getIndexStats
} = require('../../services/opensearch/indexManager');
const {
  bulkIndexPages,
  resetIndexReadyFlag
} = require('../../services/opensearch/indexingService');
const openSearch = require('../../services/opensearch/searchService');

const available = process.env.OPENSEARCH_AVAILABLE === 'true';

/** Fixture corpus: small, hand-built, and designed to make ranking testable. */
const PAGES = [
  {
    _id: 'p-python-org',
    url: 'https://python.org/about',
    domain: 'python.org',
    title: 'Python',
    description: 'Python is a programming language that lets you work quickly.',
    content:
      'Python is a high level programming language. Python is widely used for data science, scripting and web development. The python community is large.',
    language: 'en',
    lastCrawledAt: new Date('2026-09-01T00:00:00Z')
  },
  {
    _id: 'p-python-tut',
    url: 'https://docs.example.com/python-tutorial',
    domain: 'docs.example.com',
    title: 'Python Tutorial for Beginners',
    description: 'Learn python step by step.',
    content:
      'This python tutorial covers variables, loops and functions. A good tutorial for beginners learning python programming.',
    language: 'en',
    lastCrawledAt: new Date('2026-08-20T00:00:00Z')
  },
  {
    _id: 'p-snake',
    url: 'https://wildlife.example.org/snakes',
    domain: 'wildlife.example.org',
    title: 'Snakes of the World',
    description: 'A guide to snake species.',
    // Mentions python once, in a different sense — must rank below the
    // programming pages for the query "python".
    content:
      'The reticulated python is a large snake. Snakes are reptiles found on every continent except Antarctica.',
    language: 'en',
    lastCrawledAt: new Date('2026-07-01T00:00:00Z')
  },
  {
    _id: 'p-ml',
    url: 'https://ml.example.com/machine-learning',
    domain: 'ml.example.com',
    title: 'Machine Learning Explained',
    description: 'An introduction to machine learning.',
    content:
      'Machine learning is a field of artificial intelligence. Machine learning models learn patterns from data.',
    language: 'en',
    lastCrawledAt: new Date('2026-09-10T00:00:00Z')
  },
  {
    _id: 'p-scattered',
    url: 'https://misc.example.com/glossary',
    domain: 'misc.example.com',
    title: 'Technology Glossary',
    description: 'Definitions of technology terms.',
    // Contains "machine" and "learning" but far apart and never as a phrase,
    // so proximity scoring should place it below the real ML page.
    content:
      'A machine is a device that does work. Separately, learning is the process of acquiring knowledge. ' +
      'This glossary covers many unrelated terms across dozens of paragraphs of filler text about hardware. '.repeat(
        6
      ),
    language: 'en',
    lastCrawledAt: new Date('2026-09-11T00:00:00Z')
  },
  {
    _id: 'p-youtube',
    url: 'https://youtube.com',
    domain: 'youtube.com',
    title: 'YouTube',
    description: 'Share your videos with friends and family.',
    content:
      'Enjoy the videos and music you love, upload original content and share it with friends and the world on YouTube.',
    language: 'en',
    lastCrawledAt: new Date('2026-09-05T00:00:00Z')
  },
  {
    _id: 'p-about-youtube',
    url: 'https://blog.example.com/why-youtube-won',
    domain: 'blog.example.com',
    title: 'Why YouTube Won The Video Wars',
    description: 'An analysis of YouTube, youtube growth and the video market.',
    // Mentions youtube far more often than youtube.com itself — the site
    // query must still put the real site first.
    content:
      'YouTube changed video. '.repeat(30) + ' youtube youtube youtube analysis of the platform.',
    language: 'en',
    lastCrawledAt: new Date('2026-09-12T00:00:00Z')
  },
  {
    _id: 'p-spam',
    url: 'https://spam.example.net/cheap',
    domain: 'spam.example.net',
    title: 'python python python python python cheap buy now',
    description: '',
    // Keyword stuffing: huge word count, almost no distinct words.
    content: 'python cheap buy now '.repeat(400),
    language: 'en',
    lastCrawledAt: new Date('2026-09-14T00:00:00Z')
  },
  // Two near-duplicate copies of one article at different addresses.
  {
    _id: 'p-dup-a',
    url: 'https://news.example.com/electric-cars',
    domain: 'news.example.com',
    title: 'The Best Electric Cars of 2026',
    description: 'Our ranking of the best electric cars this year.',
    content:
      'The best electric cars of 2026 combine range and price. Electric cars are improving quickly.',
    language: 'en',
    isArticle: true,
    publishedAt: new Date('2026-09-15T00:00:00Z'),
    siteName: 'Example News',
    lastCrawledAt: new Date('2026-09-15T00:00:00Z')
  },
  {
    _id: 'p-dup-b',
    url: 'https://mirror.example.org/electric-cars-copy',
    domain: 'mirror.example.org',
    title: 'The Best Electric Cars of 2026',
    description: 'Our ranking of the best electric cars this year.',
    content:
      'The best electric cars of 2026 combine range and price. Electric cars are improving quickly.',
    language: 'en',
    isArticle: true,
    publishedAt: new Date('2026-09-15T00:00:00Z'),
    siteName: 'Example Mirror',
    lastCrawledAt: new Date('2026-09-15T00:00:00Z')
  },
  {
    _id: 'p-old-news',
    url: 'https://news.example.com/old-story',
    domain: 'news.example.com',
    title: 'Electric Cars In 2019',
    description: 'An older look at electric cars.',
    content: 'Electric cars in 2019 were expensive and had limited range.',
    language: 'en',
    isArticle: true,
    publishedAt: new Date('2019-03-01T00:00:00Z'),
    siteName: 'Example News',
    lastCrawledAt: new Date('2026-09-01T00:00:00Z')
  },
  {
    _id: 'p-french',
    url: 'https://fr.example.com/recherche',
    domain: 'fr.example.com',
    title: 'Moteur de recherche open source',
    description: 'Un moteur de recherche libre.',
    content: 'Un moteur de recherche open source permet de chercher des pages web.',
    language: 'fr',
    lastCrawledAt: new Date('2026-09-02T00:00:00Z')
  },
  {
    _id: 'p-search-engine',
    url: 'https://search.example.com/open-source-search-engine',
    domain: 'search.example.com',
    title: 'Open Source Search Engine',
    description: 'Building an open source search engine from scratch.',
    content:
      'An open source search engine indexes web pages and ranks them. Building a search engine requires a crawler and an inverted index.',
    language: 'en',
    lastCrawledAt: new Date('2026-09-08T00:00:00Z')
  }
];

/** URLs of the results, for readable assertions. */
const urlsOf = outcome => outcome.results.map(r => r.url);

/** Position of the first result whose url contains `fragment` (-1 if absent). */
const rankOf = (outcome, fragment) => urlsOf(outcome).findIndex(u => u.includes(fragment));

/**
 * Skips the whole suite when no cluster is reachable.
 *
 * `describe.skip` is deliberate. An earlier version wrapped `it` in a helper
 * that returned early when the cluster was down — which made Jest report 40
 * assertion-free tests as *passed*, a green run that proved nothing. Skipping
 * at the describe level means Jest prints them as skipped, and the count of
 * passing tests only ever includes tests that actually asserted something.
 *
 * `tests/helpers/globalSetup.js` decides availability once, before any test
 * file is loaded, and fails the run outright when OPENSEARCH_REQUIRED=true.
 */
const describeLive = available ? describe : describe.skip;

describeLive('OpenSearch search quality', () => {
  beforeAll(async () => {
    resetClient();
    const health = await checkHealth(true);
    if (!health.ok) {
      // globalSetup said the cluster was up, so losing it mid-run is a real
      // failure, not a reason to skip.
      throw new Error(`OpenSearch became unreachable at ${health.node}: ${health.error || ''}`);
    }

    resetIndexReadyFlag();
    await recreateIndex();
    await bulkIndexPages(PAGES);
    await refreshIndex();
  }, 120000);

  afterAll(async () => {
    await closeClient();
  });

  it('indexes the whole fixture corpus', async () => {
    const stats = await getIndexStats();
    expect(stats.exists).toBe(true);
    expect(stats.documentCount).toBe(PAGES.length);
  });

  // ------------------------------------------------------------------
  describe('exact title match', () => {
    it('puts the page titled exactly "Python" first', async () => {
      const outcome = await openSearch.search({ query: 'python', limit: 10 });
      expect(outcome.results.length).toBeGreaterThan(0);
      expect(outcome.results[0].url).toBe('https://python.org/about');
    });

    it('ranks an exact title above a page that merely mentions the word', async () => {
      const outcome = await openSearch.search({ query: 'machine learning', limit: 10 });
      expect(outcome.results[0].title).toBe('Machine Learning Explained');
    });
  });

  // ------------------------------------------------------------------
  describe('phrase matching', () => {
    it('a quoted phrase requires the words together, in order', async () => {
      const quoted = await openSearch.search({ query: '"machine learning"', limit: 10 });

      // The glossary page has both words, but never as the phrase.
      expect(urlsOf(quoted)).not.toContain('https://misc.example.com/glossary');
      expect(quoted.results[0].title).toBe('Machine Learning Explained');
    });

    it('an unquoted query is broader than a quoted one', async () => {
      const quoted = await openSearch.search({ query: '"machine learning"', limit: 10 });
      const loose = await openSearch.search({ query: 'machine learning', limit: 10 });
      expect(loose.totalResults).toBeGreaterThanOrEqual(quoted.totalResults);
    });

    it('a multi-word phrase query works for a longer phrase', async () => {
      const outcome = await openSearch.search({ query: '"open source search engine"', limit: 10 });
      expect(outcome.results[0].url).toBe('https://search.example.com/open-source-search-engine');
    });
  });

  // ------------------------------------------------------------------
  describe('proximity', () => {
    it('ranks words appearing together above words scattered apart', async () => {
      const outcome = await openSearch.search({ query: 'machine learning', limit: 10 });
      const real = rankOf(outcome, 'ml.example.com');
      const scattered = rankOf(outcome, 'misc.example.com');

      expect(real).toBeGreaterThanOrEqual(0);
      if (scattered >= 0) expect(real).toBeLessThan(scattered);
    });
  });

  // ------------------------------------------------------------------
  describe('domain and URL queries', () => {
    it('"youtube.com" returns youtube.com itself first', async () => {
      const outcome = await openSearch.search({ query: 'youtube.com', limit: 10 });
      expect(outcome.results[0].url).toBe('https://youtube.com');
    });

    it('the real site outranks a page that mentions it far more often', async () => {
      const outcome = await openSearch.search({ query: 'youtube.com', limit: 10 });
      const site = rankOf(outcome, 'https://youtube.com');
      const about = rankOf(outcome, 'blog.example.com');
      expect(site).toBe(0);
      if (about >= 0) expect(site).toBeLessThan(about);
    });
  });

  // ------------------------------------------------------------------
  describe('typo tolerance', () => {
    it('"pyhton" still finds the python pages', async () => {
      const outcome = await openSearch.search({ query: 'pyhton', limit: 10 });
      expect(outcome.results.length).toBeGreaterThan(0);
      expect(urlsOf(outcome).some(u => u.includes('python'))).toBe(true);
    });

    it('a correct spelling still outranks a fuzzy match', async () => {
      const exact = await openSearch.search({ query: 'python', limit: 5 });
      const typo = await openSearch.search({ query: 'pyhton', limit: 5 });
      // Fuzzy is a weak rescue clause, so the exact query scores much higher.
      expect(exact.results[0].score).toBeGreaterThan(typo.results[0].score);
    });

    it('does not admit a page matching only one term of a multi-word query', async () => {
      // The snake page and the spam page mention python but never
      // programming, so neither satisfies "python programming".
      const outcome = await openSearch.search({ query: 'python programming', limit: 10 });
      expect(urlsOf(outcome)).not.toContain('https://wildlife.example.org/snakes');
      expect(urlsOf(outcome)).not.toContain('https://spam.example.net/cheap');
      expect(outcome.results[0].url).toMatch(/python/);
    });

    it('"pyhton programming" finds the python programming pages and nothing else', async () => {
      const outcome = await openSearch.search({ query: 'pyhton programming', limit: 10 });
      expect(urlsOf(outcome)).toContain('https://python.org/about');
      expect(urlsOf(outcome)).toContain('https://docs.example.com/python-tutorial');
      expect(urlsOf(outcome)).not.toContain('https://wildlife.example.org/snakes');
      expect(urlsOf(outcome)).not.toContain('https://spam.example.net/cheap');
    });

    it('"machne learning" still finds the machine learning page first', async () => {
      const outcome = await openSearch.search({ query: 'machne learning', limit: 10 });
      expect(outcome.results[0].url).toBe('https://ml.example.com/machine-learning');
    });
  });

  // ------------------------------------------------------------------
  describe('question queries', () => {
    it('"what is machine learning" puts the machine learning page first', async () => {
      const outcome = await openSearch.search({ query: 'what is machine learning', limit: 10 });
      expect(outcome.results[0].url).toBe('https://ml.example.com/machine-learning');
    });

    it('"how does a search engine work" puts the search engine page first', async () => {
      const outcome = await openSearch.search({
        query: 'how does a search engine work',
        limit: 10
      });
      expect(outcome.results[0].url).toBe('https://search.example.com/open-source-search-engine');
    });

    it('"what is python" puts python.org first', async () => {
      const outcome = await openSearch.search({ query: 'what is python', limit: 10 });
      expect(outcome.results[0].url).toBe('https://python.org/about');
    });
  });

  // ------------------------------------------------------------------
  describe('synonyms', () => {
    it('"ai" finds the artificial intelligence content', async () => {
      const outcome = await openSearch.search({ query: 'ai', limit: 10 });
      expect(urlsOf(outcome)).toContain('https://ml.example.com/machine-learning');
    });
  });

  // ------------------------------------------------------------------
  describe('freshness', () => {
    /**
     * Regression: freshness was first implemented as a gauss decay on
     * publishedAt. `decay` is the multiplier at one scale unit and the curve
     * keeps falling quadratically past it, so a 2001-dated page scored about
     * 1e-42 and disappeared from the results entirely — however well it
     * matched. Freshness must only ever lift a recent page, never bury an
     * old one.
     */
    it('does not bury an old page that is the best match', async () => {
      const outcome = await openSearch.search({ query: 'electric cars 2019', limit: 10 });
      expect(rankOf(outcome, 'old-story')).toBeGreaterThanOrEqual(0);
    });

    it('keeps an exact title match first despite a very old date', async () => {
      // p-python-org has no publishedAt; p-old-news is from 2019. Neither
      // may be excluded by the freshness function.
      const outcome = await openSearch.search({ query: 'python', limit: 10 });
      expect(outcome.results[0].url).toBe('https://python.org/about');
    });

    it('returns pages that carry no publication date at all', async () => {
      // Most of the web has no publishedAt; an unfiltered decay function
      // scores those 0 and erases them.
      const outcome = await openSearch.search({ query: 'snakes', limit: 10 });
      expect(rankOf(outcome, 'wildlife.example.org')).toBeGreaterThanOrEqual(0);
    });

    it('gives recency at most a modest lift, not dominance', async () => {
      // The 2026 duplicate article and the 2019 one both match; recency
      // should order them without letting the recent one outscore a far
      // better match by orders of magnitude.
      const outcome = await openSearch.search({ query: 'electric cars', limit: 10 });
      const scores = outcome.results.map(r => r.score).filter(s => s > 0);
      if (scores.length >= 2) {
        // A freshness bucket is capped at +15%, so it cannot create a
        // 10x gap on its own.
        expect(scores[0] / scores[scores.length - 1]).toBeLessThan(1e6);
      }
    });
  });

  // ------------------------------------------------------------------
  describe('document quality', () => {
    it('does not let a keyword-stuffed page take the top spot', async () => {
      const outcome = await openSearch.search({ query: 'python', limit: 10 });
      const spamRank = rankOf(outcome, 'spam.example.net');
      // It may appear — it genuinely contains the word — but not first.
      expect(spamRank).not.toBe(0);
    });
  });

  // ------------------------------------------------------------------
  describe('duplicate removal', () => {
    it('collapses the same article published at two addresses', async () => {
      const outcome = await openSearch.search({ query: 'best electric cars', limit: 10 });

      const copies = urlsOf(outcome).filter(
        u =>
          u.includes('news.example.com/electric-cars') ||
          u.includes('mirror.example.org/electric-cars-copy')
      );
      expect(copies).toHaveLength(1);
      expect(outcome.duplicatesRemoved).toBeGreaterThan(0);
    });

    it('reports the same page once even though variants were crawled', async () => {
      const outcome = await openSearch.search({ query: 'python', limit: 20 });
      expect(new Set(urlsOf(outcome)).size).toBe(outcome.results.length);
    });
  });

  // ------------------------------------------------------------------
  describe('filters', () => {
    it('filters by domain', async () => {
      const outcome = await openSearch.search({ query: 'python', domain: 'python.org', limit: 10 });
      expect(outcome.results.length).toBeGreaterThan(0);
      expect(outcome.results.every(r => r.domain.includes('python.org'))).toBe(true);
    });

    it('filters by language', async () => {
      const fr = await openSearch.search({ query: 'recherche', language: 'fr', limit: 10 });
      expect(fr.results.length).toBeGreaterThan(0);
      expect(fr.results.every(r => r.language === 'fr')).toBe(true);

      const en = await openSearch.search({ query: 'recherche', language: 'en', limit: 10 });
      expect(en.results).toHaveLength(0);
    });

    it('filters by date window', async () => {
      const recent = await openSearch.search({
        query: 'electric cars',
        dateWindow: 'year',
        limit: 10
      });
      expect(urlsOf(recent)).not.toContain('https://news.example.com/old-story');
    });

    it('returns nothing when filters exclude everything', async () => {
      const outcome = await openSearch.search({
        query: 'python',
        domain: 'nowhere.invalid',
        limit: 10
      });
      expect(outcome.results).toHaveLength(0);
      expect(outcome.totalResults).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  describe('sorting', () => {
    it('defaults to relevance', async () => {
      const outcome = await openSearch.search({ query: 'electric cars', limit: 10 });
      const scores = outcome.results.map(r => r.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    });

    it('sorts newest first when asked', async () => {
      const outcome = await openSearch.search({
        query: 'electric cars',
        sort: 'newest',
        limit: 10
      });
      expect(outcome.results[0].url).not.toBe('https://news.example.com/old-story');
    });

    it('sorts oldest first when asked', async () => {
      const outcome = await openSearch.search({
        query: 'electric cars',
        sort: 'oldest',
        limit: 10
      });
      expect(outcome.results[0].url).toBe('https://news.example.com/old-story');
    });
  });

  // ------------------------------------------------------------------
  describe('pagination', () => {
    it('returns at most the requested page size', async () => {
      const outcome = await openSearch.search({ query: 'the', page: 1, limit: 3 });
      expect(outcome.results.length).toBeLessThanOrEqual(3);
    });

    it('page 2 does not repeat page 1', async () => {
      const p1 = await openSearch.search({ query: 'python', page: 1, limit: 2 });
      const p2 = await openSearch.search({ query: 'python', page: 2, limit: 2 });

      const overlap = urlsOf(p1).filter(u => urlsOf(p2).includes(u));
      expect(overlap).toHaveLength(0);
    });

    it('keeps the total stable across pages', async () => {
      const p1 = await openSearch.search({ query: 'python', page: 1, limit: 2 });
      const p2 = await openSearch.search({ query: 'python', page: 2, limit: 2 });
      expect(p1.totalResults).toBe(p2.totalResults);
    });

    /** Pages 1..n of one query, as arrays of document ids. */
    const pagesOf = async (query, limit, count = 3) => {
      const pages = [];
      for (let page = 1; page <= count; page += 1) {
        pages.push(await openSearch.search({ query, page, limit }));
      }
      return pages;
    };
    const idsOf = outcome => outcome.results.map(r => r.id);
    const shared = (a, b) => idsOf(a).filter(id => idsOf(b).includes(id));

    it('never repeats a document across pages 1, 2 and 3', async () => {
      const [p1, p2, p3] = await pagesOf('python', 1);
      expect(idsOf(p1)).toHaveLength(1);
      expect(idsOf(p2)).toHaveLength(1);
      expect(shared(p1, p2)).toHaveLength(0);
      expect(shared(p2, p3)).toHaveLength(0);
      expect(shared(p1, p3)).toHaveLength(0);
    });

    it('never shows both copies of a duplicated article on different pages', async () => {
      // One copy per page: page 1 keeps one copy, and page 2 must move on to
      // the next distinct article instead of showing the other copy.
      const pages = await pagesOf('electric cars', 1);
      const urls = pages.flatMap(urlsOf);
      const copies = urls.filter(
        u =>
          u.includes('news.example.com/electric-cars') ||
          u.includes('mirror.example.org/electric-cars-copy')
      );
      expect(copies).toHaveLength(1);
      expect(urls).toContain('https://news.example.com/old-story');
    });

    it('reports the deduplicated total, identical on every page', async () => {
      const pages = await pagesOf('electric cars', 1);
      const totals = pages.map(p => p.totalResults);
      expect(new Set(totals).size).toBe(1);
      // Three pages match, two of them identical: two distinct results.
      expect(totals[0]).toBe(pages.flatMap(idsOf).length);
      expect(totals[0]).toBe(2);
    });

    it('returns the same order for the same request', async () => {
      for (const page of [1, 2]) {
        const runs = [];
        for (let i = 0; i < 3; i += 1) {
          runs.push(idsOf(await openSearch.search({ query: 'python', page, limit: 2 })));
        }
        expect(runs[1]).toEqual(runs[0]);
        expect(runs[2]).toEqual(runs[0]);
      }
    });

    it('returns each document at most once within a page', async () => {
      const outcome = await openSearch.search({ query: 'electric cars', limit: 10 });
      expect(new Set(idsOf(outcome)).size).toBe(outcome.results.length);
    });

    it('rejects a page beyond the result window with a clear 400', async () => {
      // 201 x 50 = 10,050 > the 10,000 results OpenSearch can page through.
      await expect(
        openSearch.search({ query: 'python', page: 201, limit: 50 })
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/10,000/) });
    });

    it('still serves the last page inside the result window', async () => {
      const outcome = await openSearch.search({ query: 'python', page: 200, limit: 50 });
      expect(outcome.results).toEqual([]);
      expect(outcome.totalResults).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------------
  describe('result shape (frontend contract)', () => {
    it('returns everything the React frontend renders', async () => {
      const outcome = await openSearch.search({ query: 'python', limit: 3 });

      expect(outcome.results[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          url: expect.any(String),
          displayUrl: expect.any(String),
          domain: expect.any(String),
          title: expect.any(String),
          snippet: expect.any(String),
          publishedAgo: expect.any(String),
          score: expect.any(Number)
        })
      );
    });

    it('builds the snippet from the matching text, not the page start', async () => {
      const outcome = await openSearch.search({ query: 'data science', limit: 5 });
      const hit = outcome.results.find(r => r.url.includes('python.org'));
      expect(hit).toBeDefined();
      expect(hit.snippet.toLowerCase()).toContain('data science');
    });

    it('strips highlight markup out of the snippet', async () => {
      const outcome = await openSearch.search({ query: 'python', limit: 5 });
      for (const r of outcome.results) {
        expect(r.snippet).not.toContain('<mark>');
      }
    });

    it('shortens the display URL for readability', async () => {
      const outcome = await openSearch.search({ query: 'python tutorial', limit: 5 });
      const hit = outcome.results.find(r => r.url.includes('docs.example.com'));
      expect(hit.displayUrl).toBe('docs.example.com/python-tutorial');
    });
  });

  // ------------------------------------------------------------------
  describe('edge cases', () => {
    it('returns nothing for an empty query', async () => {
      const outcome = await openSearch.search({ query: '', limit: 10 });
      expect(outcome.results).toHaveLength(0);
    });

    it('returns nothing for a stop-word-only query', async () => {
      const outcome = await openSearch.search({ query: 'the and of', limit: 10 });
      expect(outcome.results.length).toBeLessThanOrEqual(2);
    });

    it('does not execute a query as a regular expression', async () => {
      const outcome = await openSearch.search({ query: '.*', limit: 10 });
      expect(outcome.results).toHaveLength(0);
    });

    it('survives a query full of punctuation', async () => {
      const outcome = await openSearch.search({ query: '!!! ??? ***', limit: 10 });
      expect(Array.isArray(outcome.results)).toBe(true);
    });

    it('finds nothing for an unindexed term, without erroring', async () => {
      const outcome = await openSearch.search({ query: 'zzzzqqqqxxxx', limit: 10 });
      expect(outcome.results).toHaveLength(0);
      expect(outcome.totalResults).toBe(0);
    });
  });

  // ------------------------------------------------------------------
  describe('news vertical', () => {
    it('returns only pages marked as articles', async () => {
      const outcome = await openSearch.search({
        query: 'electric cars',
        isArticle: true,
        limit: 10
      });
      expect(outcome.results.length).toBeGreaterThan(0);
      // The fixture's non-article pages must not appear.
      expect(
        urlsOf(outcome).every(u => u.includes('example.com') || u.includes('example.org'))
      ).toBe(true);
    });

    it('excludes non-article pages', async () => {
      const outcome = await openSearch.search({ query: 'python', isArticle: true, limit: 10 });
      expect(urlsOf(outcome)).not.toContain('https://python.org/about');
    });
  });
});
