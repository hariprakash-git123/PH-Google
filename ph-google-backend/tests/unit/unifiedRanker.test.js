const {
  rankResults,
  countCovering,
  countAnswering,
  featuresOf,
  prepareQuery,
  titleCore,
  WEIGHTS
} = require('../../services/ranking/unifiedRanker');
const { classify, isTimeSensitive } = require('../../services/ranking/queryIntent');
const { resultIdentityKey, canonicalKey } = require('../../utils/urlNormalizer');
const { buildSnippet } = require('../../services/opensearch/searchService');
const { parseQuery } = require('../../services/opensearch/queryParser');

/** The unified ranking of web results from every source, and what it rests on. */

const index = (n, title, extra = {}) => ({
  url: `https://index.example/${n}`,
  title,
  snippet: '',
  source: 'index',
  sourceRank: n,
  score: 12.5,
  ...extra
});
const external = (n, title, extra = {}) => ({
  url: `https://ext.example/${n}`,
  title,
  snippet: '',
  source: 'parallel',
  sourceRank: n,
  score: null,
  ...extra
});
const rank = (query, results, options) => rankResults(results, parseQuery(query), options);
const urls = list => list.map(r => r.url);

describe('the weights', () => {
  it('are explicit, and evidence about the query outweighs a result’s place in its source', () => {
    expect(WEIGHTS).toEqual({
      titleCoverage: 0.3,
      textCoverage: 0.2,
      titlePhrase: 0.15,
      exactTitle: 0.1,
      sourceRank: 0.2,
      freshness: 0.05,
      junkTitle: -0.2,
      repeat: -0.15
    });
    const relevance =
      WEIGHTS.titleCoverage + WEIGHTS.textCoverage + WEIGHTS.titlePhrase + WEIGHTS.exactTitle;
    expect(relevance).toBeGreaterThan(WEIGHTS.sourceRank * 3);
  });
});

describe('the evidence', () => {
  const q = prepareQuery(parseQuery('theory of relativity'));

  it('title and text coverage count the query’s meaningful words', () => {
    const f = featuresOf(
      { title: 'Relativity explained', snippet: 'A theory of space', url: 'https://x.example' },
      q
    );
    expect(f.titleCoverage).toBe(0.5);
    expect(f.textCoverage).toBe(1);
    expect(f.covers).toBe(true);
  });

  it('a title is the query when its words are, without the site’s name', () => {
    expect(titleCore('Theory of relativity - Wikipedia')).toBe('Theory of relativity');
    expect(titleCore('HTML: HyperText Markup Language | MDN')).toBe(
      'HTML: HyperText Markup Language'
    );
    expect(titleCore('Arctic – Travel guide at Wikivoyage')).toBe('Arctic');
    const f = featuresOf(
      { title: 'Theory of Relativity - Wikipedia', url: 'https://w.example' },
      q
    );
    expect(f.exactTitle).toBe(1);
    expect(f.titlePhrase).toBe(1);
  });

  it('a misspelt query word still finds the word', () => {
    const typo = prepareQuery(parseQuery('relativty theory'));
    expect(featuresOf({ title: 'Theory of relativity' }, typo).titleCoverage).toBe(1);
  });

  it('a synonym from the index’s own list counts as the word', () => {
    const ai = prepareQuery(parseQuery('ai ethics'));
    const f = featuresOf({ title: 'Artificial intelligence ethics' }, ai);
    expect(f.titleCoverage).toBe(1);
  });

  it('a page that merely shares one word does not cover a two-word query', () => {
    const f = featuresOf({ title: 'Game theory - Wikipedia', url: 'https://w.example/game' }, q);
    expect(f.covers).toBe(false);
  });

  it('a missing title, a lone character or an address as the title is junk', () => {
    expect(featuresOf({ title: '', url: 'https://a.example' }, q).junkTitle).toBe(1);
    expect(featuresOf({ title: 'X', url: 'https://a.example' }, q).junkTitle).toBe(1);
    expect(
      featuresOf({ title: 'https://arxiv.org/pdf/1', url: 'https://arxiv.org/pdf/1' }, q).junkTitle
    ).toBe(1);
    expect(featuresOf({ title: 'Relativity', url: 'https://a.example' }, q).junkTitle).toBe(0);
  });

  it('freshness counts only for a time-sensitive query, and only from a real date', () => {
    const now = Date.parse('2026-10-11T00:00:00Z');
    const recent = { title: 'x', publishedAt: '2026-10-10T00:00:00Z' };
    expect(featuresOf(recent, q, { timeSensitive: true, now }).freshness).toBe(1);
    expect(featuresOf(recent, q, { timeSensitive: false, now }).freshness).toBe(0);
    // No date is no date: nothing is assumed.
    expect(featuresOf({ title: 'x' }, q, { timeSensitive: true, now }).freshness).toBe(0);
    expect(
      featuresOf({ title: 'x', publishedAt: 'not a date' }, q, { timeSensitive: true, now })
        .freshness
    ).toBe(0);
  });
});

