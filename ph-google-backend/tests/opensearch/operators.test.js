/**
 * Search operators — against a real OpenSearch cluster.
 *
 * The unit suite proves the request has the right shape. This one proves the
 * request does what it says: site: and -word restrict the results, OR widens
 * them, and a document that survives a restriction keeps exactly the score
 * it had without it.
 *
 * Skipped (not passed) when no cluster is reachable, like the relevance
 * suite. Uses its own index so the suites never disturb each other.
 */

const previousEngine = process.env.SEARCH_ENGINE;
const previousIndex = process.env.OPENSEARCH_INDEX;
const INDEX_NAME = 'ph-google-pages-operators-test';
process.env.SEARCH_ENGINE = 'opensearch';
process.env.OPENSEARCH_INDEX = INDEX_NAME;

const request = require('supertest');
const testDb = require('../helpers/testDb');
const SearchLog = require('../../models/SearchLog');
const {
  checkHealth,
  closeClient,
  resetClient,
  getClient
} = require('../../services/opensearch/client');
const { recreateIndex, refreshIndex } = require('../../services/opensearch/indexManager');
const {
  bulkIndexPages,
  resetIndexReadyFlag
} = require('../../services/opensearch/indexingService');
const openSearch = require('../../services/opensearch/searchService');
const { config } = require('../../config/env');

const available = process.env.OPENSEARCH_AVAILABLE === 'true';
const describeLive = available ? describe : describe.skip;

const CRAWLED = new Date('2026-09-01T00:00:00Z');
const page = (id, url, title, content, extra = {}) => ({
  _id: id,
  url,
  domain: new URL(url).hostname,
  title,
  description: extra.description || `${title}.`,
  content,
  language: 'en',
  lastCrawledAt: CRAWLED,
  ...extra
});

