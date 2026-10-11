import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchApi } from './searchApi';

/**
 * searchApi.search with `fetch` replaced: the filters as the UI labels them
 * go out in the API's vocabulary, "Load more" sends the cursor instead of a
 * page, and a filter the API refuses comes back as an error to show — never
 * as an empty, apparently filtered result.
 */

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});
const sent = () => Object.fromEntries(new URL(fetch.mock.calls[0][0]).searchParams);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchApi.search filters', () => {
  it('sends every UI filter in the API vocabulary', async () => {
    fetch.mockResolvedValue(jsonResponse(200, { success: true, data: { results: [] } }));
    await searchApi.search('python', 'news', {
      page: 2,
      limit: 10,
      date: 'Past 24 hours',
      language: 'Tamil',
      sort: 'oldest',
      domain: 'example.com'
    });
    expect(new URL(fetch.mock.calls[0][0]).pathname).toBe('/api/search');
    expect(sent()).toEqual({
      q: 'python',
      category: 'news',
      page: '2',
      limit: '10',
      sort: 'oldest',
      domain: 'example.com',
      date: 'day',
      language: 'ta'
    });
  });

  // Empty values are not sent at all (apiClient drops them): "no filter".
  it.each([
    ['Any time', 'Any language', 'relevance', { date: 'any', sort: 'relevance' }],
    ['Past hour', 'English', 'Newest first', { date: 'hour', language: 'en', sort: 'newest' }],
    ['Past year', 'Hindi', 'Oldest first', { date: 'year', language: 'hi', sort: 'oldest' }]
  ])('%s / %s / %s', async (date, language, sort, expected) => {
    fetch.mockResolvedValue(jsonResponse(200, { success: true, data: { results: [] } }));
    await searchApi.search('python', 'all', { date, language, sort });
    expect(sent()).toMatchObject(expected);
    if (!expected.language) expect(sent()).not.toHaveProperty('language');
  });

  it('a label it does not know is sent as "no filter", never as an invented one', async () => {
    fetch.mockResolvedValue(jsonResponse(200, { success: true, data: { results: [] } }));
    await searchApi.search('python', 'all', { date: 'Last decade', sort: 'popular' });
    expect(sent()).not.toHaveProperty('date');
    expect(sent()).toMatchObject({ sort: 'relevance' });
  });

  it('"Load more" sends the cursor with the same filters, and no page', async () => {
    fetch.mockResolvedValue(jsonResponse(200, { success: true, data: { results: [] } }));
    await searchApi.search('python', 'images', {
      cursor: 'abc',
      limit: 20,
      date: 'Past week',
      domain: 'example.com'
    });
    expect(sent()).toMatchObject({ cursor: 'abc', date: 'week', domain: 'example.com' });
    expect(sent()).not.toHaveProperty('page');
  });

  it('a filter the API refuses is an error to show, not an empty result', async () => {
    fetch.mockResolvedValue(
      jsonResponse(400, {
        success: false,
        message: 'Invalid "domain" parameter: expected something like "example.com".'
      })
    );
    const data = await searchApi.search('python', 'all', { domain: 'exam' });
    expect(data.results).toEqual([]);
    expect(data.error).toMatch(/Invalid "domain" parameter/);
  });
});
