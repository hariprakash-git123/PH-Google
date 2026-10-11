const { parseQuery } = require('../../services/opensearch/queryParser');
const {
  coversQuery,
  assessCoverage,
  relevantResults,
  meaningfulTerms,
  meaningfulWords,
  requiredMentions
} = require('../../services/external/resultRelevance');
const { buildTopicalFilter, buildSearchBody } = require('../../services/opensearch/queryBuilder');

/**
 * Whether a result is about the query: tolerant of a misspelling the
 * provider corrected, strict about a different word; applied to a whole
 * answer (accept or reject) and then to each result in it. And the filter
 * that asks the index for the same thing.
 */

const result = (title, snippet = '', url = 'https://site.example/page') => ({
  title,
  snippet,
  url
});
const titles = list => list.map(r => r.title);

const COIMBATORE = [
  result('THE 10 BEST Restaurants in Coimbatore', 'Best dining in Coimbatore.'),
  result('The Best Restaurants in Coimbatore for Dining Out', 'Menus and ratings.'),
  result('8 Best Restaurants In Coimbatore To Explore', 'From biryani to coffee.'),
  result('THE 10 BEST Restaurants in Comporta', 'Best dining in Comporta, Portugal.'),
  result('Caboolture restaurants, bars and cafes', 'Places to eat in Caboolture.')
];

describe('a provider that corrects a misspelling', () => {
  const misspelt = parseQuery('Best restaurants in combatore');

  it('the meaningful words leave out "best" and "in"', () => {
    expect(meaningfulTerms(misspelt)).toEqual(['restaurant', 'combatore']);
    expect(meaningfulWords(misspelt)).toEqual(['restaurants', 'combatore']);
  });

  it('accepts an answer spelt "Coimbatore" for a query spelt "combatore"', () => {
    expect(coversQuery(COIMBATORE, misspelt)).toBe(true);
    expect(assessCoverage(COIMBATORE, misspelt)).toMatchObject({ covering: 3, relevant: true });
  });

  it('keeps the results about Coimbatore and leaves out the other towns', () => {
    expect(titles(relevantResults(COIMBATORE, misspelt))).toEqual([
      'THE 10 BEST Restaurants in Coimbatore',
      'The Best Restaurants in Coimbatore for Dining Out',
      '8 Best Restaurants In Coimbatore To Explore'
    ]);
  });

  it('gives the same answer for the correct spelling', () => {
    const correct = parseQuery('best restaurants in Coimbatore');
    expect(titles(relevantResults(COIMBATORE, correct))).toEqual(
      titles(relevantResults(COIMBATORE, misspelt))
    );
  });

  it('still rejects an answer that is about another place altogether', () => {
    const elsewhere = [
      result('THE 10 BEST Restaurants in Comporta'),
      result('Caboolture restaurants, bars and cafes'),
      result('Best restaurants in Cambridge')
    ];
    expect(coversQuery(elsewhere, misspelt)).toBe(false);
    expect(relevantResults(elsewhere, misspelt)).toEqual([]);
  });
});

describe('how far a word may be from the query word', () => {
  const covers = (query, title) => relevantResults([result(title)], parseQuery(query)).length === 1;

  it.each([
    ['pyhton', 'Python documentation', 'two letters swapped'],
    ['tirunelvli', 'Tirunelveli district', 'a letter missing'],
    ['halwa', 'Halva of the Balkans', 'a spelling variant'],
    ['restaurants', 'A restaurant guide', 'singular and plural'],
    ['learn', 'Learning to code', 'a longer form'],
    ['photosynthsis', 'Photosynthesis explained', 'a long word, one letter out']
  ])('"%s" is found in "%s" (%s)', (query, title) => {
    expect(covers(query, title)).toBe(true);
  });

  it.each([
    ['rice', 'The race to the pole', 'a short word: one letter makes another word'],
    ['java', 'Lava flows', 'a short word'],
    ['delhi', 'Dell laptops', 'two letters away from a five-letter word'],
    ['recipe', 'The old regime', 'two letters away from a six-letter word'],
    ['python', 'Typhon, the monster', 'does not start with the same letter'],
    ['combatore', 'Restaurants in Comporta', 'another town']
  ])('"%s" is NOT found in "%s" (%s)', (query, title) => {
    expect(covers(query, title)).toBe(false);
  });
});