/** Fixture corpus, built so each operator has something to include and something to drop. */
const PAGES = [
  // --- physics, on and off wikipedia.org --------------------------------
  page(
    'wiki-physics',
    'https://en.wikipedia.org/wiki/Physics',
    'Physics',
    'Physics is the natural science of matter, energy and motion. Classical physics and quantum physics describe different scales.'
  ),
  page(
    'wiki-quantum',
    'https://en.wikipedia.org/wiki/Quantum_mechanics',
    'Quantum mechanics',
    'Quantum mechanics is a fundamental theory in physics. The field is also called quantum physics by many authors.'
  ),
  page(
    'wiki-history',
    'https://www.wikipedia.org/history',
    'History of Science',
    'The history of science covers astronomy, chemistry and physics over many centuries.'
  ),
  page(
    'uni-physics',
    'https://physics.example.edu/intro',
    'Introduction to Physics',
    'An introduction to physics for first year students. Quantum physics is covered in the second term.'
  ),
  page(
    'blog-physics',
    'https://blog.example.com/quantum-notes',
    'Notes on the Quantum World',
    'Loose notes: the quantum world is strange. Modern physics relies on it.'
  ),

  // --- python, with and without java ------------------------------------
  page(
    'python-org',
    'https://python.org/about',
    'Python',
    'Python is a high level programming language. Python is widely used for data science, scripting and web development.'
  ),
  page(
    'python-docs',
    'https://docs.example.com/docs/python-tutorial',
    'Python Tutorial for Beginners',
    'This python tutorial covers variables, loops and functions. A good tutorial for beginners.'
  ),
  page(
    'python-vs-java',
    'https://compare.example.com/python-vs-java',
    'Python vs Java',
    'Python and java compared. Java programming is more verbose, python is more concise.'
  ),
  page(
    'python-jvm',
    'https://lang.example.com/languages',
    'Scripting Languages Overview',
    'Python is a scripting language. Unlike java, python needs no compile step.'
  ),
  page(
    'snake',
    'https://wildlife.example.org/snakes',
    'Snakes of the World',
    'The reticulated python is a large snake. Snakes are reptiles found on every continent.'
  ),
  page(
    'js-tutorial',
    'https://web.example.com/javascript-tutorial',
    'JavaScript Tutorial',
    'A javascript tutorial for the browser. This tutorial covers events and the DOM.'
  ),

  // --- cats and dogs ------------------------------------------------------
  page(
    'cats',
    'https://pets.example.com/cats',
    'Cats',
    'Cats are small carnivorous mammals kept as pets. Cats sleep for most of the day.'
  ),
  page(
    'dogs',
    'https://pets.example.com/dogs',
    'Dogs',
    'Dogs are loyal companions. Dogs need a walk every day.'
  ),
  page(
    'cats-dogs',
    'https://pets.example.com/living-together',
    'Cats and Dogs Together',
    'Cats and dogs can live together when they are introduced slowly.'
  ),

  // --- machine learning / deep learning -----------------------------------
  page(
    'ml',
    'https://ml.example.com/machine-learning',
    'Machine Learning Explained',
    'Machine learning is a field of artificial intelligence. Machine learning models learn patterns from data.'
  ),
  page(
    'dl',
    'https://ml.example.com/deep-learning',
    'Deep Learning Basics',
    'Deep learning uses neural networks with many layers. Deep learning needs a lot of data.'
  ),
  page(
    'glossary',
    'https://misc.example.com/glossary',
    'Technology Glossary',
    'A machine is a device that does work. Separately, learning is the process of acquiring knowledge.'
  ),
  page(
    'python-ml',
    'https://ml.example.com/python-machine-learning',
    'Python Machine Learning Guide',
    'A guide to machine learning with python. Python machine learning libraries are mature.'
  ),
  page(
    'python-machines',
    'https://ml.example.com/automation',
    'Automating a Workshop',
    'Controlling a machine with python scripts. Each machine reports its status to the python service.'
  ),

  // --- a stop word in a title, and the word "site" in a body -----------------
  page(
    'matrix-film',
    'https://films.example.org/matrix-1999',
    'The Matrix',
    'The Matrix is a 1999 film about a simulated reality. This site reviews the matrix trilogy.'
  ),
  page(
    'matrix-math',
    'https://math.example.org/linear-algebra',
    'Linear Algebra Notes',
    'A matrix is a rectangular array of numbers. Matrix multiplication is not commutative.'
  ),

  // --- symbol terms ---------------------------------------------------------
  page(
    'lang-c',
    'https://langs.example.com/c',
    'C',
    'C is a general purpose language created for systems work in the 1970s.'
  ),
  page(
    'lang-cpp',
    'https://langs.example.com/cpp',
    'C++',
    'C++ adds classes and templates to C. Game engines are often written in C++.'
  ),
  page(
    'lang-csharp',
    'https://langs.example.com/csharp',
    'C#',
    'C# is a managed language from Microsoft. C# runs on the common language runtime.'
  )
];

const idsOf = outcome => outcome.results.map(r => r.id);
const urlsOf = outcome => outcome.results.map(r => r.url);
const scoresOf = outcome => new Map(outcome.results.map(r => [r.id, r.score]));
const search = (query, extra = {}) => openSearch.search({ query, limit: 50, ...extra });

/**
 * Every result of `narrowed` must carry the score it has in `full` — the
 * restriction decided who qualifies and nothing else.
 *
 * @returns {number} how many results were compared
 */
function expectSameScores(narrowed, full) {
  const reference = scoresOf(full);
  expect(narrowed.results.length).toBeGreaterThan(0);
  for (const result of narrowed.results) {
    expect(reference.has(result.id)).toBe(true);
    expect(result.score).toBe(reference.get(result.id));
  }
  // …and they stay in the same relative order.
  const kept = new Set(idsOf(narrowed));
  expect(idsOf(narrowed)).toEqual(idsOf(full).filter(id => kept.has(id)));
  return narrowed.results.length;
}

