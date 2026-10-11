import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import SearchResults from './SearchResults';
import { linkToOpen } from '../../components/BrowserShell/BrowserShell';
import { searchApi } from '../../services/searchApi';

/**
 * "Load more" on the search page: the first results arrive on their own; each
 * click asks for the batch after them, from the cursor the server gave, and
 * appends it. One request at a time; a failure keeps what is shown and offers
 * a retry; a new search starts afresh and an old answer never lands in it;
 * each tab keeps what it has loaded.
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
const answer = (results, { more = false, cursor = null, total = 40 } = {}) => ({
  results,
  total,
  latency: '0.1s',
  pagination: { page: 1, limit: 10, totalResults: total, totalPages: 4 },
  hasMore: more,
  nextCursor: more ? cursor : null
});
/** A promise the test resolves when it chooses. */
function later() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
}

let navigate;
function Nav() {
  navigate = useNavigate();
  return null;
}
const open = (url = '/search?q=python') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <SearchResults />
      <Nav />
    </MemoryRouter>
  );
const titles = () => [...document.querySelectorAll('.ph-result-title')].map(h => h.textContent);
const button = () => screen.queryByRole('button', { name: /Load more results|Loading/ });

beforeEach(() => {
  searchApi.search.mockReset();
  searchApi.getAiAnswer.mockResolvedValue({ status: 'disabled', sources: [] });
});

describe('the first results', () => {
  it('appear without a click, as before, with Load more under them', async () => {
    searchApi.search.mockResolvedValue(answer(range(1, 10), { more: true, cursor: 'c1' }));
    open();
    expect(await screen.findByText('R result 1')).toBeInTheDocument();
    expect(titles()).toHaveLength(10);
    expect(searchApi.search).toHaveBeenCalledTimes(1);
    expect(searchApi.search).toHaveBeenCalledWith(
      'python',
      'all',
      expect.objectContaining({ page: 1, limit: 10 })
    );
    expect(searchApi.search.mock.calls[0][2]).not.toHaveProperty('cursor');
    expect(button()).toHaveTextContent('Load more results');
    // The numbered pages are gone.
    expect(screen.queryByRole('button', { name: /Next page|Go to page/ })).not.toBeInTheDocument();
  });

  it('with nothing more, says the results end and offers no button', async () => {
    searchApi.search.mockResolvedValue(answer(range(1, 4), { more: false, total: 4 }));
    open();
    await screen.findByText('R result 4');
    expect(button()).not.toBeInTheDocument();
    expect(screen.getByText(/reached the end of the results/)).toBeInTheDocument();
  });

  it('no results: the usual empty state, and no Load more at all', async () => {
    searchApi.search.mockResolvedValue(answer([], { total: 0 }));
    open();
    expect(await screen.findByText(/No results found for/)).toBeInTheDocument();
    expect(button()).not.toBeInTheDocument();
    expect(screen.queryByText(/reached the end/)).not.toBeInTheDocument();
  });
});

