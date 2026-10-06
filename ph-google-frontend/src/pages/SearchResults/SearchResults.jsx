import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import Header from '../../components/Header/Header';
import SearchTabs from '../../components/SearchTabs/SearchTabs';
import Filters from '../../components/Filters/Filters';
import AIAnswer from '../../components/AIAnswer/AIAnswer';
import SearchResult from '../../components/SearchResult/SearchResult';
import Pagination from '../../components/Pagination/Pagination';
import ImageResults from '../../components/ImageResults/ImageResults';
import VideoResults from '../../components/VideoResults/VideoResults';
import NewsResults from '../../components/NewsResults/NewsResults';
import MapResults from '../../components/MapResults/MapResults';
import {
  ExternalImageResults,
  ExternalVideoResults,
  ExternalPlaceResults,
  VerticalSkeleton
} from '../../components/ExternalVerticals/ExternalVerticals';
import { searchApi } from '../../services/searchApi';
import { loadPreferences } from '../../services/preferences';
import {
  SlidersHorizontal,
  ShieldCheck,
  Globe,
  HelpCircle,
  ArrowRight,
  AlertCircle,
  Link2
} from 'lucide-react';
import './SearchResults.css';

/** Each vertical shows the number of results that suits its layout. */
const PAGE_SIZE_BY_TAB = {
  all: 10,
  images: 24,
  videos: 12,
  news: 10,
  maps: 10
};

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

  const [searchData, setSearchData] = useState({
    results: [],
    total: 0,
    latency: '0.000s',
    pagination: null,
    message: null,
    indexed: true,
    error: null,
    external: null,
    loading: true
  });

  useEffect(() => {
    let isSubscribed = true;
    setSearchData(prev => ({ ...prev, loading: true, error: null }));

    if (!query) {
      setSearchData({
        results: [],
        total: 0,
        latency: '0.000s',
        pagination: null,
        message: null,
        indexed: true,
        error: null,
        external: null,
        loading: false
      });
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
        setSearchData({
          results: data.results || [],
          total: data.total || 0,
          latency: data.latency || '0.000s',
          pagination: data.pagination || null,
          message: data.message || null,
          indexed: data.indexed !== false,
          error: data.error || null,
          external: data.external || null,
          loading: false
        });
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

  const handlePageChange = useCallback(
    newPage => {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        if (newPage <= 1) next.delete('page');
        else next.set('page', String(newPage));
        return next;
      });
    },
    [setSearchParams]
  );

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

  const handleSuggestionClick = topic => {
    navigate(`/search?q=${encodeURIComponent(topic)}`);
  };

  const clearDomainFilter = () => handleFilterChange('domain', '');

  const pagination = searchData.pagination;
  // Images, videos and maps come from Google (SerpApi) when the backend has
  // it switched on; otherwise they are the crawler's own verticals.
  const external = searchData.external;
  const fromGoogle = Boolean(external) && external.status !== 'disabled';
  const externalUnavailable = fromGoogle && external.status === 'unavailable';
  const showingFrom =
    pagination && searchData.results.length > 0 ? (pagination.page - 1) * pagination.limit + 1 : 0;
  const showingTo = pagination ? showingFrom + searchData.results.length - 1 : 0;

  return (
    <div className="ph-results-page">
      <Header searchQuery={query} />

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

        {/* Image and map verticals need the full width; the sidebar is
            hidden for them rather than squeezing the grid. */}
        <div
          className={`ph-results-layout ${WIDE_TABS.has(activeTab) ? 'ph-results-layout-wide' : ''}`}
        >
          <div className="ph-results-content">
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
                            : 'Try different keywords, or crawl more pages from the admin console to grow the index.'}
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
                  ) : (
                    <ImageResults results={searchData.results} query={query} />
                  ))}
                {activeTab === 'videos' &&
                  (fromGoogle ? (
                    <ExternalVideoResults
                      results={searchData.results}
                      unavailable={externalUnavailable}
                    />
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
                  ) : (
                    <MapResults results={searchData.results} query={query} />
                  ))}

                {pagination && searchData.results.length > 0 && (
                  <Pagination
                    currentPage={pagination.page}
                    totalPages={pagination.totalPages}
                    hasNextPage={pagination.hasNextPage}
                    hasPreviousPage={pagination.hasPreviousPage}
                    onPageChange={handlePageChange}
                  />
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
                <div className="ph-sidebar-controls-list">
                  <div className="ph-control-item">
                    <div className="ph-control-info">
                      <ShieldCheck size={14} />
                      <span>Safe Search</span>
                    </div>
                    <span className="ph-control-badge">
                      {filters.safeSearch ? 'Active' : 'Disabled'}
                    </span>
                  </div>

                  <div className="ph-control-item">
                    <div className="ph-control-info">
                      <Globe size={14} />
                      <span>Region</span>
                    </div>
                    <span className="ph-control-badge">{filters.region}</span>
                  </div>

                  <div className="ph-control-item">
                    <div className="ph-control-info">
                      <SlidersHorizontal size={14} />
                      <span>Sort</span>
                    </div>
                    <span className="ph-control-badge">
                      {filters.sort === 'newest'
                        ? 'Newest'
                        : filters.sort === 'oldest'
                          ? 'Oldest'
                          : 'Relevance'}
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

              <div className="ph-sidebar-card ph-card">
                <div className="ph-sidebar-header">
                  <HelpCircle size={15} />
                  <h4>Try these</h4>
                </div>
                <div className="ph-try-list">
                  {['search ranking explained', 'how web crawlers work', 'OpenSearch tutorial'].map(
                    topic => (
                      <button
                        key={topic}
                        type="button"
                        className="ph-try-item-btn"
                        onClick={() => handleSuggestionClick(topic)}
                      >
                        <span>{topic}</span>
                        <ArrowRight size={13} />
                      </button>
                    )
                  )}
                </div>
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
