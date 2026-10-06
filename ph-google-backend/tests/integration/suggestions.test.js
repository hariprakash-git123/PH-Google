const request = require('supertest');
const mongoose = require('mongoose');
const testDb = require('../helpers/testDb');
const SearchLog = require('../../models/SearchLog');
const Suggestion = require('../../models/Suggestion');
const Term = require('../../models/Term');

/**
 * GET /api/suggestions — ordering, zero-result filtering and limits.
 *
 * The three sources are MongoDB collections, so this suite needs no search
 * cluster and behaves the same whichever engine answers /api/search.
 */

let app;

beforeAll(async () => {
  await testDb.connect();
  app = require('../../app').createApp();
});
afterAll(async () => {
  await testDb.disconnect();
});
beforeEach(async () => {
  await testDb.clear();
});

const suggest = params => request(app).get('/api/suggestions').query(params);
const textsOf = res => res.body.data.map(s => s.text);

/** A term found in `documents` pages. */
const seedTerm = (word, documents) =>
  Term.create({
    word,
    documents: Array.from({ length: documents }, () => ({
      pageId: new mongoose.Types.ObjectId(),
      frequency: 1
    }))
  });

/** `times` past searches for a query, each of which found `resultCount` results. */
const seedSearches = (query, times, resultCount = 5) =>
  SearchLog.create(
    Array.from({ length: times }, () => ({ query, normalizedQuery: query, resultCount }))
  );

describe('GET /api/suggestions — indexed terms', () => {
  it('orders by how many documents hold the word, before applying the limit', async () => {
    // Thirty matching words, the most common ones inserted last: taking the
    // first rows the database returns would miss every one of them.
    for (let i = 1; i <= 30; i += 1) {
      await seedTerm(`pyword${String(i).padStart(2, '0')}`, i);
    }

    const res = await suggest({ q: 'py', limit: 5 });
    expect(res.status).toBe(200);
    expect(textsOf(res)).toEqual(['pyword30', 'pyword29', 'pyword28', 'pyword27', 'pyword26']);
  });

  it('breaks ties alphabetically, so the order is stable', async () => {
    await seedTerm('pear', 2);
    await seedTerm('peach', 2);
    await seedTerm('pea', 2);
    expect(textsOf(await suggest({ q: 'pe' }))).toEqual(['pea', 'peach', 'pear']);
  });

  it('leaves out a word no document holds', async () => {
    await seedTerm('python', 3);
    await seedTerm('pythonic', 0);
    expect(textsOf(await suggest({ q: 'pyth' }))).toEqual(['python']);
  });

  it('matches the start of the word only', async () => {
    await seedTerm('python', 3);
    await seedTerm('monty', 3);
    expect(textsOf(await suggest({ q: 'thon' }))).toEqual([]);
    expect(textsOf(await suggest({ q: 'ty' }))).toEqual([]);
    expect(textsOf(await suggest({ q: 'mon' }))).toEqual(['monty']);
  });

  it('works from a single character', async () => {
    await seedTerm('python', 3);
    await seedTerm('pear', 1);
    await seedTerm('apple', 9);
    expect(textsOf(await suggest({ q: 'p' }))).toEqual(['python', 'pear']);
  });

  it('is case-insensitive', async () => {
    await seedTerm('python', 3);
    expect(textsOf(await suggest({ q: 'PYTH' }))).toEqual(['python']);
  });

  it('labels the suggestion', async () => {
    await seedTerm('python', 3);
    const res = await suggest({ q: 'pyth' });
    expect(res.body.data).toEqual([{ text: 'python', category: 'indexed term', trending: false }]);
  });
});

describe('GET /api/suggestions — past searches', () => {
  it('orders by how often the query was searched, before applying the limit', async () => {
    await seedSearches('python basics', 1);
    await seedSearches('python tutorial', 4);
    await seedSearches('python jobs', 2);
    await seedSearches('python snake', 3);

    expect(textsOf(await suggest({ q: 'python', limit: 3 }))).toEqual([
      'python tutorial',
      'python snake',
      'python jobs'
    ]);
  });

  it('breaks ties alphabetically', async () => {
    await seedSearches('python c', 2);
    await seedSearches('python a', 2);
    await seedSearches('python b', 2);
    expect(textsOf(await suggest({ q: 'python' }))).toEqual(['python a', 'python b', 'python c']);
  });

  it('leaves out a query that never found anything', async () => {
    await seedSearches('python zzzz', 6, 0);
    await seedSearches('python tutorial', 1, 12);

    const res = await suggest({ q: 'python' });
    expect(textsOf(res)).toEqual(['python tutorial']);
  });

  it('keeps a query that found something at least once, counting only those searches', async () => {
    // Searched five times with a filter that excluded everything, once without.
    await seedSearches('python news', 5, 0);
    await seedSearches('python news', 1, 7);
    await seedSearches('python tutorial', 2, 3);

    const res = await suggest({ q: 'python' });
    expect(textsOf(res)).toEqual(['python tutorial', 'python news']);
    expect(res.body.data[1]).toEqual({
      text: 'python news',
      category: 'recent search',
      trending: false
    });
    expect(res.body.data[0].trending).toBe(true);
  });

  it('returns nothing when every matching query found nothing', async () => {
    await seedSearches('zzzz one', 3, 0);
    await seedSearches('zzzz two', 1, 0);
    expect(textsOf(await suggest({ q: 'zzzz' }))).toEqual([]);
  });

  it('matches the start of the query only', async () => {
    await seedSearches('learn python', 3);
    expect(textsOf(await suggest({ q: 'python' }))).toEqual([]);
    expect(textsOf(await suggest({ q: 'learn' }))).toEqual(['learn python']);
  });
});

