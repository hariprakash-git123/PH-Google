import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ExternalImageResults } from './ExternalVerticals';
import { downloadUrlFor } from './ImageLightbox';
import SearchResults from '../../pages/SearchResults/SearchResults';
import { searchApi } from '../../services/searchApi';

/**
 * Image search: clicking a result opens a preview on the page instead of
 * leaving for the source site. The preview shows the full image, says what
 * it is, and offers Download (through the backend), Visit site and Open
 * original. All data is mocked; nothing calls SerpApi or a real image host.
 */

vi.mock('../../services/searchApi', () => ({
  searchApi: { search: vi.fn(), getAiAnswer: vi.fn(), sendAiFeedback: vi.fn() }
}));
vi.mock('../Header/Header', () => ({ default: () => <div data-testid="header" /> }));
vi.mock('../Filters/Filters', () => ({ default: () => null }));
vi.mock('../AIAnswer/AIAnswer', () => ({ default: () => null }));

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
  downloadToken: `token-${n}`,
  source: 'serpapi',
  ...overrides
});

const IMAGES = [image(1), image(2), image(3)];
const renderGrid = (results = IMAGES) => render(<ExternalImageResults results={results} />);
const tile = n => screen.getByAltText(`Image ${n}`).closest('button');
const open = n => fireEvent.click(tile(n));
const dialog = () => screen.getByRole('dialog');
const preview = () => within(dialog()).getByRole('img', { name: /Image/ });

beforeEach(() => {
  document.body.style.overflow = '';
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
  globalThis.URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the image grid', () => {
  it('renders the results as before: thumbnails, titles and sources', () => {
    renderGrid();
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.getByAltText('Image 1')).toHaveAttribute('src', 'https://thumbs.example/t1.jpg');
    expect(screen.getByText('Image 2')).toBeInTheDocument();
    expect(screen.getAllByText(/Pics Example/)).toHaveLength(3);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a tile is not a link, so a click cannot navigate away', () => {
    renderGrid();
    expect(tile(1).tagName).toBe('BUTTON');
    expect(tile(1)).toHaveAttribute('type', 'button');
    expect(document.querySelectorAll('.ph-image-grid a')).toHaveLength(0);
  });
});

describe('opening the preview', () => {
  it('clicking an image opens the preview and stays on the page', () => {
    const before = window.location.href;
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderGrid();
    open(2);
    expect(dialog()).toHaveAttribute('aria-modal', 'true');
    expect(window.location.href).toBe(before);
    expect(opened).not.toHaveBeenCalled();
  });

  it('shows the full image, not the thumbnail', () => {
    renderGrid();
    open(2);
    expect(preview()).toHaveAttribute('src', 'https://pics.example/full-2.jpg');
    expect(preview()).toHaveAttribute('alt', 'Image 2');
  });

  it('shows the title, the source and the dimensions the result has', () => {
    renderGrid();
    open(2);
    const box = within(dialog());
    expect(box.getByRole('heading', { name: 'Image 2' })).toBeInTheDocument();
    expect(box.getByText('Pics Example')).toBeInTheDocument();
    expect(box.getByText('1200 × 800')).toBeInTheDocument();
    expect(box.getByText('2 of 3')).toBeInTheDocument();
  });

  it('shows nothing it was not given', () => {
    renderGrid([image(1, { title: '', width: null, height: null, sourceName: '' })]);
    fireEvent.click(screen.getByAltText('Image from pics.example').closest('button'));
    const box = within(dialog());
    expect(box.queryByRole('heading')).not.toBeInTheDocument();
    expect(box.queryByText(/×/)).not.toBeInTheDocument();
    expect(box.getByText('pics.example')).toBeInTheDocument();
  });

  it('shows a loading state until the full image has loaded', () => {
    renderGrid();
    open(1);
    expect(within(dialog()).getByRole('status', { name: 'Loading image' })).toBeInTheDocument();
    fireEvent.load(preview());
    expect(
      within(dialog()).queryByRole('status', { name: 'Loading image' })
    ).not.toBeInTheDocument();
  });

  it('opens with Enter or Space on a focused tile (it is a real button)', () => {
    renderGrid();
    tile(3).focus();
    expect(document.activeElement).toBe(tile(3));
    // A native button turns Enter/Space into a click.
    fireEvent.click(document.activeElement);
    expect(preview()).toHaveAttribute('src', 'https://pics.example/full-3.jpg');
  });
});

