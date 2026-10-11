import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ExternalPlaceResults } from './ExternalVerticals';
import PlacesMap, { hasValidCoordinates, project, fitView } from './PlacesMap';
import SearchResults from '../../pages/SearchResults/SearchResults';
import { searchApi } from '../../services/searchApi';

/**
 * The small map above the Maps results: drawn from the coordinates the
 * results already have, one numbered marker per place that has a location,
 * with the place cards underneath exactly as before. All data is mocked;
 * nothing here calls SerpApi.
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
  id: `place-${n}`,
  title: `Place ${n}`,
  address: `${n} Anna Salai, Chennai`,
  rating: 4.4,
  reviews: 1245,
  phone: '+91 44 1234 5678',
  website: `https://place${n}.example/`,
  category: 'Restaurant',
  latitude: 13.04 + n / 100,
  longitude: 80.23 + n / 100,
  hours: 'Open ⋅ Closes 11 PM',
  thumbnailUrl: null,
  mapsUrl: `https://www.google.com/maps/search/?api=1&query=Place+${n}`,
  position: n,
  source: 'serpapi',
  ...overrides
});

const map = () => screen.queryByRole('region', { name: 'Map of the places found' });
const markers = () => [...document.querySelectorAll('.ph-ext-map-marker')];
const tiles = () => [...document.querySelectorAll('.ph-ext-map-tiles img')];
/** A marker's position inside the 640×260 map the tests render. */
const positionOf = marker => ({
  left: parseFloat(marker.style.left),
  top: parseFloat(marker.style.top)
});

describe('coordinates', () => {
  it.each([
    [{ latitude: 13.05, longitude: 80.25 }, true],
    [{ latitude: -33.86, longitude: 151.2 }, true],
    [{ latitude: null, longitude: null }, false],
    [{ latitude: 13.05, longitude: null }, false],
    [{ latitude: '13.05', longitude: '80.25' }, false],
    [{ latitude: NaN, longitude: 80 }, false],
    [{ latitude: 91, longitude: 80 }, false],
    [{ latitude: 13, longitude: 181 }, false],
    [{ latitude: 0, longitude: 0 }, false],
    [{}, false],
    [null, false]
  ])('%j → %s', (value, expected) => {
    expect(hasValidCoordinates(value)).toBe(expected);
  });

  it('projects the way web maps do', () => {
    expect(project(0, 0, 0)).toEqual({ x: 128, y: 128 });
    expect(project(0, -180, 1).x).toBe(0);
    expect(project(0, 180, 1).x).toBe(512);
    // North is up: a higher latitude is a smaller y.
    expect(project(13.1, 80, 10).y).toBeLessThan(project(13.0, 80, 10).y);
  });
});

describe('fitting the view', () => {
  const pixelsAt = (points, view, width, height) =>
    points.map(p => {
      const scale = 2 ** view.zoom;
      const pixel = project(p.latitude, p.longitude, view.zoom);
      return {
        left: pixel.x - (view.center.x * scale - width / 2),
        top: pixel.y - (view.center.y * scale - height / 2)
      };
    });

  it('centres a single place, close in', () => {
    const points = [{ latitude: 13.05, longitude: 80.28 }];
    const view = fitView(points, 640, 260);
    expect(view.zoom).toBe(16);
    const [pixel] = pixelsAt(points, view, 640, 260);
    expect(pixel.left).toBeCloseTo(320, 3);
    expect(pixel.top).toBeCloseTo(130, 3);
  });

  it('fits several places inside the picture, as close as they allow', () => {
    const points = [
      { latitude: 13.03, longitude: 80.24 },
      { latitude: 13.06, longitude: 80.27 },
      { latitude: 13.08, longitude: 80.21 }
    ];
    const view = fitView(points, 640, 260);
    for (const pixel of pixelsAt(points, view, 640, 260)) {
      expect(pixel.left).toBeGreaterThanOrEqual(0);
      expect(pixel.left).toBeLessThanOrEqual(640);
      expect(pixel.top).toBeGreaterThanOrEqual(0);
      expect(pixel.top).toBeLessThanOrEqual(260);
    }
    // One level closer and they would no longer fit.
    const closer = { ...view, zoom: view.zoom + 1 };
    const spread = pixelsAt(points, closer, 640, 260);
    const tooWide =
      Math.max(...spread.map(p => p.left)) - Math.min(...spread.map(p => p.left)) > 640 - 88;
    const tooTall =
      Math.max(...spread.map(p => p.top)) - Math.min(...spread.map(p => p.top)) > 260 - 88;
    expect(tooWide || tooTall).toBe(true);
  });

  it('does not zoom out past a sensible limit for places far apart', () => {
    const view = fitView(
      [
        { latitude: 13.05, longitude: 80.25 },
        { latitude: 51.5, longitude: -0.12 },
        { latitude: -33.86, longitude: 151.2 }
      ],
      320,
      200
    );
    expect(view.zoom).toBeGreaterThanOrEqual(3);
  });

  it('works at a phone width', () => {
    const points = [1, 2, 3, 4, 5].map(n => ({ latitude: 13 + n / 50, longitude: 80.2 + n / 60 }));
    const view = fitView(points, 288, 200);
    for (const pixel of pixelsAt(points, view, 288, 200)) {
      expect(pixel.left).toBeGreaterThanOrEqual(0);
      expect(pixel.left).toBeLessThanOrEqual(288);
    }
  });
});

