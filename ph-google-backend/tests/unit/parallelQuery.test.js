const { parseQuery } = require('../../services/opensearch/queryParser');
const { buildParallelRequest } = require('../../services/external/parallelQuery');

/**
 * How a PH search becomes a Parallel request — and, as importantly, when it
 * does not: Parallel is never asked a question it cannot honour.
 */

const build = (query, filters = {}) => buildParallelRequest(parseQuery(query), filters);

describe('parallelQuery — what is sent', () => {
  it('a plain query is both the objective and the keyword query', () => {
    expect(build('python programming')).toEqual({
      skip: false,
      objective: 'python programming',
      searchQueries: ['python programming'],
      sourcePolicy: {},
      afterDate: null
    });
  });

  it('a question keeps its wording as the objective and its topic as the query', () => {
    const request = build('how does gravity work');
    expect(request.objective).toBe('how does gravity work');
    expect(request.searchQueries).toEqual(['gravity']);
  });

  it('a quoted phrase is sent in quotes', () => {
    const request = build('"machine learning" tutorial');
    expect(request.searchQueries).toEqual(['tutorial "machine learning"']);
  });

  it('an OR group is sent as written', () => {
    expect(build('cats OR dogs').searchQueries).toEqual(['cats OR dogs']);
  });

  it('site: and the domain filter become include_domains', () => {
    expect(build('gravity site:nasa.gov').sourcePolicy).toEqual({ include_domains: ['nasa.gov'] });
    expect(build('gravity', { domain: 'nasa.gov' }).sourcePolicy).toEqual({
      include_domains: ['nasa.gov']
    });
    expect(build('gravity site:nasa.gov', { domain: 'nasa.gov' }).sourcePolicy).toEqual({
      include_domains: ['nasa.gov']
    });
    // The operator is not left in the words that are searched for.
    expect(build('gravity site:nasa.gov').searchQueries).toEqual(['gravity']);
  });

  it('-site: becomes exclude_domains', () => {
    expect(build('gravity -site:pinterest.com').sourcePolicy).toEqual({
      exclude_domains: ['pinterest.com']
    });
  });

  it.each(['day', 'week', 'month', 'year'])('the %s filter becomes after_date', window => {
    const request = build('gravity', { dateWindow: window });
    expect(request.afterDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(request.sourcePolicy).toEqual({ after_date: request.afterDate });
    expect(request.afterDate < new Date().toISOString().slice(0, 10)).toBe(true);
  });
});

describe('parallelQuery — when Parallel is not asked', () => {
  it.each([
    ['page 2', 'python', { page: 2 }, 'not_first_page'],
    ['another tab', 'python', { category: 'news' }, 'not_web_search'],
    ['newest first', 'python', { sort: 'newest' }, 'date_sort'],
    ['oldest first', 'python', { sort: 'oldest' }, 'date_sort'],
    ['an empty query', '   ', {}, 'empty_query']
  ])('%s', (_label, query, filters, reason) => {
    expect(build(query, filters)).toEqual({ skip: true, reason });
  });

  // Each of these would otherwise come back as results that ignore part of
  // the query while looking as though they matched it.
  it.each([
    ['intitle:', 'intitle:python tutorial'],
    ['inurl:', 'python inurl:docs'],
    ['-intitle:', 'python -intitle:java'],
    ['-inurl:', 'python -inurl:forum'],
    ['-word', 'python -snake'],
    ['-"a phrase"', 'python -"monty python"'],
    ['lang:', 'python lang:fr'],
    ['-lang:', 'python -lang:fr']
  ])('%s cannot be honoured, so the query is not sent', (_label, query) => {
    expect(build(query)).toEqual({ skip: true, reason: 'unsupported_operator' });
  });

  it('the language filter cannot be honoured', () => {
    expect(build('python', { language: 'fr' })).toEqual({
      skip: true,
      reason: 'unsupported_filter'
    });
  });

  it('the past-hour filter is finer than a calendar date', () => {
    expect(build('python', { dateWindow: 'hour' })).toEqual({
      skip: true,
      reason: 'unsupported_filter'
    });
  });

  it('a query with a site but no words has nothing to search for', () => {
    expect(build('site:nasa.gov')).toEqual({ skip: true, reason: 'no_search_text' });
  });
});