describe('Load more', () => {
  it('asks for the next 10 from the cursor and appends them; earlier results stay', async () => {
    searchApi.search.mockImplementation(async (_q, _c, filters) =>
      filters.cursor === 'c1'
        ? answer(range(11, 20), { more: true, cursor: 'c2' })
        : answer(range(1, 10), { more: true, cursor: 'c1' })
    );
    open();
    await screen.findByText('R result 1');
    fireEvent.click(button());
    await screen.findByText('R result 20');
    expect(searchApi.search).toHaveBeenLastCalledWith(
      'python',
      'all',
      expect.objectContaining({ cursor: 'c1', limit: 10 })
    );
    expect(searchApi.search.mock.calls[1][2]).not.toHaveProperty('page');
    expect(titles()).toEqual(range(1, 20).map(r => r.title));
    expect(screen.getByText(/showing 1–20/)).toBeInTheDocument();
  });

  it('the cursor advances: the next click sends the next cursor', async () => {
    searchApi.search.mockImplementation(async (_q, _c, f) => {
      if (f.cursor === 'c2') return answer(range(21, 25), { more: false });
      if (f.cursor === 'c1') return answer(range(11, 20), { more: true, cursor: 'c2' });
      return answer(range(1, 10), { more: true, cursor: 'c1' });
    });
    open();
    await screen.findByText('R result 1');
    fireEvent.click(button());
    await screen.findByText('R result 20');
    fireEvent.click(button());
    await screen.findByText('R result 25');
    expect(searchApi.search.mock.calls.map(call => call[2].cursor)).toEqual([
      undefined,
      'c1',
      'c2'
    ]);
    // Fewer than 10 were left: they are shown, and the end is said.
    expect(titles()).toHaveLength(25);
    expect(button()).not.toBeInTheDocument();
    expect(screen.getByText(/reached the end of the results/)).toBeInTheDocument();
  });

  it('shows that it is loading, keeps the results, and sends one request however many clicks', async () => {
    const pending = later();
    searchApi.search.mockImplementation((_q, _c, f) =>
      f.cursor
        ? pending.promise
        : Promise.resolve(answer(range(1, 10), { more: true, cursor: 'c1' }))
    );
    open();
    await screen.findByText('R result 1');
    fireEvent.click(button());
    fireEvent.click(button());
    fireEvent.click(button());
    expect(button()).toBeDisabled();
    expect(button()).toHaveTextContent('Loading');
    expect(titles()).toHaveLength(10);
    expect(searchApi.search).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(answer(range(11, 20), { more: false })));
    expect(titles()).toHaveLength(20);
    expect(searchApi.search).toHaveBeenCalledTimes(2);
  });

  it('never shows a result twice, even if a batch repeats one', async () => {
    searchApi.search.mockImplementation(async (_q, _c, f) =>
      f.cursor
        ? answer([web(9), { ...web(10), id: 'other-id' }, ...range(11, 18)], { more: false })
        : answer(range(1, 10), { more: true, cursor: 'c1' })
    );
    open();
    await screen.findByText('R result 1');
    fireEvent.click(button());
    await screen.findByText('R result 18');
    // Result 9 by id, result 10 by its address.
    expect(titles()).toEqual(range(1, 18).map(r => r.title));
  });

  it('a failure keeps every result and offers to try again', async () => {
    let fail = true;
    searchApi.search.mockImplementation(async (_q, _c, f) => {
      if (!f.cursor) return answer(range(1, 10), { more: true, cursor: 'c1' });
      if (fail) return { ...answer([]), error: 'Network Error' };
      return answer(range(11, 20), { more: false });
    });
    open();
    await screen.findByText('R result 1');
    fireEvent.click(button());
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load more results.");
    expect(titles()).toHaveLength(10);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('R result 20');
    expect(titles()).toHaveLength(20);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // The retry used the same cursor.
    expect(searchApi.search.mock.calls.slice(1).map(call => call[2].cursor)).toEqual(['c1', 'c1']);
  });
});

describe('a new search', () => {
  it('starts afresh: the old results and cursor are gone', async () => {
    searchApi.search.mockImplementation(async (q, _c, f) => {
      if (q === 'rust') return answer(range(1, 3, 'n'), { more: false, total: 3 });
      return f.cursor
        ? answer(range(11, 20), { more: false })
        : answer(range(1, 10), { more: true, cursor: 'c1' });
    });
    open();
    await screen.findByText('R result 1');
    fireEvent.click(button());
    await screen.findByText('R result 20');
    act(() => navigate('/search?q=rust'));
    await screen.findByText('N result 1');
    expect(titles()).toEqual(range(1, 3, 'n').map(r => r.title));
    expect(searchApi.search).toHaveBeenLastCalledWith(
      'rust',
      'all',
      expect.objectContaining({ page: 1 })
    );
  });

  it('a batch that arrives after the search changed is not added to it', async () => {
    const pending = later();
    searchApi.search.mockImplementation((q, _c, f) => {
      if (q === 'rust') return Promise.resolve(answer(range(1, 3, 'n'), { more: false, total: 3 }));
      return f.cursor
        ? pending.promise
        : Promise.resolve(answer(range(1, 10), { more: true, cursor: 'c1' }));
    });
    open();
    await screen.findByText('R result 1');
    fireEvent.click(button());
    act(() => navigate('/search?q=rust'));
    await screen.findByText('N result 1');
    await act(async () => pending.resolve(answer(range(11, 20), { more: false })));
    expect(titles()).toEqual(range(1, 3, 'n').map(r => r.title));
    expect(screen.queryByText('R result 11')).not.toBeInTheDocument();
  });

  it('a changed filter starts afresh too', async () => {
    searchApi.search.mockImplementation(async (_q, _c, f) =>
      f.cursor ? answer(range(11, 20)) : answer(range(1, 10), { more: true, cursor: 'c1' })
    );
    open('/search?q=python');
    await screen.findByText('R result 1');
    fireEvent.click(button());
    await screen.findByText('R result 20');
    act(() => navigate('/search?q=python&page=2'));
    await waitFor(() => expect(titles()).toHaveLength(10));
  });
});

