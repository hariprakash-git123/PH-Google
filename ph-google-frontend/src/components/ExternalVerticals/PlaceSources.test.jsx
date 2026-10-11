import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SearchResults from '../../pages/SearchResults/SearchResults';
import { ExternalPlaceResults } from './ExternalVerticals';
import { searchApi } from '../../services/searchApi';

/**
 * Places that come from a page's own description rather than a places
 * provider: each card links to the page its details were read from, a place
 * whose page gave no coordinates is listed without a pin, and the Maps tab
 * tells "found nothing", "not available right now" and "switched off" apart.
 */

vi.mock('../../services/searchApi', () => ({
  searchApi: {
    search: vi.fn(),
    getAiAnswer: vi.fn(),
    sendAiFeedback: vi.fn(),
    getSuggestions: vi.fn(async () => [])
  }
}));
vi.mock('../Header/Header', () => ({ default: () => <div data-testid="header" /> }));
vi.mock('../Filters/Filters', () => ({ default: () => null }));
vi.mock('../AIAnswer/AIAnswer', () => ({ default: () => <div data-testid="ai-answer" /> }));

const place = (n, overrides = {}) => ({
  id: `parallel-place:${n}`,
  title: `Place ${n}`,
  address: `${n} DB Road, Coimbatore`,
  rating: null,
  reviews: null,
  phone: null,
  website: null,
  category: 'Restaurant',
  latitude: 11.0 + n / 100,
  longitude: 76.95 + n / 100,
  hours: null,
  thumbnailUrl: null,
  sourceUrl: `https://dir.example/place-${n}`,
  sourceDomain: 'dir.example',
  mapsUrl: `https://www.openstreetmap.org/?mlat=${11.0 + n / 100}&mlon=${76.95 + n / 100}#map=17/11/76`,
  position: n,
  source: 'parallel',
  ...overrides
});
const unplaced = (n, overrides = {}) =>
  place(n, {
    latitude: null,
    longitude: null,
    mapsUrl: `https://www.openstreetmap.org/search?query=Place%20${n}`,
    ...overrides
  });

const markers = () => [...document.querySelectorAll('.ph-ext-map-marker')];
const map = () => screen.queryByRole('region', { name: 'Map of the places found' });
const cards = () => screen.getAllByRole('listitem');

describe('the source of a place', () => {
  it('each card links to the page its details come from, in a new tab', () => {
    render(<ExternalPlaceResults results={[place(1), place(2)]} />);
    const link = within(cards()[1]).getByRole('link', { name: /Source: dir\.example/ });
    expect(link).toHaveAttribute('href', 'https://dir.example/place-2');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
  });

  it('a result with no source page has no source link (provider results are unchanged)', () => {
    render(
      <ExternalPlaceResults
        results={[place(1, { sourceUrl: undefined, sourceDomain: undefined })]}
      />
    );
    expect(screen.queryByRole('link', { name: /Source/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View on Maps/ })).toBeInTheDocument();
  });

  it('never links an unsafe source address', () => {
    render(<ExternalPlaceResults results={[place(1, { sourceUrl: 'javascript:alert(1)' })]} />);
    expect(screen.queryByRole('link', { name: /Source/ })).not.toBeInTheDocument();
  });

  it('View on Maps goes to the place’s own coordinates', () => {
    render(<ExternalPlaceResults results={[place(1)]} />);
    expect(screen.getByRole('link', { name: /View on Maps/ })).toHaveAttribute(
      'href',
      place(1).mapsUrl
    );
  });
});

describe('a place without coordinates', () => {
  it('is listed with its details and its source, says so, and gets no pin', () => {
    render(
      <ExternalPlaceResults results={[place(1), unplaced(2, { phone: '+91 422 249 0000' })]} />
    );
    expect(cards()).toHaveLength(2);
    const card = cards()[1];
    expect(within(card).getByRole('heading', { name: 'Place 2' })).toBeInTheDocument();
    expect(within(card).getByText(/2 DB Road, Coimbatore/)).toBeInTheDocument();
    expect(within(card).getByText('+91 422 249 0000')).toBeInTheDocument();
    expect(within(card).getByText(/No map location published for this place/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /Source: dir\.example/ })).toBeInTheDocument();
    // One pin, for the one place that has a position — numbered as its card is.
    expect(markers().map(m => m.getAttribute('aria-label'))).toEqual(['1. Place 1']);
    expect(screen.getByText(/1 place on the map · 1 without a location/)).toBeInTheDocument();
  });

  it('a pin is never drawn from made-up, zero or out-of-range coordinates', () => {
    render(
      <ExternalPlaceResults
        results={[
          place(1, { latitude: 0, longitude: 0 }),
          place(2, { latitude: '11.01', longitude: '76.96' }),
          place(3, { latitude: 95, longitude: 76.96 }),
          place(4, { latitude: NaN, longitude: 76.96 }),
          place(5)
        ]}
      />
    );
    expect(markers().map(m => m.textContent)).toEqual(['5']);
    expect(cards()).toHaveLength(5);
  });

  it('with no place that has a position there is no map at all — only the cards', () => {
    render(<ExternalPlaceResults results={[unplaced(1), unplaced(2)]} />);
    expect(map()).not.toBeInTheDocument();
    expect(cards()).toHaveLength(2);
    expect(document.querySelectorAll('.ph-ext-map-tiles img')).toHaveLength(0);
  });
});

