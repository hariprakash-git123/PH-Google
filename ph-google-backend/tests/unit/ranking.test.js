const {
  calculateScore,
  explainScore,
  textScore,
  titleScore,
  descriptionScore,
  urlScore,
  freshnessScore,
  coverageScore,
  countMatches,
  WEIGHTS
} = require('../../services/rankingService');
const { sortRanked } = require('../../services/searchService');

const daysAgo = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe('rankingService', () => {
  describe('term frequency (text score)', () => {
    it('scores proportionally to frequency', () => {
      expect(textScore(5)).toBe(5);
      expect(textScore(20)).toBe(20);
    });

    it('caps the frequency contribution so keyword stuffing cannot dominate', () => {
      expect(textScore(10000)).toBe(WEIGHTS.termFrequencyCap);
      expect(textScore(WEIGHTS.termFrequencyCap + 1)).toBe(WEIGHTS.termFrequencyCap);
    });

    it('is zero for no or invalid frequency', () => {
      expect(textScore(0)).toBe(0);
      expect(textScore(-4)).toBe(0);
      expect(textScore(undefined)).toBe(0);
      expect(textScore(NaN)).toBe(0);
    });
  });

  describe('title relevance', () => {
    it('adds the title weight for each matching term', () => {
      expect(titleScore('React Tutorial Guide', ['react'])).toBe(WEIGHTS.title);
      expect(titleScore('React Tutorial Guide', ['react', 'tutorial'])).toBe(WEIGHTS.title * 2);
    });

    it('matches case-insensitively', () => {
      expect(titleScore('REACT', ['react'])).toBe(WEIGHTS.title);
    });

    it('is zero for a missing title or no terms', () => {
      expect(titleScore('', ['react'])).toBe(0);
      expect(titleScore(null, ['react'])).toBe(0);
      expect(titleScore('React', [])).toBe(0);
    });

    it('weighs a title match above a description match', () => {
      expect(titleScore('react', ['react'])).toBeGreaterThan(descriptionScore('react', ['react']));
    });
  });

  describe('description relevance', () => {
    it('adds the description weight for each matching term', () => {
      expect(descriptionScore('A guide to react hooks', ['react'])).toBe(WEIGHTS.description);
      expect(descriptionScore('A guide to react hooks', ['react', 'hooks'])).toBe(
        WEIGHTS.description * 2
      );
    });

    it('is zero when the description is absent', () => {
      expect(descriptionScore(undefined, ['react'])).toBe(0);
    });
  });

  describe('URL relevance', () => {
    it('rewards a term appearing in the URL', () => {
      expect(urlScore('https://react.dev/learn', ['react'])).toBe(WEIGHTS.url);
    });

    it('is zero when the term is absent from the URL', () => {
      expect(urlScore('https://example.com/page', ['react'])).toBe(0);
    });
  });

  describe('freshness', () => {
    it('gives the full boost to a page crawled within 7 days', () => {
      expect(freshnessScore(daysAgo(1))).toBe(WEIGHTS.freshnessRecent);
      expect(freshnessScore(daysAgo(6))).toBe(WEIGHTS.freshnessRecent);
    });

    it('gives a reduced boost between 7 and 30 days', () => {
      expect(freshnessScore(daysAgo(10))).toBe(WEIGHTS.freshnessMonth);
    });

    it('gives no boost to an old page', () => {
      expect(freshnessScore(daysAgo(365))).toBe(0);
    });

    it('is zero for a missing or invalid date', () => {
      expect(freshnessScore(null)).toBe(0);
      expect(freshnessScore('not-a-date')).toBe(0);
    });

    it('does not reward a future date', () => {
      expect(freshnessScore(new Date(Date.now() + 86400000))).toBe(0);
    });
  });

  describe('term coverage', () => {
    it('rewards matching every term of a multi-word query', () => {
      expect(coverageScore(3, 3)).toBe(WEIGHTS.coverage);
      expect(coverageScore(1, 3)).toBeCloseTo(WEIGHTS.coverage / 3);
    });

    it('does not apply to a single-term query', () => {
      expect(coverageScore(1, 1)).toBe(0);
      expect(coverageScore(1, 0)).toBe(0);
    });
  });

  describe('countMatches', () => {
    it('counts distinct matching terms, not occurrences', () => {
      expect(countMatches('react react react', ['react'])).toBe(1);
      expect(countMatches('react and hooks', ['react', 'hooks'])).toBe(2);
    });
  });

  describe('calculateScore', () => {
    const page = {
      title: 'React Tutorial',
      description: 'Learn react basics',
      url: 'https://react.dev/tutorial',
      lastCrawledAt: daysAgo(1)
    };

    it('sums every signal', () => {
      const score = calculateScore(page, ['react'], 10);
      const expected =
        10 + // text
        WEIGHTS.title + // title contains "react"
        WEIGHTS.description + // description contains "react"
        WEIGHTS.url + // url contains "react"
        WEIGHTS.freshnessRecent; // crawled yesterday
      expect(score).toBe(expected);
    });

    it('ranks a title match above a body-only match', () => {
      const titled = calculateScore(
        { title: 'React Guide', description: '', url: 'https://x.com/a', lastCrawledAt: null },
        ['react'],
        1
      );
      const bodyOnly = calculateScore(
        { title: 'Unrelated', description: '', url: 'https://x.com/b', lastCrawledAt: null },
        ['react'],
        9
      );
      expect(titled).toBeGreaterThan(bodyOnly);
    });

    it('survives a page with no usable fields', () => {
      expect(calculateScore({}, ['react'], 0)).toBe(0);
      expect(calculateScore(null, ['react'], 0)).toBe(0);
      expect(calculateScore(page, null, 0)).toBeGreaterThanOrEqual(0);
    });

    it('applies the coverage bonus when options are supplied', () => {
      const withCoverage = calculateScore(page, ['react', 'tutorial'], 5, {
        matchedTerms: 2,
        totalTerms: 2
      });
      const withoutCoverage = calculateScore(page, ['react', 'tutorial'], 5);
      expect(withCoverage).toBeGreaterThan(withoutCoverage);
      expect(withCoverage - withoutCoverage).toBeCloseTo(WEIGHTS.coverage);
    });
  });

  describe('explainScore', () => {
    it('returns a per-signal breakdown that sums to the total', () => {
      const page = {
        title: 'React',
        description: 'react',
        url: 'https://react.dev',
        lastCrawledAt: daysAgo(1)
      };
      const breakdown = explainScore(page, ['react'], 7);

      expect(breakdown).toMatchObject({
        text: 7,
        title: WEIGHTS.title,
        description: WEIGHTS.description,
        url: WEIGHTS.url,
        freshness: WEIGHTS.freshnessRecent
      });
      expect(breakdown.total).toBe(calculateScore(page, ['react'], 7));
    });
  });
});

