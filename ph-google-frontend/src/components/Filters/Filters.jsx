import React from 'react';
import { Calendar, Globe, Link2, ArrowUpDown, X } from 'lucide-react';
import './Filters.css';

/**
 * Advanced search controls.
 *
 * Date, language, domain and sort are sent to the search API and change the
 * result set. Safe Search is a local display preference only — the crawler
 * does not yet classify content, so the UI labels it as such rather than
 * implying a filter that does not exist.
 */
export default function Filters({ filters, onFilterChange, onClose }) {
  const dateOptions = [
    'Any time',
    'Past hour',
    'Past 24 hours',
    'Past week',
    'Past month',
    'Past year'
  ];
  const languageOptions = ['Any language', 'English', 'Tamil', 'Hindi'];
  const sortOptions = [
    { value: 'relevance', label: 'Relevance' },
    { value: 'newest', label: 'Newest first' },
    { value: 'oldest', label: 'Oldest first' }
  ];

  return (
    <div className="ph-filters-panel animate-slide-down">
      <div className="ph-filters-header">
        <h4>Advanced Search Controls</h4>
        <button
          type="button"
          className="ph-filters-close-btn"
          onClick={onClose}
          aria-label="Close filters"
        >
          <X size={16} />
        </button>
      </div>

      <div className="ph-filters-grid">
        {/* Date Filter */}
        <div className="ph-filter-group">
          <label className="ph-filter-label" htmlFor="ph-filter-date">
            <Calendar size={14} />
            <span>Date Range</span>
          </label>
          <select
            id="ph-filter-date"
            className="ph-filter-select"
            value={filters.date}
            onChange={e => onFilterChange('date', e.target.value)}
          >
            {dateOptions.map(opt => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>

        {/* Language Filter */}
        <div className="ph-filter-group">
          <label className="ph-filter-label" htmlFor="ph-filter-language">
            <Globe size={14} />
            <span>Language</span>
          </label>
          <select
            id="ph-filter-language"
            className="ph-filter-select"
            value={filters.language}
            onChange={e => onFilterChange('language', e.target.value)}
          >
            {languageOptions.map(opt => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>

        {/* Sort Order */}
        <div className="ph-filter-group">
          <label className="ph-filter-label" htmlFor="ph-filter-sort">
            <ArrowUpDown size={14} />
            <span>Sort by</span>
          </label>
          <select
            id="ph-filter-sort"
            className="ph-filter-select"
            value={filters.sort}
            onChange={e => onFilterChange('sort', e.target.value)}
          >
            {sortOptions.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Site / domain restriction */}
        <div className="ph-filter-group">
          <label className="ph-filter-label" htmlFor="ph-filter-domain">
            <Link2 size={14} />
            <span>Site or domain</span>
          </label>
          <input
            id="ph-filter-domain"
            type="text"
            className="ph-filter-select ph-filter-input"
            placeholder="example.com"
            value={filters.domain || ''}
            onChange={e => onFilterChange('domain', e.target.value)}
            autoComplete="off"
            spellCheck="false"
          />
        </div>
      </div>

      <p className="ph-filters-note">
        Date, language, site and sort are applied by the search index. Safe Search filtering is not
        available yet, so results are not filtered for explicit content.
      </p>
    </div>
  );
}
