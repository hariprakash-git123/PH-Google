/**
 * Homepage website shortcuts, kept in this browser's localStorage.
 *
 * Like the display preferences (preferences.js), they are a per-browser
 * convenience: not synced across devices, browsers or users, and never sent
 * to the backend. Storage can be unavailable (private mode, blocked site
 * data), so every access is guarded and a failed save still applies for the
 * page view.
 *
 * Stored as { version: 1, items: [{ id, name, url }] }. Until the visitor
 * changes the list, nothing is stored and the defaults are shown; once they
 * have, their list — even an empty one — is what is shown.
 */

const STORAGE_KEY = 'ph-search:shortcuts';
const VERSION = 1;

/** As many as fit two rows of the grid. */
export const MAX_SHORTCUTS = 10;
export const MAX_NAME_LENGTH = 24;
const MAX_URL_LENGTH = 2048;

export const DEFAULT_SHORTCUTS = [
  { id: 'default-wikipedia', name: 'Wikipedia', url: 'https://www.wikipedia.org/' },
  { id: 'default-youtube', name: 'YouTube', url: 'https://www.youtube.com/' },
  { id: 'default-github', name: 'GitHub', url: 'https://github.com/' },
  { id: 'default-stackoverflow', name: 'Stack Overflow', url: 'https://stackoverflow.com/' }
];

/**
 * What was typed in the URL field, as an address a shortcut may open — or
 * why not. Only http(s) web addresses: `javascript:`, `data:`, `file:` and
 * the like are refused, as are addresses with a user name or password in
 * them. "example.com" is taken as https://example.com/.
 *
 * @param {string} input
 * @returns {{ok: true, url: string} | {ok: false, error: string}}
 */
export function parseShortcutUrl(input) {
  const text = String(input || '').trim();
  if (!text) return { ok: false, error: 'Enter the website’s address.' };
  if (text.length > MAX_URL_LENGTH) return { ok: false, error: 'That address is too long.' };
  if (/\s/.test(text)) return { ok: false, error: 'A web address has no spaces.' };

  // A scheme other than http(s) is refused outright, not "fixed".
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  const hasScheme = scheme && !/^\d+$/.test(text.slice(scheme[0].length).split('/')[0]);
  if (hasScheme && !/^https?$/i.test(scheme[1])) {
    return { ok: false, error: 'Only web addresses (http or https) can be shortcuts.' };
  }

  let url;
  try {
    url = new URL(hasScheme ? text : `https://${text}`);
  } catch {
    return { ok: false, error: 'That is not a valid web address.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only web addresses (http or https) can be shortcuts.' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Addresses with a user name or password are not allowed.' };
  }
  const host = url.hostname;
  if (!host || (!host.includes('.') && host !== 'localhost' && !host.startsWith('['))) {
    return { ok: false, error: 'That is not a valid web address.' };
  }
  return { ok: true, url: url.href };
}

/**
 * Which site a shortcut is for, to find two shortcuts for the same one:
 * http and https alike, "www." or not, no fragment, no trailing slash, host
 * in lower case — the path and query keep their case.
 */
export function shortcutKey(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.host.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${host}${path}${parsed.search}`;
  } catch {
    return String(url || '').trim();
  }
}

/** A name for a shortcut: what was typed, or the site's own host. */
export function shortcutName(name, url) {
  const typed = String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  if (typed) return typed;
  try {
    return new URL(url).hostname.replace(/^www\./, '').slice(0, MAX_NAME_LENGTH);
  } catch {
    return 'Website';
  }
}

/** A stored item, checked again: anything malformed or unsafe is dropped. */
function cleanItem(item) {
  if (!item || typeof item !== 'object') return null;
  const parsed = parseShortcutUrl(item.url);
  if (!parsed.ok) return null;
  const id = typeof item.id === 'string' && item.id ? item.id.slice(0, 64) : null;
  if (!id) return null;
  return { id, name: shortcutName(item.name, parsed.url), url: parsed.url };
}

/** The shortcuts to show: the visitor's own, or the defaults. */
export function loadShortcuts() {
  let stored;
  try {
    stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    stored = null;
  }
  if (!stored || stored.version !== VERSION || !Array.isArray(stored.items)) {
    return DEFAULT_SHORTCUTS.map(item => ({ ...item }));
  }
  const seen = new Set();
  const items = [];
  for (const raw of stored.items) {
    const item = cleanItem(raw);
    if (!item || seen.has(shortcutKey(item.url))) continue;
    seen.add(shortcutKey(item.url));
    items.push(item);
    if (items.length >= MAX_SHORTCUTS) break;
  }
  return items;
}

/** Saves the visitor's list. @returns {boolean} whether it was stored */
export function saveShortcuts(items) {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: VERSION, items: items.slice(0, MAX_SHORTCUTS) })
    );
    return true;
  } catch {
    return false;
  }
}

/** A new shortcut id, unique within the list. */
export function newShortcutId(items) {
  const taken = new Set(items.map(item => item.id));
  let id;
  do {
    id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  } while (taken.has(id));
  return id;
}

export const SHORTCUTS_STORAGE_KEY = STORAGE_KEY;