describe('each tab keeps its own results', () => {
  it('going back to a tab shows what was loaded there, without asking again', async () => {
    searchApi.search.mockImplementation(async (_q, category, f) => {
      if (category === 'videos') {
        return {
          ...answer([], { more: false, total: 0 }),
          external: { provider: 'parallel', status: 'ok', count: 0 }
        };
      }
      return f.cursor
        ? answer(range(11, 20), { more: true, cursor: 'c2' })
        : answer(range(1, 10), { more: true, cursor: 'c1' });
    });
    open();
    await screen.findByText('R result 1');
    fireEvent.click(button());
    await screen.findByText('R result 20');

    fireEvent.click(screen.getByRole('tab', { name: /Videos/ }));
    await waitFor(() =>
      expect(searchApi.search).toHaveBeenLastCalledWith('python', 'videos', expect.anything())
    );
    const calls = searchApi.search.mock.calls.length;
    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    await screen.findByText('R result 20');
    expect(titles()).toHaveLength(20);
    expect(searchApi.search.mock.calls.length).toBe(calls);
    // And it continues from where it was.
    expect(button()).toHaveTextContent('Load more results');
  });

  it('Videos pages through its own source', async () => {
    const video = n => ({
      id: `v${n}`,
      title: `Video ${n}`,
      videoUrl: `https://www.youtube.com/watch?v=vid${String(n).padStart(8, '0')}`,
      sourceUrl: `https://www.youtube.com/watch?v=vid${String(n).padStart(8, '0')}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${n}/hq.jpg`,
      sourceName: 'YouTube',
      source: 'parallel'
    });
    searchApi.search.mockImplementation(async (_q, category, f) => ({
      ...answer(
        f.cursor ? [13, 14, 15].map(video) : Array.from({ length: 12 }, (_, i) => video(i + 1)),
        { more: !f.cursor, cursor: 'v-c1', total: 15 }
      ),
      external: { provider: 'parallel', status: 'ok', count: 12 }
    }));
    open('/search?q=python&category=videos');
    await screen.findByText('Video 1');
    fireEvent.click(button());
    await screen.findByText('Video 15');
    expect(searchApi.search).toHaveBeenLastCalledWith(
      'python',
      'videos',
      expect.objectContaining({ cursor: 'v-c1', limit: 10 })
    );
    expect(document.querySelectorAll('.ph-video-card')).toHaveLength(15);
  });
});

