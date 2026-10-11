import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import Home from './Home';
import { searchApi } from '../../services/searchApi';

/**
 * The homepage's "Trending now" card: live trends from the API, a quiet
 * loading state, a plain "temporarily unavailable" note when there are no
 * real trends — never placeholder topics — and a click that goes through
 * the ordinary search page. The rest of the homepage is
 * untouched and keeps working whatever the trends API does.
 */

vi.mock('../../services/searchApi', () => ({
  searchApi: { getTrending: vi.fn(), getHistory: vi.fn() }
}));
vi.mock('../../components/Header/Header', () => ({ default: () => <div data-testid="header" /> }));
vi.mock('../../components/SearchBar/SearchBar', () => ({
  default: () => <div data-testid="searchbar" />
}));
const authState = vi.hoisted(() => ({ isAdmin: false, isAuthenticated: false }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => authState }));

const NOW = Date.parse('2026-10-07T10:05:00Z');
const live = (overrides = {}) => ({
  region: 'IN',
  updatedAt: '2026-10-07T10:00:00Z',
  trends: [
    { title: 'india vs australia', query: 'india vs australia' },
    { title: 'gold rate today', query: 'gold rate today' },
    { title: 'diwali 2026', query: 'diwali 2026' }
  ],
  source: 'serpapi',
  stale: false,
  ...overrides
});

function renderHome() {
  let location;
  function SearchPage() {
    location = useLocation();
    return <p>search page</p>;
  }
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/search" element={<SearchPage />} />
      </Routes>
    </MemoryRouter>
  );
  return () => location;
}

/** The Trending card, found by its heading. */
const card = () =>
  screen.getByRole('heading', { name: 'Trending now' }).closest('.ph-feature-card');

beforeEach(() => {
  localStorage.clear();
  searchApi.getTrending.mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => vi.restoreAllMocks());

describe('Trending now — live trends', () => {
  it('asks for India by default and shows the trends it gets', async () => {
    searchApi.getTrending.mockResolvedValue(live());
    renderHome();
    expect(await within(card()).findByRole('button', { name: 'india vs australia' })).toBeVisible();
    expect(within(card()).getByRole('button', { name: 'gold rate today' })).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: 'diwali 2026' })).toBeInTheDocument();
    expect(searchApi.getTrending).toHaveBeenCalledTimes(1);
    expect(searchApi.getTrending).toHaveBeenCalledWith('IN');
    // The fixed topics are gone once real ones are in.
    expect(within(card()).queryByRole('button', { name: 'AI tools' })).not.toBeInTheDocument();
  });

  it('shows when the trends were really fetched', async () => {
    searchApi.getTrending.mockResolvedValue(live());
    renderHome();
    expect(await within(card()).findByText('Updated 5 min ago')).toBeInTheDocument();
  });

  it.each([
    ['2026-10-07T10:04:40Z', 'Updated just now'],
    ['2026-10-07T09:20:00Z', 'Updated 45 min ago'],
    ['2026-10-07T08:05:00Z', 'Updated 2 hours ago'],
    ['2026-10-06T09:05:00Z', 'Updated 1 day ago']
  ])('%s → %s', async (updatedAt, text) => {
    searchApi.getTrending.mockResolvedValue(live({ updatedAt }));
    renderHome();
    expect(await within(card()).findByText(text)).toBeInTheDocument();
  });

  it('keeps the card small: at most five trends', async () => {
    searchApi.getTrending.mockResolvedValue(
      live({
        trends: Array.from({ length: 12 }, (_, i) => ({ title: `trend ${i}`, query: `trend ${i}` }))
      })
    );
    renderHome();
    await within(card()).findByRole('button', { name: 'trend 0' });
    expect(within(card()).getAllByRole('button')).toHaveLength(5);
  });

  it.each([
    ['USA', 'US'],
    ['Australia', 'AU'],
    ['India', 'IN'],
    ['Global', 'IN']
  ])('with the region %s chosen in Settings, asks for %s', async (region, code) => {
    localStorage.setItem('ph-search:preferences', JSON.stringify({ region }));
    searchApi.getTrending.mockResolvedValue(live({ region: code }));
    renderHome();
    await waitFor(() => expect(searchApi.getTrending).toHaveBeenCalledWith(code));
  });

  it('renders a trend as text, never as markup', async () => {
    searchApi.getTrending.mockResolvedValue(
      live({ trends: [{ title: '<img src=x onerror=alert(1)>', query: 'x' }] })
    );
    renderHome();
    expect(await within(card()).findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(card().querySelector('img')).toBeNull();
  });
});

