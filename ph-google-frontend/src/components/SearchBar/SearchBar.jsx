import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, Mic, MicOff, ArrowRight } from 'lucide-react';
import SearchSuggestions from '../SearchSuggestions/SearchSuggestions';
import { searchApi } from '../../services/searchApi';
import { loadPreferences } from '../../services/preferences';
import { useVoiceSearch, voiceLanguage, VOICE_MESSAGES } from '../../hooks/useVoiceSearch';
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

  // Voice: the words are put in the box as they are heard, then searched
  // for exactly as if they had been typed and submitted.
  const voice = useVoiceSearch({
    lang: voiceLanguage(loadPreferences()),
    onInterim: text => {
      isTypingRef.current = false;
      setQuery(text);
    },
    onFinal: text => {
      isTypingRef.current = false;
      setQuery(text);
      handleSubmit(text);
    }
  });
  const { error: voiceError, clearError: clearVoiceError } = voice;

  // A voice message goes away by itself.
  useEffect(() => {
    if (!voiceError) return undefined;
    const timer = setTimeout(clearVoiceError, 6000);
    return () => clearTimeout(timer);
  }, [voiceError, clearVoiceError]);

  const handleVoiceSearch = () => {
    setShowDropdown(false);
    voice.start();
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
          placeholder={
            voice.ready ? 'Listening…' : voice.listening ? 'Starting microphone…' : placeholder
          }
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
            className={`ph-searchbar-btn ph-btn-mic${voice.listening ? ' listening' : ''}`}
            onClick={handleVoiceSearch}
            aria-label={voice.listening ? 'Stop listening' : 'Search by voice'}
            aria-pressed={voice.listening}
            title={voice.listening ? 'Stop listening' : 'Search by voice'}
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

      {/* Voice search: listening, or why it did not work */}
      {voice.listening && (
        <div className="ph-toast-notice ph-voice-notice animate-fade-in" role="status">
          <span className="ph-voice-dot" aria-hidden="true" />
          <span>{voice.ready ? 'Listening… speak now' : 'Starting microphone…'}</span>
        </div>
      )}
      {!voice.listening && voiceError && (
        <div className="ph-toast-notice ph-voice-notice animate-fade-in" role="alert">
          <MicOff size={15} aria-hidden="true" />
          <span>{VOICE_MESSAGES[voiceError]}</span>
        </div>
      )}
    </div>
  );
}
