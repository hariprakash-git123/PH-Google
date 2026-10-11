import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Plus,
  RotateCw,
  Search,
  ShieldAlert,
  X
} from 'lucide-react';
import { LogoMark } from '../Logo/Logo';
import {
  MAIN_TAB_ID,
  TabsProvider,
  currentEntry,
  kindOf,
  searchPath,
  useTabs
} from '../../context/TabsContext';
import { checkEmbeddable } from '../../services/embedApi';
import { safeHttpUrl } from '../../utils/safeUrl';
import { hostOf, opensExternally, parseAddressInput, titleForUrl } from '../../utils/browserUrl';
import './BrowserShell.css';

/**
 * PH Search as a small browser: a row of tabs, a toolbar, and the page of
 * the tab in view.
 *
 * The application's own routes are the first tab and are never unmounted,
 * so nothing about search changes. A search result opens in the tab it was
 * clicked in, after the search page in that tab's history; any other link
 * that would open a new browser window opens a new tab here instead. Every
 * tab's frame stays mounted while another tab is in view, so switching back
 * does not reload it.
 *
 * A website is shown in a sandboxed frame, inside the browser's ordinary
 * security rules: nothing is proxied or rewritten. A site that refuses to be
 * framed gets a notice and a link that opens it normally.
 *
 * Inside a PH tab's frame the application runs again, without this shell
 * (see EmbeddedApp): it reports where it is and hands its link clicks to
 * the shell that frames it.
 */

const MESSAGE_SOURCE = 'ph-tab';
const SLOW_AFTER_MS = 12000;

/** Whether this document is PH Search inside one of its own tabs. */
function isEmbedded() {
  try {
    return window.self !== window.top && window.parent.location.origin === window.location.origin;
  } catch {
    // A parent on another origin cannot be read: not one of our tabs.
    return false;
  }
}

/**
 * The page a click should open in a tab, or null to leave the click alone.
 *
 * Only an ordinary click on a link that would have opened a new browser
 * window. Ctrl/Cmd/Shift/middle-click keep their meaning, as do downloads,
 * map links and the admin's links.
 *
 * `inPlace` is set for a search result (`data-ph-result`): it opens in the
 * tab it was clicked in, never in a new one. A site that cannot be framed
 * shows its notice there, with a link to open it outside.
 */
export function linkToOpen(event) {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
  if (!link || link.target !== '_blank' || link.hasAttribute('download')) return null;
  if (link.hasAttribute('data-ph-external')) return null;
  const inPlace = link.hasAttribute('data-ph-result');

  const url = safeHttpUrl(link.href);
  if (!url || (!inPlace && opensExternally(url))) return null;
  if (new URL(url).origin === window.location.origin) return null;
  if (window.location.pathname.startsWith('/admin')) return null;
  return { url, title: titleForUrl(url), inPlace };
}

// --- Inside a PH tab's frame ---------------------------------------------

function EmbeddedApp({ children }) {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    window.parent.postMessage(
      { source: MESSAGE_SOURCE, type: 'moved', url: `${location.pathname}${location.search}` },
      window.location.origin
    );
  }, [location.pathname, location.search]);

  // The shell's Back and Forward, and a search typed in its address field:
  // this page goes there itself, so nothing reloads.
  useEffect(() => {
    const onMessage = event => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      const data = event.data;
      if (!data || data.source !== MESSAGE_SOURCE || data.type !== 'navigate') return;
      if (typeof data.url === 'string' && /^\/(?!\/)/.test(data.url)) navigate(data.url);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [navigate]);

  const onClick = event => {
    const target = linkToOpen(event);
    if (!target) return;
    event.preventDefault();
    // A result is followed in this tab; any other link gets a tab of its own.
    window.parent.postMessage(
      {
        source: MESSAGE_SOURCE,
        type: target.inPlace ? 'follow' : 'open',
        url: target.url,
        title: target.title
      },
      window.location.origin
    );
  };

  // Click delegation only: the links themselves stay ordinary, focusable links.
  return (
    <div className="ph-shell-app" onClick={onClick}>
      {children}
    </div>
  );
}

// --- The tab row -----------------------------------------------------------

