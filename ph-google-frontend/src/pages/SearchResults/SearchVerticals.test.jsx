import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import SearchResults from './SearchResults';
import {
  ExternalImageResults,
  ExternalVideoResults,
  ExternalPlaceResults
} from '../../components/ExternalVerticals/ExternalVerticals';
import { searchApi } from '../../services/searchApi';

/**
 * The Images / Videos / Maps tabs: the URL carries the tab and keeps the
 * query, each tab asks the API for its own category, Google results render
 * in their own layouts with only safe links, and "nothing found" is told
 * apart from "nothing available right now".
 */

vi.mock('../../services/searchApi', () => ({
  searchApi: { search: vi.fn(), getAiAnswer: vi.fn(), sendAiFeedback: vi.fn() }
}));
vi.mock('../../components/Header/Header', () => ({ default: () => <div data-testid="header" /> }));
vi.mock('../../components/Filters/Filters', () => ({ default: () => null }));
vi.mock('../../components/AIAnswer/AIAnswer', () => ({
  default: () => <div data-testid="ai-answer" />
}));

const image = (n, overrides = {}) => ({
  id: `img-${n}`,
  title: `Image ${n}`,
  imageUrl: `https://pics.example/full-${n}.jpg`,
  thumbnailUrl: `https://thumbs.example/t${n}.jpg`,
  sourceUrl: `https://pics.example/page-${n}`,
  sourceDomain: 'pics.example',
  sourceName: 'Pics Example',
  width: 1200,
  height: 800,
  position: n,
  source: 'serpapi',
  ...overrides
});

const video = (n, overrides = {}) => ({
  id: `vid-${n}`,
  title: `Video ${n}`,
  thumbnailUrl: `https://i.ytimg.example/${n}.jpg`,
  videoUrl: `https://www.youtube.com/watch?v=v${n}`,
  sourceUrl: `https://www.youtube.com/watch?v=v${n}`,
  sourceDomain: 'youtube.com',
  sourceName: 'YouTube',
  duration: '12:34',
  publishedAgo: '2 weeks ago',
  position: n,
  source: 'serpapi',
  ...overrides
});

const place = (n, overrides = {}) => ({
  id: `place-${n}`,
  title: `Place ${n}`,
  address: `${n} Anna Salai, Chennai`,
  rating: 4.4,
  reviews: 1245,
  phone: '+91 44 1234 5678',
  website: `https://place${n}.example/`,
  category: 'Restaurant',
  latitude: 13.06,
  longitude: 80.25,
  hours: 'Open ⋅ Closes 11 PM',
  thumbnailUrl: null,
  mapsUrl: `https://www.google.com/maps/search/?api=1&query=Place+${n}`,
  position: n,
  source: 'serpapi',
  ...overrides
});

const response = (
  results,
  external = { provider: 'serpapi', status: 'ok', count: results.length }
) => ({
  results,
  total: results.length,
  latency: '0.500s',
  pagination: {
    page: 1,
    limit: 24,
    totalResults: results.length,
    totalPages: 1,
    hasNextPage: false,
    hasPreviousPage: false
  },
  external
});

/** Renders the page and exposes the current URL. */
function renderPage(url) {
  let location;
  function Probe() {
    location = useLocation();
    return null;
  }
  render(
    <MemoryRouter initialEntries={[url]}>
      <SearchResults />
      <Probe />
    </MemoryRouter>
  );
  return () => location;
}

beforeEach(() => {
  searchApi.search.mockReset();
  searchApi.getAiAnswer.mockResolvedValue({ status: 'disabled', sources: [] });
});

