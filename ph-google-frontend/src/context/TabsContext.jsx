import React, { createContext, useCallback, useContext, useMemo, useReducer } from 'react';
import { embedUrlFor, titleForUrl } from '../utils/browserUrl';

/**
 * The in-app browser tabs.
 *
 * The first tab ("PH Search") is the application itself — its routes, as
 * they always were. Every other tab is one of:
 *
 *   ph     PH Search again, in a frame of its own: the same home page and
 *          search pages, with their own query, page and filters. A new tab
 *          starts here, on the home page.
 *   web    a website, shown in a frame
 *
 * A search result followed in a tab opens in that same tab — the first one
 * too, whose history then holds the website after the search page it came
 * from; its own routes stay mounted, hidden, while the website is in view.
 *
 * Every tab, the first included, keeps its own history: the pages it has
 * been on, and where among them it is. Back and Forward move within that,
 * never through the browser's own history, which all the frames share.
 *
 * `frameSrc` is the address last given to a tab's frame; it changes only
 * when the frame must load something, never because the page inside moved
 * on by itself — so reporting a move never reloads the frame. `innerNav`
 * counts the pages a website tab's visitor has followed inside the site,
 * which this app can count but not see.
 */

export const MAIN_TAB_ID = 'main';
export const MAIN_TAB_TITLE = 'PH Search';
export const HOME_PATH = '/';
const NEW_TAB_TITLE = 'New Tab';

const mainTab = { id: MAIN_TAB_ID, title: MAIN_TAB_TITLE, history: [], index: -1, loading: false };

export const initialTabsState = { tabs: [mainTab], activeId: MAIN_TAB_ID, nextId: 1 };

/** What a tab is showing: main, web or ph. */
export function kindOf(tab) {
  const entry = tab.history[tab.index];
  if (tab.id === MAIN_TAB_ID) return entry && entry.kind === 'web' ? 'web' : 'main';
  return entry ? entry.kind : 'ph';
}

export const currentEntry = tab => tab.history[tab.index] || null;

/** The address for a search, in the first tab or a PH tab's own frame. */
export const searchPath = query => `/search?q=${encodeURIComponent(query)}`;

const PAGE_TITLES = {
  '/': NEW_TAB_TITLE,
  '/history': 'History',
  '/settings': 'Settings',
  '/login': 'Sign in',
  '/signup': 'Sign up'
};

/** A PH tab is named after what is searched in it, or the page it is on. */
function phTitle(path) {
  try {
    const url = new URL(path, 'http://x');
    return url.searchParams.get('q') || PAGE_TITLES[url.pathname] || MAIN_TAB_TITLE;
  } catch {
    return MAIN_TAB_TITLE;
  }
}

function entryFor(target) {
  return target.kind === 'web'
    ? { kind: 'web', url: target.url, title: target.title || titleForUrl(target.url) }
    : { kind: 'ph', url: target.url, title: phTitle(target.url) };
}

const frameSrcOf = entry => (entry.kind === 'web' ? embedUrlFor(entry.url) : entry.url);

/** A tab's frame loading an entry afresh. */
const framed = (tab, entry) => ({
  ...tab,
  title: entry.title,
  frameSrc: frameSrcOf(entry),
  frameKey: (tab.frameKey || 0) + 1,
  innerNav: 0,
  loading: true
});

/** A tab sent to an entry: the entry joins its history and its frame loads it. */
function sendTo(tab, entry) {
  const history = [...tab.history.slice(0, tab.index + 1), entry];
  return framed({ ...tab, history, index: history.length - 1 }, entry);
}

const update = (state, id, change) => ({
  ...state,
  tabs: state.tabs.map(tab => (tab.id === id ? change(tab) : tab))
});