describe('appended results look like the rest', () => {
  it('each appended web result has its site icon and opens like the first page’s', async () => {
    searchApi.search.mockImplementation(async (_q, _c, f) =>
      f.cursor ? answer(range(11, 12)) : answer(range(1, 10), { more: true, cursor: 'c1' })
    );
    open();
    await screen.findByText('R result 1');
    fireEvent.click(button());
    const link = await screen.findByRole('link', { name: 'R result 12' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // A plain click opens it in the current PH tab; Ctrl/middle-click are the browser's.
    expect(link).toHaveAttribute('data-ph-result');
    expect(linkToOpen({ defaultPrevented: false, button: 0, target: link })).toMatchObject({
      url: link.getAttribute('href'),
      inPlace: true
    });
    expect(
      linkToOpen({ defaultPrevented: false, button: 0, ctrlKey: true, target: link })
    ).toBeNull();
    expect(linkToOpen({ defaultPrevented: false, button: 1, target: link })).toBeNull();
    const card = link.closest('article');
    expect(card.querySelector('.ph-result-favicon img')).toHaveAttribute(
      'src',
      'https://site12.example/favicon.ico'
    );
  });
});

describe('Images and Videos, batch after batch', () => {
  const video = (n, overrides = {}) => ({
    id: `v${n}`,
    title: `Video ${n}`,
    videoUrl: `https://www.youtube.com/watch?v=vid${String(n).padStart(8, '0')}`,
    sourceUrl: `https://www.youtube.com/watch?v=vid${String(n).padStart(8, '0')}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${n}/hq.jpg`,
    sourceName: 'YouTube',
    source: 'parallel',
    ...overrides
  });
  const picture = n => ({
    id: `img-${n}`,
    title: `Picture ${n}`,
    imageUrl: `https://pics.example/${n}.jpg`,
    thumbnailUrl: `https://pics.example/${n}.jpg`,
    sourceUrl: `https://pics.example/page-${n}`,
    sourceDomain: 'pics.example',
    width: 800,
    height: 600,
    source: 'parallel'
  });
  const ids = (from, n) => Array.from({ length: n }, (_, i) => from + i);
  const external = { provider: 'parallel', status: 'ok', count: 10 };
  const batch = (results, next) => ({
    ...answer(results, { more: Boolean(next), cursor: next, total: 99 }),
    external
  });
  /** Pages of a provider list, by cursor: [results, next cursor or null]. */
  const pages = (category, table) =>
    searchApi.search.mockImplementation(async (_q, asked, f) => {
      if (asked !== category) return batch([], null);
      const [results, next] = table[f.cursor || 'first'];
      return batch(results, next);
    });
  const videoCards = () => document.querySelectorAll('.ph-video-card').length;
  const tileIds = () =>
    [...document.querySelectorAll('.ph-masonry-tile')].map(tile => tile.dataset.imageId);

  it('Videos: every click asks for the next batch with the latest cursor, until the provider has no more', async () => {
    pages('videos', {
      first: [ids(1, 12).map(n => video(n)), 'v1'],
      v1: [ids(13, 10).map(n => video(n)), 'v2'],
      v2: [ids(23, 10).map(n => video(n)), 'v3'],
      v3: [ids(33, 4).map(n => video(n)), null]
    });
    open('/search?q=python&category=videos');
    await screen.findByText('Video 1');
    for (const last of [22, 32, 36]) {
      fireEvent.click(button());
      await screen.findByText(`Video ${last}`);
      expect(videoCards()).toBe(last);
    }
    expect(searchApi.search.mock.calls.map(call => call[2].cursor)).toEqual([
      undefined,
      'v1',
      'v2',
      'v3'
    ]);
    // The first results are still the first.
    expect(screen.getByText('Video 1')).toBeInTheDocument();
    expect(button()).toBeNull();
    expect(screen.getByText(/reached the end of the results/)).toBeInTheDocument();
  });

  it('Images: Load more is offered after a short first answer, and each click appends new pictures', async () => {
    pages('images', {
      first: [ids(1, 18).map(picture), 'i1'],
      i1: [ids(19, 9).map(picture), 'i2'],
      i2: [ids(28, 5).map(picture), 'i3'],
      i3: [[], null]
    });
    open('/search?q=python&category=images');
    await screen.findByAltText('Picture 1');
    expect(tileIds()).toHaveLength(18);
    fireEvent.click(button());
    await screen.findByAltText('Picture 27');
    fireEvent.click(button());
    await screen.findByAltText('Picture 32');
    expect(tileIds()).toHaveLength(32);
    // The last round found nothing new: the end, and nothing removed.
    fireEvent.click(button());
    await screen.findByText(/reached the end of the results/);
    expect(tileIds()).toHaveLength(32);
    expect(new Set(tileIds()).size).toBe(32);
    expect(searchApi.search).toHaveBeenLastCalledWith(
      'python',
      'images',
      expect.objectContaining({ cursor: 'i3', limit: 20 })
    );
  });

  it('a repeat is dropped by its address or id; a different video with the same title, or an id differing in case, is kept', async () => {
    pages('videos', {
      first: [ids(1, 12).map(n => video(n)), 'v1'],
      v1: [
        [
          // The same video again: a new id, the same address with a fragment.
          video(1, { id: 'other-id', videoUrl: `${video(1).videoUrl}#t=30` }),
          // The same id again.
          video(99, { id: 'v2' }),
          // Different videos: the same title; an id differing only in case.
          video(40, { title: 'Video 1' }),
          video(41, {
            title: 'Upper case',
            videoUrl: video(3).videoUrl.replace('vid', 'VID'),
            sourceUrl: null
          })
        ],
        null
      ]
    });
    open('/search?q=python&category=videos');
    await screen.findByText('Video 12');
    fireEvent.click(button());
    await screen.findByText('Upper case');
    expect(videoCards()).toBe(14);
    expect(screen.getAllByText('Video 1')).toHaveLength(2);
  });

  it('one request at a time, however fast the clicks come', async () => {
    const pending = later();
    searchApi.search.mockImplementation(async (_q, _c, f) =>
      f.cursor ? pending.promise : batch(ids(1, 18).map(picture), 'i1')
    );
    open('/search?q=python&category=images');
    await screen.findByAltText('Picture 1');
    const load = button();
    fireEvent.click(load);
    fireEvent.click(load);
    fireEvent.click(load);
    expect(searchApi.search).toHaveBeenCalledTimes(2);
    expect(button()).toBeDisabled();
    expect(button()).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      pending.resolve(batch(ids(19, 4).map(picture), null));
    });
    expect(tileIds()).toHaveLength(22);
  });

  it('a failed batch shows the reason and keeps the list; the retry continues from the same place', async () => {
    let fail = true;
    searchApi.search.mockImplementation(async (_q, _c, f) => {
      if (!f.cursor)
        return batch(
          ids(1, 12).map(n => video(n)),
          'v1'
        );
      if (f.cursor === 'v1' && fail) {
        return {
          ...answer([]),
          error: 'More results could not be loaded right now. Try again in a moment.'
        };
      }
      if (f.cursor === 'v1')
        return batch(
          ids(13, 10).map(n => video(n)),
          'v2'
        );
      return batch(
        ids(23, 2).map(n => video(n)),
        null
      );
    });
    open('/search?q=python&category=videos');
    await screen.findByText('Video 12');
    fireEvent.click(button());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't load more results. More results could not be loaded right now."
    );
    expect(videoCards()).toBe(12);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Video 22');
    fireEvent.click(button());
    await screen.findByText('Video 24');
    expect(videoCards()).toBe(24);
    expect(searchApi.search.mock.calls.map(call => call[2].cursor)).toEqual([
      undefined,
      'v1',
      'v1',
      'v2'
    ]);
  });

  it('Images and Videos keep their own lists and cursors', async () => {
    searchApi.search.mockImplementation(async (_q, category, f) => {
      if (category === 'images') {
        return f.cursor
          ? batch(ids(19, 3).map(picture), 'i2')
          : batch(ids(1, 18).map(picture), 'i1');
      }
      return f.cursor
        ? batch(
            ids(13, 2).map(n => video(n)),
            'v2'
          )
        : batch(
            ids(1, 12).map(n => video(n)),
            'v1'
          );
    });
    open('/search?q=python&category=images');
    await screen.findByAltText('Picture 1');
    fireEvent.click(button());
    await screen.findByAltText('Picture 21');

    act(() => navigate('/search?q=python&category=videos'));
    await screen.findByText('Video 1');
    fireEvent.click(button());
    await screen.findByText('Video 14');
    expect(searchApi.search).toHaveBeenLastCalledWith(
      'python',
      'videos',
      expect.objectContaining({ cursor: 'v1' })
    );

    act(() => navigate('/search?q=python&category=images'));
    await screen.findByAltText('Picture 21');
    expect(tileIds()).toHaveLength(21);
    fireEvent.click(button());
    await waitFor(() =>
      expect(searchApi.search).toHaveBeenLastCalledWith(
        'python',
        'images',
        expect.objectContaining({ cursor: 'i2' })
      )
    );
  });

  it('a new query starts Images again from its first batch', async () => {
    searchApi.search.mockImplementation(async (q, _c, f) => {
      if (f.cursor) return batch(ids(19, 3).map(picture), 'i2');
      return batch(ids(q === 'python' ? 1 : 101, 18).map(picture), 'i1');
    });
    open('/search?q=python&category=images');
    await screen.findByAltText('Picture 1');
    fireEvent.click(button());
    await screen.findByAltText('Picture 21');
    act(() => navigate('/search?q=cats&category=images'));
    await screen.findByAltText('Picture 101');
    expect(tileIds()).toHaveLength(18);
    expect(screen.queryByAltText('Picture 1')).toBeNull();
    const [query, category, filters] = searchApi.search.mock.calls.at(-1);
    expect([query, category, filters.cursor]).toEqual(['cats', 'images', undefined]);
  });
});

