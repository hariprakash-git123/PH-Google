import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SearchResults from './SearchResults';
import { normalizeDomain } from '../../components/Filters/Filters';
import { searchApi } from '../../services/searchApi';

/**
 * The search filters on the results page, with the real Filters panel and
 * tabs and the API replaced: what each control sends, that every request of
 * one search — another tab, "Load more" — carries the same filters, that an
 * old answer never replaces a newer one, and that a filter the results do not
 * reflect is said so rather than shown as applied.
 */

vi.mock('../../services/searchApi', () => ({
  searchApi: {
    search: vi.fn(),
    getAiAnswer: vi.fn(),
    sendAiFeedback: vi.fn(),
    getSuggestions: vi.fn(async () => [])
  }
}));
vi.mock('../../components/Header/Header', () => ({ default: () => <div data-testid="header" /> }));
vi.mock('../../components/AIAnswer/AIAnswer', () => ({ default: () => null }));

const web = (n, prefix = 'r') => ({
  id: `${prefix}${n}`,
  url: `https://site${n}.example/${prefix}`,
  domain: `site${n}.example`,
  title: `${prefix.toUpperCase()} result ${n}`,
  snippet: `Snippet ${n}`,
  publishedAgo: '1 day ago',
  category: 'Web Result',
  source: 'index'
});
const range = (from, to, prefix) =>
  Array.from({ length: to - from + 1 }, (_, i) => web(from + i, prefix));
const answer = (results, extra = {}) => ({
  results,
  total: results.length,
  latency: '0.1s',
  pagination: { page: 1, limit: 10, totalResults: results.length, totalPages: 1 },
  hasMore: false,
  nextCursor: null,
  ...extra
});
function later() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
}

const open = (url = '/search?q=python') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <SearchResults />
    </MemoryRouter>
  );
const openFilters = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Toggle Advanced Search Filters' }));
const choose = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const lastCall = () => searchApi.search.mock.calls[searchApi.search.mock.calls.length - 1];
const titles = () => [...document.querySelectorAll('.ph-result-title')].map(h => h.textContent);
/** The filter notice under the result count, once it is on screen. */
const notice = () =>
  waitFor(() => {
    const element = document.querySelector('.ph-filter-notice');
    if (!element) throw new Error('no filter notice');
    return element;
  });

beforeEach(() => {
  searchApi.search.mockReset();
  searchApi.search.mockResolvedValue(answer(range(1, 3)));
  searchApi.getAiAnswer.mockResolvedValue({ status: 'disabled', sources: [] });
});

describe('applying and clearing filters', () => {
  it('a filter starts a new search with it; choosing "Any" again clears it', async () => {
    open('/search?q=python&page=3');
    await screen.findByText('R result 1');
    openFilters();

    choose('Date Range', 'Past week');
    await waitFor(() => expect(lastCall()[2]).toMatchObject({ date: 'Past week', page: 1 }));

    choose('Date Range', 'Any time');
    await waitFor(() => expect(lastCall()[2]).toMatchObject({ date: 'Any time' }));
  });

  it('date, language, sort and site combine in one request', async () => {
    open();
    await screen.findByText('R result 1');
    openFilters();
    choose('Date Range', 'Past month');
    choose('Language', 'Tamil');
    choose('Sort by', 'oldest');
    const site = screen.getByLabelText('Site or domain');
    fireEvent.change(site, { target: { value: 'https://www.Example.com/news' } });
    fireEvent.keyDown(site, { key: 'Enter' });

    await waitFor(() =>
      expect(lastCall()[2]).toMatchObject({
        date: 'Past month',
        language: 'Tamil',
        sort: 'oldest',
        domain: 'example.com'
      })
    );
    expect(site).toHaveValue('example.com');
  });
});