describe('the map above the results', () => {
  it('shows a map with a numbered marker for each place, and the cards below it', () => {
    render(<ExternalPlaceResults results={[place(1), place(2), place(3)]} />);
    expect(map()).toBeInTheDocument();
    expect(markers().map(m => m.textContent)).toEqual(['1', '2', '3']);
    expect(markers().map(m => m.getAttribute('aria-label'))).toEqual([
      '1. Place 1',
      '2. Place 2',
      '3. Place 3'
    ]);
    expect(screen.getByText('3 places on the map')).toBeInTheDocument();
    // The cards are still there, after the map.
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(map().compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws OpenStreetMap tiles and credits them — no key, no map script', () => {
    render(<ExternalPlaceResults results={[place(1), place(2)]} />);
    expect(tiles().length).toBeGreaterThan(0);
    for (const tile of tiles()) {
      expect(tile.getAttribute('src')).toMatch(
        /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/
      );
      expect(tile.getAttribute('src')).not.toMatch(/key=|token=|api_key/i);
    }
    expect(screen.getByRole('link', { name: /OpenStreetMap contributors/ })).toHaveAttribute(
      'href',
      'https://www.openstreetmap.org/copyright'
    );
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.querySelector('script[src*="maps"]')).toBeNull();
  });

  it('places every marker inside the picture', () => {
    render(<ExternalPlaceResults results={[1, 2, 3, 4, 5, 6].map(n => place(n))} />);
    expect(markers()).toHaveLength(6);
    for (const marker of markers()) {
      const { left, top } = positionOf(marker);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(640);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top).toBeLessThanOrEqual(260);
    }
  });

  it('centres a single place', () => {
    render(<ExternalPlaceResults results={[place(1)]} />);
    expect(markers()).toHaveLength(1);
    const { left, top } = positionOf(markers()[0]);
    expect(left).toBeCloseTo(320, 0);
    expect(top).toBeCloseTo(130, 0);
    expect(screen.getByText('1 place on the map')).toBeInTheDocument();
  });

  it('gives no marker to a place without usable coordinates, and says how many', () => {
    render(
      <ExternalPlaceResults
        results={[
          place(1),
          place(2, { latitude: null, longitude: null }),
          place(3, { latitude: 200, longitude: 80 }),
          place(4, { latitude: 0, longitude: 0 }),
          place(5)
        ]}
      />
    );
    // Numbers still match the cards: the first and the fifth.
    expect(markers().map(m => m.textContent)).toEqual(['1', '5']);
    expect(screen.getByText('2 places on the map · 3 without a location')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('shows no map at all when no place has coordinates — only the cards', () => {
    render(
      <ExternalPlaceResults
        results={[place(1, { latitude: null, longitude: null }), place(2, { latitude: null })]}
      />
    );
    expect(map()).not.toBeInTheDocument();
    expect(tiles()).toHaveLength(0);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows the usual empty state, and no map, when nothing was found', () => {
    render(<ExternalPlaceResults results={[]} />);
    expect(screen.getByText('No places found for this search.')).toBeInTheDocument();
    expect(map()).not.toBeInTheDocument();
    expect(tiles()).toHaveLength(0);
  });

  it('survives junk', () => {
    expect(() => render(<PlacesMap places={[{}, { id: 'x', title: 'X' }]} />)).not.toThrow();
    expect(map()).not.toBeInTheDocument();
  });
});

describe('marker interaction', () => {
  it('clicking a marker shows what the result already says about the place', () => {
    render(<ExternalPlaceResults results={[place(1), place(2)]} />);
    fireEvent.click(screen.getByRole('button', { name: '2. Place 2' }));
    const popup = screen.getByRole('group', { name: 'Place 2' });
    expect(within(popup).getByText('2. Place 2')).toBeInTheDocument();
    expect(within(popup).getByLabelText('Rated 4.4 out of 5')).toHaveTextContent('4.4');
    expect(within(popup).getByText(/Restaurant/)).toBeInTheDocument();
    expect(within(popup).getByText('2 Anna Salai, Chennai')).toBeInTheDocument();
    const link = within(popup).getByRole('link', { name: /View on Maps/ });
    expect(link).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=Place+2');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('button', { name: '2. Place 2' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('shows only what exists, and never an unsafe link', () => {
    render(
      <ExternalPlaceResults
        results={[
          place(1, { rating: null, category: null, address: null, mapsUrl: 'javascript:alert(1)' })
        ]}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '1. Place 1' }));
    const popup = screen.getByRole('group', { name: 'Place 1' });
    expect(within(popup).queryByText(/Rated/)).not.toBeInTheDocument();
    expect(within(popup).queryByRole('link')).not.toBeInTheDocument();
    expect(popup.innerHTML).not.toMatch(/javascript:/);
  });

  it('another marker replaces the popup; the same marker or ✕ closes it', () => {
    render(<ExternalPlaceResults results={[place(1), place(2)]} />);
    fireEvent.click(screen.getByRole('button', { name: '1. Place 1' }));
    fireEvent.click(screen.getByRole('button', { name: '2. Place 2' }));
    expect(screen.queryByRole('group', { name: 'Place 1' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Place 2' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '2. Place 2' }));
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1. Place 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close place details' }));
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('zoom buttons redraw the map without asking the search API for anything', () => {
    render(<ExternalPlaceResults results={[place(1), place(2)]} />);
    const before = tiles()[0].getAttribute('src');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(tiles()[0].getAttribute('src')).not.toBe(before);
    expect(markers()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(tiles()[0].getAttribute('src')).toBe(before);
    expect(searchApi.search).not.toHaveBeenCalled();
  });
});

describe('the place cards are unchanged', () => {
  it('still show name, rating, reviews, category, address, hours, phone, coordinates and View on Maps', () => {
    render(<ExternalPlaceResults results={[place(1)]} />);
    const card = screen.getByRole('listitem');
    expect(within(card).getByRole('heading', { name: 'Place 1' })).toBeInTheDocument();
    expect(within(card).getByText('4.4')).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: 'Rated 4.4 out of 5' })).toBeInTheDocument();
    expect(within(card).getByText('1,245 reviews')).toBeInTheDocument();
    expect(within(card).getByText('Restaurant')).toBeInTheDocument();
    expect(within(card).getByText(/1 Anna Salai, Chennai/)).toBeInTheDocument();
    expect(within(card).getByText(/Open ⋅ Closes 11 PM/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: '+91 44 1234 5678' })).toHaveAttribute(
      'href',
      'tel:+914412345678'
    );
    expect(within(card).getByText(/13\.05000, 80\.24000/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /View on Maps/ })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=Place+1'
    );
    expect(within(card).getByRole('link', { name: /Website/ })).toHaveAttribute(
      'href',
      'https://place1.example/'
    );
  });
});

describe('only the Maps tab has a map', () => {
  const response = (results, extra = {}) => ({
    results,
    total: results.length,
    latency: '0.2s',
    pagination: {
      page: 1,
      limit: 10,
      totalResults: results.length,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false
    },
    ...extra
  });
  const external = { provider: 'serpapi', status: 'ok', count: 2 };
  const BY_TAB = {
    all: response([
      {
        id: 'w1',
        url: 'https://example.org/a',
        domain: 'example.org',
        title: 'Web result',
        snippet: 's',
        category: 'Web Result'
      }
    ]),
    images: response(
      [
        {
          id: 'i1',
          title: 'Image 1',
          thumbnailUrl: 'https://t.example/1.jpg',
          sourceUrl: 'https://s.example/1',
          sourceDomain: 's.example'
        }
      ],
      { external }
    ),
    videos: response(
      [
        {
          id: 'v1',
          title: 'Video 1',
          videoUrl: 'https://www.youtube.com/watch?v=1',
          sourceDomain: 'youtube.com'
        }
      ],
      { external }
    ),
    news: response([
      {
        id: 'n1',
        url: 'https://news.example/a',
        title: 'News 1',
        snippet: 's',
        domain: 'news.example',
        source: 'news.example'
      }
    ]),
    maps: response([place(1), place(2)], { external })
  };
  const renderTab = tab =>
    render(
      <MemoryRouter
        initialEntries={[`/search?q=chennai${tab === 'all' ? '' : `&category=${tab}`}`]}
      >
        <SearchResults />
      </MemoryRouter>
    );

  beforeEach(() => {
    searchApi.search.mockReset();
    searchApi.search.mockImplementation(async (_q, category) => BY_TAB[category]);
    searchApi.getAiAnswer.mockResolvedValue({ status: 'disabled', sources: [] });
  });

  it.each([
    ['all', 'Web result'],
    ['images', 'Image 1'],
    ['videos', 'Video 1'],
    ['news', 'News 1']
  ])('the %s tab renders as before, with no map and no map tiles', async (tab, text) => {
    renderTab(tab);
    expect(await screen.findAllByText(text)).not.toHaveLength(0);
    expect(map()).not.toBeInTheDocument();
    expect(tiles()).toHaveLength(0);
    expect(markers()).toHaveLength(0);
  });

  it('the Maps tab shows the map above its results, from one search request', async () => {
    renderTab('maps');
    await waitFor(() => expect(map()).toBeInTheDocument());
    expect(markers()).toHaveLength(2);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(searchApi.search).toHaveBeenCalledTimes(1);
    expect(searchApi.search).toHaveBeenCalledWith('chennai', 'maps', expect.any(Object));
    // Using the map asks for nothing more.
    fireEvent.click(screen.getByRole('button', { name: '1. Place 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(searchApi.search).toHaveBeenCalledTimes(1);
  });

  it('leaving the Maps tab removes the map', async () => {
    renderTab('maps');
    await waitFor(() => expect(map()).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /Videos/ }));
    await screen.findByText('Video 1');
    expect(map()).not.toBeInTheDocument();
    expect(tiles()).toHaveLength(0);
  });
});
