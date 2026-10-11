const {
  dominantScript,
  scriptOfLanguage,
  languageCompatible,
  wantedScript,
  languagesOutside
} = require('../../services/ranking/languageScript');
const { rankResults, PER_HOST } = require('../../services/ranking/unifiedRanker');
const { buildSearchBody, OTHER_SCRIPT_WEIGHT } = require('../../services/opensearch/queryBuilder');
const { parseQuery } = require('../../services/opensearch/queryParser');

/**
 * Language compatibility and host crowding — generic rules, no query or site
 * named anywhere in the code:
 *
 *   - a result in another writing system than the query's ranks after the
 *     compatible ones that cover the query (provider results: by their text;
 *     index pages: by their recorded language, as a scoring weight in the
 *     OpenSearch query, the same on every page);
 *   - a provider's third and later results from one site wait for the other
 *     sites' results about the query;
 *   - the index's own order is never moved by the ranker: one page of 40 is
 *     two pages of 20.
 */

const rank = (query, results, options) => rankResults(results, parseQuery(query), options);
const urls = list => list.map(r => r.url);

const provider = (n, url, title, snippet = '', extra = {}) => ({
  id: `p${n}`,
  url,
  title,
  snippet,
  source: 'parallel',
  sourceRank: n,
  language: '',
  ...extra
});
const indexed = (n, url, title, snippet = '', extra = {}) => ({
  id: `i${n}`,
  url,
  title,
  snippet,
  source: 'index',
  sourceRank: n,
  language: 'en',
  ...extra
});

describe('writing systems', () => {
  it('reads the script a text is mostly written in', () => {
    expect(dominantScript('python tutorial')).toBe('latin');
    expect(dominantScript('Python入門講座 科学技術計算のために')).toBe('cjk');
    expect(dominantScript('பைத்தான் நிரலாக்கம்')).toBe('tamil');
    expect(dominantScript('2024 3.14')).toBeNull();
  });

  it('maps recorded languages to their script; unknown codes to none', () => {
    expect(scriptOfLanguage('ja')).toBe('cjk');
    expect(scriptOfLanguage('en-GB')).toBe('latin');
    expect(scriptOfLanguage('fr')).toBe('latin');
    expect(scriptOfLanguage('ta')).toBe('tamil');
    expect(scriptOfLanguage('')).toBeNull();
    expect(scriptOfLanguage('xx')).toBeNull();
  });

  it('a page shares the query’s script when most of its text does — a shared word is not enough', () => {
    const ja = {
      title: 'Python - Wikipedia',
      snippet: 'Python入門講座 - Python Japan 科学技術計算のために Python を始めよう。'
    };
    expect(languageCompatible(ja, 'latin')).toBe(false);
    expect(
      languageCompatible(
        { title: 'Python - Wikipedia', snippet: 'Python is a programming language.' },
        'latin'
      )
    ).toBe(true);
    // A recorded language decides; Latin languages are not told apart.
    expect(
      languageCompatible({ language: 'ja', title: 'Python', snippet: 'Python' }, 'latin')
    ).toBe(false);
    expect(languageCompatible({ language: 'fr', title: 'Python', snippet: '' }, 'latin')).toBe(
      true
    );
    // No evidence, or no script in the query: compatible.
    expect(languageCompatible({ title: '', snippet: '' }, 'latin')).toBe(true);
    expect(languageCompatible(ja, null)).toBe(true);
  });

  it('a query that names its language decides it: no preference applied', () => {
    expect(wantedScript(parseQuery('python'))).toBe('latin');
    expect(wantedScript(parseQuery('python lang:ja'))).toBeNull();
    expect(wantedScript(parseQuery('python'), { language: 'ja' })).toBeNull();
    expect(languagesOutside('latin')).toEqual(expect.arrayContaining(['ja', 'zh', 'ru', 'ta']));
    expect(languagesOutside('latin')).not.toEqual(expect.arrayContaining(['en']));
    expect(languagesOutside('latin')).not.toContain('fr');
    expect(languagesOutside('cjk')).toEqual(expect.arrayContaining(['en', 'fr', 'ta']));
    expect(languagesOutside(null)).toEqual([]);
  });
});

