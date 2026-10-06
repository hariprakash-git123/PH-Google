import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import Header from '../../components/Header/Header';
import Logo from '../../components/Logo/Logo';
import SearchBar from '../../components/SearchBar/SearchBar';
import { Sparkles, History, TrendingUp, Globe } from 'lucide-react';
import { loadPreferences } from '../../services/preferences';
import { useAuth } from '../../context/AuthContext';
import './Home.css';

export default function Home() {
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const [{ language: selectedLanguage, region: selectedRegion }] = useState(loadPreferences);

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
            <div className="ph-feature-tags-list">
              {['Google architecture', 'AI email agent', 'React tutorials'].map(item => (
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
            <Link to="/history" className="ph-feature-link-btn">
              View history →
            </Link>
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
            <div className="ph-feature-tags-list">
              {['AI tools', 'Search systems', 'React', 'Cloud'].map(topic => (
                <button
                  key={topic}
                  type="button"
                  className="ph-chip-btn trending-chip"
                  onClick={() => handleTopicClick(topic)}
                >
                  {topic}
                </button>
              ))}
            </div>
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