describe('Trending now — loading', () => {
  it('shows a quiet loading line, and the rest of the homepage is already there', () => {
    searchApi.getTrending.mockReturnValue(new Promise(() => {}));
    renderHome();
    expect(within(card()).getByRole('status')).toHaveTextContent('Loading trends…');
    expect(within(card()).queryAllByRole('button')).toHaveLength(0);
    // Nothing else waits for the trends.
    expect(screen.getByTestId('searchbar')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'AI answers' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Trending now' })).toBeInTheDocument();
  });
});

describe('Trending now — when trends cannot be had', () => {
  it.each([
    ['the request failed', null],
    [
      'the provider is switched off',
      live({ trends: [], updatedAt: null, source: 'none', reason: 'disabled' })
    ],
    [
      'the API has no trends',
      live({ trends: [], updatedAt: null, source: 'none', reason: 'timeout' })
    ],
    ['the reply is unusable', live({ trends: [{ nope: true }, null] })]
  ])('%s: says trending is unavailable, with no placeholder topics', async (_label, value) => {
    searchApi.getTrending.mockResolvedValue(value);
    renderHome();
    const note = await within(card()).findByText('Trending is temporarily unavailable.');
    expect(note.closest('[role="status"]')).toHaveTextContent(/check back later/);
    // Nothing is offered as a trend: no chips at all, and not the old fixed topics.
    expect(within(card()).queryAllByRole('button')).toHaveLength(0);
    for (const topic of ['AI tools', 'Search systems', 'React', 'Cloud']) {
      expect(screen.queryByText(topic)).not.toBeInTheDocument();
    }
    expect(within(card()).queryByText(/Updated/)).not.toBeInTheDocument();
    // A quiet note, not an error: the homepage is whole.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Trending now' })).toBeInTheDocument();
    expect(screen.getByTestId('searchbar')).toBeInTheDocument();
    expect(document.querySelectorAll('.ph-feature-card')).toHaveLength(3);
  });

  it('stale trends from the server are still shown, with their real age', async () => {
    searchApi.getTrending.mockResolvedValue(
      live({ stale: true, reason: 'daily_limit', updatedAt: '2026-10-07T07:05:00Z' })
    );
    renderHome();
    expect(
      await within(card()).findByRole('button', { name: 'gold rate today' })
    ).toBeInTheDocument();
    expect(within(card()).getByText('Updated 3 hours ago')).toBeInTheDocument();
  });

  it('live trends replace the note when the API has them again', async () => {
    searchApi.getTrending.mockResolvedValue(live());
    renderHome();
    await within(card()).findByRole('button', { name: 'gold rate today' });
    expect(within(card()).queryByText(/temporarily unavailable/)).not.toBeInTheDocument();
  });
});

describe('Trending now — clicking a trend', () => {
  it('goes to the normal search page with that query', async () => {
    searchApi.getTrending.mockResolvedValue(live());
    const where = renderHome();
    fireEvent.click(await within(card()).findByRole('button', { name: 'india vs australia' }));
    expect(await screen.findByText('search page')).toBeInTheDocument();
    expect(where().pathname).toBe('/search');
    expect(new URLSearchParams(where().search).get('q')).toBe('india vs australia');
  });

  it('searches the query the API gave, encoded safely', async () => {
    searchApi.getTrending.mockResolvedValue(
      live({ trends: [{ title: 'C++ & Rust?', query: 'c++ & rust?' }] })
    );
    const where = renderHome();
    fireEvent.click(await within(card()).findByRole('button', { name: 'C++ & Rust?' }));
    await screen.findByText('search page');
    expect(new URLSearchParams(where().search).get('q')).toBe('c++ & rust?');
  });
});

describe('the rest of the homepage', () => {
  it('the other two cards are as they were', async () => {
    searchApi.getTrending.mockResolvedValue(live());
    renderHome();
    await within(card()).findByRole('button', { name: 'india vs australia' });
    expect(screen.getByRole('heading', { name: 'AI answers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try an AI answer/ })).toBeInTheDocument();
    expect(document.querySelectorAll('.ph-feature-card')).toHaveLength(3);
  });

  it('website shortcuts sit under the search box; the search box and buttons are as they were', async () => {
    window.localStorage.clear();
    searchApi.getTrending.mockResolvedValue(live());
    renderHome();
    const shortcuts = screen.getByRole('region', { name: 'Website shortcuts' });
    expect(within(shortcuts).getByRole('button', { name: 'Add shortcut' })).toBeInTheDocument();
    expect(within(shortcuts).getByRole('link', { name: 'Wikipedia' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Feeling Curious/ })).toBeInTheDocument();
    expect(screen.getByTestId('searchbar')).toBeInTheDocument();
    // Between the search area and the feature cards.
    const cards = document.querySelector('.ph-home-features-grid');
    expect(
      shortcuts.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    await within(card()).findByRole('button', { name: 'india vs australia' });
  });
});

describe('Recent searches', () => {
  beforeEach(() => {
    searchApi.getTrending.mockResolvedValue(null);
    searchApi.getHistory.mockReset();
  });
  afterEach(() => {
    authState.isAuthenticated = false;
  });
  const recentCard = () =>
    screen.getByRole('heading', { name: 'Recent searches' }).closest('.ph-feature-card');

  it('signed out: no sample topics, a prompt to sign in, and no history request', () => {
    renderHome();
    const card = within(recentCard());
    expect(card.getByText('Sign in to see your recent searches here.')).toBeInTheDocument();
    expect(card.getByRole('link', { name: /Sign in/ })).toHaveAttribute('href', '/login');
    expect(card.queryAllByRole('button')).toHaveLength(0);
    for (const sample of ['Google architecture', 'AI email agent', 'React tutorials']) {
      expect(screen.queryByText(sample)).not.toBeInTheDocument();
    }
    expect(searchApi.getHistory).not.toHaveBeenCalled();
  });

  it('signed in: the user’s own latest searches, each once, at most three', async () => {
    authState.isAuthenticated = true;
    searchApi.getHistory.mockResolvedValue({
      history: [
        { query: 'red pandas' },
        { query: 'Red Pandas' },
        { query: 'theory of relativity' },
        { query: 'node.js' },
        { query: 'mongodb' }
      ],
      error: null
    });
    renderHome();
    const card = within(recentCard());
    await card.findByRole('button', { name: 'red pandas' });
    expect(card.getAllByRole('button').map(b => b.textContent)).toEqual([
      'red pandas',
      'theory of relativity',
      'node.js'
    ]);
    expect(card.getByRole('link', { name: /View history/ })).toHaveAttribute('href', '/history');
  });

  it('signed in with no history yet: says so', async () => {
    authState.isAuthenticated = true;
    searchApi.getHistory.mockResolvedValue({ history: [], error: null });
    renderHome();
    expect(
      await within(recentCard()).findByText('Your searches will appear here.')
    ).toBeInTheDocument();
  });

  it('when the history cannot be loaded: says so, and the page still works', async () => {
    authState.isAuthenticated = true;
    searchApi.getHistory.mockResolvedValue({ history: [], error: 'down' });
    renderHome();
    expect(
      await within(recentCard()).findByText('Your recent searches cannot be loaded right now.')
    ).toBeInTheDocument();
    expect(screen.getByTestId('searchbar')).toBeInTheDocument();
  });
});
