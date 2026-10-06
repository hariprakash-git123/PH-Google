import React from 'react';
import { Search, Image, Newspaper, Video, MapPin, SlidersHorizontal } from 'lucide-react';
import './SearchTabs.css';

export default function SearchTabs({
  activeTab = 'all',
  onTabChange,
  showFilters,
  onToggleFilters
}) {
  const tabs = [
    { id: 'all', label: 'All', icon: Search },
    { id: 'images', label: 'Images', icon: Image },
    { id: 'news', label: 'News', icon: Newspaper },
    { id: 'videos', label: 'Videos', icon: Video },
    { id: 'maps', label: 'Maps', icon: MapPin }
  ];

  return (
    <div className="ph-search-tabs-bar">
      <div className="ph-search-tabs-container">
        <div className="ph-tabs-list" role="tablist">
          {tabs.map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                className={`ph-tab-item ${isActive ? 'active' : ''}`}
                onClick={() => onTabChange(tab.id)}
                role="tab"
                aria-selected={isActive}
              >
                <Icon size={16} />
                <span>{tab.label}</span>
                {isActive && <div className="ph-tab-indicator" />}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          className={`ph-filters-toggle-btn ${showFilters ? 'active' : ''}`}
          onClick={onToggleFilters}
          aria-label="Toggle Advanced Search Filters"
        >
          <SlidersHorizontal size={15} />
          <span>Filters</span>
        </button>
      </div>
    </div>
  );
}