describeLive('search operators', () => {
  let app;

  beforeAll(async () => {
    if (config.searchEngine !== 'opensearch') {
      throw new Error('This suite must run with SEARCH_ENGINE=opensearch');
    }
    resetClient();
    const health = await checkHealth(true);
    if (!health.ok) {
      throw new Error(`OpenSearch became unreachable at ${health.node}: ${health.error || ''}`);
    }

    resetIndexReadyFlag();
    await recreateIndex();
    await bulkIndexPages(PAGES);
    await refreshIndex();

    await testDb.connect();
    app = require('../../app').createApp();
  }, 120000);

  afterAll(async () => {
    await testDb.disconnect();
    try {
      await getClient().indices.delete({ index: INDEX_NAME });
    } catch {
      /* already gone */
    }
    await closeClient();
    process.env.SEARCH_ENGINE = previousEngine;
    process.env.OPENSEARCH_INDEX = previousIndex;
  });

  // ------------------------------------------------------------------
  describe('site:', () => {
    it('restricts results to the site and its subdomains', async () => {
      const outcome = await search('site:wikipedia.org physics');
      expect(outcome.results.length).toBe(3);
      expect(outcome.results.every(r => r.domain.endsWith('wikipedia.org'))).toBe(true);
      expect(outcome.totalResults).toBe(3);
    });

    it('is strict: a narrower site drops the rest', async () => {
      const outcome = await search('site:en.wikipedia.org physics');
      expect(urlsOf(outcome).sort()).toEqual([
        'https://en.wikipedia.org/wiki/Physics',
        'https://en.wikipedia.org/wiki/Quantum_mechanics'
      ]);
    });

    it('returns what the domain parameter returns', async () => {
      const operator = await search('site:wikipedia.org physics');
      const parameter = await search('physics', { domain: 'wikipedia.org' });
      expect(operator.results).toEqual(parameter.results);
      expect(operator.totalResults).toBe(parameter.totalResults);
    });

    it('does not search for the words "site" or the domain', async () => {
      // No page mentions "site", so a literal reading would find nothing.
      const outcome = await search('site:physics.example.edu physics');
      expect(urlsOf(outcome)).toEqual(['https://physics.example.edu/intro']);
    });

    it('leaves the scores of the remaining results untouched', async () => {
      const compared = expectSameScores(
        await search('site:wikipedia.org physics'),
        await search('physics')
      );
      expect(compared).toBe(3);
    });

    it('works with a quoted phrase', async () => {
      const outcome = await search('site:en.wikipedia.org "quantum physics"');
      expect(urlsOf(outcome).sort()).toEqual([
        'https://en.wikipedia.org/wiki/Physics',
        'https://en.wikipedia.org/wiki/Quantum_mechanics'
      ]);
      expectSameScores(outcome, await search('"quantum physics"'));
    });

    it('accepts a full URL', async () => {
      const outcome = await search('site:https://en.wikipedia.org/wiki/Physics physics');
      expect(outcome.results.every(r => r.domain === 'en.wikipedia.org')).toBe(true);
      expect(outcome.results.length).toBe(2);
    });

    it('lists the whole site when nothing else is asked for', async () => {
      const outcome = await search('site:pets.example.com');
      expect(outcome.totalResults).toBe(3);
      expect(outcome.results.every(r => r.domain === 'pets.example.com')).toBe(true);
    });

    it('narrows the domain parameter rather than overriding it', async () => {
      const both = await search('site:en.wikipedia.org physics', { domain: 'wikipedia.org' });
      expect(both.results.every(r => r.domain === 'en.wikipedia.org')).toBe(true);
      expect(both.results.length).toBe(2);

      const disjoint = await search('site:en.wikipedia.org physics', { domain: 'example.com' });
      expect(disjoint.results).toHaveLength(0);
      expect(disjoint.totalResults).toBe(0);
    });

    it('excludes a site with -site:', async () => {
      const full = await search('physics');
      const outcome = await search('physics -site:wikipedia.org');
      expect(outcome.results.length).toBe(full.results.length - 3);
      expect(outcome.results.some(r => r.domain.endsWith('wikipedia.org'))).toBe(false);
      expectSameScores(outcome, full);
    });
  });

  // ------------------------------------------------------------------
  describe('negative terms', () => {
    it('removes every page holding the excluded word', async () => {
      const full = await search('python');
      const outcome = await search('python -java');
      expect(urlsOf(full)).toEqual(
        expect.arrayContaining([
          'https://compare.example.com/python-vs-java',
          'https://lang.example.com/languages'
        ])
      );
      expect(urlsOf(outcome)).not.toContain('https://compare.example.com/python-vs-java');
      expect(urlsOf(outcome)).not.toContain('https://lang.example.com/languages');
      expect(outcome.totalResults).toBe(full.totalResults - 2);
    });

    it('never turns the excluded word into a required one', async () => {
      const outcome = await search('python -java');
      // python.org never mentions java; it is still there, and still first.
      expect(urlsOf(outcome)[0]).toBe('https://python.org/about');
    });

    it('leaves the scores of the remaining results untouched', async () => {
      const compared = expectSameScores(await search('python -java'), await search('python'));
      expect(compared).toBe(5);
    });

    it('excludes a phrase only where the phrase occurs', async () => {
      const outcome = await search('python -"java programming"');
      expect(urlsOf(outcome)).not.toContain('https://compare.example.com/python-vs-java');
      // Mentions java, but never "java programming".
      expect(urlsOf(outcome)).toContain('https://lang.example.com/languages');
      expectSameScores(outcome, await search('python'));
    });

    it('applies several exclusions together', async () => {
      const outcome = await search('python -java -snake -"machine learning"');
      expect(urlsOf(outcome).sort()).toEqual([
        'https://docs.example.com/docs/python-tutorial',
        'https://ml.example.com/automation',
        'https://python.org/about'
      ]);
      expectSameScores(outcome, await search('python'));
    });

    it('returns nothing for a query that is only an exclusion', async () => {
      const outcome = await search('-java');
      expect(outcome.results).toHaveLength(0);
      expect(outcome.totalResults).toBe(0);
    });

    it('still lets a typo find its match', async () => {
      const outcome = await search('pyhton -java');
      expect(urlsOf(outcome)).toContain('https://python.org/about');
      expect(urlsOf(outcome)).not.toContain('https://compare.example.com/python-vs-java');
    });
  });

  // ------------------------------------------------------------------
  describe('OR', () => {
    it('returns pages matching either word', async () => {
      const outcome = await search('cats OR dogs');
      expect(urlsOf(outcome).sort()).toEqual([
        'https://pets.example.com/cats',
        'https://pets.example.com/dogs',
        'https://pets.example.com/living-together'
      ]);
    });

    it('widens what the same words return without it', async () => {
      const implicit = await search('cats dogs');
      const either = await search('cats OR dogs');
      expect(urlsOf(implicit)).toEqual(['https://pets.example.com/living-together']);
      expect(either.totalResults).toBeGreaterThan(implicit.totalResults);
    });

    it('ranks a page matching both sides first', async () => {
      const outcome = await search('cats OR dogs');
      expect(urlsOf(outcome)[0]).toBe('https://pets.example.com/living-together');
    });

    it('does not search for the word OR', async () => {
      // "or" is in no title here; a literal reading would change nothing but
      // an AND reading would return only the page holding both words.
      expect((await search('cats OR dogs')).totalResults).toBe(3);
    });

    it('matches either phrase, and only as a phrase', async () => {
      const outcome = await search('"machine learning" OR "deep learning"');
      expect(urlsOf(outcome).sort()).toEqual([
        'https://ml.example.com/deep-learning',
        'https://ml.example.com/machine-learning',
        'https://ml.example.com/python-machine-learning'
      ]);
      // "machine … learning" far apart is not the phrase.
      expect(urlsOf(outcome)).not.toContain('https://misc.example.com/glossary');
    });

    it('keeps the word outside the group required', async () => {
      const outcome = await search('python OR javascript tutorial');
      expect(urlsOf(outcome).sort()).toEqual([
        'https://docs.example.com/docs/python-tutorial',
        'https://web.example.com/javascript-tutorial'
      ]);
    });

    it('treats a lower-case "or" as an ordinary word', async () => {
      const lower = await search('cats or dogs');
      expect(urlsOf(lower)).not.toContain('https://pets.example.com/dogs');
    });
  });

  // ------------------------------------------------------------------
  describe('AND', () => {
    it('requires every word', async () => {
      const implicit = await search('python machine learning');
      const explicit = await search('python AND machine learning');
      // Without the operator a page can qualify without "python"…
      expect(urlsOf(implicit)).toContain('https://ml.example.com/machine-learning');
      // …and not with it.
      expect(urlsOf(explicit)).toEqual(['https://ml.example.com/python-machine-learning']);
    });

    it('leaves the scores of the remaining results untouched', async () => {
      const compared = expectSameScores(
        await search('python AND machine learning'),
        await search('python machine learning')
      );
      expect(compared).toBe(1);
    });

    it('changes nothing for two words, which are both required already', async () => {
      const implicit = await search('cats dogs');
      const explicit = await search('cats AND dogs');
      expect(explicit.results).toEqual(implicit.results);
    });
  });

  // ------------------------------------------------------------------
  describe('intitle:', () => {
    it('returns only pages with the word in the title', async () => {
      const outcome = await search('intitle:python');
      expect(urlsOf(outcome).sort()).toEqual([
        'https://compare.example.com/python-vs-java',
        'https://docs.example.com/docs/python-tutorial',
        'https://ml.example.com/python-machine-learning',
        'https://python.org/about'
      ]);
      // In the body only.
      expect(urlsOf(outcome)).not.toContain('https://wildlife.example.org/snakes');
    });

    it('returns only pages with the phrase in the title', async () => {
      const outcome = await search('intitle:"machine learning"');
      expect(urlsOf(outcome).sort()).toEqual([
        'https://ml.example.com/machine-learning',
        'https://ml.example.com/python-machine-learning'
      ]);
    });

    it('searches the other words normally', async () => {
      const outcome = await search('intitle:python tutorial');
      expect(urlsOf(outcome)).toEqual(['https://docs.example.com/docs/python-tutorial']);
    });

    it('excludes with -intitle:', async () => {
      const full = await search('python');
      const outcome = await search('python -intitle:java');
      expect(urlsOf(outcome)).not.toContain('https://compare.example.com/python-vs-java');
      // Java in the body, not the title: stays.
      expect(urlsOf(outcome)).toContain('https://lang.example.com/languages');
      expectSameScores(outcome, full);
    });
  });

  // ------------------------------------------------------------------
  describe('inurl:', () => {
    it('returns only pages with the word in the URL', async () => {
      const outcome = await search('inurl:docs python');
      expect(urlsOf(outcome)).toEqual(['https://docs.example.com/docs/python-tutorial']);
    });

    it('matches the path as well as the host', async () => {
      const outcome = await search('inurl:wiki physics');
      expect(urlsOf(outcome).sort()).toEqual([
        'https://en.wikipedia.org/wiki/Physics',
        'https://en.wikipedia.org/wiki/Quantum_mechanics'
      ]);
    });

    it('works with no other words', async () => {
      const outcome = await search('inurl:tutorial');
      expect(urlsOf(outcome).sort()).toEqual([
        'https://docs.example.com/docs/python-tutorial',
        'https://web.example.com/javascript-tutorial'
      ]);
    });

    it('excludes with -inurl:', async () => {
      const outcome = await search('python -inurl:docs');
      expect(urlsOf(outcome)).not.toContain('https://docs.example.com/docs/python-tutorial');
      expectSameScores(outcome, await search('python'));
    });
  });

  // ------------------------------------------------------------------
  describe('symbol terms', () => {
    it.each([
      ['c++', 'https://langs.example.com/cpp'],
      ['c#', 'https://langs.example.com/csharp'],
      ['c', 'https://langs.example.com/c']
    ])('"%s" puts the page with that exact title first', async (query, url) => {
      const outcome = await search(query);
      expect(urlsOf(outcome)[0]).toBe(url);
    });
  });

  // ------------------------------------------------------------------
  describe('combinations', () => {
    it('site + negative term', async () => {
      const outcome = await search('site:wikipedia.org physics -quantum');
      expect(urlsOf(outcome)).toEqual(['https://www.wikipedia.org/history']);
      expectSameScores(outcome, await search('physics'));
    });

    it('site + OR', async () => {
      const outcome = await search('site:ml.example.com "machine learning" OR "deep learning"');
      expect(outcome.results.every(r => r.domain === 'ml.example.com')).toBe(true);
      expect(outcome.totalResults).toBe(3);
    });

    it('intitle + site', async () => {
      const outcome = await search('intitle:python site:ml.example.com');
      expect(urlsOf(outcome)).toEqual(['https://ml.example.com/python-machine-learning']);
    });

    it('inurl + site', async () => {
      const outcome = await search('inurl:learning site:ml.example.com python');
      expect(urlsOf(outcome)).toEqual(['https://ml.example.com/python-machine-learning']);
    });

    it('phrase + negative phrase', async () => {
      const outcome = await search('"machine learning" -"python machine learning"');
      expect(urlsOf(outcome)).toEqual(['https://ml.example.com/machine-learning']);
      expectSameScores(outcome, await search('"machine learning"'));
    });

    it('several operators together', async () => {
      const outcome = await search(
        'site:example.com -site:compare.example.com intitle:python tutorial OR guide -java'
      );
      expect(urlsOf(outcome).sort()).toEqual([
        'https://docs.example.com/docs/python-tutorial',
        'https://ml.example.com/python-machine-learning'
      ]);
    });
  });

  // ------------------------------------------------------------------
  describe('regressions from the semantic review', () => {
    it.each(['matrix -site:', 'matrix -site:localhost', 'matrix -intitle:', 'matrix -inurl:'])(
      '"%s" returns what "matrix" returns',
      async query => {
        const plain = await search('matrix');
        // One of the two pages has the word "site" in its body.
        expect(plain.results).toHaveLength(2);
        expect((await search(query)).results).toEqual(plain.results);
      }
    );

    it('a question with AND finds its topic instead of looking for "what"', async () => {
      const outcome = await search('what is python AND programming');
      expect(urlsOf(outcome).sort()).toEqual([
        'https://compare.example.com/python-vs-java',
        'https://python.org/about'
      ]);
      const compared = expectSameScores(outcome, await search('what is python programming'));
      expect(compared).toBe(2);
    });

    it('a longer question with AND requires every topic word', async () => {
      const outcome = await search('what is python AND programming language');
      expect(urlsOf(outcome)).toEqual(['https://python.org/about']);
    });

    it('a word repeated outside its OR group is still required', async () => {
      expect(urlsOf(await search('cats OR dogs cats')).sort()).toEqual([
        'https://pets.example.com/cats',
        'https://pets.example.com/living-together'
      ]);
      expect(urlsOf(await search('cats OR dogs dogs')).sort()).toEqual([
        'https://pets.example.com/dogs',
        'https://pets.example.com/living-together'
      ]);
    });

    it('a word outside an OR group of a phrase and a word is still required', async () => {
      const outcome = await search('"machine learning" OR python machine');
      expect(urlsOf(outcome).sort()).toEqual([
        'https://ml.example.com/automation',
        'https://ml.example.com/machine-learning',
        'https://ml.example.com/python-machine-learning'
      ]);
    });

    it('a stop word after intitle: does not empty the results', async () => {
      const outcome = await search('intitle:the matrix');
      expect(outcome.results).toEqual((await search('matrix')).results);
      expect(outcome.results).toHaveLength(2);
    });

    it('intitle: with only a stop word has nothing to search for', async () => {
      const outcome = await search('intitle:the');
      expect(outcome.results).toHaveLength(0);
      expect(outcome.totalResults).toBe(0);
    });

    it('a title phrase holding a stop word still works', async () => {
      const outcome = await search('intitle:"the matrix"');
      expect(urlsOf(outcome)).toEqual(['https://films.example.org/matrix-1999']);
    });

    it('intitle: with an ordinary word is unchanged', async () => {
      expect(urlsOf(await search('intitle:matrix'))).toEqual([
        'https://films.example.org/matrix-1999'
      ]);
    });

    it.each(['cats OR dogs OR', 'OR cats OR dogs', 'cats OR dogs AND', 'cats OR dogs the'])(
      '"%s" returns what "cats OR dogs" returns',
      async query => {
        const plain = await search('cats OR dogs');
        expect(plain.results).toHaveLength(3);
        const outcome = await search(query);
        expect(outcome.results).toEqual(plain.results);
        expect(outcome.totalResults).toBe(plain.totalResults);
      }
    );

    it('a stop word beside a quoted phrase does not empty the results', async () => {
      const plain = await search('"machine learning"');
      expect(plain.results.length).toBeGreaterThan(0);
      for (const query of ['"machine learning" the', 'the "machine learning"']) {
        const outcome = await search(query);
        expect(outcome.results).toEqual(plain.results);
        expect(outcome.totalResults).toBe(plain.totalResults);
      }
    });

    it('a real word beside an OR group is still required', async () => {
      const outcome = await search('python OR javascript the tutorial');
      expect(urlsOf(outcome).sort()).toEqual([
        'https://docs.example.com/docs/python-tutorial',
        'https://web.example.com/javascript-tutorial'
      ]);
    });

    it.each([
      ['intitle:python the', 'intitle:python', 4],
      ['inurl:tutorial the', 'inurl:tutorial', 2],
      ['site:pets.example.com the', 'site:pets.example.com', 3],
      ['site:wikipedia.org -quantum the', 'site:wikipedia.org -quantum', 1]
    ])('"%s" returns what "%s" returns', async (query, equivalent, count) => {
      const plain = await search(equivalent);
      expect(plain.results).toHaveLength(count);
      const outcome = await search(query);
      expect(outcome.results).toEqual(plain.results);
      expect(outcome.totalResults).toBe(plain.totalResults);
    });

    it('a real word beside an operator and a stop word is still searched', async () => {
      expect(urlsOf(await search('intitle:python the tutorial'))).toEqual([
        'https://docs.example.com/docs/python-tutorial'
      ]);
      expect(urlsOf(await search('inurl:docs the python'))).toEqual([
        'https://docs.example.com/docs/python-tutorial'
      ]);
      expect(urlsOf(await search('site:wikipedia.org the history'))).toEqual([
        'https://www.wikipedia.org/history'
      ]);
    });

    it('a query of stop words with nothing else to match still returns nothing', async () => {
      for (const query of ['the', 'the -java', 'the -site:example.com']) {
        const outcome = await search(query);
        expect(outcome.results).toHaveLength(0);
        expect(outcome.totalResults).toBe(0);
      }
    });

    it('AND stays strict: it does not accept a typo', async () => {
      expect((await search('pyhton programing')).results.length).toBeGreaterThan(0);
      expect((await search('pyhton AND programing')).results).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------
  describe('pagination with operators', () => {
    it('keeps pages disjoint and the total stable', async () => {
      const query = 'python -java';
      const all = await search(query);
      const one = await openSearch.search({ query, page: 1, limit: 2 });
      const two = await openSearch.search({ query, page: 2, limit: 2 });

      expect(one.totalResults).toBe(all.totalResults);
      expect(two.totalResults).toBe(all.totalResults);
      expect([...idsOf(one), ...idsOf(two)]).toEqual(idsOf(all).slice(0, 4));
      expect(new Set([...idsOf(one), ...idsOf(two)]).size).toBe(4);
    });

    it('gives a result the same score on its page as in the full list', async () => {
      const all = scoresOf(await search('site:example.com python -java'));
      const two = await openSearch.search({
        query: 'site:example.com python -java',
        page: 2,
        limit: 1
      });
      expect(two.results).toHaveLength(1);
      expect(two.results[0].score).toBe(all.get(two.results[0].id));
    });
  });

  // ------------------------------------------------------------------
  describe('GET /api/search', () => {
    beforeEach(async () => {
      await testDb.clear();
    });

    const get = params => request(app).get('/api/search').query(params);

    it('applies site: from the query string', async () => {
      const res = await get({ q: 'site:wikipedia.org physics' });
      expect(res.status).toBe(200);
      expect(res.body.data.total).toBe(3);
      expect(res.body.data.results.every(r => r.domain.endsWith('wikipedia.org'))).toBe(true);
      expect(res.body.data.query).toBe('site:wikipedia.org physics');
    });

    it('applies a negative term', async () => {
      const res = await get({ q: 'python -java' });
      expect(res.status).toBe(200);
      const urls = res.body.data.results.map(r => r.url);
      expect(urls).toContain('https://python.org/about');
      expect(urls).not.toContain('https://compare.example.com/python-vs-java');
    });

    it('combines the domain parameter with site:', async () => {
      const res = await get({ q: 'site:en.wikipedia.org physics', domain: 'wikipedia.org' });
      expect(res.body.data.total).toBe(2);
      expect(res.body.data.filters.domain).toBe('wikipedia.org');
    });

    it('paginates an operator query', async () => {
      const res = await get({ q: 'cats OR dogs', limit: 2, page: 2 });
      expect(res.status).toBe(200);
      expect(res.body.data.results).toHaveLength(1);
      expect(res.body.data.pagination).toMatchObject({
        page: 2,
        totalResults: 3,
        totalPages: 2,
        hasNextPage: false
      });
    });

    it('answers an exclusion-only query with an empty result, not an error', async () => {
      const res = await get({ q: '-java' });
      expect(res.status).toBe(200);
      expect(res.body.data.results).toEqual([]);
      expect(res.body.data.total).toBe(0);
    });

    it('logs the query as it was typed', async () => {
      await get({ q: 'site:wikipedia.org physics -quantum' });
      const logs = await SearchLog.find().lean();
      expect(logs).toHaveLength(1);
      expect(logs[0].query).toBe('site:wikipedia.org physics -quantum');
      expect(logs[0].resultCount).toBe(1);
    });

    it.each([
      'site:',
      '-',
      'OR',
      'AND OR AND',
      'intitle:""',
      '-site:',
      'python -site:',
      'intitle:the',
      'what is python AND programming',
      'cats OR dogs cats',
      'cats OR dogs OR',
      'OR cats OR dogs',
      'cats OR dogs AND',
      'cats OR dogs the',
      '"machine learning" the',
      'intitle:python the',
      'inurl:docs the',
      'site:wikipedia.org the',
      'the -java',
      'site:not_a_domain x',
      '"unbalanced -"quote',
      'a OR -b AND "c',
      ':::'
    ])('never fails on "%s"', async q => {
      const res = await get({ q });
      expect(res.status).toBe(200);
    });
  });
});