describe('the actions', () => {
  it('Visit site opens the page the image is on, in a new tab', () => {
    renderGrid();
    open(1);
    const link = within(dialog()).getByRole('link', { name: /Visit site/ });
    expect(link).toHaveAttribute('href', 'https://pics.example/page-1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('Open original opens the image file itself, in a new tab', () => {
    renderGrid();
    open(1);
    const link = within(dialog()).getByRole('link', { name: /Open original/ });
    expect(link).toHaveAttribute('href', 'https://pics.example/full-1.jpg');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('Download asks the backend for the signed image address', async () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
    vi.stubGlobal('fetch', fetchMock);
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderGrid();
    open(2);
    fireEvent.click(within(dialog()).getByRole('button', { name: /Download/ }));

    await waitFor(() => expect(clicked).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const called = new URL(fetchMock.mock.calls[0][0]);
    expect(called.pathname).toMatch(/\/api\/images\/download$/);
    expect(called.searchParams.get('url')).toBe('https://pics.example/full-2.jpg');
    expect(called.searchParams.get('sig')).toBe('token-2');
    expect(called.searchParams.get('name')).toBe('Image 2');
    // Saved under a name from the title and the type that came back.
    const saved = clicked.mock.instances[0];
    expect(saved.download).toBe('Image 2.png');
    expect(saved.getAttribute('href')).toBe('blob:preview');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('says so when the download fails, and stays open', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    renderGrid();
    open(1);
    fireEvent.click(within(dialog()).getByRole('button', { name: /Download/ }));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      /could not be downloaded.*Open original/
    );
    expect(within(dialog()).getByRole('button', { name: /Download/ })).toBeEnabled();
  });

  it('a result with no full image has no Download or Open original, and still previews', () => {
    renderGrid([image(1, { imageUrl: null, downloadToken: null })]);
    open(1);
    const box = within(dialog());
    expect(preview()).toHaveAttribute('src', 'https://thumbs.example/t1.jpg');
    expect(box.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
    expect(box.queryByRole('link', { name: /Open original/ })).not.toBeInTheDocument();
    expect(box.getByRole('link', { name: /Visit site/ })).toBeInTheDocument();
  });

  it('a result with no source page has no Visit site', () => {
    renderGrid([image(1, { sourceUrl: null })]);
    open(1);
    expect(within(dialog()).queryByRole('link', { name: /Visit site/ })).not.toBeInTheDocument();
    expect(within(dialog()).getByRole('link', { name: /Open original/ })).toBeInTheDocument();
  });

  it('never builds a link or a download from an unsafe address', () => {
    renderGrid([image(1, { sourceUrl: 'javascript:alert(1)', imageUrl: 'javascript:alert(2)' })]);
    open(1);
    const box = within(dialog());
    expect(box.queryByRole('link')).not.toBeInTheDocument();
    expect(box.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
    expect(preview()).toHaveAttribute('src', 'https://thumbs.example/t1.jpg');
    expect(document.body.innerHTML).not.toMatch(/javascript:/);
    expect(downloadUrlFor(image(1, { imageUrl: 'javascript:x' }))).toBeNull();
    expect(downloadUrlFor(image(1, { downloadToken: null }))).toBeNull();
  });
});

describe('when the image will not load', () => {
  it('falls back to the thumbnail and says so', () => {
    renderGrid();
    open(1);
    fireEvent.error(preview());
    expect(preview()).toHaveAttribute('src', 'https://thumbs.example/t1.jpg');
    fireEvent.load(preview());
    expect(within(dialog()).getByText(/full-size image could not be loaded/)).toBeInTheDocument();
    // The actions still work from the result's own addresses.
    expect(within(dialog()).getByRole('link', { name: /Open original/ })).toBeInTheDocument();
  });

  it('shows a message when neither the image nor the thumbnail loads', () => {
    renderGrid();
    open(1);
    fireEvent.error(preview());
    fireEvent.error(preview());
    expect(within(dialog()).getByText('This image could not be loaded.')).toBeInTheDocument();
    expect(within(dialog()).getByRole('link', { name: /Visit site/ })).toBeInTheDocument();
  });
});

describe('closing', () => {
  it('the close button closes it', () => {
    renderGrid();
    open(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Escape closes it', () => {
    renderGrid();
    open(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clicking outside closes it; clicking inside does not', () => {
    renderGrid();
    open(1);
    fireEvent.click(preview());
    fireEvent.click(within(dialog()).getByText('Pics Example'));
    expect(dialog()).toBeInTheDocument();
    fireEvent.click(document.querySelector('.ph-lightbox'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('locks page scrolling while open and restores it on close', () => {
    document.body.style.overflow = 'auto';
    renderGrid();
    open(1);
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('auto');
  });

  it('moves focus into the preview and back to the tile it came from', () => {
    renderGrid();
    open(2);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close preview' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(tile(2));
  });
});

describe('keyboard and navigation', () => {
  it('arrow keys and the buttons move through the images on the page', () => {
    renderGrid();
    open(1);
    expect(screen.queryByRole('button', { name: 'Previous image' })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(preview()).toHaveAttribute('src', 'https://pics.example/full-2.jpg');
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(preview()).toHaveAttribute('src', 'https://pics.example/full-3.jpg');
    expect(screen.queryByRole('button', { name: 'Next image' })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'ArrowRight' }); // already the last one
    expect(within(dialog()).getByText('3 of 3')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(within(dialog()).getByText('2 of 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
    expect(within(dialog()).getByText('1 of 3')).toBeInTheDocument();
  });

  it('moving to another image starts loading again and makes no search request', () => {
    renderGrid();
    open(1);
    fireEvent.load(preview());
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(within(dialog()).getByRole('status', { name: 'Loading image' })).toBeInTheDocument();
    expect(searchApi.search).not.toHaveBeenCalled();
  });

  it('Tab stays inside the preview', () => {
    renderGrid();
    open(2);
    const controls = [...dialog().querySelectorAll('button:not([disabled]), a[href]')];
    const first = controls[0];
    const last = controls[controls.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('every control in the preview has a name', () => {
    renderGrid();
    open(2);
    for (const control of dialog().querySelectorAll('button, a')) {
      expect((control.getAttribute('aria-label') || control.textContent).trim()).not.toBe('');
    }
  });
});

describe('on the search page', () => {
  const page = (n, pageNo) => ({
    results: Array.from({ length: n }, (_, i) => image((pageNo - 1) * 24 + i + 1)),
    total: 30,
    latency: '0.2s',
    pagination: {
      page: pageNo,
      limit: 24,
      totalResults: 30,
      totalPages: 2,
      hasNextPage: pageNo < 2,
      hasPreviousPage: pageNo > 1
    },
    external: { provider: 'serpapi', status: 'ok', count: n }
  });

  it('image pagination still works, and the preview follows the page shown', async () => {
    searchApi.getAiAnswer.mockResolvedValue({ status: 'disabled', sources: [] });
    searchApi.search.mockImplementation(async (_q, _c, filters) =>
      filters.page === 2 ? page(6, 2) : page(24, 1)
    );
    let location;
    function Probe() {
      location = useLocation();
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/search?q=python&category=images']}>
        <SearchResults />
        <Probe />
      </MemoryRouter>
    );
    await screen.findByAltText('Image 1');
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    await screen.findByAltText('Image 25');
    expect(new URLSearchParams(location.search).get('page')).toBe('2');
    expect(new URLSearchParams(location.search).get('category')).toBe('images');
    expect(searchApi.search).toHaveBeenLastCalledWith(
      'python',
      'images',
      expect.objectContaining({ page: 2 })
    );

    fireEvent.click(screen.getByAltText('Image 26').closest('button'));
    expect(within(dialog()).getByText('2 of 6')).toBeInTheDocument();
    // Opening and moving through the preview makes no further search.
    const calls = searchApi.search.mock.calls.length;
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(searchApi.search.mock.calls.length).toBe(calls);
  });
});