export function tabsReducer(state, action) {
  switch (action.type) {
    case 'new': {
      const id = `tab-${state.nextId}`;
      const tab = { id, title: NEW_TAB_TITLE, history: [], index: -1, loading: false };
      // A new tab opens the home page, like the first tab does.
      const opened = sendTo(tab, entryFor(action.target || { kind: 'ph', url: HOME_PATH }));
      return { tabs: [...state.tabs, opened], activeId: id, nextId: state.nextId + 1 };
    }
    case 'activate':
      return state.tabs.some(tab => tab.id === action.id)
        ? { ...state, activeId: action.id }
        : state;
    case 'close': {
      // The first tab is the application itself and stays.
      if (action.id === MAIN_TAB_ID) return state;
      const at = state.tabs.findIndex(tab => tab.id === action.id);
      if (at === -1) return state;
      const tabs = state.tabs.filter(tab => tab.id !== action.id);
      // Closing the tab in view moves to its right-hand neighbour, else its left.
      const activeId =
        state.activeId === action.id ? (tabs[at] || tabs[at - 1]).id : state.activeId;
      return { ...state, tabs, activeId };
    }
    case 'go':
      // The first tab's own pages are its router's; a website can follow them.
      if (action.id === MAIN_TAB_ID && action.target.kind !== 'web') return state;
      return update(state, action.id, tab => sendTo(tab, entryFor(action.target)));
    case 'step':
      return update(state, action.id, tab => {
        const index = tab.index + action.delta;
        const entry = tab.history[index];
        if (!entry) return tab;
        // "Soft": the page in the tab is told to go there itself (the first
        // tab's router, or the PH page in a frame), so no frame reloads.
        if (action.soft) return { ...tab, index, title: entry.title };
        // The first tab's own pages are its router's to show; a website it
        // followed is loaded like any tab's.
        if (tab.id === MAIN_TAB_ID && entry.kind !== 'web')
          return { ...tab, index, title: entry.title };
        return framed({ ...tab, index }, entry);
      });
    case 'reload':
      // The frame loads the tab's current page again — which, for a PH tab
      // that has moved on by itself, is where it is now, not where it began.
      return update(state, action.id, tab => {
        const entry = currentEntry(tab);
        if (!entry) return tab;
        return tab.id === MAIN_TAB_ID && entry.kind !== 'web'
          ? { ...tab, loading: true }
          : framed(tab, entry);
      });
    case 'loaded':
      return update(state, action.id, tab => (tab.loading ? { ...tab, loading: false } : tab));
    case 'inner':
      // A website tab's visitor followed a link inside the site, or came back.
      return update(state, action.id, tab => ({
        ...tab,
        innerNav: Math.max(0, (tab.innerNav || 0) + action.delta)
      }));
    case 'moved':
      // The page in a tab went somewhere by itself — the first tab's router,
      // or the PH page in a frame: remember where, without touching a frame.
      return update(state, action.id, tab => {
        const kind = tab.id === MAIN_TAB_ID ? 'main' : 'ph';
        const entry = currentEntry(tab);
        if (kind === 'ph' && (!entry || entry.kind !== 'ph')) return tab;
        if (entry && entry.url === action.url) return tab;
        const title = kind === 'main' ? MAIN_TAB_TITLE : phTitle(action.url);
        // The browser's own Back or Forward button: a step, not a new page.
        const at = [tab.index - 1, tab.index + 1].find(
          i => tab.history[i] && tab.history[i].kind === kind && tab.history[i].url === action.url
        );
        if (at !== undefined) return { ...tab, index: at, title };
        const history = [...tab.history.slice(0, tab.index + 1), { kind, url: action.url, title }];
        return { ...tab, history, index: history.length - 1, title };
      });
    default:
      return state;
  }
}

const TabsContext = createContext(null);

export function TabsProvider({ children }) {
  const [state, dispatch] = useReducer(tabsReducer, initialTabsState);

  const newTab = useCallback(() => dispatch({ type: 'new' }), []);
  const openUrl = useCallback(
    (url, title) => dispatch({ type: 'new', target: { kind: 'web', url, title } }),
    []
  );
  const activate = useCallback(id => dispatch({ type: 'activate', id }), []);
  const close = useCallback(id => dispatch({ type: 'close', id }), []);
  const go = useCallback((id, target) => dispatch({ type: 'go', id, target }), []);
  const step = useCallback(
    (id, delta, soft = false) => dispatch({ type: 'step', id, delta, soft }),
    []
  );
  const reload = useCallback(id => dispatch({ type: 'reload', id }), []);
  const loaded = useCallback(id => dispatch({ type: 'loaded', id }), []);
  const moved = useCallback((id, url) => dispatch({ type: 'moved', id, url }), []);
  const inner = useCallback((id, delta) => dispatch({ type: 'inner', id, delta }), []);

  const value = useMemo(
    () => ({ ...state, newTab, openUrl, activate, close, go, step, reload, loaded, moved, inner }),
    [state, newTab, openUrl, activate, close, go, step, reload, loaded, moved, inner]
  );
  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}

export function useTabs() {
  const value = useContext(TabsContext);
  if (!value) throw new Error('useTabs must be used inside <TabsProvider>.');
  return value;
}
