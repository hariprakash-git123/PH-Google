const {
  coversQuestion,
  wordsRequired,
  keepRelevant
} = require('../../services/ai/retrievalService');
const { meaningfulTerms } = require('../../services/external/resultRelevance');
const { parseQuery } = require('../../services/opensearch/queryParser');

/**
 * Which retrieved pages count as evidence for an AI answer: those whose own
 * text covers the question — every meaningful word of a short question, the
 * usual share of a long one. A page the search admitted on its headings or
 * keywords alone is not evidence, and does not set the relevance bar for
 * the pages that are.
 */

const terms = query => meaningfulTerms(parseQuery(query));

describe('wordsRequired', () => {
  it.each([
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 3],
    [5, 3],
    [8, 5]
  ])('%i meaningful words: %i must be covered', (count, required) => {
    expect(wordsRequired(count)).toBe(required);
  });
});

describe('coversQuestion', () => {
  const q = terms('python tutorial for beginners');

  it('a page on another subject that shares the generic words is not evidence', () => {
    const htmlPage = {
      title: 'HTML: HyperText Markup Language',
      description: 'A tutorial for beginners.',
      content: 'This HTML tutorial for beginners covers elements and attributes.'
    };
    expect(q).toEqual(['python', 'tutorial', 'beginner']);
    expect(coversQuestion(htmlPage, q)).toBe(false);
  });

  it('a page that covers every word is evidence, read from its body text too', () => {
    const page = {
      title: 'Learn Python',
      description: '',
      content: 'This Python tutorial is written for beginners who have never programmed.'
    };
    expect(coversQuestion(page, q)).toBe(true);
  });

  it('a reference page on the subject that is not a tutorial is not evidence for one', () => {
    const reference = {
      title: 'Python (programming language) - Wikipedia',
      content: 'Python is a high-level, general-purpose programming language.'
    };
    expect(coversQuestion(reference, q)).toBe(false);
  });

  it('a long question needs the usual share of its words, not all of them', () => {
    const long = terms('how did the roman empire build roads aqueducts and bridges');
    expect(long.length).toBeGreaterThan(3);
    const page = {
      title: 'Roman engineering',
      content: 'The Roman empire built roads and aqueducts across Europe.'
    };
    expect(coversQuestion(page, long)).toBe(true);
  });

  it('a question with no meaningful words admits any page', () => {
    expect(coversQuestion({ title: 'Anything' }, [])).toBe(true);
  });
});

describe('the relevance bar is set among the evidence', () => {
  it('a low-scoring page on the subject is kept once the off-topic top result is gone', () => {
    const offTopicTop = { id: 'html', score: 126 };
    const onTopic = { id: 'py', score: 30 };
    // Measured with the off-topic page, the on-topic one falls below the bar…
    expect(keepRelevant([offTopicTop, onTopic], 0.3).map(r => r.id)).toEqual(['html']);
    // …measured among the evidence alone, it is the best there is.
    expect(keepRelevant([onTopic], 0.3).map(r => r.id)).toEqual(['py']);
  });
});
