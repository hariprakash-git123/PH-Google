import React from 'react';
import { Search, TrendingUp, History } from 'lucide-react';
import './SearchSuggestions.css';

export default function SearchSuggestions({ suggestions, activeIndex, onSelectSuggestion }) {
  if (!suggestions || suggestions.length === 0) return null;

  return (
    <div className="ph-suggestions-dropdown animate-fade-in" role="listbox">
      {suggestions.map((item, index) => {
        const isActive = index === activeIndex;
        return (
          <div
            key={index}
            className={`ph-suggestion-item ${isActive ? 'active' : ''}`}
            onClick={() => onSelectSuggestion(item.text)}
            role="option"
            aria-selected={isActive}
          >
            <div className="ph-suggestion-icon-wrap">
              {item.trending ? (
                <TrendingUp size={15} className="ph-suggestion-icon trending" />
              ) : (
                <Search size={15} className="ph-suggestion-icon" />
              )}
            </div>
            <span className="ph-suggestion-text">{item.text}</span>
            {item.category && <span className="ph-suggestion-category">{item.category}</span>}
          </div>
        );
      })}
    </div>
  );
}