describe('result sorting', () => {
  const build = (url, score, ageDays) => ({
    page: { url, lastCrawledAt: daysAgo(ageDays) },
    score
  });

  it('sorts by descending score for relevance', () => {
    const rows = [
      build('https://a.com', 5, 1),
      build('https://b.com', 50, 9),
      build('https://c.com', 20, 3)
    ];
    sortRanked(rows, 'relevance');
    expect(rows.map(r => r.score)).toEqual([50, 20, 5]);
  });

  it('breaks relevance ties deterministically by url', () => {
    const rows = [build('https://z.com', 10, 1), build('https://a.com', 10, 1)];
    sortRanked(rows, 'relevance');
    expect(rows.map(r => r.page.url)).toEqual(['https://a.com', 'https://z.com']);
  });

  it('sorts newest first when asked', () => {
    const rows = [
      build('https://a.com', 5, 10),
      build('https://b.com', 50, 1),
      build('https://c.com', 20, 5)
    ];
    sortRanked(rows, 'newest');
    expect(rows.map(r => r.page.url)).toEqual(['https://b.com', 'https://c.com', 'https://a.com']);
  });

  it('sorts oldest first when asked', () => {
    const rows = [build('https://a.com', 5, 10), build('https://b.com', 50, 1)];
    sortRanked(rows, 'oldest');
    expect(rows.map(r => r.page.url)).toEqual(['https://a.com', 'https://b.com']);
  });

  it('falls back to relevance for an unknown sort value', () => {
    const rows = [build('https://a.com', 5, 1), build('https://b.com', 50, 9)];
    sortRanked(rows, 'nonsense');
    expect(rows.map(r => r.score)).toEqual([50, 5]);
  });

  it('treats a page with no crawl date as oldest when sorting by date', () => {
    const rows = [
      { page: { url: 'https://nodate.com', lastCrawledAt: null }, score: 1 },
      build('https://dated.com', 1, 5)
    ];
    sortRanked(rows, 'newest');
    expect(rows[0].page.url).toBe('https://dated.com');
  });
});
