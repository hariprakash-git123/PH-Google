import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import BrowserShell, { linkToOpen } from './BrowserShell';
import SearchResult from '../SearchResult/SearchResult';
import { initialTabsState, kindOf, tabsReducer } from '../../context/TabsContext';
import {
  embedUrlFor,
  opensExternally,
  parseAddressInput,
  titleForUrl
} from '../../utils/browserUrl';
import { checkEmbeddable } from '../../services/embedApi';

vi.mock('../../services/embedApi', () => ({ checkEmbeddable: vi.fn(async () => 'ok') }));

describe('what is typed in the address field', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    ['http://example.com/a?b=1', 'http://example.com/a?b=1'],
    ['example.com', 'https://example.com/'],
    ['en.wikipedia.org/wiki/Python', 'https://en.wikipedia.org/wiki/Python'],
    ['localhost:3000/x', 'http://localhost:3000/x']
  ])('%s is an address', (input, url) => {
    expect(parseAddressInput(input)).toEqual({ type: 'url', url });
  });

  it.each([
    'python tutorial',
    'python',
    'what is example.com',
    'javascript:alert(1)',
    'file:///etc/passwd'
  ])('%s is a search', input => {
    expect(parseAddressInput(input)).toEqual({ type: 'search', query: input });
  });

  it('nothing typed is nothing to do', () => {
    expect(parseAddressInput('   ')).toBeNull();
  });
});

