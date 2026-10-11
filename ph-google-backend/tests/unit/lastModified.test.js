const { parseLastModified } = require('../../utils/httpDate');
const { toSearchDocument } = require('../../services/opensearch/documentMapper');
const { modifiedLabelFor } = require('../../services/opensearch/searchService');
const { MAPPINGS } = require('../../services/opensearch/indexSettings');

/**
 * The source's Last-Modified date: read from the header only when it is a
 * credible HTTP-date, stored only when there is one, shown as "Modified …".
 */

const FETCHED = Date.parse('2026-10-11T12:00:00Z');
const parse = value => {
  const date = parseLastModified(value, { fetchedAt: FETCHED });
  return date && date.toISOString();
};

describe('parseLastModified', () => {
  it.each([
    ['IMF-fixdate', 'Fri, 02 Oct 2026 10:00:00 GMT', '2026-10-02T10:00:00.000Z'],
    ['RFC 850', 'Friday, 02-Oct-26 10:00:00 GMT', '2026-10-02T10:00:00.000Z'],
    ['asctime', 'Fri Oct  2 10:00:00 2026', '2026-10-02T10:00:00.000Z'],
    ['with surrounding spaces', '  Sun, 06 Nov 1994 08:49:37 GMT ', '1994-11-06T08:49:37.000Z'],
    ['one value in a list', ['Fri, 02 Oct 2026 10:00:00 GMT'], '2026-10-02T10:00:00.000Z']
  ])('reads %s', (_label, value, iso) => {
    expect(parse(value)).toBe(iso);
  });

  it.each([
    ['a missing header', undefined],
    ['an empty header', ''],
    ['a word', 'yesterday'],
    ['an ISO date', '2026-10-02T10:00:00Z'],
    ['a zone other than GMT', 'Fri, 02 Oct 2026 10:00:00 +0530'],
    ['an impossible day', 'Tue, 31 Feb 2026 10:00:00 GMT'],
    ['a date in the future', 'Mon, 12 Oct 2026 12:00:00 GMT'],
    ['the moment of the response ("now")', 'Sun, 11 Oct 2026 11:59:30 GMT'],
    ['a date before the web', 'Thu, 01 Jan 1970 00:00:00 GMT'],
    ['two different values', ['Fri, 02 Oct 2026 10:00:00 GMT', 'Sat, 03 Oct 2026 10:00:00 GMT']],
    ['something absurdly long', `Fri, 02 Oct 2026 10:00:00 GMT${' '.repeat(80)}x`],
    ['a number', 1696240800000]
  ])('gives no date for %s', (_label, value) => {
    expect(parse(value)).toBeNull();
  });
});

describe('the search document', () => {
  const page = extra => ({
    _id: 'p1',
    url: 'https://lighthouse.example.org/keeping',
    title: 'Lighthouse keeping',
    content: 'Keepers trimmed wicks.',
    lastCrawledAt: new Date('2026-10-10T00:00:00Z'),
    ...extra
  });

  it('carries the date when there is one', () => {
    const { document } = toSearchDocument(page({ modifiedAt: new Date('2026-10-02T10:00:00Z') }));
    expect(document.modifiedAt).toBe('2026-10-02T10:00:00.000Z');
    expect(document.crawledAt).toBe('2026-10-10T00:00:00.000Z'); // unchanged, separate
  });

  it('lacks the field when there is none — so an index without it still accepts the page', () => {
    for (const modifiedAt of [null, undefined, 'not a date']) {
      const { document } = toSearchDocument(page({ modifiedAt }));
      expect('modifiedAt' in document).toBe(false);
    }
  });

  it('is mapped as a date', () => {
    expect(MAPPINGS.properties.modifiedAt).toEqual({ type: 'date' });
  });
});

describe('modifiedLabelFor', () => {
  const NOW = FETCHED;
  it.each([
    ['2026-10-08T12:00:00.000Z', 'Modified 3 days ago'],
    ['2026-07-01T00:00:00.000Z', 'Modified 3 months ago'],
    ['2022-11-06T08:49:37.000Z', 'Modified Nov 6, 2022']
  ])('%s -> %s', (at, text) => {
    expect(modifiedLabelFor(at, NOW)).toEqual({ at, text });
  });

  it('no date, an unreadable one or one in the future: no label', () => {
    expect(modifiedLabelFor(null, NOW)).toBeNull();
    expect(modifiedLabelFor('garbage', NOW)).toBeNull();
    expect(modifiedLabelFor('2026-12-01T00:00:00.000Z', NOW)).toBeNull();
  });
});