describe('GET /api/suggestions — sources together', () => {
  it('puts past searches first, then terms, then the legacy collection', async () => {
    await seedSearches('python tutorial', 2);
    await seedTerm('pythonic', 4);
    await Suggestion.create({ text: 'Python packaging', category: 'guide', trending: false });

    const res = await suggest({ q: 'python' });
    expect(res.body.data).toEqual([
      { text: 'python tutorial', category: 'recent search', trending: true },
      { text: 'pythonic', category: 'indexed term', trending: false },
      { text: 'Python packaging', category: 'guide', trending: false }
    ]);
  });

  it('lists a suggestion once when two sources hold it', async () => {
    await seedSearches('python', 2);
    await seedTerm('python', 9);
    await Suggestion.create({ text: 'Python', category: 'guide', trending: true });

    const res = await suggest({ q: 'pyth' });
    expect(res.body.data).toEqual([{ text: 'python', category: 'recent search', trending: true }]);
  });

  it('fills the limit from the next source, best matches first', async () => {
    await seedSearches('python tutorial', 3);
    await seedSearches('python jobs', 1);
    for (let i = 1; i <= 10; i += 1) await seedTerm(`pythonword${i}`, i);

    expect(textsOf(await suggest({ q: 'python', limit: 5 }))).toEqual([
      'python tutorial',
      'python jobs',
      'pythonword10',
      'pythonword9',
      'pythonword8'
    ]);
  });

  it('orders the legacy collection: trending first, then by text', async () => {
    await Suggestion.create([
      { text: 'solar panels', category: 'search', trending: false },
      { text: 'solar eclipse', category: 'search', trending: true },
      { text: 'solar cells', category: 'search', trending: false }
    ]);
    expect(textsOf(await suggest({ q: 'solar' }))).toEqual([
      'solar eclipse',
      'solar cells',
      'solar panels'
    ]);
  });

  it('works when only one source has anything', async () => {
    await seedTerm('python', 2);
    expect(textsOf(await suggest({ q: 'pyth' }))).toEqual(['python']);

    await testDb.clear();
    await seedSearches('python tutorial', 1);
    expect(textsOf(await suggest({ q: 'pyth' }))).toEqual(['python tutorial']);

    await testDb.clear();
    await Suggestion.create({ text: 'python', category: 'search', trending: false });
    expect(textsOf(await suggest({ q: 'pyth' }))).toEqual(['python']);
  });

  it('returns an empty list when every source is empty', async () => {
    const res = await suggest({ q: 'python' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('GET /api/suggestions — limits and input', () => {
  beforeEach(async () => {
    for (let i = 1; i <= 30; i += 1) await seedTerm(`term${String(i).padStart(2, '0')}`, i);
  });

  it('returns eight by default', async () => {
    const res = await suggest({ q: 'term' });
    expect(res.body.data).toHaveLength(8);
    expect(textsOf(res)[0]).toBe('term30');
  });

  it('honours an explicit limit up to the maximum of twenty', async () => {
    expect((await suggest({ q: 'term', limit: 1 })).body.data).toHaveLength(1);
    expect((await suggest({ q: 'term', limit: 20 })).body.data).toHaveLength(20);
  });

  it.each([
    ['limit=21', { limit: 21 }, /maximum is 20/],
    ['limit=0', { limit: 0 }, /limit/i],
    ['limit=-1', { limit: -1 }, /limit/i],
    ['limit=abc', { limit: 'abc' }, /limit/i],
    ['limit=2.5', { limit: 2.5 }, /limit/i]
  ])('rejects %s with 400', async (_label, extra, message) => {
    const res = await suggest({ q: 'term', ...extra });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(message);
  });

  it('returns an empty list for an empty or blank query', async () => {
    for (const q of ['', '   ', undefined]) {
      const res = await suggest(q === undefined ? {} : { q });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    }
  });

  it('reads only the first hundred characters of the prefix', async () => {
    const stored = 'a'.repeat(120);
    await seedSearches(stored, 1);

    // 150 characters: longer than anything stored, so only a truncated
    // prefix can match.
    const long = await suggest({ q: 'a'.repeat(150) });
    expect(long.status).toBe(200);
    expect(textsOf(long)).toEqual([stored]);

    // What follows the hundredth character is not part of the prefix.
    const tail = await suggest({ q: 'a'.repeat(100) + 'b'.repeat(50) });
    expect(textsOf(tail)).toEqual([stored]);

    // The ninety-ninth is.
    const mismatch = await suggest({ q: 'a'.repeat(98) + 'b' });
    expect(textsOf(mismatch)).toEqual([]);
  });

  it('treats regular-expression characters as text', async () => {
    await seedSearches('a.b test', 1);
    await seedSearches('axb test', 1);
    await seedSearches('c++ tutorial', 1);
    await seedSearches('what is (x)', 1);

    expect(textsOf(await suggest({ q: 'a.' }))).toEqual(['a.b test']);
    expect(textsOf(await suggest({ q: 'c++' }))).toEqual(['c++ tutorial']);
    expect(textsOf(await suggest({ q: 'what is (' }))).toEqual(['what is (x)']);
    expect(textsOf(await suggest({ q: '.*' }))).toEqual([]);
  });

  it.each(['(', '[a-z', '\\', '*', '+', '?', '^term', 'term$', '{1,2}', '|', 'a|term'])(
    'does not fail on, or expand, the pattern "%s"',
    async q => {
      const res = await suggest({ q });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    }
  );

  it('ignores control characters in the prefix', async () => {
    const res = await suggest({ q: 'term\u0000\u0007' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(8);
  });
});