describe('Images: 60 first, then 20 a click', () => {
  const picture = n => ({
    id: `img-${n}`,
    title: `Picture ${n}`,
    imageUrl: `https://pics.example/${n}.jpg`,
    thumbnailUrl: `https://pics.example/${n}.jpg`,
    sourceUrl: `https://pics.example/page-${n}`,
    sourceDomain: 'pics.example',
    width: 800,
    height: 600,
    source: 'parallel'
  });
  const ids = (from, n) => Array.from({ length: n }, (_, i) => from + i);
  const external = { provider: 'parallel', status: 'ok', count: 20 };
  const batch = (results, next) => ({
    ...answer(results, { more: Boolean(next), cursor: next, total: 99 }),
    external
  });
  const tileIds = () =>
    [...document.querySelectorAll('.ph-masonry-tile')].map(tile => tile.dataset.imageId);

  it('asks for 60 pictures first and 20 a click after; Videos keeps 12 and 10', async () => {
    searchApi.search.mockImplementation(async (_q, category, f) => {
      if (category === 'videos') return { ...answer([]), external };
      const table = {
        first: [ids(1, 60).map(picture), 'i1'],
        // A repeat of picture 60 and of picture 1 come back: they are not shown twice.
        i1: [[picture(60), ...ids(61, 20).map(picture), picture(1)], 'i2'],
        i2: [ids(81, 7).map(picture), null]
      };
      const [results, next] = table[f.cursor || 'first'];
      return batch(results, next);
    });
    open('/search?q=python&category=images');
    await screen.findByAltText('Picture 60');
    expect(tileIds()).toHaveLength(60);
    expect(searchApi.search.mock.calls[0][2]).toMatchObject({ limit: 60 });
    expect(searchApi.search.mock.calls[0][2].cursor).toBeUndefined();

    fireEvent.click(button());
    await screen.findByAltText('Picture 80');
    expect(tileIds()).toHaveLength(80);
    expect(new Set(tileIds()).size).toBe(80);
    expect(searchApi.search.mock.calls[1][2]).toMatchObject({ cursor: 'i1', limit: 20 });

    fireEvent.click(button());
    await screen.findByAltText('Picture 87');
    expect(tileIds()).toHaveLength(87);
    expect(searchApi.search.mock.calls[2][2]).toMatchObject({ cursor: 'i2', limit: 20 });
    expect(button()).toBeNull();
    expect(screen.getByText(/reached the end of the results/)).toBeInTheDocument();

    act(() => navigate('/search?q=python&category=videos'));
    await waitFor(() =>
      expect(searchApi.search).toHaveBeenLastCalledWith(
        'python',
        'videos',
        expect.objectContaining({ limit: 12 })
      )
    );
  });

  it('fewer than 60 and nothing more: every picture there is, and no Load more', async () => {
    searchApi.search.mockResolvedValue(batch(ids(1, 36).map(picture), null));
    open('/search?q=python&category=images');
    await screen.findByAltText('Picture 36');
    expect(tileIds()).toHaveLength(36);
    expect(button()).toBeNull();
  });
});
