const { maxPageFor, parsePage, parseLimit } = require('../../utils/validators');
const { buildPagination } = require('../../services/searchService');
const { MAX_RESULT_WINDOW } = require('../../services/opensearch/searchService');
const { config } = require('../../config/env');

/**
 * Page bounds of the search API.
 *
 * Only the first 10,000 results of a search can be paged through, so the
 * last page depends on the page size. The API must never accept, or
 * advertise, a page beyond it.
 */

describe('search page bounds', () => {
  it('uses the limits these tests assume', () => {
    expect(config.search.maxResultWindow).toBe(10000);
    expect(config.search.maxPage).toBe(500);
    expect(config.search.maxLimit).toBe(50);
    // One value, shared by the validator and the OpenSearch service.
    expect(MAX_RESULT_WINDOW).toBe(config.search.maxResultWindow);
  });

  describe('maxPageFor', () => {
    it.each([
      [1, 500],
      [10, 500],
      [20, 500],
      [21, 476],
      [24, 416],
      [25, 400],
      [50, 200]
    ])('a limit of %i ends at page %i', (limit, lastPage) => {
      expect(maxPageFor(limit)).toBe(lastPage);
    });

    it('never reaches past the result window or the configured maximum page', () => {
      for (let limit = 1; limit <= config.search.maxLimit; limit += 1) {
        const last = maxPageFor(limit);
        expect(last).toBeGreaterThanOrEqual(1);
        expect(last).toBeLessThanOrEqual(config.search.maxPage);
        expect(last * limit).toBeLessThanOrEqual(config.search.maxResultWindow);
      }
    });
  });

  describe('parsePage with a page size', () => {
    it('accepts the last page inside the window', () => {
      expect(parsePage('200', { limit: 50 })).toBe(200);
      expect(parsePage('500', { limit: 20 })).toBe(500);
      expect(parsePage('500', { limit: 10 })).toBe(500);
      expect(parsePage('416', { limit: 24 })).toBe(416);
    });

    it('refuses the first page beyond the window, and says why', () => {
      expect(() => parsePage('201', { limit: 50 })).toThrow(/maximum is 200 for a limit of 50/);
      expect(() => parsePage('201', { limit: 50 })).toThrow(/first 10,000 results/);
      expect(() => parsePage('417', { limit: 24 })).toThrow(/maximum is 416 for a limit of 24/);
    });

    it('keeps the plain message when the configured maximum is the limit', () => {
      expect(() => parsePage('501', { limit: 10 })).toThrow(/maximum is 500\.$/);
      expect(() => parsePage('501', { limit: 20 })).toThrow(/maximum is 500\.$/);
    });

    it('still rejects what is not a page number', () => {
      for (const raw of ['0', '-1', 'abc', '1.5']) {
        expect(() => parsePage(raw, { limit: 10 })).toThrow(/integer of 1 or greater/);
      }
      expect(parsePage(undefined, { limit: 50 })).toBe(1);
      expect(parsePage('', { limit: 50 })).toBe(1);
    });

    it('is unchanged for callers that have no page size', () => {
      expect(parsePage('500')).toBe(500);
      expect(() => parsePage('501')).toThrow(/maximum is 500\.$/);
    });

    it('pairs with the largest page size the API accepts', () => {
      const limit = parseLimit(String(config.search.maxLimit));
      expect(parsePage(String(maxPageFor(limit)), { limit }) * limit).toBe(10000);
      expect(() => parseLimit(String(config.search.maxLimit + 1))).toThrow(/maximum is 50/);
    });
  });

  describe('buildPagination', () => {
    it('is unchanged for an ordinary result set', () => {
      expect(buildPagination({ page: 2, limit: 10, totalResults: 95 })).toEqual({
        page: 2,
        limit: 10,
        totalResults: 95,
        totalPages: 10,
        hasNextPage: true,
        hasPreviousPage: true
      });
      expect(buildPagination({ page: 10, limit: 10, totalResults: 95 }).hasNextPage).toBe(false);
      expect(buildPagination({ page: 1, limit: 10, totalResults: 0 })).toMatchObject({
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false
      });
    });

    it.each([
      [50, 15000, 200],
      [50, 10001, 200],
      [50, 10000, 200],
      [50, 9999, 200],
      [50, 9950, 199],
      [20, 25000, 500],
      [20, 10000, 500],
      [10, 15000, 500],
      [10, 4990, 499],
      [24, 20000, 416]
    ])('at %i per page, %i results are %i reachable pages', (limit, totalResults, pages) => {
      const pagination = buildPagination({ page: 1, limit, totalResults });
      expect(pagination.totalPages).toBe(pages);
      // The count of matches is reported as it is.
      expect(pagination.totalResults).toBe(totalResults);
    });

    it('stops offering a next page at the last reachable one', () => {
      expect(buildPagination({ page: 199, limit: 50, totalResults: 15000 }).hasNextPage).toBe(true);
      expect(buildPagination({ page: 200, limit: 50, totalResults: 15000 }).hasNextPage).toBe(
        false
      );
      expect(buildPagination({ page: 500, limit: 10, totalResults: 15000 }).hasNextPage).toBe(
        false
      );
    });

    it('never advertises a page the API would refuse', () => {
      for (let limit = 1; limit <= config.search.maxLimit; limit += 1) {
        for (const totalResults of [1, 9999, 10000, 10001, 250000]) {
          const { totalPages } = buildPagination({ page: 1, limit, totalResults });
          expect(parsePage(String(totalPages), { limit })).toBe(totalPages);
        }
      }
    });
  });

  describe('buildPagination with fewer reachable results than matches', () => {
    it.each([
      // limit, matches, reachable inside the window, pages
      [20, 5300, 5266, 264],
      [50, 5300, 5266, 106],
      [24, 5300, 5266, 220],
      [10, 5300, 5266, 500],
      [50, 10060, 9950, 199],
      [20, 10060, 9950, 498],
      [50, 10020, 9998, 200],
      [50, 10060, 10000, 200]
    ])(
      'at %i per page, %i matches of which %i are reachable make %i pages',
      (limit, totalResults, reachableResults, pages) => {
        const pagination = buildPagination({ page: 1, limit, totalResults, reachableResults });
        expect(pagination.totalPages).toBe(pages);
        // The count of matches is still reported as it is.
        expect(pagination.totalResults).toBe(totalResults);
      }
    );

    it('never advertises a page with nothing on it', () => {
      for (const limit of [10, 20, 24, 50]) {
        for (const reachableResults of [1, 49, 50, 5266, 9950, 9998, 10000]) {
          const { totalPages } = buildPagination({
            page: 1,
            limit,
            totalResults: 15000,
            reachableResults
          });
          // The last advertised page starts at a result that exists…
          expect((totalPages - 1) * limit).toBeLessThan(reachableResults);
          // …and the API accepts it.
          expect(parsePage(String(totalPages), { limit })).toBe(totalPages);
        }
      }
    });

    it('stops offering a next page at the last page with results', () => {
      const at = page =>
        buildPagination({ page, limit: 20, totalResults: 5300, reachableResults: 5266 });
      expect(at(263).hasNextPage).toBe(true);
      expect(at(264).hasNextPage).toBe(false);
    });

    it('is unchanged when everything that matched is reachable', () => {
      for (const totalResults of [0, 1, 95, 9999, 10000, 15000]) {
        expect(
          buildPagination({ page: 1, limit: 20, totalResults, reachableResults: totalResults })
        ).toEqual(buildPagination({ page: 1, limit: 20, totalResults }));
      }
    });

    it('never reports more reachable results than matches', () => {
      expect(
        buildPagination({ page: 1, limit: 10, totalResults: 30, reachableResults: 1000 }).totalPages
      ).toBe(3);
    });
  });
});
