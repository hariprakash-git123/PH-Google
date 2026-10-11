const {
  getTimeAgo,
  dateLabelFor,
  calendarMonthsBetween,
  formatHit
} = require('../../services/opensearch/searchService');
const { mapResult: mapParallel } = require('../../services/external/parallelMapper');
const { mapOrganicResult } = require('../../services/external/serpApiMapper');
const { mapBingItem } = require('../../services/external/bingSearchMapper');

/**
 * Which date a result shows, and how it reads.
 *
 *   published  an article's own publication date (index), or the publication
 *              date a provider states
 *   crawled    when PH last read an index page that is not an article, or an
 *              article that states no date — said as such
 *   none       a provider's result that gives no date
 *
 * A crawl date is never shown as a publication date, and no date is made up.
 */

const NOW = Date.parse('2026-10-11T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = ms => new Date(NOW - ms).toISOString();

describe('getTimeAgo counts calendar time', () => {
  it.each([
    ['2026-10-11T11:59:30Z', 'Just now'],
    ['2026-10-11T11:30:00Z', '30 min ago'],
    ['2026-10-11T07:00:00Z', '5 hours ago'],
    ['2026-10-10T12:00:00Z', '1 day ago'],
    ['2026-09-18T09:00:00Z', '23 days ago'],
    ['2026-09-11T12:00:00Z', '1 month ago'],
    ['2026-06-29T18:30:00Z', '3 months ago'],
    ['2025-10-11T12:00:00Z', '1 year ago'],
    // The case behind "24 years ago": 23 years and 8 months, not 24 — a year
    // is not twelve 30-day months.
    ['2003-02-11T00:00:00Z', '23 years ago'],
    ['2001-10-29T18:24:39Z', '24 years ago'],
    ['2004-05-11T00:00:00Z', '22 years ago']
  ])('%s -> %s', (date, text) => {
    expect(getTimeAgo(date, NOW)).toBe(text);
  });

  it('a month is complete only once its day is reached', () => {
    const now = new Date('2026-10-11T12:00:00Z');
    expect(calendarMonthsBetween(new Date('2026-09-12T00:00:00Z'), now)).toBe(0);
    expect(calendarMonthsBetween(new Date('2026-09-11T12:00:00Z'), now)).toBe(1);
    expect(calendarMonthsBetween(new Date('2003-02-11T00:00:00Z'), now)).toBe(284);
  });

  it('a missing or unreadable date is "Unknown", never "NaN years ago"', () => {
    expect(getTimeAgo(null, NOW)).toBe('Unknown');
    expect(getTimeAgo('not a date', NOW)).toBe('Unknown');
  });
});

describe('dateLabelFor', () => {
  it('an article with a publication date: that date, as "Published"', () => {
    expect(
      dateLabelFor({ publishedAt: ago(2 * DAY), crawledAt: ago(DAY), isArticle: true }, NOW)
    ).toEqual({ kind: 'published', at: ago(2 * DAY), text: 'Published 2 days ago' });
  });

  it('a reference page: its creation date is not its age — the crawl date, labelled as one', () => {
    // A Wikipedia article states datePublished 2001 (when it was created).
    const label = dateLabelFor(
      {
        publishedAt: '2001-10-29T18:24:39.000Z',
        crawledAt: '2026-09-18T09:42:37.018Z',
        isArticle: false
      },
      NOW
    );
    expect(label).toEqual({
      kind: 'crawled',
      at: '2026-09-18T09:42:37.018Z',
      text: 'Crawled 23 days ago'
    });
  });

  it('an article with no publication date shows when it was crawled, said so', () => {
    expect(
      dateLabelFor({ publishedAt: null, crawledAt: ago(5 * 1000), isArticle: true }, NOW)
    ).toEqual({
      kind: 'crawled',
      at: ago(5 * 1000),
      text: 'Crawled just now'
    });
  });

  it('older than a year: the date itself, not a count of years', () => {
    expect(
      dateLabelFor({ publishedAt: '2003-02-11T00:00:00.000Z', fromIndex: false }, NOW).text
    ).toBe('Published Feb 11, 2003');
    expect(
      dateLabelFor({ crawledAt: '2024-03-05T10:00:00.000Z', isArticle: false }, NOW).text
    ).toBe('Crawled Mar 5, 2024');
  });

  it('a provider result without a date shows none — no crawl date exists for it', () => {
    expect(dateLabelFor({ publishedAt: null, crawledAt: null, fromIndex: false }, NOW)).toBeNull();
    expect(
      dateLabelFor({ publishedAt: null, crawledAt: ago(DAY), fromIndex: false }, NOW)
    ).toBeNull();
  });

  it('nothing to go on, or a publication date in the future: no date', () => {
    expect(dateLabelFor({}, NOW)).toBeNull();
    expect(
      dateLabelFor({ publishedAt: 'garbage', crawledAt: 'garbage', isArticle: true }, NOW)
    ).toBeNull();
    expect(
      dateLabelFor({ publishedAt: new Date(NOW + 30 * DAY).toISOString(), fromIndex: false }, NOW)
    ).toBeNull();
  });
});

describe('an index hit', () => {
  const hit = source =>
    formatHit({ _id: 'x', _score: 1, _source: { url: 'https://a.example/', ...source } }, {});

  it('a reference page: no publication age, the crawl date labelled', () => {
    const result = hit({
      publishedAt: '2001-10-29T18:24:39.000Z',
      crawledAt: ago(DAY),
      isArticle: false
    });
    expect(result.publishedAgo).toBeNull();
    expect(result.publishedAt).toBe('2001-10-29T18:24:39.000Z'); // kept as data, not shown as age
    expect(result.dateLabel.kind).toBe('crawled');
    expect(result.dateLabel.text).toMatch(/^Crawled /);
  });

  it('an article: its publication date, labelled', () => {
    const result = hit({ publishedAt: ago(3 * DAY), crawledAt: ago(DAY), isArticle: true });
    expect(result.publishedAgo).toBe('3 days ago');
    expect(result.dateLabel).toMatchObject({ kind: 'published', text: 'Published 3 days ago' });
  });
});

describe('provider results', () => {
  it('Parallel: its stated publish date, labelled; without one, none', () => {
    const dated = mapParallel({
      url: 'https://ja.example.org/x',
      title: 'X',
      publish_date: '2003-02-11'
    });
    expect(dated.dateLabel).toEqual({
      kind: 'published',
      at: '2003-02-11T00:00:00.000Z',
      text: 'Published Feb 11, 2003'
    });
    const undated = mapParallel({ url: 'https://b.example.org/y', title: 'Y' });
    expect(undated.dateLabel).toBeNull();
    expect(undated.crawledAt).toBeNull();
  });

  it('SerpApi: a date, or Google’s own relative wording; Bing: none', () => {
    const relative = mapOrganicResult({
      link: 'https://c.example/',
      title: 'C',
      date: '3 days ago'
    });
    expect(relative.dateLabel).toEqual({
      kind: 'published',
      at: null,
      text: 'Published 3 days ago'
    });
    const none = mapOrganicResult({ link: 'https://d.example/', title: 'D' });
    expect(none.dateLabel).toBeNull();
    expect(mapBingItem({ link: 'https://e.example/', title: 'E' }).dateLabel).toBeNull();
  });
});