/**
 * Modelled on the local index and Parallel's real answer for "python"
 * (11 Oct 2026): Parallel's own order, the index's one strong page, and the
 * Japanese article whose title is exactly "Python - Wikipedia".
 */
const PYTHON = [
  provider(
    1,
    'https://www.python.org/downloads/release/python-3127',
    'Python Release Python 3.12.7 | Python.org',
    'Python 3.12.7 release notes.'
  ),
  provider(
    2,
    'https://www.python.org/downloads/release/python-3140b4',
    'Python Release Python 3.14.0b4 | Python.org',
    'Python 3.14.0b4 release notes.'
  ),
  provider(
    3,
    'https://www.python.org/downloads/release/python-31010',
    'Python Release Python 3.10.10 | Python.org',
    'Python 3.10.10 release notes.'
  ),
  provider(
    4,
    'https://ja.wikipedia.org/wiki/Python',
    'Python - Wikipedia',
    'Python入門講座 - Python Japan 科学技術計算のために Python を始めよう。 Python による科学技術計算の概要'
  ),
  provider(
    5,
    'https://en.wikipedia.org/wiki/Python',
    'Python - Wikipedia',
    'Python may refer to: Python (programming language).'
  ),
  provider(
    7,
    'https://www.python.org/downloads/release/python-3121',
    'Python Release Python 3.12.1 | Python.org',
    'Python 3.12.1 release notes.'
  ),
  provider(
    8,
    'https://www.python.org/downloads/release/python-3113',
    'Python Release Python 3.11.3 | Python.org',
    'Python 3.11.3 release notes.'
  ),
  provider(
    10,
    'http://docs.python.org/',
    'Python 3 documentation',
    'Tutorial Start here: a tour of Python’s syntax and features.'
  ),
  provider(
    11,
    'https://realpython.com/tutorials/python',
    'Core Python Tutorials – Real Python',
    'Guided Python tutorials for beginners.'
  ),
  indexed(
    1,
    'https://en.wikipedia.org/wiki/Python_(programming_language)',
    'Python (programming language) - Wikipedia',
    'Python is a high-level programming language.'
  ),
  indexed(
    2,
    'https://en.wikipedia.org/wiki/Multi-paradigm',
    'Comparison of multi-paradigm programming languages',
    'Python supports several paradigms.'
  ),
  indexed(
    3,
    'https://engineering.fb.com/category/developer-tools',
    'DevInfra Archives - Engineering at Meta',
    'Tooling in Python and other languages.'
  )
];

describe('one list from the index and a provider ("python")', () => {
  const ranked = urls(rank('python', PYTHON));
  const at = url => ranked.indexOf(url);

  it('the Japanese article ranks after every English page that covers the query', () => {
    const ja = at('https://ja.wikipedia.org/wiki/Python');
    for (const url of ranked.filter(u => !u.includes('ja.wikipedia'))) {
      expect(at(url)).toBeLessThan(ja);
    }
    // Before: it was first, ahead of everything, for its exact title.
    expect(ja).toBe(ranked.length - 1);
  });

  it(`no site fills the list: python.org shows ${PER_HOST} pages, then other sites’ pages about Python`, () => {
    const firstEight = ranked.slice(0, 8);
    const fromPythonOrg = firstEight.filter(u => u.includes('www.python.org'));
    // Its first two, then docs and Real Python before its third.
    const third = at('https://www.python.org/downloads/release/python-31010');
    expect(at('http://docs.python.org/')).toBeLessThan(third);
    expect(at('https://realpython.com/tutorials/python')).toBeLessThan(third);
    expect(fromPythonOrg.slice(0, 2)).toEqual([
      'https://www.python.org/downloads/release/python-3127',
      'https://www.python.org/downloads/release/python-3140b4'
    ]);
    // Nothing removed.
    expect(ranked).toHaveLength(PYTHON.length);
  });

  it('a held-back page about the query still goes before pages that only mention it', () => {
    const third = at('https://www.python.org/downloads/release/python-31010');
    expect(third).toBeLessThan(at('https://engineering.fb.com/category/developer-tools'));
    expect(third).toBeLessThan(at('https://en.wikipedia.org/wiki/Multi-paradigm'));
  });

  it('with the language asked for, the language rule stands aside', () => {
    const japanese = urls(rank('python', PYTHON, { language: 'ja' }));
    // Its ordinary place by score: first, as before this change.
    expect(japanese.indexOf('https://ja.wikipedia.org/wiki/Python')).toBe(0);
  });
});