describe('vertical tabs', () => {
  it('a direct link to category=images asks for images and shows the grid', async () => {
    searchApi.search.mockResolvedValue(response([image(1), image(2)]));
    renderPage('/search?q=python&category=images');
    expect(await screen.findByAltText('Image 1')).toBeInTheDocument();
    expect(searchApi.search).toHaveBeenCalledWith('python', 'images', expect.any(Object));
    expect(screen.getByRole('tab', { name: /Images/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('still reads the older ?tab= links', async () => {
    searchApi.search.mockResolvedValue(response([video(1)]));
    renderPage('/search?q=python&tab=videos');
    await screen.findByText('Video 1');
    expect(searchApi.search).toHaveBeenCalledWith('python', 'videos', expect.any(Object));
  });

  it('changing tab keeps the query and puts the tab in the URL', async () => {
    searchApi.search.mockImplementation(async (_q, category) =>
      category === 'videos' ? response([video(1)]) : response([image(1)])
    );
    const where = renderPage('/search?q=python&category=images&page=2');
    await screen.findByAltText('Image 1');

    fireEvent.click(screen.getByRole('tab', { name: /Videos/ }));
    await screen.findByText('Video 1');
    const params = new URLSearchParams(where().search);
    expect(params.get('q')).toBe('python');
    expect(params.get('category')).toBe('videos');
    expect(params.has('page')).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    await waitFor(() => expect(new URLSearchParams(where().search).has('category')).toBe(false));
    expect(new URLSearchParams(where().search).get('q')).toBe('python');
  });

  it('an unknown category in the URL falls back to All', async () => {
    searchApi.search.mockResolvedValue(response([]));
    renderPage('/search?q=python&category=shopping');
    await waitFor(() =>
      expect(searchApi.search).toHaveBeenCalledWith('python', 'all', expect.any(Object))
    );
  });

  it('shows a layout-shaped skeleton while loading', async () => {
    searchApi.search.mockReturnValue(new Promise(() => {}));
    renderPage('/search?q=python&category=maps');
    expect(await screen.findByRole('status', { name: 'Loading places' })).toBeInTheDocument();
  });

  it('with SerpApi disabled, the crawler layouts are used as before', async () => {
    searchApi.search.mockResolvedValue(
      response([], { provider: 'serpapi', status: 'disabled', count: 0, reason: 'disabled' })
    );
    renderPage('/search?q=python&category=images');
    expect(
      await screen.findByText(/Images are indexed from the pages the crawler visits/)
    ).toBeInTheDocument();
  });
});

describe('empty states', () => {
  it.each([
    [ExternalImageResults, 'No images found for this search.'],
    [ExternalVideoResults, 'No videos found for this search.'],
    [ExternalPlaceResults, 'No places found for this search.']
  ])('%#: nothing found', (Component, text) => {
    render(<Component results={[]} unavailable={false} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('nothing available right now is a different message', () => {
    render(<ExternalImageResults results={[]} unavailable />);
    expect(screen.getByText('No results available right now.')).toBeInTheDocument();
    expect(screen.queryByText('No images found for this search.')).not.toBeInTheDocument();
  });
});

describe('Google images', () => {
  it('shows each tile as a button that lazy-loads its thumbnail and has alt text', () => {
    render(<ExternalImageResults results={[image(1), image(2, { title: '' })]} />);
    const img = screen.getByAltText('Image 1');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('src', 'https://thumbs.example/t1.jpg');
    // A tile opens the preview; it is not a link to the site any more
    // (the preview itself is covered in ImageLightbox.test.jsx).
    expect(img.closest('a')).toBeNull();
    expect(img.closest('button')).toHaveAttribute('aria-haspopup', 'dialog');
    // No title: the alt text still says what it is.
    expect(screen.getByAltText('Image from Pics Example')).toBeInTheDocument();
  });

  it('never links or loads an unsafe URL', () => {
    render(
      <ExternalImageResults
        results={[
          image(1, { sourceUrl: 'javascript:alert(1)', imageUrl: 'javascript:alert(2)' }),
          image(2, { thumbnailUrl: 'javascript:alert(3)' })
        ]}
      />
    );
    const img = screen.getByAltText('Image 1');
    expect(img.closest('a')).toBeNull();
    expect(screen.queryByAltText('Image 2')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toMatch(/javascript:/);
  });

  it('hides an image that fails to load', () => {
    render(<ExternalImageResults results={[image(1), image(2)]} />);
    fireEvent.error(screen.getByAltText('Image 1'));
    expect(screen.queryByAltText('Image 1')).not.toBeInTheDocument();
    expect(screen.getByAltText('Image 2')).toBeInTheDocument();
  });

  it('renders provider text as text, never as HTML', () => {
    render(
      <ExternalImageResults results={[image(1, { title: '<img src=x onerror=alert(1)>' })]} />
    );
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelectorAll('img[src="x"]')).toHaveLength(0);
  });
});

describe('Google videos', () => {
  it('shows thumbnail, title, source, duration and date, linking to the original page', () => {
    render(<ExternalVideoResults results={[video(1)]} />);
    expect(screen.getByText('12:34')).toBeInTheDocument();
    expect(screen.getByText('YouTube')).toBeInTheDocument();
    expect(screen.getByText(/2 weeks ago/)).toBeInTheDocument();
    const title = screen.getByRole('link', { name: 'Video 1' });
    expect(title).toHaveAttribute('href', 'https://www.youtube.com/watch?v=v1');
    expect(screen.getByRole('link', { name: 'Watch Video 1 on YouTube' })).toHaveAttribute(
      'href',
      'https://www.youtube.com/watch?v=v1'
    );
    // Linked, not embedded.
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('drops a video with no safe link', () => {
    render(
      <ExternalVideoResults
        results={[video(1, { videoUrl: 'javascript:x', sourceUrl: 'javascript:y' }), video(2)]}
      />
    );
    expect(screen.queryByText('Video 1')).not.toBeInTheDocument();
    expect(screen.getByText('Video 2')).toBeInTheDocument();
  });
});

describe('Google Maps places', () => {
  it('shows the place card with rating, reviews, address, phone, category and a maps link', () => {
    render(<ExternalPlaceResults results={[place(1)]} />);
    const card = screen.getByRole('listitem');
    expect(within(card).getByRole('heading', { name: 'Place 1' })).toBeInTheDocument();
    expect(within(card).getByText('4.4')).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: 'Rated 4.4 out of 5' })).toBeInTheDocument();
    expect(within(card).getByText('1,245 reviews')).toBeInTheDocument();
    expect(within(card).getByText(/1 Anna Salai, Chennai/)).toBeInTheDocument();
    expect(within(card).getByText('Restaurant')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: '+91 44 1234 5678' })).toHaveAttribute(
      'href',
      'tel:+914412345678'
    );
    expect(within(card).getByText(/13\.06000, 80\.25000/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /View on Maps/ })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=Place+1'
    );
  });

  it('shows only what was returned — no invented fields', () => {
    render(
      <ExternalPlaceResults
        results={[
          place(1, {
            rating: null,
            reviews: null,
            phone: null,
            website: null,
            category: null,
            latitude: null,
            longitude: null,
            hours: null,
            address: null
          })
        ]}
      />
    );
    const card = screen.getByRole('listitem');
    expect(within(card).queryByText(/review/)).not.toBeInTheDocument();
    expect(within(card).queryByRole('img', { name: /Rated/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: /Website/ })).not.toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /View on Maps/ })).toBeInTheDocument();
  });

  it('does not link unsafe website or maps URLs', () => {
    render(
      <ExternalPlaceResults
        results={[place(1, { website: 'javascript:alert(1)', mapsUrl: 'data:text/html,x' })]}
      />
    );
    expect(screen.queryByRole('link', { name: /Website/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View on Maps/ })).not.toBeInTheDocument();
  });
});
