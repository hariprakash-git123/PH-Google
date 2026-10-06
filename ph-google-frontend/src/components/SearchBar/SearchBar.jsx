import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, Mic, ArrowRight } from 'lucide-react';
import SearchSuggestions from '../SearchSuggestions/SearchSuggestions';
import { searchApi } from '../../services/searchApi';
import './SearchBar.css';

export default function SearchBar({
  initialValue = '',
  variant = 'large', // 'large' | 'header'
  placeholder = 'What are you looking for?',
  showSubmitButton = true,
  buttonLabel = 'Search',
  autoFocus = false,
  onSearchSubmit
}) {
  const [query, setQuery] = useState(initialValue);
  const [suggestions, setSuggestions] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [toastMessage, setToastMessage] = useState('');

  const navigate = useNavigate();
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  // True only while the user is editing the text. A query filled in from the
  // URL, or one just submitted, must not pop the suggestion list open.
  const isTypingRef = useRef(false);

  useEffect(() => {
    isTypingRef.current = false;
    setQuery(initialValue);
  }, [initialValue]);

  // Fetch suggestions when query changes
  useEffect(() => {
    let active = true;
    if (query.trim().length > 0) {
      searchApi.getSuggestions(query).then(results => {
        if (active) {
          setSuggestions(results);
          setShowDropdown(isTypingRef.current && results.length > 0);
        }
      });
    } else {
      setSuggestions([]);
      setShowDropdown(false);
    }
    return () => {
      active = false;
    };
  }, [query]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSubmit = targetQuery => {
    const finalQuery = targetQuery || query;
    if (!finalQuery.trim()) return;

    isTypingRef.current = false;
    setShowDropdown(false);
    if (onSearchSubmit) {
      onSearchSubmit(finalQuery);
    } else {
      navigate(`/search?q=${encodeURIComponent(finalQuery.trim())}`);
    }
  };

  const handleKeyDown = e => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (suggestions.length > 0) {
        setActiveIndex(prev => (prev < suggestions.length - 1 ? prev + 1 : 0));
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (suggestions.length > 0) {
        setActiveIndex(prev => (prev > 0 ? prev - 1 : suggestions.length - 1));
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && suggestions[activeIndex]) {
        handleSubmit(suggestions[activeIndex].text);
      } else {
        handleSubmit();
      }
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
      setActiveIndex(-1);
    }
  };

  const handleVoiceSearch = () => {
    setToastMessage('Voice search is not connected yet.');
    setTimeout(() => setToastMessage(''), 3000);
  };

  const handleClear = () => {
    setQuery('');
    setSuggestions([]);
    setShowDropdown(false);
    if (inputRef.current) inputRef.current.focus();
  };

  return (
    <div className={`ph-searchbar-wrapper ph-searchbar-${variant}`} ref={containerRef}>
      <form
        className="ph-searchbar-box"
        onSubmit={e => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <div className="ph-searchbar-icon-left">
          <Search size={variant === 'large' ? 22 : 18} />
        </div>

        <input
          ref={inputRef}
          type="text"
          className="ph-searchbar-input"
          value={query}
          onChange={e => {
            isTypingRef.current = true;
            setQuery(e.target.value);
          }}
          onFocus={() => {
            if (suggestions.length > 0) setShowDropdown(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoFocus={autoFocus}
          aria-label="Search the web"
          autoComplete="off"
        />

        <div className="ph-searchbar-actions">
          {query && (
            <button
              type="button"
              className="ph-searchbar-btn ph-btn-clear"
              onClick={handleClear}
              aria-label="Clear search text"
              title="Clear"
            >
              <X size={18} />
            </button>
          )}

          <button
            type="button"
            className="ph-searchbar-btn ph-btn-mic"
            onClick={handleVoiceSearch}
            aria-label="Voice search placeholder"
            title="Voice search"
          >
            <Mic size={19} />
          </button>

          {showSubmitButton && (
            <button type="submit" className="ph-searchbar-submit-btn" aria-label="Submit search">
              {/* The arrow is the PH submit mark in every variant; the label
                  stays available to screen readers. */}
              <ArrowRight size={variant === 'large' ? 22 : 18} strokeWidth={2.4} />
              <span className="ph-visually-hidden">{buttonLabel}</span>
            </button>
          )}
        </div>
      </form>

      {/* Autocomplete Suggestions */}
      {showDropdown && (
        <SearchSuggestions
          suggestions={suggestions}
          activeIndex={activeIndex}
          onSelectSuggestion={selectedText => {
            setQuery(selectedText);
            handleSubmit(selectedText);
          }}
        />
      )}

      {/* Voice Search Toast Banner */}
      {toastMessage && (
        <div className="ph-toast-notice animate-fade-in" role="status">
          <Mic size={15} />
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}
