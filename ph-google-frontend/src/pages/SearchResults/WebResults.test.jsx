import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import SearchResults from './SearchResults';
import SearchResult from '../../components/SearchResult/SearchResult';
import { linkToOpen } from '../../components/BrowserShell/BrowserShell';
import { searchApi } from '../../services/searchApi';

/**
 * The All (web) results page: result cards that keep long titles and
 * addresses inside them, results in the order the server ranked them, and
 * related searches from the backend's real suggestions — never stand-in topics.
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
vi.mock('../../components/Filters/Filters', () => ({ default: () => null }));
vi.mock('../../components/AIAnswer/AIAnswer', () => ({ default: () => null }));

const web = n => ({
  id: `r${n}`,
  url: `https://site${n}.example/page`,
  domain: `site${n}.example`,
  title: `Result ${n}`,
  snippet: `Snippet ${n}`,
  publishedAgo: '1 day ago',
  category: 'Web Result',
  source: 'index'
});
const answer = results => ({
  results,
  total: results.length,
  latency: '0.1s',
  pagination: { page: 1, limit: 10, totalResults: results.length, totalPages: 1 },
  hasMore: false,
  nextCursor: null
});

let location;
function Probe() {
  location = useLocation();
  return null;
}
const open = (url = '/search?q=python') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <SearchResults />
      <Probe />
    </MemoryRouter>
  );

beforeEach(() => {
  searchApi.search.mockReset();
  searchApi.getSuggestions.mockReset();
  searchApi.getSuggestions.mockResolvedValue([]);
  searchApi.getAiAnswer.mockResolvedValue({ status: 'disabled', sources: [] });
});

describe('the web results', () => {
  it('are shown in the order the server ranked them', async () => {
    searchApi.search.mockResolvedValue(answer([web(3), web(1), web(2)]));
    open();
    await screen.findByText('Result 3');
    expect(
      [...document.querySelectorAll('.ph-result-title')].map(title => title.textContent)
    ).toEqual(['Result 3', 'Result 1', 'Result 2']);
  });

  it('each title opens its page in the current PH tab, as before', async () => {
    searchApi.search.mockResolvedValue(answer([web(1)]));
    open();
    const link = await screen.findByRole('link', { name: 'Result 1' });
    expect(link).toHaveAttribute('data-ph-result');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(linkToOpen({ defaultPrevented: false, button: 0, target: link })).toMatchObject({
      inPlace: true
    });
    expect(linkToOpen({ defaultPrevented: false, button: 1, target: link })).toBeNull();
  });
});

describe('a result card with very long content', () => {
  const long = {
    ...web(1),
    url: `https://example.com/${'very-long-path-segment/'.repeat(30)}?q=${'x'.repeat(200)}`,
    domain: `${'sub.'.repeat(20)}example.com`,
    title: `A ${'very long title '.repeat(30)}`,
    snippet: 'unbroken'.repeat(80)
  };

  it('keeps the whole address in a tooltip while the line itself is cut short', () => {
    const { container } = render(<SearchResult result={long} />);
    const line = container.querySelector('.ph-result-url');
    expect(line).toHaveAttribute('title', long.url);
    expect(line.querySelector('.ph-result-url-text')).toHaveTextContent(long.url);
  });

  it('still shows the title, domain and snippet in full text for screen readers', () => {
    render(<SearchResult result={long} />);
    expect(screen.getByRole('link', { name: long.title.trim() })).toHaveAttribute('href', long.url);
    expect(screen.getByText(long.domain)).toBeInTheDocument();
    expect(screen.getByText(long.snippet)).toBeInTheDocument();
  });
});

describe('related searches', () => {
  it('are the backend’s own suggestions, shown under the results; choosing one searches it', async () => {
    searchApi.search.mockResolvedValue(answer([web(1), web(2)]));
    searchApi.getSuggestions.mockResolvedValue([
      { text: 'python', category: 'recent search' },
      { text: 'python tutorial', category: 'recent search' },
      { text: 'Python Tutorial', category: 'indexed term' },
      { text: 'python download', category: 'indexed term' }
    ]);
    open();
    const related = await screen.findByRole('navigation', { name: 'Related searches' });
    expect(searchApi.getSuggestions).toHaveBeenCalledWith('python');
    expect(
      within(related)
        .getAllByRole('button')
        .map(b => b.textContent)
    ).toEqual(['python tutorial', 'python download']);
    // Under the results, not above them.
    const lastResult = [...document.querySelectorAll('.ph-search-result-card')].pop();
    expect(
      lastResult.compareDocumentPosition(related) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    fireEvent.click(within(related).getByRole('button', { name: 'python download' }));
    await waitFor(() => expect(location.search).toBe('?q=python%20download'));
  });

  it('are not shown when there are none, and no made-up topics stand in', async () => {
    searchApi.search.mockResolvedValue(answer([web(1)]));
    open();
    await screen.findByText('Result 1');
    await waitFor(() => expect(searchApi.getSuggestions).toHaveBeenCalled());
    expect(screen.queryByRole('navigation', { name: 'Related searches' })).not.toBeInTheDocument();
    expect(screen.queryByText('Try these')).not.toBeInTheDocument();
    expect(screen.queryByText('search ranking explained')).not.toBeInTheDocument();
  });

  it('belong to the All tab: Videos has none', async () => {
    searchApi.search.mockResolvedValue({ ...answer([]), external: null });
    searchApi.getSuggestions.mockResolvedValue([{ text: 'python tutorial' }]);
    open('/search?q=python&category=videos');
    await waitFor(() => expect(searchApi.search).toHaveBeenCalled());
    expect(screen.queryByRole('navigation', { name: 'Related searches' })).not.toBeInTheDocument();
  });
});
