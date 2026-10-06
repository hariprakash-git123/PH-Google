/**
 * User display preferences, kept in this browser's localStorage.
 *
 * These are per-device conveniences (theme, default region/language, safe
 * search), not account data, so they never touch the backend. Storage can be
 * unavailable (private mode, blocked site data), so every access is guarded
 * and the defaults are always a valid fallback.
 */

const STORAGE_KEY = 'ph-search:preferences';

export const DEFAULT_PREFERENCES = {
  theme: 'light',
  safeSearch: true,
  region: 'India',
  language: 'English'
};

export function loadPreferences() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULT_PREFERENCES, ...stored };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(changes) {
  const next = { ...loadPreferences(), ...changes };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — the preference still applies for this page view.
  }
  return next;
}

/** Sets the theme attribute the design tokens in index.css key off. */
export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
}
