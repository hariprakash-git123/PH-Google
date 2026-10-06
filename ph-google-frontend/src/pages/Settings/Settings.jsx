import React, { useState, useEffect } from 'react';
import Header from '../../components/Header/Header';
import {
  Settings as SettingsIcon,
  ShieldCheck,
  Globe,
  Languages,
  Moon,
  Sun,
  Save,
  Check
} from 'lucide-react';
import { applyTheme, loadPreferences, savePreferences } from '../../services/preferences';
import './Settings.css';

export default function SettingsPage() {
  // Start from what is saved, so opening Settings never resets anything.
  const [initial] = useState(loadPreferences);
  const [safeSearch, setSafeSearch] = useState(initial.safeSearch);
  const [region, setRegion] = useState(initial.region);
  const [language, setLanguage] = useState(initial.language);
  const [themeMode, setThemeMode] = useState(initial.theme);
  const [savedNotice, setSavedNotice] = useState(false);

  // The theme is a visual choice, so it applies and persists immediately.
  useEffect(() => {
    applyTheme(themeMode);
    savePreferences({ theme: themeMode });
  }, [themeMode]);

  const handleSave = e => {
    e.preventDefault();
    savePreferences({ safeSearch, region, language, theme: themeMode });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2500);
  };

  return (
    <div className="ph-settings-page">
      <Header />

      <main className="ph-settings-main container animate-fade-in">
        <div className="ph-settings-header">
          <div className="ph-settings-icon-badge">
            <SettingsIcon size={20} />
          </div>
          <div>
            <h1>Search Preferences & Settings</h1>
            <p>Configure search boundaries, region, language, and display theme</p>
          </div>
        </div>

        <form className="ph-settings-form" onSubmit={handleSave}>
          {/* Section 1: Search Boundaries */}
          <div className="ph-settings-section ph-card">
            <h3>Search Boundaries</h3>

            <div className="ph-setting-row">
              <div className="ph-setting-info">
                <div className="ph-setting-title">
                  <ShieldCheck size={16} />
                  <span>Safe Search</span>
                </div>
                <p className="ph-setting-desc">
                  Filter explicit web results and media content automatically.
                </p>
              </div>
              <button
                type="button"
                className={`ph-toggle-switch ${safeSearch ? 'on' : ''}`}
                onClick={() => setSafeSearch(!safeSearch)}
                role="switch"
                aria-checked={safeSearch}
                aria-label="Safe Search"
              >
                <span className="ph-toggle-thumb" />
                <span className="ph-toggle-text">{safeSearch ? 'On' : 'Off'}</span>
              </button>
            </div>

            <div className="ph-setting-row">
              <div className="ph-setting-info">
                <div className="ph-setting-title">
                  <Globe size={16} />
                  <span>Default Region</span>
                </div>
                <p className="ph-setting-desc">
                  Tailor local web search results and regional news relevance.
                </p>
              </div>
              <select
                className="ph-setting-select"
                value={region}
                aria-label="Default region"
                onChange={e => setRegion(e.target.value)}
              >
                <option value="India">India</option>
                <option value="Global">Global</option>
                <option value="USA">USA</option>
                <option value="Australia">Australia</option>
              </select>
            </div>

            <div className="ph-setting-row">
              <div className="ph-setting-info">
                <div className="ph-setting-title">
                  <Languages size={16} />
                  <span>Search Language</span>
                </div>
                <p className="ph-setting-desc">
                  Display results in your preferred language interface.
                </p>
              </div>
              <select
                className="ph-setting-select"
                value={language}
                aria-label="Search language"
                onChange={e => setLanguage(e.target.value)}
              >
                <option value="English">English</option>
                <option value="Tamil">Tamil</option>
                <option value="Hindi">Hindi</option>
              </select>
            </div>
          </div>

          {/* Section 2: Theme Preview */}
          <div className="ph-settings-section ph-card">
            <h3>Appearance & Theme Preview</h3>
            <p className="ph-section-desc">
              Choose your preferred visual theme interface across all search views.
            </p>

            <div className="ph-theme-selector-grid">
              <button
                type="button"
                className={`ph-theme-card ${themeMode === 'light' ? 'selected' : ''}`}
                onClick={() => setThemeMode('light')}
              >
                <div className="ph-theme-icon light">
                  <Sun size={20} />
                </div>
                <div className="ph-theme-label">
                  <strong>Light Mode</strong>
                  <span>Clean high contrast</span>
                </div>
              </button>

              <button
                type="button"
                className={`ph-theme-card ${themeMode === 'dark' ? 'selected' : ''}`}
                onClick={() => setThemeMode('dark')}
              >
                <div className="ph-theme-icon dark">
                  <Moon size={20} />
                </div>
                <div className="ph-theme-label">
                  <strong>Dark Mode</strong>
                  <span>Soft dark theme</span>
                </div>
              </button>
            </div>
          </div>

          {/* Save Action Bar */}
          <div className="ph-settings-actions">
            <button type="submit" className="ph-btn-save">
              {savedNotice ? <Check size={16} /> : <Save size={16} />}
              <span>{savedNotice ? 'Preferences Saved!' : 'Save Preferences'}</span>
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