describe('ranking two sources together', () => {
  it('raw scores are never compared: a huge BM25 score does not beat a better-matching provider result', () => {
    const results = [
      index(1, 'Game theory - Wikipedia', { score: 9999 }),
      external(1, 'Theory of relativity - Britannica', { score: null })
    ];
    expect(urls(rank('theory of relativity', results))).toEqual([
      'https://ext.example/1',
      'https://index.example/1'
    ]);
  });

  it('a provider result is not promoted for being external: with equal evidence the index leads', () => {
    const results = [external(1, 'Theory of relativity'), index(1, 'Theory of relativity')];
    expect(rank('theory of relativity', results).map(r => r.source)).toEqual(['index', 'parallel']);
  });

  it('one matching word in a title is not enough to lead', () => {
    const results = [
      external(1, 'Relativity (band) tour dates'),
      index(2, 'Theory of relativity', { snippet: 'Special and general relativity.' })
    ];
    expect(rank('theory of relativity', results)[0].source).toBe('index');
  });

  it('results that do not cover the query go after those that do, from either source', () => {
    const results = [
      index(1, 'Christianity in Asia'),
      external(1, 'MongoDB: the developer data platform'),
      index(2, 'MongoDB - Wikipedia'),
      external(2, 'Mongolia travel guide')
    ];
    expect(urls(rank('mongodb', results))).toEqual([
      'https://index.example/2',
      'https://ext.example/1',
      // Neither mentions "mongodb": the loose matches, last.
      'https://index.example/1',
      'https://ext.example/2'
    ]);
  });

  it('an empty or junk title does not lead', () => {
    const results = [
      external(1, 'X'),
      external(2, 'Kuiper Belt and Oort Cloud'),
      index(5, 'Oort Cloud')
    ];
    expect(rank('kuiper belt vs oort cloud', results)[0].url).toBe('https://ext.example/2');
  });

  it('a repeat of a page ranked above it loses ground: the mobile copy, or the same title on the same site', () => {
    const results = [
      index(1, 'Theory of relativity - Wikipedia', {
        url: 'https://en.wikipedia.org/wiki/Theory_of_relativity'
      }),
      external(1, 'Theory of relativity - Wikipedia', {
        url: 'https://en.m.wikipedia.org/wiki/Theory_of_relativity'
      }),
      external(2, 'Relativity | Britannica', {
        url: 'https://www.britannica.com/science/relativity'
      })
    ];
    const ranked = rank('theory of relativity', results, { explain: true });
    const mobile = ranked.find(r => r.url.includes('en.m.'));
    expect(mobile.ranking.features.repeat).toBe(1);
    expect(ranked[0].url).toBe('https://en.wikipedia.org/wiki/Theory_of_relativity');
  });

  it('copies of one page do not fill the top: they follow every other result about the query', () => {
    const copy = n =>
      external(n, 'TechCrunch Disrupt 2026 | TechCrunch', {
        url: `https://techcrunch.com/events/techcrunch-disrupt/?display&promo=post_${n}`
      });
    const results = [
      copy(1),
      copy(2),
      copy(3),
      external(4, 'TechCrunch Disrupt 2026', {
        url: 'https://www.moscone.com/events/disrupt-2026'
      }),
      index(1, 'Tickets - TechCrunch Disrupt 2026 | TechCrunch', {
        url: 'https://techcrunch.com/events/techcrunch-disrupt/tickets'
      })
    ];
    const ranked = rank('techcrunch disrupt 2026', results);
    const firstThree = ranked.slice(0, 3).map(r => r.url);
    // One copy of the event page, and the two other pages about it.
    expect(firstThree.filter(url => url.includes('promo='))).toHaveLength(1);
    expect(ranked).toHaveLength(5); // kept, not removed
  });

  it('two pages of one site that only share the site’s name in their titles are not repeats', () => {
    const results = [
      external(1, 'Node.js — Run JavaScript Everywhere', { url: 'https://nodejs.org/zh-tw' }),
      index(1, 'Node.js — About Node.js®', { url: 'https://nodejs.org/en/about' }),
      index(2, 'Changelog - Learn web development | MDN', {
        url: 'https://developer.mozilla.org/x',
        snippet: 'Node.js and npm'
      })
    ];
    const ranked = rank('node.js', results, { explain: true });
    expect(ranked.find(r => r.url.endsWith('/en/about')).ranking.features.repeat).toBeUndefined();
    expect(ranked.findIndex(r => r.url.endsWith('/en/about'))).toBeLessThan(
      ranked.findIndex(r => r.url.includes('mozilla'))
    );
  });

  it('for a time-sensitive query a recent page wins a tie; for any other query the date changes nothing', () => {
    const now = Date.parse('2026-10-11T00:00:00Z');
    const results = [
      index(1, 'GitHub Copilot news', { publishedAt: '2025-01-01T00:00:00Z' }),
      external(1, 'GitHub Copilot news', { publishedAt: '2026-10-10T00:00:00Z' })
    ];
    expect(
      rank('latest github copilot news', results, { timeSensitive: true, now })[0].source
    ).toBe('parallel');
    expect(rank('github copilot news', results, { timeSensitive: false, now })[0].source).toBe(
      'index'
    );
  });

  it('nothing is removed, and the result objects are returned as they were', () => {
    const results = [index(1, 'A'), external(1, 'B'), index(2, 'C')];
    const ranked = rank('zebra', results);
    expect(ranked).toHaveLength(3);
    expect(ranked.every(r => results.includes(r))).toBe(true);
  });

  it('a query with no meaningful words keeps each source’s order', () => {
    const results = [index(1, 'A'), index(2, 'B')];
    expect(urls(rank('the', results))).toEqual(urls(results));
  });
});