describe('relevantResults', () => {
  it('keeps the order it was given', () => {
    const parsed = parseQuery('python tutorial');
    const list = [
      result('Python tutorial 1'),
      result('Cooking basics'),
      result('A tutorial for Python 3'),
      result('Python only'),
      result('The Python Tutorial')
    ];
    expect(titles(relevantResults(list, parsed))).toEqual([
      'Python tutorial 1',
      'A tutorial for Python 3',
      'The Python Tutorial'
    ]);
  });

  it('finds the words in the snippet and the address too', () => {
    const parsed = parseQuery('tirunelveli halwa');
    expect(
      relevantResults(
        [
          result('Sweets of the south', 'Tirunelveli is famous for its halwa.'),
          result('Home', '', 'https://tirunelveli-halwa.example/'),
          result('Sweets of the north', 'Jalebi and more.')
        ],
        parsed
      )
    ).toHaveLength(2);
  });

  it('asks for both words of two, and most of three or more', () => {
    expect([1, 2, 3, 4, 5].map(requiredMentions)).toEqual([1, 2, 2, 3, 3]);
    const parsed = parseQuery('tirunelveli halwa recipe');
    const list = [
      result('Tirunelveli halwa: the story'),
      result('Halwa recipe'),
      result('Recipe ideas for dinner'),
      result('Tirunelveli travel guide')
    ];
    expect(titles(relevantResults(list, parsed))).toEqual([
      'Tirunelveli halwa: the story',
      'Halwa recipe'
    ]);
  });

  it('does not judge a query that has no meaningful words', () => {
    const list = [result('Anything'), result('At all')];
    expect(relevantResults(list, parseQuery('the best of the best'))).toEqual(list);
    expect(relevantResults(null, parseQuery('python'))).toEqual([]);
  });
});

describe('the filter that asks the index for pages on the subject', () => {
  it('requires the words, each within its own tolerance, and scores nothing', () => {
    const filter = buildTopicalFilter(['restaurants', 'combatore', 'rice', 'halwa'], 3);
    expect(filter.bool.minimum_should_match).toBe(3);
    expect(filter.bool.should.map(c => [c.multi_match.query, c.multi_match.fuzziness])).toEqual([
      ['restaurants', 2],
      ['combatore', 2],
      ['rice', 0],
      ['halwa', 1]
    ]);
    for (const clause of filter.bool.should) {
      expect(clause.multi_match.prefix_length).toBe(2);
      expect(clause.multi_match.fields).toEqual(
        expect.arrayContaining(['title', 'description', 'content'])
      );
    }
  });

  it('never requires more words than there are, nor fewer than one', () => {
    expect(buildTopicalFilter(['python'], 5).bool.minimum_should_match).toBe(1);
    expect(buildTopicalFilter(['python', 'tutorial'], 0).bool.minimum_should_match).toBe(2);
    expect(buildTopicalFilter([], 2)).toBeNull();
    expect(buildTopicalFilter(null, 2)).toBeNull();
  });

  it('is added to the search as a filter only when asked for', () => {
    const parsed = parseQuery('best restaurants in combatore');
    const plain = buildSearchBody(parsed, {});
    const strict = buildSearchBody(parsed, {
      topical: { words: ['restaurants', 'combatore'], required: 2 }
    });
    const filtersOf = body => body.query.function_score.query.bool.filter;

    expect(JSON.stringify(plain)).not.toContain('"fuzziness":2');
    expect(filtersOf(strict)).toHaveLength(filtersOf(plain).length + 1);
    expect(filtersOf(strict)[filtersOf(strict).length - 1]).toEqual(
      buildTopicalFilter(['restaurants', 'combatore'], 2)
    );
    // Scoring is untouched: the same must and should clauses, the same sort.
    expect(strict.query.function_score.query.bool.must).toEqual(
      plain.query.function_score.query.bool.must
    );
    expect(strict.query.function_score.query.bool.should).toEqual(
      plain.query.function_score.query.bool.should
    );
    expect(strict.sort).toEqual(plain.sort);
  });
});
