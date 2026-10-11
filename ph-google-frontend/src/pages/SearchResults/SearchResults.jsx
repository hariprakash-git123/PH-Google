import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import Header from '../../components/Header/Header';
import SearchTabs from '../../components/SearchTabs/SearchTabs';
import Filters from '../../components/Filters/Filters';
import AIAnswer from '../../components/AIAnswer/AIAnswer';
import SearchResult from '../../components/SearchResult/SearchResult';
import LoadMore from '../../components/LoadMore/LoadMore';
import ImageResults from '../../components/ImageResults/ImageResults';
import VideoResults from '../../components/VideoResults/VideoResults';
import NewsResults from '../../components/NewsResults/NewsResults';
import MapResults from '../../components/MapResults/MapResults';
import {
  ExternalImageResults,
  ExternalVideoResults,
  ExternalPlaceResults,
  VerticalServiceOff,
  VerticalSkeleton
} from '../../components/ExternalVerticals/ExternalVerticals';
import ImageRefinements from '../../components/ExternalVerticals/ImageRefinements';
import RelatedSearches from '../../components/RelatedSearches/RelatedSearches';
import { searchApi } from '../../services/searchApi';
import { loadPreferences } from '../../services/preferences';
import { SlidersHorizontal, AlertCircle, Link2, Info } from 'lucide-react';
import './SearchResults.css';

/** Each vertical shows the number of results that suits its layout. */
const PAGE_SIZE_BY_TAB = {
  all: 10,
  images: 60,
  videos: 12,
  news: 10,
  maps: 10
};

/** "Load more" asks for this many results at a time: 20 pictures, 10 of anything else. */
const LOAD_MORE_SIZE_BY_TAB = { images: 20 };
const LOAD_MORE_SIZE = 10;

/**
 * An address as one result: scheme and host in lower case, no fragment, no
 * trailing slash. The path and query keep their case — a YouTube video id,
 * for one, is case-sensitive, and two ids differing only in case are two videos.
 */
