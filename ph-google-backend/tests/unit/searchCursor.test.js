const { encodeCursor, decodeCursor, searchKey } = require('../../utils/searchCursor');

/**
 * The "Load more" cursor: an offset, tied to one search. Nothing in it is
 * trusted — every field is checked, and a cursor made for one search is
 * refused for another.
 */

const search = {
  query: 'mathematics',
  category: 'all',
  sort: 'relevance',
  domain: '',
  dateWindow: 'any',
  language: ''
};
const raw = body => Buffer.from(JSON.stringify(body)).toString('base64url');

describe('round trip', () => {
  it('carries the offsets and where external results go', () => {
    const cursor = encodeCursor(search, {
      offset: 20,
      externalOffset: 10,
      placement: 'first',
      externalMore: true
    });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, search)).toEqual({
      offset: 20,
      externalOffset: 10,
      placement: 'first',
      externalMore: true,
      rounds: 0
    });
  });

  it('a vertical cursor is an offset alone', () => {
    const vertical = { ...search, category: 'images' };
    expect(decodeCursor(encodeCursor(vertical, { offset: 24 }), vertical)).toEqual({
      offset: 24,
      externalOffset: 0,
      placement: null,
      externalMore: false,
      rounds: 0
    });
  });

  it.each(['ranked', 'external', 'first', 'after'])('accepts the placement %s', placement => {
    const cursor = encodeCursor(search, { offset: 10, externalOffset: 10, placement });
    expect(decodeCursor(cursor, search).placement).toBe(placement);
  });

  it('refuses an unknown placement', () => {
    const body = { v: 1, k: searchKey(search), o: 10, e: 0, p: 'sideways' };
    const raw = Buffer.from(JSON.stringify(body)).toString('base64url');
    expect(() => decodeCursor(raw, search)).toThrow(/Invalid "cursor"/);
  });

  it('an Images/Videos cursor carries how many rounds its list is made of', () => {
    const vertical = { ...search, category: 'videos' };
    const cursor = encodeCursor(vertical, { offset: 22, rounds: 2 });
    expect(decodeCursor(cursor, vertical)).toMatchObject({ offset: 22, rounds: 2 });
  });

  it.each([0, -1, 1.5, 11, '2'])('refuses a rounds count of %p', rounds => {
    const vertical = { ...search, category: 'videos' };
    const body = { v: 1, k: searchKey(vertical), o: 10, e: 0, r: rounds };
    const raw = Buffer.from(JSON.stringify(body)).toString('base64url');
    expect(() => decodeCursor(raw, vertical)).toThrow(/Invalid "cursor"/);
  });

  it('the same search however it is typed has the same key', () => {
    expect(searchKey({ ...search, query: '  MatheMatics  ' })).toBe(searchKey(search));
  });
});

describe('a cursor for another search is refused', () => {
  const cursor = encodeCursor(search, { offset: 10 });
  it.each([
    ['another query', { query: 'physics' }],
    ['another tab', { category: 'news' }],
    ['another sort', { sort: 'newest' }],
    ['another site filter', { domain: 'wikipedia.org' }],
    ['another date window', { dateWindow: 'week' }],
    ['another language', { language: 'fr' }]
  ])('%s', (_label, change) => {
    expect(() => decodeCursor(cursor, { ...search, ...change })).toThrow(/different search/);
  });
});

describe('anything that is not a cursor is refused', () => {
  const key = searchKey(search);
  it.each([
    ['empty', ''],
    ['not base64url', 'abc$%^'],
    ['not JSON', Buffer.from('nope').toString('base64url')],
    ['a list', raw([1, 2])],
    ['another version', raw({ v: 2, k: key, o: 10, e: 0 })],
    ['a negative offset', raw({ v: 1, k: key, o: -10, e: 0 })],
    ['a fractional offset', raw({ v: 1, k: key, o: 10.5, e: 0 })],
    ['an offset past the result window', raw({ v: 1, k: key, o: 10001, e: 0 })],
    ['an offset that is text', raw({ v: 1, k: key, o: '10', e: 0 })],
    ['an absurd external offset', raw({ v: 1, k: key, o: 10, e: 5000 })],
    ['an unknown placement', raw({ v: 1, k: key, o: 10, e: 0, p: 'middle' })],
    ['a malformed "more" flag', raw({ v: 1, k: key, o: 10, e: 0, x: 'yes' })],
    ['far too long', 'a'.repeat(600)],
    ['not a string', 42]
  ])('%s', (_label, value) => {
    expect(() => decodeCursor(value, search)).toThrow(/cursor/);
  });
});