describe('the site filter', () => {
  it('is not searched on every keystroke, only when it is complete', async () => {
    open();
    await screen.findByText('R result 1');
    openFilters();
    const before = searchApi.search.mock.calls.length;
    const site = screen.getByLabelText('Site or domain');
    for (const value of ['e', 'ex', 'exam', 'example', 'example.', 'example.com']) {
      fireEvent.change(site, { target: { value } });
    }
    expect(searchApi.search).toHaveBeenCalledTimes(before);

    fireEvent.blur(site);
    await waitFor(() => expect(lastCall()[2]).toMatchObject({ domain: 'example.com' }));
    expect(screen.getByRole('button', { name: /site: example\.com/ })).toBeInTheDocument();
  });

  it('something that is not a domain is said beside the field and not searched', async () => {
    open();
    await screen.findByText('R result 1');
    openFilters();
    const before = searchApi.search.mock.calls.length;
    const site = screen.getByLabelText('Site or domain');
    fireEvent.change(site, { target: { value: 'not a domain' } });
    fireEvent.keyDown(site, { key: 'Enter' });

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a domain such as example.com.');
    expect(site).toHaveAttribute('aria-invalid', 'true');
    expect(searchApi.search).toHaveBeenCalledTimes(before);
    expect(screen.queryByRole('button', { name: /site:/ })).not.toBeInTheDocument();
  });

  it('the "site:" chip clears it, and the field with it', async () => {
    open();
    await screen.findByText('R result 1');
    openFilters();
    const site = screen.getByLabelText('Site or domain');
    fireEvent.change(site, { target: { value: 'example.com' } });
    fireEvent.keyDown(site, { key: 'Enter' });
    const chip = await screen.findByRole('button', { name: /site: example\.com/ });

    fireEvent.click(chip);
    await waitFor(() => expect(lastCall()[2]).toMatchObject({ domain: '' }));
    expect(site).toHaveValue('');
    expect(screen.queryByRole('button', { name: /site:/ })).not.toBeInTheDocument();
  });

  it('normalises as the API does', () => {
    expect(normalizeDomain('https://www.Example.com:8080/a/b')).toBe('example.com');
    expect(normalizeDomain(' docs.python.org ')).toBe('docs.python.org');
    expect(normalizeDomain('')).toBe('');
    expect(normalizeDomain('exam')).toBeNull();
    expect(normalizeDomain('javascript:alert(1)')).toBeNull();
    expect(normalizeDomain('-bad-.com')).toBeNull();
  });
});

describe('one search across tabs and batches', () => {
  it('switching tabs keeps the filters', async () => {
    // Web results for All; the other tabs have nothing (their cards need media fields).
    searchApi.search.mockImplementation(async (q, category) =>
      category === 'all' ? answer(range(1, 3)) : answer([])
    );
    open();
    await screen.findByText('R result 1');
    openFilters();
    choose('Date Range', 'Past week');
    choose('Language', 'English');
    await waitFor(() => expect(lastCall()[2]).toMatchObject({ language: 'English' }));

    for (const [tab, category] of [
      ['Images', 'images'],
      ['Videos', 'videos'],
      ['News', 'news'],
      ['Maps', 'maps'],
      ['All', 'all']
    ]) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      if (category !== 'all') {
        await waitFor(() => expect(lastCall()[1]).toBe(category));
        expect(lastCall()[2]).toMatchObject({ date: 'Past week', language: 'English' });
      }
    }
  });

  it('"Load more" asks with the same filters and never shows a result twice', async () => {
    searchApi.search
      .mockResolvedValueOnce(answer(range(1, 10), { hasMore: true, nextCursor: 'c1', total: 30 }))
      .mockResolvedValueOnce(answer(range(1, 10), { hasMore: true, nextCursor: 'c1', total: 30 }))
      // The batch overlaps the first page by two results.
      .mockResolvedValueOnce(answer([...range(9, 10), ...range(11, 18)], { total: 30 }));
    open();
    await screen.findByText('R result 1');
    openFilters();
    choose('Sort by', 'newest');
    await waitFor(() => expect(searchApi.search).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(titles()).toHaveLength(10));

    fireEvent.click(screen.getByRole('button', { name: /Load more results/ }));
    await waitFor(() => expect(titles()).toHaveLength(18));
    expect(lastCall()[2]).toMatchObject({ cursor: 'c1', sort: 'newest' });
    expect(new Set(titles()).size).toBe(18);
  });

  it('an answer for older filters never replaces the newer one', async () => {
    const slow = later();
    searchApi.search
      .mockResolvedValueOnce(answer(range(1, 3)))
      .mockReturnValueOnce(slow.promise) // Past week
      .mockResolvedValueOnce(answer(range(1, 2, 'm'))); // Past month
    open();
    await screen.findByText('R result 1');
    openFilters();
    choose('Date Range', 'Past week');
    choose('Date Range', 'Past month');
    expect(await screen.findByText('M result 1')).toBeInTheDocument();

    slow.resolve(answer(range(1, 5, 'w')));
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByText('W result 1')).not.toBeInTheDocument();
    expect(titles()).toEqual(['M result 1', 'M result 2']);
  });
});