describe('the index alone keeps its own order', () => {
  it('neither language nor crowding moves an index-only list', () => {
    const list = [
      indexed(1, 'https://a.example/1', 'Python guide', 'python'),
      indexed(2, 'https://a.example/2', 'Python notes', 'python'),
      indexed(3, 'https://a.example/3', 'Python tips', 'python'),
      indexed(4, 'https://ja.example/4', 'Python', 'python', { language: 'ja' }),
      indexed(5, 'https://b.example/5', 'Python intro', 'python')
    ];
    // Exactly the index's order: what pages and "Load more" continue from.
    expect(urls(rank('python', list))).toEqual(urls(list));
  });

  it('a provider’s own list is crowded and language-ordered; the index’s never is', () => {
    const mixed = [
      indexed(1, 'https://a.example/1', 'Python one', 'python'),
      indexed(2, 'https://a.example/2', 'Python two', 'python'),
      indexed(3, 'https://a.example/3', 'Python three', 'python'),
      provider(1, 'https://b.example/1', 'Python from b', 'python')
    ];
    const ranked = urls(rank('python', mixed));
    // a.example's third page is the index's: it is not held back for b.example.
    expect(ranked.indexOf('https://a.example/3')).toBeLessThan(ranked.length);
    expect(ranked.filter(u => u.startsWith('https://a.example'))).toEqual([
      'https://a.example/1',
      'https://a.example/2',
      'https://a.example/3'
    ]);
  });
});

describe('the index query weighs language the same on every page', () => {
  const functionsOf = (query, options = {}) =>
    buildSearchBody(parseQuery(query), { from: 0, size: 10, ...options }).query.function_score
      .functions;
  const languageWeight = functions =>
    functions.find(f => f.filter && f.filter.terms && f.filter.terms.language);

  it('an English query lowers pages recorded in another script, and only those', () => {
    const weight = languageWeight(functionsOf('python'));
    expect(weight.weight).toBe(OTHER_SCRIPT_WEIGHT);
    expect(weight.filter.terms.language).toEqual(expect.arrayContaining(['ja', 'zh', 'ru']));
    expect(weight.filter.terms.language).not.toContain('en');
    expect(weight.filter.terms.language).not.toContain('fr');
  });

  it('the same weight whatever the page: from 0 or from 40', () => {
    expect(languageWeight(functionsOf('python', { from: 40, size: 20 }))).toEqual(
      languageWeight(functionsOf('python'))
    );
  });

  it('not when a language is asked for, and not for a query with no letters', () => {
    expect(languageWeight(functionsOf('python', { language: 'ja' }))).toBeUndefined();
    expect(languageWeight(functionsOf('python lang:ja'))).toBeUndefined();
    expect(languageWeight(functionsOf('2024'))).toBeUndefined();
  });

  it('a query in another script lowers Latin-script pages instead', () => {
    const weight = languageWeight(functionsOf('பைத்தான்'));
    expect(weight.filter.terms.language).toEqual(expect.arrayContaining(['en', 'ja']));
    expect(weight.filter.terms.language).not.toContain('ta');
  });
});