describe('one source alone', () => {
  it('keeps its own order, with only the results that do not cover the query moved after the rest', () => {
    const results = [
      index(1, 'MongoDB - Wikipedia'),
      index(2, 'Christianity in Asia'),
      index(3, 'Node.js - Wikipedia', { snippet: 'Used with MongoDB.' }),
      index(4, 'History of cartography')
    ];
    expect(urls(rank('mongodb', results))).toEqual([
      'https://index.example/1',
      'https://index.example/3',
      'https://index.example/2',
      'https://index.example/4'
    ]);
  });

  it('countAnswering asks the title: a word mentioned in passing in a snippet does not count', () => {
    const query = parseQuery('how does the immune system work');
    const results = [
      index(1, 'Vitamin D: MedlinePlus', {
        snippet: 'a role in your nerve, muscle, and immune systems'
      }),
      index(2, 'COVID-19 - Wikipedia', { snippet: 'the immune system works against it' }),
      index(3, 'Immune system - Wikipedia')
    ];
    // All three mention the words somewhere; only one is about the immune system.
    expect(countCovering(results, query)).toBe(3);
    expect(countAnswering(results, query)).toBe(1);
  });

  it('countCovering counts the results about the query', () => {
    const results = [index(1, 'MongoDB - Wikipedia'), index(2, 'Christianity in Asia')];
    expect(countCovering(results, parseQuery('mongodb'))).toBe(1);
    expect(countCovering(results, parseQuery('the'))).toBe(2);
  });
});

