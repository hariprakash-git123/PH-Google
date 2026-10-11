import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ExternalImageResults, VerticalSkeleton } from './ExternalVerticals';
import { downloadUrlFor } from './ImageLightbox';
import { linkToOpen } from '../BrowserShell/BrowserShell';
import SearchResults from '../../pages/SearchResults/SearchResults';
import { searchApi } from '../../services/searchApi';

/**
 * Image search: a masonry grid of the results, and a preview that opens
 * beside it when an image is clicked. The preview shows the full image, says
 * what it is, and offers Visit (in the current PH tab), Share, Save (through
 * the backend's signed download) and Open original. All data is mocked;
 * nothing calls a provider or a real image host.
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
  source: 'parallel',
  ...overrides
});

const IMAGES = [image(1), image(2), image(3)];
const renderGrid = (results = IMAGES) => render(<ExternalImageResults results={results} />);
const tile = n => document.querySelector(`.ph-masonry-tile[data-image-id="img-${n}"]`);
const open = n => fireEvent.click(tile(n));
const dialog = () => screen.getByRole('dialog');
const preview = () => within(dialog()).getByRole('img', { name: /Image/ });
const tiles = () => [...document.querySelectorAll('.ph-masonry-tile')];
const setNarrow = narrow =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: narrow, addEventListener() {}, removeEventListener() {} }))
  );

beforeEach(() => {
  document.body.style.overflow = '';
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
  globalThis.URL.revokeObjectURL = vi.fn();
  searchApi.search.mockReset();
  searchApi.getSuggestions.mockReset();
  searchApi.getSuggestions.mockResolvedValue([]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the masonry grid', () => {
  it('shows each image with its title, site name and site icon, in result order', () => {
    renderGrid();
    expect(tiles().map(t => t.dataset.imageId)).toEqual(['img-1', 'img-2', 'img-3']);
    expect(screen.getByAltText('Image 1')).toHaveAttribute('src', 'https://thumbs.example/t1.jpg');
    expect(screen.getByText('Image 2')).toBeInTheDocument();
    expect(screen.getAllByText('Pics Example')).toHaveLength(3);
    // The site's own icon, from the site's own origin.
    const icons = document.querySelectorAll('.ph-masonry-tile img.ph-site-icon');
    expect(icons).toHaveLength(3);
    expect(icons[0]).toHaveAttribute('src', 'https://pics.example/favicon.ico');
    expect(icons[0]).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a tile is a button, not a link, so a click cannot navigate away', () => {
    renderGrid();
    expect(tile(1).tagName).toBe('BUTTON');
    expect(tile(1)).toHaveAttribute('type', 'button');
    expect(document.querySelectorAll('.ph-masonry a')).toHaveLength(0);
  });

  it('tiles take the shape of their image, so heights vary; extremes are cropped', () => {
    renderGrid([
      image(1, { width: 1200, height: 800 }),
      image(2, { width: 600, height: 900 }),
      image(3, { width: 400, height: 4000 }),
      image(4, { width: 5000, height: 500 })
    ]);
    const ratio = n =>
      String(parseFloat(tile(n).querySelector('.ph-masonry-thumb').style.aspectRatio));
    expect(ratio(1)).toBe('1.5');
    expect(Number(ratio(2))).toBeCloseTo(0.667, 2);
    expect(ratio(3)).toBe('0.5'); // a very tall image is cropped
    expect(ratio(4)).toBe('2.2'); // a very wide one too
    const span = n => Number(tile(n).style.gridRow.match(/span (\d+)/)[1]);
    expect(span(2)).toBeGreaterThan(span(1));
    expect(span(3)).toBeGreaterThan(span(2));
  });

  it('each tile goes into the shortest column; appending never moves those already placed', () => {
    const first = [image(1), image(2, { height: 2400 }), image(3), image(4)];
    const { rerender } = renderGrid(first);
    const place = n => [tile(n).style.gridColumn, tile(n).style.gridRow];
    const before = [1, 2, 3, 4].map(place);
    expect(before[0][0]).toBe('1');
    expect(before[1][0]).toBe('2');
    // Image 3 goes under the shorter column 1, not the tall image in column 2.
    expect(before[2][0]).toBe('1');
    rerender(<ExternalImageResults results={[...first, image(5), image(6)]} />);
    expect([1, 2, 3, 4].map(place)).toEqual(before);
  });

  it('an image without a size gets its shape once it loads', () => {
    renderGrid([image(1, { width: null, height: null })]);
    const thumb = screen.getByAltText('Image 1');
    expect(parseFloat(tile(1).querySelector('.ph-masonry-thumb').style.aspectRatio)).toBeCloseTo(
      4 / 3
    );
    Object.defineProperty(thumb, 'naturalWidth', { value: 500 });
    Object.defineProperty(thumb, 'naturalHeight', { value: 1000 });
    fireEvent.load(thumb);
    expect(parseFloat(tile(1).querySelector('.ph-masonry-thumb').style.aspectRatio)).toBe(0.5);
  });

  it('an image that will not load is taken out of the grid, not shown broken', () => {
    renderGrid();
    fireEvent.error(screen.getByAltText('Image 2'));
    expect(screen.queryByAltText('Image 2')).not.toBeInTheDocument();
    expect(tiles()).toHaveLength(2);
  });

  it('a site icon that will not load is replaced, once, by a generic one; the site name stays', () => {
    renderGrid([image(1)]);
    fireEvent.error(document.querySelector('.ph-masonry-tile img.ph-site-icon'));
    expect(document.querySelector('.ph-masonry-tile img.ph-site-icon')).toBeNull();
    expect(document.querySelector('.ph-masonry-tile .ph-site-icon-generic')).not.toBeNull();
    expect(screen.getByText('Pics Example')).toBeInTheDocument();
  });

  it('says there are no images, or that the service could not be reached', () => {
    const { rerender } = renderGrid([]);
    expect(screen.getByRole('status')).toHaveTextContent('No images found for this search.');
    rerender(<ExternalImageResults results={[]} unavailable />);
    expect(screen.getByRole('status')).toHaveTextContent('No results available right now.');
  });

  it('the loading skeleton is a grid of blocks of different heights', () => {
    render(<VerticalSkeleton tab="images" />);
    const blocks = [...document.querySelectorAll('.ph-masonry-skeleton .ph-ext-skeleton-block')];
    expect(screen.getByRole('status', { name: 'Loading images' })).toBeInTheDocument();
    expect(new Set(blocks.map(b => b.style.height)).size).toBeGreaterThan(3);
  });
});

describe('opening the preview', () => {
  it('opens beside the grid, which stays on the page and usable', () => {
    const before = window.location.href;
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderGrid();
    open(2);
    expect(dialog()).toHaveAttribute('aria-modal', 'false');
    expect(document.querySelector('.ph-img-view')).toHaveClass('has-preview');
    expect(tiles()).toHaveLength(3);
    expect(tile(2)).toHaveAttribute('aria-pressed', 'true');
    expect(tile(1)).toHaveAttribute('aria-pressed', 'false');
    expect(window.location.href).toBe(before);
    expect(opened).not.toHaveBeenCalled();

    // Another tile, clicked with the preview open, is shown in it.
    open(3);
    expect(preview()).toHaveAttribute('src', 'https://pics.example/full-3.jpg');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('shows the full image, not the thumbnail', () => {
    renderGrid();
    open(2);
    expect(preview()).toHaveAttribute('src', 'https://pics.example/full-2.jpg');
    expect(preview()).toHaveAttribute('alt', 'Image 2');
  });

  it('shows the title, the site and the dimensions the result has', () => {
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
    expect(box.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
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
  it('Visit opens the page the image is on in the current PH tab, like a search result', () => {
    renderGrid();
    open(1);
    const link = within(dialog()).getByRole('link', { name: /Visit/ });
    expect(link).toHaveAttribute('href', 'https://pics.example/page-1');
    // A search result link: the shell opens it in the tab it was clicked in;
    // Ctrl/middle-click are the browser's, which opens a new tab.
    expect(link).toHaveAttribute('data-ph-result');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(linkToOpen({ defaultPrevented: false, button: 0, target: link })).toMatchObject({
      url: 'https://pics.example/page-1',
      inPlace: true
    });
    expect(
      linkToOpen({ defaultPrevented: false, button: 0, ctrlKey: true, target: link })
    ).toBeNull();
    expect(linkToOpen({ defaultPrevented: false, button: 1, target: link })).toBeNull();
  });

  it('Open original opens the image file itself', () => {
    renderGrid();
    open(1);
    const link = within(dialog()).getByRole('link', { name: /Open original/ });
    expect(link).toHaveAttribute('href', 'https://pics.example/full-1.jpg');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('Share uses the device’s share sheet with the page’s address', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, share });
    renderGrid();
    open(2);
    fireEvent.click(within(dialog()).getByRole('button', { name: /Share/ }));
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith({ title: 'Image 2', url: 'https://pics.example/page-2' })
    );
    expect(await within(dialog()).findByText('Shared.')).toBeInTheDocument();
  });

  it('Share copies the address where there is no share sheet', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, share: undefined, clipboard: { writeText } });
    renderGrid();
    open(1);
    fireEvent.click(within(dialog()).getByRole('button', { name: /Share/ }));
    expect(await within(dialog()).findByText('Link copied.')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('https://pics.example/page-1');
  });

  it('closing the share sheet is not an error; a real failure says so', async () => {
    const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const share = vi.fn().mockRejectedValueOnce(abort).mockRejectedValueOnce(new Error('no'));
    vi.stubGlobal('navigator', { ...navigator, share });
    renderGrid();
    open(1);
    const button = within(dialog()).getByRole('button', { name: /Share/ });
    fireEvent.click(button);
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(within(dialog()).queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      'This link could not be shared or copied.'
    );
  });

  it('Save downloads the image through the backend’s signed address', async () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
    vi.stubGlobal('fetch', fetchMock);
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderGrid();
    open(2);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save image to your device' }));

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
    expect(await within(dialog()).findByText('Image saved to your downloads.')).toBeInTheDocument();
  });

  it('says so when saving fails, and stays open', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    renderGrid();
    open(1);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save image to your device' }));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      /could not be saved.*Open original/
    );
    expect(
      within(dialog()).getByRole('button', { name: 'Save image to your device' })
    ).toBeEnabled();
  });

  it('a result with no full image has no Save or Open original, and still previews', () => {
    renderGrid([image(1, { imageUrl: null, downloadToken: null })]);
    open(1);
    const box = within(dialog());
    expect(preview()).toHaveAttribute('src', 'https://thumbs.example/t1.jpg');
    expect(box.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
    expect(box.queryByRole('link', { name: /Open original/ })).not.toBeInTheDocument();
    expect(box.getByRole('link', { name: /Visit/ })).toBeInTheDocument();
  });

  it('a result with no source page has no Visit, and shares the image address', () => {
    renderGrid([image(1, { sourceUrl: null })]);
    open(1);
    expect(within(dialog()).queryByRole('link', { name: /Visit/ })).not.toBeInTheDocument();
    expect(within(dialog()).getByRole('link', { name: /Open original/ })).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: /Share/ })).toBeInTheDocument();
  });

  it('never builds a link, a share or a download from an unsafe address', () => {
    renderGrid([image(1, { sourceUrl: 'javascript:alert(1)', imageUrl: 'javascript:alert(2)' })]);
    open(1);
    const box = within(dialog());
    expect(box.queryByRole('link')).not.toBeInTheDocument();
    expect(box.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
    expect(box.queryByRole('button', { name: /Share/ })).not.toBeInTheDocument();
    expect(preview()).toHaveAttribute('src', 'https://thumbs.example/t1.jpg');
    expect(document.body.innerHTML).not.toMatch(/javascript:/);
    expect(downloadUrlFor(image(1, { imageUrl: 'javascript:x' }))).toBeNull();
    expect(downloadUrlFor(image(1, { downloadToken: null }))).toBeNull();
  });
});

describe('more from the same site', () => {
  it('lists the other images on the page from the same site; choosing one shows it', () => {
    renderGrid([
      image(1),
      image(2, { sourceDomain: 'other.example', sourceName: 'Other' }),
      image(3)
    ]);
    open(1);
    const more = within(dialog()).getByRole('region', { name: 'More from Pics Example' });
    const choices = within(more).getAllByRole('button');
    expect(choices).toHaveLength(1);
    expect(choices[0]).toHaveAccessibleName('Show Image 3');
    fireEvent.click(choices[0]);
    expect(preview()).toHaveAttribute('src', 'https://pics.example/full-3.jpg');
    expect(within(dialog()).getByText('3 of 3')).toBeInTheDocument();
  });

  it('is left out when no other image on the page is from that site', () => {
    renderGrid([image(1), image(2, { sourceDomain: 'other.example', sourceName: 'Other' })]);
    open(1);
    expect(within(dialog()).queryByRole('region')).not.toBeInTheDocument();
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
    expect(within(dialog()).getByRole('link', { name: /Open original/ })).toBeInTheDocument();
  });

  it('shows a message when neither the image nor the thumbnail loads', () => {
    renderGrid();
    open(1);
    fireEvent.error(preview());
    fireEvent.error(within(dialog()).getByRole('img', { name: 'Image 1' }));
    expect(within(dialog()).getByText('This image could not be loaded.')).toBeInTheDocument();
    expect(within(dialog()).getByRole('link', { name: /Visit/ })).toBeInTheDocument();
  });
});

describe('closing', () => {
  it('the close button closes it, and the grid takes the full width again', () => {
    renderGrid();
    open(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('.ph-img-view')).not.toHaveClass('has-preview');
  });

  it('Escape closes it — but not while typing in a field', () => {
    render(
      <>
        <input aria-label="Search" />
        <ExternalImageResults results={IMAGES} />
      </>
    );
    open(1);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search' }), { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search' }), { key: 'ArrowRight' });
    expect(within(dialog()).getByText('1 of 3')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves focus into the preview and back to the tile it came from', () => {
    renderGrid();
    open(2);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close preview' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(tile(2));
  });

  it('on a wide screen the page still scrolls beside it', () => {
    setNarrow(false);
    document.body.style.overflow = 'auto';
    renderGrid();
    open(1);
    expect(document.body.style.overflow).toBe('auto');
  });

  it('on a narrow screen it covers the page: no scrolling behind, and a tap outside closes', () => {
    setNarrow(true);
    document.body.style.overflow = 'auto';
    renderGrid();
    open(1);
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(document.querySelector('.ph-img-panel-backdrop'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('auto');
  });
});

describe('keyboard and navigation', () => {
  it('arrow keys and the buttons move through the images on the page', () => {
    renderGrid();
    open(1);
    expect(screen.getByRole('button', { name: 'Previous image' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(preview()).toHaveAttribute('src', 'https://pics.example/full-2.jpg');
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(preview()).toHaveAttribute('src', 'https://pics.example/full-3.jpg');
    expect(screen.getByRole('button', { name: 'Next image' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'ArrowRight' }); // already the last one
    expect(within(dialog()).getByText('3 of 3')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(within(dialog()).getByText('2 of 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
    expect(within(dialog()).getByText('1 of 3')).toBeInTheDocument();
    // The grid shows which image is open.
    expect(tile(1)).toHaveAttribute('aria-pressed', 'true');
  });

  it('moving to another image starts loading again and makes no search request', () => {
    renderGrid();
    open(1);
    fireEvent.load(preview());
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(within(dialog()).getByRole('status', { name: 'Loading image' })).toBeInTheDocument();
    expect(searchApi.search).not.toHaveBeenCalled();
  });

  it('every control in the grid and the preview has a name', () => {
    renderGrid();
    open(2);
    for (const control of document.querySelectorAll('button, a')) {
      expect((control.getAttribute('aria-label') || control.textContent).trim()).not.toBe('');
    }
  });
});

describe('on the search page', () => {
  /** The first page of 24, then a batch of 6 from the cursor. */
  const batch = (from, n, more, extra = []) => ({
    results: [...Array.from({ length: n }, (_, i) => image(from + i)), ...extra],
    total: 30,
    latency: '0.2s',
    pagination: {
      page: 1,
      limit: 24,
      totalResults: 30,
      totalPages: 2,
      hasNextPage: more,
      hasPreviousPage: false
    },
    hasMore: more,
    nextCursor: more ? 'cursor-after-24' : null,
    external: { provider: 'parallel', status: 'ok', count: n }
  });
  let location;
  function Probe() {
    location = useLocation();
    return null;
  }
  const renderPage = (path = '/search?q=python&category=images') =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <SearchResults />
        <Probe />
      </MemoryRouter>
    );

  beforeEach(() => {
    searchApi.getAiAnswer.mockResolvedValue({ status: 'disabled', sources: [] });
  });

  it('Load more appends the next images without repeats, and the preview moves through all of them', async () => {
    searchApi.search.mockImplementation(async (_q, _c, filters) =>
      // The next batch repeats two images already shown.
      filters.cursor === 'cursor-after-24'
        ? batch(25, 6, false, [image(3), image(10)])
        : batch(1, 24, true)
    );
    renderPage();
    await screen.findByAltText('Image 1');
    fireEvent.click(screen.getByRole('button', { name: 'Load more results' }));
    await screen.findByAltText('Image 25');
    // Appended: the first page is still there, nothing twice, and the URL is unchanged.
    expect(screen.getByAltText('Image 1')).toBeInTheDocument();
    expect(tiles()).toHaveLength(30);
    expect(new Set(tiles().map(t => t.dataset.imageId)).size).toBe(30);
    expect(new URLSearchParams(location.search).get('page')).toBeNull();
    expect(new URLSearchParams(location.search).get('category')).toBe('images');
    expect(searchApi.search).toHaveBeenLastCalledWith(
      'python',
      'images',
      expect.objectContaining({ cursor: 'cursor-after-24', limit: 20 })
    );
    expect(screen.getByText(/reached the end of the results/)).toBeInTheDocument();

    fireEvent.click(screen.getByAltText('Image 26').closest('button'));
    expect(within(dialog()).getByText('26 of 30')).toBeInTheDocument();
    const calls = searchApi.search.mock.calls.length;
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(searchApi.search.mock.calls.length).toBe(calls);
  });

  it('a category chip runs a real image search for the query with that category', async () => {
    searchApi.search.mockResolvedValue(batch(1, 3, false));
    renderPage();
    await screen.findByAltText('Image 1');
    const chips = within(screen.getByRole('group', { name: 'Image categories' }));
    expect(chips.getAllByRole('button').map(b => b.textContent)).toEqual([
      'Wallpaper',
      'Nature',
      'Art',
      'Cute',
      'Animal',
      'City',
      'Space',
      'Food'
    ]);
    fireEvent.click(chips.getByRole('button', { name: 'Wallpaper' }));
    await waitFor(() =>
      expect(searchApi.search).toHaveBeenLastCalledWith(
        'python wallpaper',
        'images',
        expect.objectContaining({ limit: 60 })
      )
    );
    expect(new URLSearchParams(location.search).get('q')).toBe('python wallpaper');
    expect(new URLSearchParams(location.search).get('category')).toBe('images');
  });

  it('the chip in use is shown pressed; pressing it again searches without it', async () => {
    searchApi.search.mockResolvedValue(batch(1, 3, false));
    renderPage('/search?q=python%20wallpaper&category=images');
    await screen.findByAltText('Image 1');
    const chips = within(screen.getByRole('group', { name: 'Image categories' }));
    expect(chips.getByRole('button', { name: 'Wallpaper' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(chips.getByRole('button', { name: 'Nature' })).toHaveAttribute('aria-pressed', 'false');
    // Another chip replaces it rather than piling up.
    fireEvent.click(chips.getByRole('button', { name: 'Nature' }));
    await waitFor(() =>
      expect(new URLSearchParams(location.search).get('q')).toBe('python nature')
    );
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Image categories' })).getByRole('button', {
        name: 'Nature'
      })
    );
    await waitFor(() => expect(new URLSearchParams(location.search).get('q')).toBe('python'));
    expect(searchApi.search).toHaveBeenLastCalledWith('python', 'images', expect.anything());
  });

  it('related searches come from the backend’s suggestions; choosing one searches it', async () => {
    searchApi.search.mockResolvedValue(batch(1, 3, false));
    searchApi.getSuggestions.mockResolvedValue([
      { text: 'python', category: 'recent search' },
      { text: 'python logo', category: 'recent search' },
      { text: 'Python Logo', category: 'indexed term' },
      { text: 'python snake', category: 'indexed term' }
    ]);
    renderPage();
    const related = await screen.findByRole('navigation', { name: 'Related searches' });
    expect(searchApi.getSuggestions).toHaveBeenCalledWith('python');
    // Not the query itself, and nothing twice.
    expect(
      within(related)
        .getAllByRole('button')
        .map(b => b.textContent)
    ).toEqual(['python logo', 'python snake']);
    fireEvent.click(within(related).getByRole('button', { name: 'python snake' }));
    await waitFor(() =>
      expect(searchApi.search).toHaveBeenLastCalledWith('python snake', 'images', expect.anything())
    );
    expect(new URLSearchParams(location.search).get('category')).toBe('images');
  });

  it('with no suggestions there is no related-searches row', async () => {
    searchApi.search.mockResolvedValue(batch(1, 3, false));
    renderPage();
    await screen.findByAltText('Image 1');
    await waitFor(() => expect(searchApi.getSuggestions).toHaveBeenCalled());
    expect(screen.queryByRole('navigation', { name: 'Related searches' })).not.toBeInTheDocument();
  });

  it('chips stay available while images load and when nothing is found', async () => {
    let finish;
    searchApi.search.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    renderPage();
    expect(screen.getByRole('status', { name: 'Loading images' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Image categories' })).toBeInTheDocument();
    finish({ ...batch(1, 0, false), external: { provider: 'parallel', status: 'ok', count: 0 } });
    expect(await screen.findByText('No images found for this search.')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Image categories' })).toBeInTheDocument();
  });

  it('other tabs have no image chips', async () => {
    searchApi.search.mockResolvedValue({ ...batch(1, 0, false), external: null });
    renderPage('/search?q=python');
    await waitFor(() => expect(searchApi.search).toHaveBeenCalled());
    expect(screen.queryByRole('group', { name: 'Image categories' })).not.toBeInTheDocument();
  });
});
