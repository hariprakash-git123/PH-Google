const { parseQuery } = require('../../services/opensearch/queryParser');
const { buildSerpApiRequest } = require('../../services/external/serpApiQuery');

/**
 * PH queries translated for Google. Built from the parser's output, so
 * whatever the parser dropped never reaches SerpApi.
 */

const build = (q, filters = {}) => buildSerpApiRequest(parseQuery(q), filters);

describe('serpApiQuery — operators', () => {
  it.each([
    ['site:developer.mozilla.org javascript', 'javascript site:developer.mozilla.org', {}],
    ['"climate change"', '"climate change"', {}],
    ['python -java', 'python -java', {}],
    ['intitle:javascript', 'intitle:javascript', {}],
    ['inurl:python', 'inurl:python', {}],
    ['python OR javascript', 'python OR javascript', {}],
    // Google requires every word anyway.
    ['python AND programming', 'python programming', {}],
    // lang: becomes the lr parameter, not query text.
    ['lang:en machine learning', 'machine learning', { lr: 'lang_en' }]
  ])('%s', (input, q, params) => {
    expect(build(input)).toEqual({ skip: false, q, params });
  });

  it('keeps words outside an OR group required', () => {
    expect(build('python OR javascript tutorial').q).toBe('tutorial python OR javascript');
  });

  it('translates negated operators', () => {
    expect(build('python -site:pinterest.com -intitle:snake -inurl:forum -"monty python"').q).toBe(
      'python -"monty python" -site:pinterest.com -intitle:snake -inurl:forum'
    );
  });

  it('turns several site: operators into alternatives', () => {
    expect(build('docs site:python.org site:docs.python.org').q).toBe(
      'docs site:python.org OR site:docs.python.org'
    );
  });

  it('keeps a question as typed (the index strips the opener; Google does not need to)', () => {
    expect(build('how does gravity work').q).toBe('how does gravity work');
  });

  it('never forwards an operator the parser ignored', () => {
    // "-site:" with nothing after it is dropped by the parser.
    expect(build('python -site:').q).toBe('python');
  });
});

describe('serpApiQuery — request filters', () => {
  it('maps the domain filter to site:', () => {
    expect(build('python', { domain: 'python.org' }).q).toBe('python site:python.org');
  });

  it('maps the language filter to lr', () => {
    expect(build('python', { language: 'fr' }).params).toEqual({ lr: 'lang_fr' });
  });

  it.each([
    ['hour', 'qdr:h'],
    ['day', 'qdr:d'],
    ['week', 'qdr:w'],
    ['month', 'qdr:m'],
    ['year', 'qdr:y']
  ])('maps date=%s to tbs=%s', (dateWindow, tbs) => {
    expect(build('python', { dateWindow }).params).toEqual({ tbs });
  });

  it('sends no tbs for date=any', () => {
    expect(build('python', { dateWindow: 'any' }).params).toEqual({});
  });
});

describe('serpApiQuery — when SerpApi is not asked', () => {
  it.each([
    ['page 2', 'python', { page: 2 }, 'not_first_page'],
    ['a vertical', 'python', { category: 'news' }, 'not_web_search'],
    ['newest first', 'python', { sort: 'newest' }, 'date_sort'],
    ['oldest first', 'python', { sort: 'oldest' }, 'date_sort'],
    ['an empty query', '   ', {}, 'empty_query'],
    ['exclusions only', '-java', {}, 'empty_query'],
    ['-lang:', 'python -lang:de', {}, 'unsupported_operator'],
    ['a site alone', 'site:python.org', {}, 'no_search_text'],
    ['lang: alone', 'lang:en', {}, 'no_search_text'],
    ['conflicting languages', 'lang:en python', { language: 'fr' }, 'conflicting_filters']
  ])('%s', (_label, q, filters, reason) => {
    expect(build(q, filters)).toEqual({ skip: true, reason });
  });
});