function TabBar() {
  const { tabs, activeId, activate, close, newTab } = useTabs();
  const rowRef = useRef(null);
  const activeRef = useRef(null);

  // A tab that comes into view — new, or chosen — is scrolled into the row.
  // Only the row moves: scrollIntoView would scroll the page as well.
  useEffect(() => {
    const row = rowRef.current;
    const tab = activeRef.current;
    if (!row || !tab) return;
    if (tab.offsetLeft < row.scrollLeft) row.scrollLeft = tab.offsetLeft;
    else if (tab.offsetLeft + tab.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = tab.offsetLeft + tab.offsetWidth - row.clientWidth;
    }
  }, [activeId, tabs.length]);

  return (
    <div className="ph-tabbar">
      <div className="ph-tabbar-tabs" ref={rowRef} role="tablist" aria-label="Open tabs">
        {tabs.map(tab => {
          const active = tab.id === activeId;
          const kind = kindOf(tab);
          const entry = currentEntry(tab);
          return (
            <div
              key={tab.id}
              ref={active ? activeRef : null}
              className={`ph-tab${active ? ' active' : ''}`}
              title={entry && entry.kind === 'web' ? entry.url : tab.title}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="ph-tab-select"
                onClick={() => activate(tab.id)}
              >
                <span className="ph-tab-icon" aria-hidden="true">
                  {tab.loading ? (
                    <RotateCw size={13} className="animate-spin" />
                  ) : kind === 'web' ? (
                    <Globe size={13} />
                  ) : (
                    <LogoMark size={15} />
                  )}
                </span>
                <span className="ph-tab-title">{tab.title}</span>
              </button>
              {tab.id !== MAIN_TAB_ID && (
                <button
                  type="button"
                  className="ph-tab-close"
                  aria-label={`Close tab: ${tab.title}`}
                  onClick={() => close(tab.id)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" className="ph-tab-new" aria-label="New tab" onClick={newTab}>
        <Plus size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

// --- The toolbar -----------------------------------------------------------

function Toolbar({ onSubmit, onStep, onReload }) {
  const { tabs, activeId } = useTabs();
  const tab = tabs.find(t => t.id === activeId);
  const entry = currentEntry(tab);

  // What the field shows when it is not being typed in: a website's address,
  // or the words searched for on a PH page.
  const shown = !entry
    ? ''
    : entry.kind === 'web'
      ? entry.url
      : new URLSearchParams(entry.url.split('?')[1] || '').get('q') || '';

  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown, activeId]);

  // Back and Forward are the tab's own: its history, plus — for a website —
  // the links followed inside the site.
  const canBack = tab.index > 0 || (tab.innerNav || 0) > 0;
  const canForward = tab.index < tab.history.length - 1;
  const external = entry && entry.kind === 'web' ? safeHttpUrl(entry.url) : null;

  const submit = event => {
    event.preventDefault();
    onSubmit(draft);
    if (event.target.querySelector) {
      const field = event.target.querySelector('input');
      if (field) field.blur();
    }
  };

  return (
    <div className="ph-toolbar">
      <div className="ph-toolbar-nav">
        <button
          type="button"
          className="ph-toolbar-btn"
          aria-label="Back"
          title="Back"
          disabled={!canBack}
          onClick={() => onStep(tab, -1)}
        >
          <ArrowLeft size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ph-toolbar-btn"
          aria-label="Forward"
          title="Forward"
          disabled={!canForward}
          onClick={() => onStep(tab, 1)}
        >
          <ArrowRight size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ph-toolbar-btn"
          aria-label="Reload"
          title="Reload this tab"
          onClick={() => onReload(tab)}
        >
          <RotateCw size={16} aria-hidden="true" />
        </button>
      </div>

      <form className="ph-address" role="search" onSubmit={submit}>
        {entry && entry.kind === 'web' ? (
          <Globe size={15} className="ph-address-icon" aria-hidden="true" />
        ) : (
          <Search size={15} className="ph-address-icon" aria-hidden="true" />
        )}
        <input
          type="text"
          className="ph-address-input"
          aria-label="Search PH or enter a web address"
          placeholder="Search PH or enter a web address"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onFocus={event => event.target.select()}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          enterKeyHint="go"
        />
      </form>

      {external && (
        <a
          className="ph-toolbar-btn"
          href={external}
          target="_blank"
          rel="noopener noreferrer"
          data-ph-external=""
          aria-label="Open this page in a new browser tab"
          title="Open in a new browser tab"
        >
          <ExternalLink size={16} aria-hidden="true" />
        </a>
      )}
    </div>
  );
}

// --- What a tab shows ------------------------------------------------------

function BlockedNotice({ url, onBack }) {
  const host = hostOf(url);
  return (
    <div className="ph-webview-notice" role="status">
      <ShieldAlert size={30} className="ph-webview-notice-icon" aria-hidden="true" />
      <h2>This website does not allow embedded viewing.</h2>
      <p>
        {host || 'This site'} asks browsers not to show it inside another page, so it cannot be
        opened in a PH tab. You can open it in a new browser tab instead.
      </p>
      <div className="ph-webview-notice-actions">
        <a
          className="ph-btn-primary"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          data-ph-external=""
        >
          <ExternalLink size={15} aria-hidden="true" /> Open externally
        </a>
        {onBack && (
          <button type="button" className="ph-btn-secondary" onClick={onBack}>
            <ArrowLeft size={15} aria-hidden="true" /> Back
          </button>
        )}
      </div>
    </div>
  );
}

/** A website in a frame — or the notice that it may not be framed. */
function WebView({ tab, frames, onInnerLoad, onBack }) {
  const { loaded } = useTabs();
  const entry = currentEntry(tab);
  // The verdict belongs to one page load. Until this load has its own, the
  // tab is "checking" — a verdict left from the page before is never used,
  // so a frame is mounted once, when its own answer arrives.
  const loadId = `${tab.frameKey}:${tab.frameSrc}`;
  const [checked, setChecked] = useState({ id: null, verdict: 'checking' });
  const embed = checked.id === loadId ? checked.verdict : 'checking';
  const [slow, setSlow] = useState(false);
  // How many pages each frame element has loaded. The first is the page it
  // was given; each one after is a link followed inside the site.
  const loads = useRef(new WeakMap());
  const onLoad = event => {
    loaded(tab.id);
    const count = (loads.current.get(event.target) || 0) + 1;
    loads.current.set(event.target, count);
    if (count > 1) onInnerLoad(tab.id);
  };

  useEffect(() => {
    let current = true;
    setSlow(false);
    checkEmbeddable(tab.frameSrc).then(verdict => {
      if (!current) return;
      setChecked({ id: loadId, verdict });
      if (verdict === 'blocked') loaded(tab.id);
    });
    return () => {
      current = false;
    };
  }, [tab.id, tab.frameSrc, loadId, loaded]);

  // A page that never finishes loading is not left without a way out.
  useEffect(() => {
    if (embed !== 'ok' || !tab.loading) return undefined;
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [embed, tab.loading, tab.frameKey]);

  if (embed === 'blocked') {
    return <BlockedNotice url={entry.url} onBack={tab.index > 0 ? onBack : null} />;
  }

  return (
    <>
      {tab.loading && <div className="ph-webview-progress" aria-hidden="true" />}
      {embed === 'checking' && (
        <div className="ph-webview-notice" role="status">
          <RotateCw size={22} className="animate-spin" aria-hidden="true" />
          <p>Opening {hostOf(entry.url) || 'page'}…</p>
        </div>
      )}
      {slow && tab.loading && (
        <div className="ph-webview-slow" role="status">
          <span>
            Still loading. If the page stays blank, the site may not allow embedded viewing.
          </span>
          <a href={entry.url} target="_blank" rel="noopener noreferrer" data-ph-external="">
            Open externally
          </a>
        </div>
      )}
      {embed === 'ok' && (
        <iframe
          key={tab.frameKey}
          ref={node => frames.set(tab.id, node)}
          className="ph-webview-frame"
          src={tab.frameSrc}
          title={tab.title}
          // The page runs as itself, but may not navigate or replace this app.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation"
          allow="fullscreen; picture-in-picture; encrypted-media"
          referrerPolicy="no-referrer"
          onLoad={onLoad}
        />
      )}
    </>
  );
}

/**
 * PH Search again, in a frame of its own: the application's real pages —
 * the home page of a new tab, its search results — not a copy of them.
 */
function PhView({ tab, frames }) {
  const { loaded } = useTabs();
  return (
    <>
      {tab.loading && <div className="ph-webview-progress" aria-hidden="true" />}
      <iframe
        key={tab.frameKey}
        ref={node => frames.set(tab.id, node)}
        className="ph-webview-frame"
        src={tab.frameSrc}
        title={`PH Search: ${tab.title}`}
        onLoad={() => loaded(tab.id)}
      />
    </>
  );
}

// --- The shell --------------------------------------------------------------

function Shell({ children }) {
  const { tabs, activeId, openUrl, go, step, reload, loaded, moved, inner } = useTabs();
  const navigate = useNavigate();
  const location = useLocation();
  const frames = useRef(new Map()).current; // tab id -> its <iframe>
  const [mainKey, setMainKey] = useState(0);
  const mainActive = activeId === MAIN_TAB_ID;
  const mainTab = tabs.find(tab => tab.id === MAIN_TAB_ID);
  // The first tab showing a search result it followed; its pages wait behind it.
  const mainOnWeb = kindOf(mainTab) === 'web';
  const mainVisible = mainActive && !mainOnWeb;
  const scrollY = useRef(0);
  // Which tab's page moved last. The browser keeps one history for the
  // window and all its frames, so its "back" undoes that move, whoever made it.
  const lastMoved = useRef(MAIN_TAB_ID);
  // A website tab sent back inside its site: its next load is that, not a new page.
  const returning = useRef(null);

  // The first tab's own history: every page its router shows.
  const mainUrl = `${location.pathname}${location.search}`;
  useEffect(() => {
    moved(MAIN_TAB_ID, mainUrl);
    lastMoved.current = MAIN_TAB_ID;
  }, [mainUrl, moved]);

  // The shell's height is known to the page styles (sticky headers sit
  // below it, full-height pages subtract it).
  useEffect(() => {
    document.documentElement.classList.add('ph-has-shell');
    return () => document.documentElement.classList.remove('ph-has-shell');
  }, []);

  // The search page is hidden, not unmounted, while another tab is in view;
  // it comes back scrolled to where it was left.
  const leaveMain = useCallback(() => {
    if (!mainOnWeb) scrollY.current = window.scrollY;
  }, [mainOnWeb]);
  useLayoutEffect(() => {
    if (mainVisible) window.scrollTo(0, scrollY.current);
  }, [mainVisible]);

  // What the PH pages inside tabs report: where they are, and links to open.
  useEffect(() => {
    const onMessage = event => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.source !== MESSAGE_SOURCE) return;
      const sender = [...frames.entries()].find(
        ([, frame]) => frame && frame.contentWindow === event.source
      );
      if (!sender) return;
      if (data.type === 'moved' && typeof data.url === 'string' && data.url.startsWith('/')) {
        moved(sender[0], data.url);
        lastMoved.current = sender[0];
      } else if (data.type === 'follow' && safeHttpUrl(data.url)) {
        // A search result clicked in that tab: it opens there.
        const url = safeHttpUrl(data.url);
        go(sender[0], { kind: 'web', url, title: titleForUrl(url) });
        lastMoved.current = sender[0];
      } else if (data.type === 'open' && safeHttpUrl(data.url)) {
        openUrl(safeHttpUrl(data.url), titleForUrl(data.url));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frames, go, moved, openUrl]);

  /** Tells the PH page in a tab's frame to go to one of its own pages. */
  const tellFrame = useCallback(
    (id, url) => {
      const frame = frames.get(id);
      if (!frame || !frame.contentWindow) return;
      frame.contentWindow.postMessage(
        { source: MESSAGE_SOURCE, type: 'navigate', url },
        window.location.origin
      );
    },
    [frames]
  );

  /** The address field: an address to load, or a search. */
  const submit = useCallback(
    text => {
      const target = parseAddressInput(text);
      if (!target) return;
      const active = tabs.find(tab => tab.id === activeId);
      if (activeId === MAIN_TAB_ID) {
        // The first tab is the search page: a search runs in it, as always;
        // a website gets a tab of its own beside it.
        if (target.type === 'search') {
          const path = searchPath(target.query);
          // Over a result it followed, the same search is the page behind it.
          if (path === mainUrl) moved(MAIN_TAB_ID, path);
          else navigate(path);
        } else {
          leaveMain();
          openUrl(target.url);
        }
      } else if (target.type === 'url') {
        go(activeId, { kind: 'web', url: target.url });
      } else if (kindOf(active) === 'ph') {
        // A PH page is already there: it runs the search itself.
        tellFrame(activeId, searchPath(target.query));
      } else {
        go(activeId, { kind: 'ph', url: searchPath(target.query) });
      }
    },
    [activeId, go, leaveMain, mainUrl, moved, navigate, openUrl, tabs, tellFrame]
  );

  /** Back (-1) or Forward (+1), in the given tab only. */
  const stepTab = useCallback(
    (tab, delta) => {
      const kind = kindOf(tab);
      // A website tab whose visitor followed links inside the site goes back
      // inside the site. The browser can do that exactly, as long as that
      // tab was the last to move; otherwise the tab returns to the page it
      // was opened on.
      if (kind === 'web' && delta < 0 && (tab.innerNav || 0) > 0) {
        if (lastMoved.current === tab.id) {
          returning.current = tab.id;
          setTimeout(() => {
            if (returning.current === tab.id) returning.current = null;
          }, 4000);
          inner(tab.id, -1);
          window.history.back();
        } else {
          reload(tab.id);
        }
        return;
      }

      const target = tab.history[tab.index + delta];
      if (!target) return;
      if (tab.id === MAIN_TAB_ID && (kind === 'web' || target.kind === 'web')) {
        // To or from a result the first tab followed. Its own page was kept
        // mounted behind the website, so going back to it reloads nothing.
        step(tab.id, delta);
        if (target.kind === 'main' && target.url !== mainUrl) navigate(target.url);
      } else if (kind === 'main') {
        // The router goes there; the tab's place in its history moves with it.
        step(tab.id, delta, true);
        navigate(target.url);
      } else if (kind === 'ph' && target.kind === 'ph') {
        step(tab.id, delta, true);
        tellFrame(tab.id, target.url);
      } else {
        step(tab.id, delta);
      }
    },
    [inner, mainUrl, navigate, reload, step, tellFrame]
  );

  /** Reload the given tab, and nothing else. */
  const reloadTab = useCallback(
    tab => {
      reload(tab.id);
      if (kindOf(tab) !== 'main') return;
      // The first tab's page is mounted again, which fetches it again.
      setMainKey(key => key + 1);
      setTimeout(() => loaded(MAIN_TAB_ID), 700);
    },
    [loaded, reload]
  );

  /** A website tab's frame loaded another page: a link followed inside the site. */
  const onInnerLoad = useCallback(
    id => {
      if (returning.current === id) {
        returning.current = null;
        return;
      }
      inner(id, 1);
      lastMoved.current = id;
    },
    [inner]
  );

  const onAppClick = event => {
    const target = linkToOpen(event);
    if (!target) return;
    event.preventDefault();
    leaveMain();
    if (target.inPlace) {
      // A search result: this tab goes there, after the search in its history.
      go(MAIN_TAB_ID, { kind: 'web', url: target.url, title: target.title });
      lastMoved.current = MAIN_TAB_ID;
    } else {
      openUrl(target.url, target.title);
    }
  };

  return (
    <>
      <div className="ph-shell-bar">
        <TabBarWithLeave onLeaveMain={leaveMain} />
        <Toolbar onSubmit={submit} onStep={stepTab} onReload={reloadTab} />
        {mainVisible && mainTab.loading && (
          <div className="ph-webview-progress ph-shell-progress" aria-hidden="true" />
        )}
      </div>

      {/* Click delegation only: the links themselves stay ordinary links. */}
      <div className="ph-shell-app" hidden={!mainVisible} onClick={onAppClick}>
        <React.Fragment key={mainKey}>{children}</React.Fragment>
      </div>

      {mainOnWeb && (
        <div
          className="ph-shell-layer"
          role="tabpanel"
          aria-label={mainTab.title}
          hidden={!mainActive}
        >
          <WebView
            tab={mainTab}
            frames={frames}
            onInnerLoad={onInnerLoad}
            onBack={() => stepTab(mainTab, -1)}
          />
        </div>
      )}

      {tabs
        .filter(tab => tab.id !== MAIN_TAB_ID)
        .map(tab => {
          const kind = kindOf(tab);
          return (
            <div
              key={tab.id}
              className="ph-shell-layer"
              role="tabpanel"
              aria-label={tab.title}
              hidden={tab.id !== activeId}
            >
              {kind === 'web' && (
                <WebView
                  tab={tab}
                  frames={frames}
                  onInnerLoad={onInnerLoad}
                  onBack={() => stepTab(tab, -1)}
                />
              )}
              {kind === 'ph' && <PhView tab={tab} frames={frames} />}
            </div>
          );
        })}
    </>
  );
}

/** The tab row; leaving the first tab notes where its page was scrolled to. */
function TabBarWithLeave({ onLeaveMain }) {
  const { activeId } = useTabs();
  const onPointerDown = () => {
    if (activeId === MAIN_TAB_ID) onLeaveMain();
  };
  return (
    <div onPointerDownCapture={onPointerDown} onKeyDownCapture={onPointerDown}>
      <TabBar />
    </div>
  );
}

export default function BrowserShell({ children }) {
  // Decided once: a document does not move in or out of a frame.
  const [embedded] = useState(isEmbedded);
  if (embedded) return <EmbeddedApp>{children}</EmbeddedApp>;
  return (
    <TabsProvider>
      <Shell>{children}</Shell>
    </TabsProvider>
  );
}