describe('filters the results do not reflect are said so', () => {
  it('Maps: the filters a place cannot have are named, not shown as applied', async () => {
    searchApi.search.mockResolvedValue(
      answer([], {
        ignoredFilters: ['date', 'language'],
        appliedSort: 'relevance',
        external: { provider: 'parallel', status: 'ok', count: 0 }
      })
    );
    open('/search?q=museum&category=maps');
    expect(await notice()).toHaveTextContent(
      'Places have no date, language or publication order, so the date range and language filters are not applied on Maps.'
    );
  });

  it('Images: a sort that cannot be applied is named, for that tab', async () => {
    searchApi.search.mockResolvedValue(
      answer([], {
        ignoredFilters: ['sort'],
        appliedSort: 'relevance',
        external: { provider: 'parallel', status: 'ok', count: 0 }
      })
    );
    open('/search?q=tower&category=images');
    expect(await notice()).toHaveTextContent(
      'Pictures cannot be ordered by publication date, so the sort order filter is not applied on Images.'
    );
  });

  it('an operator typed with a value it cannot use is said so, with an example', async () => {
    searchApi.search.mockResolvedValue(
      answer([], { unusedOperators: ['site:notadomain', 'lang:english'] })
    );
    open('/search?q=python%20site%3Anotadomain%20lang%3Aenglish');
    expect(await notice()).toHaveTextContent(
      '“site:notadomain”, “lang:english” are not valid operators, so they did not narrow the search.'
    );
    expect(await notice()).toHaveTextContent(/site:example\.com/);
  });

  it('a source skipped because of the filters is said so', async () => {
    searchApi.search.mockResolvedValue(
      answer(range(1, 3), {
        external: { provider: 'parallel', status: 'skipped', reason: 'date_sort', count: 0 }
      })
    );
    open();
    expect(await notice()).toHaveTextContent(
      /cannot apply the selected filters, so they were not searched/
    );
    expect(await notice()).toHaveAttribute('role', 'status');
  });

  it('nothing is said when the results reflect every filter', async () => {
    searchApi.search.mockResolvedValue(
      answer(range(1, 3), {
        ignoredFilters: [],
        external: { provider: 'parallel', status: 'skipped', reason: 'not_first_page', count: 0 }
      })
    );
    open();
    await screen.findByText('R result 1');
    expect(document.querySelector('.ph-filter-notice')).toBeNull();
  });

  it('the sidebar shows the order the results are really in (News: newest first)', async () => {
    searchApi.search.mockResolvedValue(answer(range(1, 3), { appliedSort: 'newest' }));
    open('/search?q=python&category=news');
    const card = (await screen.findByText('Search controls')).closest('.ph-sidebar-card');
    await waitFor(() => expect(within(card).getByText('Newest')).toBeInTheDocument());
  });
});

describe('failures and empty results', () => {
  it('a refused or failed search shows the error, not an empty filtered list', async () => {
    searchApi.search.mockResolvedValue({
      ...answer([]),
      error: 'Invalid "date" parameter. Allowed values: any, hour, day, week, month, year.'
    });
    open();
    expect(await screen.findByText('Search is unavailable')).toBeInTheDocument();
    expect(screen.getByText(/Invalid "date" parameter/)).toBeInTheDocument();
  });

  it('no results under a site filter suggests removing it', async () => {
    searchApi.search
      .mockResolvedValueOnce(answer(range(1, 3)))
      .mockResolvedValue(answer([]));
    open();
    await screen.findByText('R result 1');
    openFilters();
    const site = screen.getByLabelText('Site or domain');
    fireEvent.change(site, { target: { value: 'example.com' } });
    fireEvent.keyDown(site, { key: 'Enter' });
    expect(
      await screen.findByText(/Nothing in the index matches that query on example\.com/)
    ).toBeInTheDocument();
  });
});
