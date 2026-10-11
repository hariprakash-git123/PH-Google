import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import Header from '../../components/Header/Header';
import Logo from '../../components/Logo/Logo';
import SearchBar from '../../components/SearchBar/SearchBar';
import Shortcuts from '../../components/Shortcuts/Shortcuts';
import { Sparkles, History, TrendingUp, Globe } from 'lucide-react';
import { loadPreferences } from '../../services/preferences';
import { searchApi } from '../../services/searchApi';
import { useAuth } from '../../context/AuthContext';
import './Home.css';

/** How many trends the card shows, so it stays the size it was. */
const MAX_TRENDS = 5;

/** The region chosen in Settings, as the country code the trends API takes. */
const REGION_CODES = { India: 'IN', USA: 'US', Australia: 'AU' };

/** "Updated 5 min ago" from the time the trends were really fetched. */
function updatedLabel(updatedAt, now = Date.now()) {
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `Updated ${days} day${days === 1 ? '' : 's'} ago`;
}

export default function Home() {
  const navigate = useNavigate();
  const { isAdmin, isAuthenticated } = useAuth();
  const [{ language: selectedLanguage, region: selectedRegion }] = useState(loadPreferences);

  // Recent searches: the signed-in user's own history, newest first — never
  // sample topics standing in for it. Signed out, the card says how to get it.
  const [recent, setRecent] = useState({ status: 'idle', queries: [] });
  useEffect(() => {
    if (!isAuthenticated) {
      setRecent({ status: 'signed-out', queries: [] });
      return undefined;
    }
    let active = true;
    setRecent({ status: 'loading', queries: [] });
    searchApi.getHistory({ limit: 10 }).then(data => {
      if (!active) return;
      const seen = new Set();
      const queries = [];
      for (const item of data.history || []) {
        const query = item && typeof item.query === 'string' ? item.query.trim() : '';
        if (!query || seen.has(query.toLowerCase())) continue;
        seen.add(query.toLowerCase());
        queries.push(query);
        if (queries.length >= 3) break;
      }
      setRecent({ status: data.error ? 'unavailable' : 'ready', queries });
    });
    return () => {
      active = false;
    };
  }, [isAuthenticated]);

  // Trending now: live trends for the chosen region, or a plain "unavailable"
  // note when there are none — never topics of our own dressed up as trends.
  // The page never waits on this or fails with it.
  const [trending, setTrending] = useState({ status: 'loading', trends: [], updatedAt: null });
  const trendingRegion = REGION_CODES[selectedRegion] || 'IN';

  useEffect(() => {
    let active = true;
    searchApi.getTrending(trendingRegion).then(data => {
      if (!active) return;
      const trends = data ? data.trends.filter(t => t && t.title && t.query) : [];
      setTrending(
        trends.length > 0
          ? { status: 'live', trends: trends.slice(0, MAX_TRENDS), updatedAt: data.updatedAt }
          : { status: 'unavailable', trends: [], updatedAt: null }
      );
    });
    return () => {
      active = false;
    };
  }, [trendingRegion]);

  const handleFeelingCurious = () => {
    const curiousQueries = [
      'AI email agent',
      'building search systems',
      'opensearch documentation',
      'property management software',
      'React tutorials 2026'
    ];
    const randomQuery = curiousQueries[Math.floor(Math.random() * curiousQueries.length)];
    navigate(`/search?q=${encodeURIComponent(randomQuery)}`);
  };

  const handleTopicClick = query => {
    navigate(`/search?q=${encodeURIComponent(query)}`);
  };

  return (
    <div className="ph-home-page">
      <Header />

      <main className="ph-home-main container animate-fade-in">
        <div className="ph-home-hero">
          {/* Logo & Tagline — the wordmark is this page's <h1> */}
          <Logo size="large" showTagline={true} clickable={false} as="h1" />

          {/* Short Description */}
          <p className="ph-hero-description">
            Independent web search with transparent results and clear, simple filters.
          </p>

          {/* Search Bar Container */}
          <div className="ph-hero-search-wrapper">
            <SearchBar variant="large" placeholder="What are you looking for?" autoFocus={true} />
          </div>

          {/*
            Submitting a search is handled by the search bar's own button, so
            the only action offered here is the alternative one.
          */}
          <div className="ph-hero-buttons">
            <button
              type="button"
              className="ph-home-btn ph-btn-secondary-action"
              onClick={handleFeelingCurious}
            >
              I&apos;m Feeling Curious
            </button>
          </div>

          {/* Website shortcuts — kept in this browser only */}
          <Shortcuts />

          {/* Language / Region — shows the saved preference; changed in Settings */}
          <div className="ph-hero-language-region">
            <Globe size={14} className="ph-lang-icon" aria-hidden="true" />
            <span>Search available in</span>
            <Link to="/settings" className="ph-lang-active">
              {selectedLanguage} · {selectedRegion}
              <span className="ph-visually-hidden"> (change in settings)</span>
            </Link>
          </div>
        </div>

        {/* Unique Feature Cards Grid */}
        <div className="ph-home-features-grid">
          {/* Card 1 — PH Insight */}
          <div className="ph-feature-card ph-card">
            <div className="ph-feature-card-header">
              <div className="ph-feature-icon ai-spark">
                <Sparkles size={18} />
              </div>
              <span className="ph-feature-tag">With sources</span>
            </div>
            <h2 className="ph-feature-title">AI answers</h2>
            <p className="ph-feature-desc">
              A short answer above the results, written from the pages found and citing each one.
            </p>
            <button
              type="button"
              className="ph-feature-link-btn"
              onClick={() => handleTopicClick('How do search engines work?')}
            >
              Try an AI answer →
            </button>
          </div>

          {/* Card 2 — Your Activity */}
          <div className="ph-feature-card ph-card">
            <div className="ph-feature-card-header">
              <div className="ph-feature-icon activity-icon">
                <History size={18} />
              </div>
              {/* Badge in the header, action link in the footer — the same
                  shape as the cards either side of this one. */}
              <span className="ph-feature-tag">Recent</span>
            </div>
            <h2 className="ph-feature-title">Recent searches</h2>
            {recent.status === 'ready' && recent.queries.length > 0 ? (
              <div className="ph-feature-tags-list">
                {recent.queries.map(item => (
                  <button
                    key={item}
                    type="button"
                    className="ph-chip-btn"
                    onClick={() => handleTopicClick(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            ) : (
              <p className="ph-trending-note" role="status">
                {recent.status === 'signed-out'
                  ? 'Sign in to see your recent searches here.'
                  : recent.status === 'loading'
                    ? 'Loading your recent searches…'
                    : recent.status === 'unavailable'
                      ? 'Your recent searches cannot be loaded right now.'
                      : 'Your searches will appear here.'}
              </p>
            )}
            {recent.status === 'signed-out' ? (
              <Link to="/login" className="ph-feature-link-btn">
                Sign in →
              </Link>
            ) : (
              <Link to="/history" className="ph-feature-link-btn">
                View history →
              </Link>
            )}
          </div>

          {/* Card 3 — Explore */}
          <div className="ph-feature-card ph-card">
            <div className="ph-feature-card-header">
              <div className="ph-feature-icon explore-icon">
                <TrendingUp size={18} />
              </div>
              <span className="ph-feature-tag">Trending</span>
            </div>
            <h2 className="ph-feature-title">Trending now</h2>
            {trending.status === 'loading' ? (
              <p className="ph-trending-note" role="status">
                Loading trends…
              </p>
            ) : trending.status === 'unavailable' ? (
              <p className="ph-trending-note" role="status">
                <strong>Trending is temporarily unavailable.</strong> Live trends can&apos;t be
                loaded right now — please check back later.
              </p>
            ) : (
              <>
                <div className="ph-feature-tags-list">
                  {trending.trends.map(trend => (
                    <button
                      key={trend.query}
                      type="button"
                      className="ph-chip-btn trending-chip"
                      onClick={() => handleTopicClick(trend.query)}
                    >
                      {trend.title}
                    </button>
                  ))}
                </div>
                {updatedLabel(trending.updatedAt) && (
                  <p className="ph-trending-note">{updatedLabel(trending.updatedAt)}</p>
                )}
              </>
            )}
          </div>
        </div>
      </main>

      <footer className="ph-home-footer">
        <div className="container ph-footer-content">
          <span>PH Spectrum © 2026 · Built with React & Vite</span>
          <div className="ph-footer-links">
            <Link to="/settings">Privacy & Settings</Link>
            {isAdmin && <Link to="/admin">Ops Console</Link>}
          </div>
        </div>
      </footer>
    </div>
  );
}