function linkKey(link) {
  const text = String(link).trim();
  try {
    const url = new URL(text);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host}${path}${url.search}`;
  } catch {
    return text.replace(/\/+$/, '');
  }
}

/** What makes two results the same: their id, or the address they open. */
function resultKeys(result) {
  const link = result.url || result.videoUrl || result.imageUrl || result.sourceUrl || '';
  return [result.id ? `id:${result.id}` : null, link ? `url:${linkKey(link)}` : null].filter(
    Boolean
  );
}

/** The results not already in `shown`, in order and without repeats among themselves. */
function onlyNew(shown, incoming) {
  const seen = new Set(shown.flatMap(resultKeys));
  return incoming.filter(result => {
    const keys = resultKeys(result);
    if (keys.some(key => seen.has(key))) return false;
    keys.forEach(key => seen.add(key));
    return true;
  });
}

const EMPTY_STATE = {
  results: [],
  total: 0,
  latency: '0.000s',
  pagination: null,
  message: null,
  indexed: true,
  error: null,
  external: null,
  hasMore: false,
  nextCursor: null,
  loadingMore: false,
  loadMoreError: null,
  appliedSort: null,
  ignoredFilters: [],
  unusedOperators: []
};

const FILTER_NAMES = { date: 'date range', language: 'language', sort: 'sort order' };
const TAB_NAMES = { images: 'Images', videos: 'Videos', news: 'News', maps: 'Maps' };
/** Why a tab cannot apply a filter (the API lists which: `ignoredFilters`). */
const IGNORED_BECAUSE = {
  maps: 'Places have no date, language or publication order',
  images: 'Pictures cannot be ordered by publication date',
  videos: 'Videos cannot be ordered by publication date'
};
/** Why a source was not asked that comes from the filters chosen. */
const FILTER_SKIP_REASONS = new Set(['date_sort', 'unsupported_filter', 'conflicting_filters']);

/**
 * What the results on screen do not reflect of the filters chosen, said
 * plainly — or null when they reflect all of them. A filter is never shown
 * as applied when it was not.
 */
function filterNotice({ ignoredFilters, external }, tab) {
  if (ignoredFilters && ignoredFilters.length > 0) {
    const names = ignoredFilters.map(name => FILTER_NAMES[name] || name);
    const list =
      names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
    const why = IGNORED_BECAUSE[tab] || 'This tab cannot apply them';
    return `${why}, so the ${list} ${names.length > 1 ? 'filters are' : 'filter is'} not applied on ${
      TAB_NAMES[tab] || 'this tab'
    }.`;
  }
  if (external && external.status === 'skipped' && FILTER_SKIP_REASONS.has(external.reason)) {
    return 'Web sources outside PH’s own index cannot apply the selected filters, so they were not searched. Clear a filter to see more results.';
  }
  return null;
}

/** Operators typed with a value they cannot use: they restricted nothing. */
function operatorNotice({ unusedOperators }) {
  if (!unusedOperators || unusedOperators.length === 0) return null;
  const list = unusedOperators.map(op => `“${op}”`).join(', ');
  const many = unusedOperators.length > 1;
  return `${list} ${many ? 'are not valid operators' : 'is not a valid operator'}, so ${
    many ? 'they did' : 'it did'
  } not narrow the search. Use a value such as site:example.com, lang:ta or intitle:word.`;
}

const SORT_LABELS = { newest: 'Newest', oldest: 'Oldest', relevance: 'Relevance' };

/** Every tab the page knows; anything else in the URL means "all". */
const TABS = new Set(Object.keys(PAGE_SIZE_BY_TAB));

/** Tabs whose layout needs the full content width (sidebar hidden). */
const WIDE_TABS = new Set(['images', 'maps']);

const DEFAULT_FILTERS = {
  date: 'Any time',
  language: 'Any language',
  domain: '',
  sort: 'relevance',
  region: 'India',
  safeSearch: true
};

export default function SearchResults() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const query = searchParams.get('q') || '';
  // Page and tab live in the URL so a result page can be shared or reloaded.
  // The tab is `category` (the API's own name); `tab` is still read so
  // older links keep working.
  const page = Math.max(1, parseInt(searchParams.get('page'), 10) || 1);
  const requestedTab = searchParams.get('category') || searchParams.get('tab') || 'all';
  const activeTab = TABS.has(requestedTab) ? requestedTab : 'all';

  const [showFilters, setShowFilters] = useState(false);
  // Region and safe search start from the preferences saved in Settings.
  const [filters, setFilters] = useState(() => {
    const { region, safeSearch } = loadPreferences();
    return { ...DEFAULT_FILTERS, region, safeSearch };
  });

  const [searchData, setSearchData] = useState({ ...EMPTY_STATE, loading: true });

  // One search — a query with its filters and starting page — and one tab of it.
  const searchKey = JSON.stringify([
    query,
    page,
    filters.sort,
    filters.domain,
    filters.date,
    filters.language
  ]);
  const viewKey = `${searchKey}|${activeTab}`;
  // Each tab of the current search keeps what it has loaded, so going back to
  // a tab shows the results already loaded there. A new search starts afresh.
  const tabsRef = useRef({ searchKey: null, tabs: new Map() });
  // The view on screen. A response for any other view is not shown.
  const viewRef = useRef(viewKey);
  viewRef.current = viewKey;
  // Batches being fetched, by view: one at a time for each.
  const loadingMoreRef = useRef(new Set());

  useEffect(() => {
    let isSubscribed = true;
    if (tabsRef.current.searchKey !== searchKey) {
      tabsRef.current = { searchKey, tabs: new Map() };
      loadingMoreRef.current = new Set();
    }
    const kept = tabsRef.current.tabs.get(activeTab);
    if (kept) {
      setSearchData(kept);
      return () => {
        isSubscribed = false;
      };
    }
    setSearchData(prev => ({ ...prev, loading: true, error: null }));

    if (!query) {
      setSearchData({ ...EMPTY_STATE, loading: false });
      return () => {
        isSubscribed = false;
      };
    }

    searchApi
      .search(query, activeTab, {
        page,
        limit: PAGE_SIZE_BY_TAB[activeTab] || PAGE_SIZE_BY_TAB.all,
        sort: filters.sort,
        domain: filters.domain,
        date: filters.date,
        language: filters.language
      })
      .then(data => {
        if (!isSubscribed) return;
        const loaded = {
          ...EMPTY_STATE,
          results: onlyNew([], data.results || []),
          total: data.total || 0,
          latency: data.latency || '0.000s',
          pagination: data.pagination || null,
          message: data.message || null,
          indexed: data.indexed !== false,
          error: data.error || null,
          external: data.external || null,
          hasMore: Boolean(data.hasMore) && Boolean(data.nextCursor),
          nextCursor: data.nextCursor || null,
          appliedSort: data.appliedSort || null,
          ignoredFilters: Array.isArray(data.ignoredFilters) ? data.ignoredFilters : [],
          unusedOperators: Array.isArray(data.unusedOperators) ? data.unusedOperators : [],
          loading: false
        };
        // A failed search is not kept: coming back to the tab tries again.
        if (!loaded.error) tabsRef.current.tabs.set(activeTab, loaded);
        setSearchData(loaded);
      });

    return () => {
      isSubscribed = false;
    };
  }, [query, activeTab, page, filters.sort, filters.domain, filters.date, filters.language]);

  /** Changing a filter resets to page 1 — the old page number is meaningless. */
  const handleFilterChange = useCallback(
    (key, value) => {
      setFilters(prev => ({ ...prev, [key]: value }));
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev);
          next.delete('page');
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  /**
   * "Load more": the next batch after the results on screen, appended to
   * them. One request at a time per tab; a response that arrives after the
   * search or the tab has changed is not shown there; a failure keeps every
   * result already loaded and offers to try again.
   */
  const loadMore = useCallback(async () => {
    const view = viewKey;
    const tab = activeTab;
    const owner = tabsRef.current;
    const current = owner.tabs.get(tab);
    if (!current || !current.nextCursor || loadingMoreRef.current.has(view)) return;
    loadingMoreRef.current.add(view);

    // Applied to the tab's kept state — still right if the person has moved
    // to another tab meanwhile — and shown only if this view is on screen.
    const commit = patch => {
      if (tabsRef.current !== owner) return; // a new search has started
      const before = owner.tabs.get(tab);
      if (!before) return;
      const after = { ...before, ...patch(before) };
      owner.tabs.set(tab, after);
      if (viewRef.current === view) setSearchData(after);
    };

    commit(() => ({ loadingMore: true, loadMoreError: null }));
    let data;
    try {
      data = await searchApi.search(query, tab, {
        cursor: current.nextCursor,
        limit: LOAD_MORE_SIZE_BY_TAB[tab] || LOAD_MORE_SIZE,
        sort: filters.sort,
        domain: filters.domain,
        date: filters.date,
        language: filters.language
      });
    } finally {
      loadingMoreRef.current.delete(view);
    }

    if (data.error) {
      commit(() => ({ loadingMore: false, loadMoreError: data.error }));
      return;
    }
    commit(before => ({
      results: [...before.results, ...onlyNew(before.results, data.results || [])],
      hasMore: Boolean(data.hasMore) && Boolean(data.nextCursor),
      nextCursor: data.nextCursor || null,
      total: typeof data.total === 'number' ? Math.max(before.total, data.total) : before.total,
      loadingMore: false,
      loadMoreError: null
    }));
  }, [viewKey, activeTab, query, filters.sort, filters.domain, filters.date, filters.language]);

  const handleTabChange = useCallback(
    tab => {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.delete('tab');
        if (tab === 'all') next.delete('category');
        else next.set('category', tab);
        next.delete('page');
        return next;
      });
    },
    [setSearchParams]
  );

  /** A new image search: a category chip, a related search. */
  const searchImages = useCallback(
    text => {
      const next = String(text || '').trim();
      if (!next) return;
      navigate(`/search?q=${encodeURIComponent(next)}&category=images`);
    },
    [navigate]
  );

  const handleSuggestionClick = topic => {
    navigate(`/search?q=${encodeURIComponent(topic)}`);
  };

  const clearDomainFilter = () => handleFilterChange('domain', '');

  const pagination = searchData.pagination;
  // Images, videos and maps come from Google (SerpApi) when the backend has
  // it switched on; otherwise they are the crawler's own verticals.
  const external = searchData.external;
  const fromGoogle = Boolean(external) && external.status !== 'disabled';
  // Asked and could not answer, or could not be asked today: "not available
  // right now", which is not the same as a search that found nothing.
  const externalUnavailable =
    fromGoogle &&
    (external.status === 'unavailable' ||
      (external.status === 'skipped' && ['daily_limit', 'busy'].includes(external.reason)));
  // Switched off, and the crawler's own vertical has nothing to show in its
  // place: the tab says its service is off rather than "no results found".
  const serviceOff =
    Boolean(external) && external.status === 'disabled' && searchData.results.length === 0;
  const showingFrom =
    pagination && searchData.results.length > 0 ? (pagination.page - 1) * pagination.limit + 1 : 0;
  const showingTo = pagination ? showingFrom + searchData.results.length - 1 : 0;
  const settled = query && !searchData.loading && !searchData.error;
  const notices = settled
    ? [operatorNotice(searchData), filterNotice(searchData, activeTab)].filter(Boolean)
    : [];
  // The order the results are really in (News is newest first by default).
  const shownSort = (!searchData.loading && searchData.appliedSort) || filters.sort;

  return (
    <div className="ph-results-page">
      <Header searchQuery={query} searchCategory={activeTab === 'images' ? 'images' : null} />

      <SearchTabs
        activeTab={activeTab}
        onTabChange={handleTabChange}
        showFilters={showFilters}
        onToggleFilters={() => setShowFilters(!showFilters)}
      />

      <main className="ph-results-main container">
        {showFilters && (
          <Filters
            filters={filters}
            onFilterChange={handleFilterChange}
            onClose={() => setShowFilters(false)}
          />
        )}

        {/* Results Meta Info */}
        <div className="ph-results-meta">
          {query ? (
            <span>
              About <strong>{searchData.total.toLocaleString()}</strong> results (
              {searchData.latency})
              {pagination && searchData.results.length > 0 && (
                <>
                  {' '}
                  · showing {showingFrom.toLocaleString()}–{showingTo.toLocaleString()}
                </>
              )}
            </span>
          ) : (
            <span>What do you want to search?</span>
          )}

          {filters.domain && (
            <button type="button" className="ph-active-filter-pill" onClick={clearDomainFilter}>
              <Link2 size={12} />
              <span>site: {filters.domain}</span>
              <span className="ph-active-filter-x">×</span>
            </button>
          )}
        </div>

        {notices.map(text => (
          <p key={text} className="ph-filter-notice" role="status">
            <Info size={16} aria-hidden="true" />
            <span>{text}</span>
          </p>
        ))}

        {/* Image and map verticals need the full width; the sidebar is
            hidden for them rather than squeezing the grid. */}
        <div
          className={`ph-results-layout ${WIDE_TABS.has(activeTab) ? 'ph-results-layout-wide' : ''}`}
        >
          <div className="ph-results-content">
            {activeTab === 'images' && query && (
              <ImageRefinements query={query} onSearch={searchImages} />
            )}
            {!query ? (
              <div className="ph-empty-state ph-card animate-fade-in">
                <h3>Enter a search query</h3>
                <p>Type a keyword or topic in the search bar above to explore the web.</p>
              </div>
            ) : searchData.loading ? (
              <VerticalSkeleton tab={activeTab} />
            ) : searchData.error ? (
              <div className="ph-empty-state ph-card animate-fade-in">
                <AlertCircle size={28} className="ph-empty-icon" />
                <h3>Search is unavailable</h3>
                <p>{searchData.error}</p>
              </div>
            ) : (
              <>
                {/* Each tab renders the vertical index that backs it. */}
                {activeTab === 'all' && (
                  <>
                    {/* The AI answer belongs to the query, so it sits above
                        the first page only. It loads after the results are
                        on screen and never holds them back. */}
                    {page === 1 && (
                      <AIAnswer
                        query={query}
                        filters={{
                          domain: filters.domain,
                          date: filters.date,
                          language: filters.language
                        }}
                        hasResults={searchData.results.length > 0}
                      />
                    )}
                    {searchData.results.length > 0 ? (
                      searchData.results.map(result => (
                        <SearchResult key={result.id} result={result} />
                      ))
                    ) : (
                      <div className="ph-empty-state ph-card animate-fade-in">
                        <h3>No results found for &quot;{query}&quot;</h3>
                        <p>
                          {filters.domain
                            ? `Nothing in the index matches that query on ${filters.domain}. Try removing the site filter.`
                            : 'Try different or fewer keywords.'}
                        </p>
                      </div>
                    )}
                  </>
                )}

                {activeTab === 'images' &&
                  (fromGoogle ? (
                    <ExternalImageResults
                      results={searchData.results}
                      unavailable={externalUnavailable}
                    />
                  ) : serviceOff ? (
                    <VerticalServiceOff kind="Image" />
                  ) : (
                    <ImageResults results={searchData.results} query={query} />
                  ))}
                {activeTab === 'videos' &&
                  (fromGoogle ? (
                    <ExternalVideoResults
                      results={searchData.results}
                      unavailable={externalUnavailable}
                    />
                  ) : serviceOff ? (
                    <VerticalServiceOff kind="Video" />
                  ) : (
                    <VideoResults results={searchData.results} query={query} />
                  ))}
                {activeTab === 'news' && <NewsResults results={searchData.results} query={query} />}
                {activeTab === 'maps' &&
                  (fromGoogle ? (
                    <ExternalPlaceResults
                      results={searchData.results}
                      unavailable={externalUnavailable}
                    />
                  ) : serviceOff ? (
                    <VerticalServiceOff kind="Map" />
                  ) : (
                    <MapResults results={searchData.results} query={query} />
                  ))}

                {searchData.results.length > 0 && (
                  <LoadMore
                    hasMore={searchData.hasMore}
                    loading={searchData.loadingMore}
                    error={searchData.loadMoreError}
                    onLoadMore={loadMore}
                  />
                )}

                {activeTab === 'all' && (
                  <RelatedSearches query={query} onSearch={handleSuggestionClick} />
                )}
              </>
            )}
          </div>

          {!WIDE_TABS.has(activeTab) && (
            <aside className="ph-results-sidebar">
              <div className="ph-sidebar-card ph-card">
                <div className="ph-sidebar-header">
                  <SlidersHorizontal size={15} />
                  <h4>Search controls</h4>
                </div>
                {/* Only what the search really applies is listed. Safe Search
                    and Region are not applied to results (see Settings), so
                    they are not shown here as if they were. */}
                <div className="ph-sidebar-controls-list">
                  <div className="ph-control-item">
                    <div className="ph-control-info">
                      <SlidersHorizontal size={14} />
                      <span>Sort</span>
                    </div>
                    <span className="ph-control-badge">
                      {SORT_LABELS[shownSort] || SORT_LABELS.relevance}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="ph-sidebar-btn"
                  onClick={() => setShowFilters(!showFilters)}
                >
                  Advanced filters
                </button>
              </div>

              <div className="ph-sidebar-card ph-card ph-privacy-card">
                <h4>Your search, your control.</h4>
                <p>
                  History and account screens are separate from search results so privacy settings
                  can be managed independently.
                </p>
                <Link to="/settings" className="ph-privacy-link">
                  Review settings →
                </Link>
              </div>
            </aside>
          )}
        </div>
      </main>
    </div>
  );
}