describe('a place whose location could not be verified', () => {
  const unverified = (n, overrides = {}) =>
    unplaced(n, { locationStatus: 'unverified', locationReason: 'outside_locality', ...overrides });

  it('keeps its card, its details and its source, says why it has no pin, and gets none', () => {
    render(
      <ExternalPlaceResults
        results={[
          place(1, { locationStatus: 'verified', locationEvidence: 'openstreetmap' }),
          unverified(2, { title: 'Spice Garden Station Road', rating: 4.1, reviews: 57 })
        ]}
      />
    );
    const card = cards()[1];
    expect(
      within(card).getByRole('heading', { name: 'Spice Garden Station Road' })
    ).toBeInTheDocument();
    expect(within(card).getByText(/2 DB Road, Coimbatore/)).toBeInTheDocument();
    expect(within(card).getByText('4.1')).toBeInTheDocument();
    expect(
      within(card).getByText(/Location could not be verified, so it is not shown on the map/)
    ).toBeInTheDocument();
    expect(within(card).queryByText(/No map location published/)).not.toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /Source: dir\.example/ })).toBeInTheDocument();
    // Its "View on Maps" is a search for it by name — not a position.
    expect(within(card).getByRole('link', { name: /View on Maps/ })).toHaveAttribute(
      'href',
      'https://www.openstreetmap.org/search?query=Place%202'
    );
    expect(markers().map(m => m.getAttribute('aria-label'))).toEqual(['1. Place 1']);
    expect(screen.getByText(/1 place on the map · 1 without a location/)).toBeInTheDocument();
  });

  it('a place whose page simply gave no position says that instead', () => {
    render(<ExternalPlaceResults results={[unplaced(1, { locationStatus: 'missing' })]} />);
    expect(screen.getByText(/No map location published for this place/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be verified/)).not.toBeInTheDocument();
  });

  it('a verified place shows its coordinates and neither note', () => {
    render(<ExternalPlaceResults results={[place(1, { locationStatus: 'verified' })]} />);
    expect(
      screen.queryByText(/could not be verified|No map location published/)
    ).not.toBeInTheDocument();
    expect(markers()).toHaveLength(1);
  });

  it('a place from OpenStreetMap links to its OpenStreetMap entry as its source', () => {
    render(
      <ExternalPlaceResults
        results={[
          place(1, {
            source: 'osm',
            sourceUrl: 'https://www.openstreetmap.org/node/1001',
            sourceDomain: 'openstreetmap.org',
            locationStatus: 'verified',
            locationEvidence: 'map'
          })
        ]}
      />
    );
    expect(screen.getByRole('link', { name: /Source: openstreetmap\.org/ })).toHaveAttribute(
      'href',
      'https://www.openstreetmap.org/node/1001'
    );
  });
});

describe('a pin belongs to its place', () => {
  it('clicking pin N shows the details of card N, with its map link and its source', () => {
    render(
      <ExternalPlaceResults
        results={[place(1), unplaced(2), place(3, { title: 'Haribhavanam' })]}
      />
    );
    // The third card is the second pin, and keeps the number 3.
    expect(markers().map(m => m.textContent)).toEqual(['1', '3']);
    fireEvent.click(screen.getByRole('button', { name: '3. Haribhavanam' }));
    const popup = screen.getByRole('group', { name: 'Haribhavanam' });
    expect(within(popup).getByText('3. Haribhavanam')).toBeInTheDocument();
    expect(within(popup).getByText('3 DB Road, Coimbatore')).toBeInTheDocument();
    expect(within(popup).getByRole('link', { name: /View on Maps/ })).toHaveAttribute(
      'href',
      place(3).mapsUrl
    );
    expect(within(popup).getByRole('link', { name: /Source: dir\.example/ })).toHaveAttribute(
      'href',
      'https://dir.example/place-3'
    );
  });
});

describe('the Maps tab', () => {
  const response = (results, external) => ({
    results,
    total: results.length,
    latency: '0.500s',
    pagination: {
      page: 1,
      limit: 10,
      totalResults: results.length,
      totalPages: results.length > 0 ? 1 : 0,
      hasNextPage: false,
      hasPreviousPage: false
    },
    external
  });
  const open = () =>
    render(
      <MemoryRouter initialEntries={['/search?q=Coimbatore%20restaurants&category=maps']}>
        <SearchResults />
      </MemoryRouter>
    );

  beforeEach(() => {
    searchApi.search.mockReset();
    searchApi.getAiAnswer.mockResolvedValue({ status: 'disabled', sources: [] });
  });

  it('shows the map and the cards for places found without a places provider', async () => {
    searchApi.search.mockResolvedValue(
      response([place(1), unplaced(2)], {
        provider: 'parallel',
        status: 'ok',
        count: 2,
        indexCount: 0
      })
    );
    open();
    expect(await screen.findByRole('heading', { name: 'Place 1' })).toBeInTheDocument();
    expect(searchApi.search).toHaveBeenCalledWith(
      'Coimbatore restaurants',
      'maps',
      expect.any(Object)
    );
    expect(map()).toBeInTheDocument();
    expect(markers()).toHaveLength(1);
    expect(cards()).toHaveLength(2);
  });

  it.each([
    [
      'the search ran and found nothing',
      { provider: 'parallel', status: 'ok', count: 0, indexCount: 0 },
      'No places found for this search.'
    ],
    [
      'the provider failed',
      { provider: 'parallel', status: 'unavailable', count: 0, indexCount: 0, reason: 'timeout' },
      'No results available right now.'
    ],
    [
      'the day’s allowance is used up',
      { provider: 'parallel', status: 'skipped', count: 0, indexCount: 0, reason: 'daily_limit' },
      'No results available right now.'
    ],
    [
      'the service is switched off',
      { provider: 'serpapi', status: 'disabled', count: 0, reason: 'disabled' },
      'Map search is temporarily unavailable.'
    ]
  ])('%s', async (_label, external, text) => {
    searchApi.search.mockResolvedValue(response([], external));
    open();
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(map()).not.toBeInTheDocument();
    expect(markers()).toHaveLength(0);
  });
});