describe('what kind of search a query is', () => {
  const now = new Date('2026-10-11T00:00:00Z');
  it.each([
    ['latest github copilot news', 'time-sensitive'],
    ['techcrunch disrupt 2026', 'time-sensitive'],
    ['python 3.14 release', 'time-sensitive'],
    ['what happened today', 'time-sensitive'],
    ['kuiper belt vs oort cloud', 'comparison'],
    ['difference between tcp and udp', 'comparison'],
    ['youtube', 'navigational'],
    ['github.com', 'navigational'],
    ['theory of relativity', 'informational'],
    ['how does the immune system work', 'informational'],
    ['new york', 'informational'],
    ['electric current', 'informational'],
    ['battle of hastings 1066', 'informational']
  ])('%s → %s', (query, kind) => {
    expect(classify(query, { now }).kind).toBe(kind);
  });

  it('notes a question', () => {
    expect(classify('how does the immune system work', { now }).question).toBe(true);
    expect(classify('immune system', { now }).question).toBe(false);
    expect(isTimeSensitive('election results 2025', { now })).toBe(true);
    expect(isTimeSensitive('world war 2', { now })).toBe(false);
  });
});

describe('telling repeats apart across sources', () => {
  it.each([
    ['https://en.m.wikipedia.org/wiki/Python', 'https://en.wikipedia.org/wiki/Python'],
    ['https://m.example.com/news', 'https://example.com/news'],
    ['https://www.youtube.com/;', 'https://youtube.com/'],
    ['https://example.com/docs/index.html', 'https://example.com/docs'],
    ['https://techcrunch.com/x/?utm_source=google&utm_medium=ad', 'https://techcrunch.com/x'],
    [
      'https://techcrunch.com/events/d/?promo=post_1',
      'https://techcrunch.com/events/d/?promo=Disrupt25'
    ]
  ])('%s is the same page as %s', (a, b) => {
    expect(resultIdentityKey(a)).toBe(resultIdentityKey(b));
  });

  it.each([
    ['https://www.youtube.com/watch?v=AbC', 'https://www.youtube.com/watch?v=abc'],
    ['https://example.com/Docs', 'https://example.com/docs'],
    ['https://nodejs.org/en/about', 'https://nodejs.org/zh-tw/about'],
    ['https://mobile.example.com/a', 'https://example.com/b']
  ])('%s is a different page from %s', (a, b) => {
    expect(resultIdentityKey(a)).not.toBe(resultIdentityKey(b));
  });

  it('leaves the stored document ids alone', () => {
    // Document ids are sha1(canonicalKey): unchanged, so nothing needs reindexing.
    expect(canonicalKey('https://en.m.wikipedia.org/wiki/Python')).toBe(
      'en.m.wikipedia.org/wiki/Python'
    );
  });
});

describe('the snippet', () => {
  const hit = (highlight, description = '') => ({ highlight, _source: { description } });

  it('is the part of the page that matched the query', () => {
    expect(
      buildSnippet(hit({ content: ['The <mark>theory</mark> of relativity…'] }, 'A physics page.'))
    ).toBe('The theory of relativity…');
  });

  it('a page that matched only in its title shows its description, not its first lines', () => {
    expect(
      buildSnippet(
        hit(
          { content: ['Jump to navigation. From Wikipedia, the free…'] },
          'Albert Einstein’s theory.'
        )
      )
    ).toBe('Albert Einstein’s theory.');
  });

  it('with no description, the opening text is still better than nothing', () => {
    expect(buildSnippet(hit({ content: ['Opening text.'] }))).toBe('Opening text.');
    expect(buildSnippet(hit({}))).toBe('No description available.');
  });
});