describe('tab titles and addresses', () => {
  it.each([
    ['https://en.wikipedia.org/wiki/Python', 'Wikipedia'],
    ['https://github.com/nodejs/node', 'GitHub'],
    ['https://www.youtube.com/watch?v=abc123xyz', 'YouTube'],
    ['https://docs.python.org/3/', 'Python'],
    ['https://www.bbc.co.uk/news', 'BBC'],
    ['https://example.com/', 'Example'],
    ['not a url', 'New Tab']
  ])('%s → %s', (url, title) => {
    expect(titleForUrl(url)).toBe(title);
  });

  it('frames a YouTube video at the address YouTube publishes for framing', () => {
    expect(embedUrlFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ'
    );
    expect(embedUrlFor('https://youtu.be/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ'
    );
    // Every other page is framed at its own address.
    expect(embedUrlFor('https://example.com/a')).toBe('https://example.com/a');
  });

  it('map links keep opening outside the app', () => {
    expect(opensExternally('https://www.google.com/maps/place/x')).toBe(true);
    expect(opensExternally('https://www.openstreetmap.org/copyright')).toBe(true);
    expect(opensExternally('https://en.wikipedia.org/wiki/Python')).toBe(false);
  });
});

describe('tab state', () => {
  const run = (...actions) => actions.reduce(tabsReducer, initialTabsState);
  const web = url => ({ kind: 'web', url });

  it('starts with one tab: PH Search', () => {
    expect(initialTabsState.tabs.map(t => t.title)).toEqual(['PH Search']);
    expect(initialTabsState.activeId).toBe('main');
  });

  it('a new tab is added and comes into view; each keeps its own state', () => {
    const state = run(
      { type: 'new', target: web('https://en.wikipedia.org/wiki/Python') },
      { type: 'new' }
    );
    expect(state.tabs.map(t => [t.title, kindOf(t)])).toEqual([
      ['PH Search', 'main'],
      ['Wikipedia', 'web'],
      ['New Tab', 'ph']
    ]);
    expect(state.activeId).toBe('tab-2');
    expect(state.tabs[1].frameSrc).toBe('https://en.wikipedia.org/wiki/Python');
    // A new tab is the application's own home page, in its own frame.
    expect(state.tabs[2].frameSrc).toBe('/');
  });

  it('the first tab has a history of its own: the pages its router showed', () => {
    const at = url => ({ type: 'moved', id: 'main', url });
    let state = run(at('/'), at('/search?q=python'), at('/search?q=python&category=images'));
    const main = () => state.tabs[0];
    expect(main().history.map(e => e.url)).toEqual([
      '/',
      '/search?q=python',
      '/search?q=python&category=images'
    ]);
    expect([main().index, main().title]).toEqual([2, 'PH Search']);

    // A step is the router's to make: only the place in the history moves.
    state = tabsReducer(state, { type: 'step', id: 'main', delta: -1, soft: true });
    expect(main().index).toBe(1);
    // The router arriving there is not a new page…
    state = tabsReducer(state, at('/search?q=python'));
    expect([main().index, main().history.length]).toEqual([1, 3]);
    // …nor is the browser's own Back button, one page further.
    state = tabsReducer(state, at('/'));
    expect([main().index, main().history.length]).toEqual([0, 3]);
    // Somewhere new from here drops what was ahead.
    state = tabsReducer(state, at('/settings'));
    expect(main().history.map(e => e.url)).toEqual(['/', '/settings']);
  });

  it('the first tab can follow a search result, and step back to its own page', () => {
    const at = url => ({ type: 'moved', id: 'main', url });
    let state = run(at('/search?q=youtube'), {
      type: 'go',
      id: 'main',
      target: web('https://www.youtube.com/')
    });
    const main = () => state.tabs[0];
    expect(state.tabs).toHaveLength(1);
    expect(kindOf(main())).toBe('web');
    expect(main().history.map(e => [e.kind, e.url])).toEqual([
      ['main', '/search?q=youtube'],
      ['web', 'https://www.youtube.com/']
    ]);
    expect([main().title, main().frameSrc]).toEqual(['YouTube', 'https://www.youtube.com/']);

    state = tabsReducer(state, { type: 'step', id: 'main', delta: -1 });
    expect([kindOf(main()), main().index, main().title]).toEqual(['main', 0, 'PH Search']);
    state = tabsReducer(state, { type: 'step', id: 'main', delta: 1 });
    expect([kindOf(main()), main().index]).toEqual(['web', 1]);

    // Its own pages stay its router's: only a website can be sent to it.
    const before = state;
    state = tabsReducer(state, { type: 'go', id: 'main', target: { kind: 'ph', url: '/' } });
    expect(state).toBe(before);
  });

  it('counts the links followed inside a website tab, and forgets them when the tab moves on', () => {
    let state = run({ type: 'new', target: web('https://a.example/') });
    state = tabsReducer(state, { type: 'inner', id: 'tab-1', delta: 1 });
    state = tabsReducer(state, { type: 'inner', id: 'tab-1', delta: 1 });
    expect(state.tabs[1].innerNav).toBe(2);
    state = tabsReducer(state, { type: 'inner', id: 'tab-1', delta: -1 });
    expect(state.tabs[1].innerNav).toBe(1);
    state = tabsReducer(state, { type: 'reload', id: 'tab-1' });
    expect(state.tabs[1].innerNav).toBe(0);
  });

  it('reloading a PH tab loads the page it is on now, not the one it began on', () => {
    let state = run({ type: 'new' });
    state = tabsReducer(state, { type: 'moved', id: 'tab-1', url: '/search?q=python' });
    expect(state.tabs[1].frameSrc).toBe('/'); // moving on did not touch the frame
    state = tabsReducer(state, { type: 'reload', id: 'tab-1' });
    expect(state.tabs[1].frameSrc).toBe('/search?q=python');
  });

  it('closing the tab in view moves to its neighbour; closing another changes nothing in view', () => {
    const three = run({ type: 'new' }, { type: 'new' }, { type: 'new' });
    const middle = tabsReducer({ ...three, activeId: 'tab-2' }, { type: 'close', id: 'tab-2' });
    expect(middle.activeId).toBe('tab-3');
    const last = tabsReducer(three, { type: 'close', id: 'tab-3' });
    expect(last.activeId).toBe('tab-2');
    const other = tabsReducer(three, { type: 'close', id: 'tab-1' });
    expect(other.activeId).toBe('tab-3');
  });

  it('the first tab cannot be closed', () => {
    expect(tabsReducer(initialTabsState, { type: 'close', id: 'main' })).toBe(initialTabsState);
  });

  it('back and forward move through the tab’s own history', () => {
    let state = run(
      { type: 'new', target: web('https://a.example/') },
      { type: 'go', id: 'tab-1', target: web('https://b.example/') }
    );
    const tab = () => state.tabs[1];
    expect([tab().index, tab().frameSrc]).toEqual([1, 'https://b.example/']);

    state = tabsReducer(state, { type: 'step', id: 'tab-1', delta: -1 });
    expect([tab().index, tab().frameSrc, tab().title]).toEqual([0, 'https://a.example/', 'A']);
    state = tabsReducer(state, { type: 'step', id: 'tab-1', delta: 1 });
    expect(tab().frameSrc).toBe('https://b.example/');
    // Nothing past either end.
    expect(tabsReducer(state, { type: 'step', id: 'tab-1', delta: 1 })).toEqual(state);

    // Going somewhere new from the middle drops what was ahead.
    state = tabsReducer(state, { type: 'step', id: 'tab-1', delta: -1 });
    state = tabsReducer(state, { type: 'go', id: 'tab-1', target: web('https://c.example/') });
    expect(tab().history.map(e => e.url)).toEqual(['https://a.example/', 'https://c.example/']);
  });

  it('reload gives the frame a new key without changing the address', () => {
    const before = run({ type: 'new', target: web('https://a.example/') });
    const after = tabsReducer(before, { type: 'reload', id: 'tab-1' });
    expect(after.tabs[1].frameSrc).toBe(before.tabs[1].frameSrc);
    expect(after.tabs[1].frameKey).toBe(before.tabs[1].frameKey + 1);
  });

  it('a PH tab remembers where its page went without reloading its frame', () => {
    let state = run(
      { type: 'new' },
      { type: 'go', id: 'tab-1', target: { kind: 'ph', url: '/search?q=python' } }
    );
    const { frameSrc, frameKey } = state.tabs[1];
    expect(state.tabs[1].title).toBe('python');
    state = tabsReducer(state, {
      type: 'moved',
      id: 'tab-1',
      url: '/search?q=python&category=images'
    });
    // The home page it opened on, the search, and where the search went.
    expect(state.tabs[1].history.map(e => e.url)).toEqual([
      '/',
      '/search?q=python',
      '/search?q=python&category=images'
    ]);
    expect([state.tabs[1].frameSrc, state.tabs[1].frameKey]).toEqual([frameSrc, frameKey]);
  });
});

describe('the shell', () => {
  function Where() {
    const location = useLocation();
    return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
  }
  const SearchPage = () => (
    <main>
      <Where />
      <h1>Results</h1>
      <a href="https://en.wikipedia.org/wiki/Python" target="_blank" rel="noopener noreferrer">
        Python (programming language) - Wikipedia
      </a>
      <a href="https://www.google.com/maps/place/x" target="_blank" rel="noopener noreferrer">
        View on Maps
      </a>
      <a href="/settings">Settings</a>
    </main>
  );
  const renderShell = (path = '/search?q=python') =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <BrowserShell>
          <Routes>
            <Route path="*" element={<SearchPage />} />
          </Routes>
        </BrowserShell>
      </MemoryRouter>
    );
  const tabTitles = () => screen.getAllByRole('tab').map(t => t.textContent);
  const address = () => screen.getByRole('textbox', { name: /search ph or enter a web address/i });
  const typeAddress = text => {
    fireEvent.change(address(), { target: { value: text } });
    fireEvent.submit(address().closest('form'));
  };

  beforeEach(() => {
    checkEmbeddable.mockReset();
    checkEmbeddable.mockResolvedValue('ok');
    window.scrollTo = vi.fn();
  });

  it('starts with one PH Search tab showing the application', () => {
    renderShell();
    expect(tabTitles()).toEqual(['PH Search']);
    expect(screen.getByRole('tab', { name: 'PH Search' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Results' })).toBeVisible();
    expect(address()).toHaveValue('python');
    // The only tab has no close button.
    expect(screen.queryByRole('button', { name: /close tab/i })).toBeNull();
  });

  it('+ opens a new tab on the real home page; the search tab is kept, hidden', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    expect(tabTitles()).toEqual(['PH Search', 'New Tab']);
    expect(screen.getByRole('tab', { name: 'New Tab' })).toHaveAttribute('aria-selected', 'true');
    // The application itself at "/", in the tab's own frame — not a second,
    // simpler start page.
    const frame = await screen.findByTitle('PH Search: New Tab');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', '/');
    expect(frame).not.toHaveAttribute('sandbox');
    expect(screen.queryByPlaceholderText('Search the web or enter an address')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Results', hidden: true })).not.toBeVisible();
  });

  describe('Back, Forward and Reload in the first tab', () => {
    const button = name => screen.getByRole('button', { name });
    const where = () => screen.getByTestId('where').textContent;

    it('are the tab’s own: disabled with nowhere to go, enabled as its history grows', () => {
      renderShell('/');
      expect(button('Back')).toBeDisabled();
      expect(button('Forward')).toBeDisabled();
      expect(button('Reload')).toBeEnabled();

      typeAddress('python');
      expect(where()).toBe('/search?q=python');
      expect(button('Back')).toBeEnabled();
      expect(button('Forward')).toBeDisabled();

      fireEvent.click(button('Back'));
      expect(where()).toBe('/');
      expect(address()).toHaveValue('');
      expect(button('Back')).toBeDisabled();
      expect(button('Forward')).toBeEnabled();

      fireEvent.click(button('Forward'));
      expect(where()).toBe('/search?q=python');
      expect(address()).toHaveValue('python');
      expect(button('Forward')).toBeDisabled();
    });

    it('do not use the browser’s history, which every framed tab shares', () => {
      const back = vi.spyOn(window.history, 'back');
      const forward = vi.spyOn(window.history, 'forward');
      const goSpy = vi.spyOn(window.history, 'go');
      renderShell('/');
      typeAddress('python');
      typeAddress('openai');
      fireEvent.click(button('Back'));
      fireEvent.click(button('Back'));
      fireEvent.click(button('Forward'));
      expect(where()).toBe('/search?q=python');
      expect(back).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
      expect(goSpy).not.toHaveBeenCalled();
    });

    it('going back in the first tab leaves the other tabs as they are', async () => {
      renderShell('/');
      typeAddress('python');
      fireEvent.click(screen.getByRole('link', { name: /Python \(programming language\)/ }));
      const frame = await screen.findByTitle('Wikipedia');
      // A website opened from a result has nowhere to go back to yet.
      expect(button('Back')).toBeDisabled();

      fireEvent.click(screen.getByRole('tab', { name: 'PH Search' }));
      fireEvent.click(button('Back'));
      expect(where()).toBe('/');
      expect(screen.getByTitle('Wikipedia')).toBe(frame);
      expect(frame).toHaveAttribute('src', 'https://en.wikipedia.org/wiki/Python');
    });

    it('Reload mounts the page again and shows that it did; other tabs are untouched', async () => {
      let mounts = 0;
      const Counted = () => {
        React.useEffect(() => {
          mounts += 1;
        }, []);
        return <h1>Results</h1>;
      };
      render(
        <MemoryRouter initialEntries={['/search?q=python']}>
          <BrowserShell>
            <Counted />
          </BrowserShell>
        </MemoryRouter>
      );
      fireEvent.click(button('New tab'));
      const other = await screen.findByTitle('PH Search: New Tab');
      fireEvent.click(screen.getByRole('tab', { name: 'PH Search' }));
      expect(mounts).toBe(1);

      fireEvent.click(button('Reload'));
      expect(mounts).toBe(2);
      expect(document.querySelector('.ph-shell-progress')).not.toBeNull();
      await waitFor(() => expect(document.querySelector('.ph-shell-progress')).toBeNull(), {
        timeout: 2000
      });
      // The other tab's frame is the same one: it was not reloaded.
      expect(screen.getByTitle('PH Search: New Tab')).toBe(other);
      expect(tabTitles()).toEqual(['PH Search', 'New Tab']);
    });
  });

  describe('a website tab and the links followed inside it', () => {
    const button = name => screen.getByRole('button', { name });

    it('Back becomes available, and goes back inside the site', async () => {
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
      renderShell();
      fireEvent.click(screen.getByRole('link', { name: /Python \(programming language\)/ }));
      const frame = await screen.findByTitle('Wikipedia');
      fireEvent.load(frame); // the page it was opened on
      expect(button('Back')).toBeDisabled();

      fireEvent.load(frame); // a link followed inside the site
      expect(button('Back')).toBeEnabled();
      fireEvent.click(button('Back'));
      expect(back).toHaveBeenCalledTimes(1);
      fireEvent.load(frame); // the site's previous page arriving
      expect(button('Back')).toBeDisabled();
      // The frame itself was never replaced.
      expect(screen.getByTitle('Wikipedia')).toBe(frame);
    });

    it('if another tab has moved since, Back returns to the page the tab was opened on', async () => {
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
      renderShell();
      fireEvent.click(screen.getByRole('link', { name: /Python \(programming language\)/ }));
      const frame = await screen.findByTitle('Wikipedia');
      fireEvent.load(frame);
      fireEvent.load(frame);

      // The first tab searches for something else in the meantime.
      fireEvent.click(screen.getByRole('tab', { name: 'PH Search' }));
      typeAddress('openai');
      fireEvent.click(screen.getByRole('tab', { name: 'Wikipedia' }));
      fireEvent.click(button('Back'));

      // The browser's history would have undone the first tab's search.
      expect(back).not.toHaveBeenCalled();
      expect(screen.getByTestId('where')).toHaveTextContent('/search?q=openai');
      await waitFor(() => expect(screen.getByTitle('Wikipedia')).not.toBe(frame));
      expect(screen.getByTitle('Wikipedia')).toHaveAttribute(
        'src',
        'https://en.wikipedia.org/wiki/Python'
      );
      expect(button('Back')).toBeDisabled();
    });
  });

  it('clicking a result opens it in a new PH tab, in a sandboxed frame — not a browser window', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderShell();
    const link = screen.getByRole('link', { name: /Python \(programming language\)/ });
    const notPrevented = fireEvent.click(link);

    expect(notPrevented).toBe(false); // the browser's own new window was stopped
    expect(open).not.toHaveBeenCalled();
    expect(tabTitles()).toEqual(['PH Search', 'Wikipedia']);
    expect(screen.getByRole('tab', { name: 'Wikipedia' })).toHaveAttribute('aria-selected', 'true');
    expect(checkEmbeddable).toHaveBeenCalledWith('https://en.wikipedia.org/wiki/Python');

    const frame = await screen.findByTitle('Wikipedia');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', 'https://en.wikipedia.org/wiki/Python');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(address()).toHaveValue('https://en.wikipedia.org/wiki/Python');

    // The search is still there, untouched, behind its tab.
    fireEvent.click(screen.getByRole('tab', { name: 'PH Search' }));
    expect(screen.getByRole('heading', { name: 'Results' })).toBeVisible();
    expect(screen.getByTestId('where')).toHaveTextContent('/search?q=python');
    expect(address()).toHaveValue('python');
    // And the website's frame was not thrown away by switching.
    expect(screen.getByTitle('Wikipedia')).toBe(frame);
  });

  it('leaves alone the clicks that mean something else', () => {
    renderShell();
    const link = screen.getByRole('link', { name: /Python \(programming language\)/ });
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { button: 1 });
    fireEvent.click(screen.getByRole('link', { name: 'View on Maps' }));
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    expect(tabTitles()).toEqual(['PH Search']);
  });

  it('a site that refuses framing gets a notice and a way out, not a blank frame', async () => {
    checkEmbeddable.mockResolvedValue('blocked');
    renderShell();
    fireEvent.click(screen.getByRole('link', { name: /Python \(programming language\)/ }));

    expect(await screen.findByText('This website does not allow embedded viewing.')).toBeVisible();
    expect(screen.queryByTitle('Wikipedia')).toBeNull();
    const out = screen.getByRole('link', { name: /open externally/i });
    expect(out).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Python');
    expect(out).toHaveAttribute('target', '_blank');
    expect(out).toHaveAttribute('rel', 'noopener noreferrer');
    // That link really leaves: it does not open yet another tab.
    fireEvent.click(out);
    expect(tabTitles()).toEqual(['PH Search', 'Wikipedia']);
  });

  it('an address typed in a tab loads there; back, forward and reload work', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();

    typeAddress('https://example.com');
    const first = await screen.findByTitle('Example');
    expect(first).toHaveAttribute('src', 'https://example.com/');
    expect(tabTitles()).toEqual(['PH Search', 'Example']);

    typeAddress('en.wikipedia.org/wiki/Python');
    expect(await screen.findByTitle('Wikipedia')).toHaveAttribute(
      'src',
      'https://en.wikipedia.org/wiki/Python'
    );
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByTitle('Example')).toHaveAttribute('src', 'https://example.com/');
    expect(address()).toHaveValue('https://example.com/');

    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    const again = await screen.findByTitle('Wikipedia');

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(screen.getByTitle('Wikipedia')).not.toBe(again));
    expect(screen.getByTitle('Wikipedia')).toHaveAttribute(
      'src',
      'https://en.wikipedia.org/wiki/Python'
    );
  });

  it('a search typed in the first tab uses the existing search page', () => {
    renderShell('/');
    typeAddress('python tutorial');
    expect(screen.getByTestId('where')).toHaveTextContent('/search?q=python%20tutorial');
    expect(tabTitles()).toEqual(['PH Search']);
  });

  it('a search typed in the address field of a new tab is run by that tab’s own page', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    const frame = await screen.findByTitle('PH Search: New Tab');
    const told = vi.spyOn(frame.contentWindow, 'postMessage').mockImplementation(() => {});

    typeAddress('openai');
    // The page in the frame is told to search; the frame is not reloaded.
    expect(told).toHaveBeenCalledWith(
      { source: 'ph-tab', type: 'navigate', url: '/search?q=openai' },
      window.location.origin
    );
    expect(screen.getByTitle('PH Search: New Tab')).toBe(frame);
    // The first tab's search did not move.
    expect(screen.getByTestId('where')).toHaveTextContent('/search?q=python');

    // The page reports where it went: the tab is renamed, and can go back.
    fireEvent(
      window,
      new MessageEvent('message', {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: { source: 'ph-tab', type: 'moved', url: '/search?q=openai' }
      })
    );
    expect(tabTitles()).toEqual(['PH Search', 'openai']);
    expect(address()).toHaveValue('openai');
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();

    told.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(told).toHaveBeenCalledWith(
      { source: 'ph-tab', type: 'navigate', url: '/' },
      window.location.origin
    );
    expect(tabTitles()).toEqual(['PH Search', 'New Tab']);
    expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled();
  });

  it('a search typed in a website tab turns that tab into PH Search', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('link', { name: /Python \(programming language\)/ }));
    await screen.findByTitle('Wikipedia');
    typeAddress('openai');
    const frame = await screen.findByTitle('PH Search: openai');
    expect(frame).toHaveAttribute('src', '/search?q=openai');
    expect(tabTitles()).toEqual(['PH Search', 'openai']);
    expect(screen.getByTestId('where')).toHaveTextContent('/search?q=python');
  });

  it('closing the tab in view shows a neighbour; the last one left is PH Search', async () => {
    renderShell();
    fireEvent.click(screen.getByRole('link', { name: /Python \(programming language\)/ }));
    await screen.findByTitle('Wikipedia');
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    expect(tabTitles()).toEqual(['PH Search', 'Wikipedia', 'New Tab']);

    fireEvent.click(screen.getByRole('button', { name: 'Close tab: New Tab' }));
    expect(screen.getByRole('tab', { name: 'Wikipedia' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Close tab: Wikipedia' }));
    expect(tabTitles()).toEqual(['PH Search']);
    expect(screen.getByRole('heading', { name: 'Results' })).toBeVisible();
    expect(
      within(screen.getByRole('tablist')).queryByRole('button', { name: /close/i })
    ).toBeNull();
  });
});

describe('a search result link', () => {
  const result = {
    id: 'yt',
    url: 'https://www.youtube.com/',
    domain: 'youtube.com',
    title: 'YouTube',
    snippet: 'Enjoy the videos.',
    publishedAgo: 'Unknown',
    category: 'Web',
    source: 'parallel'
  };
  function Where() {
    const location = useLocation();
    return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
  }
  const renderWithResult = () =>
    render(
      <MemoryRouter initialEntries={['/search?q=youtube']}>
        <BrowserShell>
          <Routes>
            <Route
              path="*"
              element={
                <main>
                  <Where />
                  <h1>Results</h1>
                  <SearchResult result={result} />
                </main>
              }
            />
          </Routes>
        </BrowserShell>
      </MemoryRouter>
    );
  const tabTitles = () => screen.getAllByRole('tab').map(t => t.textContent);
  const resultLink = () => screen.getByRole('link', { name: 'YouTube' });

  beforeEach(() => {
    checkEmbeddable.mockReset();
    checkEmbeddable.mockResolvedValue('ok');
    window.scrollTo = vi.fn();
  });

  it('keeps its new-tab attributes for Ctrl/middle-click, and is marked as a result', () => {
    renderWithResult();
    expect(resultLink()).toHaveAttribute('href', 'https://www.youtube.com/');
    expect(resultLink()).toHaveAttribute('target', '_blank');
    expect(resultLink()).toHaveAttribute('rel', 'noopener noreferrer');
    expect(resultLink()).toHaveAttribute('data-ph-result');
    expect(linkToOpen({ defaultPrevented: false, button: 0, target: resultLink() })).toEqual({
      url: 'https://www.youtube.com/',
      title: 'YouTube',
      inPlace: true
    });
  });

  it('a plain click opens it in the current PH tab: no new PH tab, no browser tab', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderWithResult();
    // fireEvent returns false when a handler called preventDefault(): the
    // browser's own new tab was stopped.
    expect(fireEvent.click(resultLink(), { button: 0 })).toBe(false);
    expect(open).not.toHaveBeenCalled();

    // Still one tab — the one clicked in — now showing the site.
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
    const frame = await screen.findByTitle('YouTube');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', 'https://www.youtube.com/');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(screen.getByRole('textbox', { name: /search ph or enter/i })).toHaveValue(
      'https://www.youtube.com/'
    );
    expect(screen.getByRole('heading', { name: 'Results', hidden: true })).not.toBeVisible();
    open.mockRestore();
  });

  it('Back returns that tab to the results it came from, as they were', async () => {
    renderWithResult();
    fireEvent.click(resultLink(), { button: 0 });
    await screen.findByTitle('YouTube');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(tabTitles()).toEqual(['PH Search']);
    expect(screen.getByRole('heading', { name: 'Results' })).toBeVisible();
    expect(screen.getByTestId('where')).toHaveTextContent('/search?q=youtube');
    expect(screen.queryByTitle('YouTube')).toBeNull();
    // Forward goes to the site again.
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    expect(await screen.findByTitle('YouTube')).toHaveAttribute('src', 'https://www.youtube.com/');
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });

  it('a site that refuses framing shows its notice in the same tab, with a way out and a way back', async () => {
    checkEmbeddable.mockResolvedValue('blocked');
    renderWithResult();
    fireEvent.click(resultLink(), { button: 0 });

    expect(await screen.findByText('This website does not allow embedded viewing.')).toBeVisible();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    const out = screen.getByRole('link', { name: /open externally/i });
    expect(out).toHaveAttribute('href', 'https://www.youtube.com/');
    expect(out).toHaveAttribute('target', '_blank');
    expect(out).toHaveAttribute('rel', 'noopener noreferrer');
    // Opening it outside is the visitor's choice, and leaves the tabs alone.
    expect(fireEvent.click(out)).toBe(true);
    expect(screen.getAllByRole('tab')).toHaveLength(1);

    const notice = screen
      .getByText('This website does not allow embedded viewing.')
      .closest('[role="status"]');
    fireEvent.click(within(notice).getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Results' })).toBeVisible();
  });

  it('Ctrl/Cmd-click, Shift-click and middle-click are left to the browser', () => {
    renderWithResult();
    // Not prevented: the browser opens its own new tab or window.
    expect(fireEvent.click(resultLink(), { button: 0, ctrlKey: true })).toBe(true);
    expect(fireEvent.click(resultLink(), { button: 0, metaKey: true })).toBe(true);
    expect(fireEvent.click(resultLink(), { button: 0, shiftKey: true })).toBe(true);
    expect(fireEvent.click(resultLink(), { button: 1 })).toBe(true);
    expect(
      fireEvent(
        resultLink(),
        new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
      )
    ).toBe(true);
    expect(tabTitles()).toEqual(['PH Search']);
    expect(screen.getByRole('heading', { name: 'Results' })).toBeVisible();
    expect(screen.queryByTitle('YouTube')).toBeNull();
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
      expect(
        linkToOpen({ defaultPrevented: false, button: 0, [modifier]: true, target: resultLink() })
      ).toBeNull();
    }
    expect(linkToOpen({ defaultPrevented: false, button: 1, target: resultLink() })).toBeNull();
  });

  it('other new-window links still open a tab of their own', () => {
    renderWithResult();
    const other = document.createElement('a');
    other.href = 'https://en.wikipedia.org/wiki/Python';
    other.target = '_blank';
    document.body.appendChild(other);
    expect(linkToOpen({ defaultPrevented: false, button: 0, target: other })).toMatchObject({
      url: 'https://en.wikipedia.org/wiki/Python',
      inPlace: false
    });
    other.remove();
  });

  it('a result clicked in a PH tab opened with + opens in that tab', async () => {
    renderWithResult();
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    const frame = await screen.findByTitle('PH Search: New Tab');
    // The PH page in that frame reports a result click (see EmbeddedApp).
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: frame.contentWindow,
          data: { source: 'ph-tab', type: 'follow', url: 'https://www.youtube.com/' }
        })
      );
    });
    expect(tabTitles()).toEqual(['PH Search', 'YouTube']);
    expect(screen.getByRole('tab', { name: 'YouTube' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTitle('YouTube')).toHaveAttribute('src', 'https://www.youtube.com/');
    // Back in that tab returns it to its own PH page.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByTitle('PH Search: New Tab')).toHaveAttribute('src', '/');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('an unsafe address reported by a PH tab is ignored', async () => {
    renderWithResult();
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    const frame = await screen.findByTitle('PH Search: New Tab');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: frame.contentWindow,
          data: { source: 'ph-tab', type: 'follow', url: 'javascript:alert(1)' }
        })
      );
    });
    expect(tabTitles()).toEqual(['PH Search', 'New Tab']);
    expect(screen.getByTitle('PH Search: New Tab')).toBe(frame);
  });
});
