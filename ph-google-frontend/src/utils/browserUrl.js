import { safeHttpUrl } from './safeUrl';

/**
 * Helpers for the in-app browser tabs: reading what was typed in the
 * address field, naming a tab, and choosing the address to frame.
 */

// A host name: labels joined by dots, ending in a top-level domain.
const LOOKS_LIKE_HOST = /^([a-z0-9-]+\.)+[a-z]{2,}(:\d{1,5})?([/?#].*)?$/i;
const LOCAL_HOST = /^localhost(:\d{1,5})?([/?#].*)?$/i;

/**
 * What the text in the address field means.
 *
 *   "https://example.com"   → a page to load
 *   "example.com/docs"      → the same, https assumed
 *   "python tutorial"       → a search
 *   "javascript:alert(1)"   → a search (never run, never loaded)
 *
 * @param {string} input
 * @returns {{type: 'url', url: string} | {type: 'search', query: string} | null}
 */
export function parseAddressInput(input) {
  const text = String(input || '').trim();
  if (!text) return null;

  if (!/\s/.test(text)) {
    let url = null;
    if (/^https?:\/\//i.test(text)) url = safeHttpUrl(text);
    else if (LOCAL_HOST.test(text)) url = safeHttpUrl(`http://${text}`);
    else if (LOOKS_LIKE_HOST.test(text)) url = safeHttpUrl(`https://${text}`);
    if (url) return { type: 'url', url };
  }
  return { type: 'search', query: text };
}

// Sites whose name is not just their domain with a capital letter.
const SITE_NAMES = {
  youtube: 'YouTube',
  youtu: 'YouTube',
  github: 'GitHub',
  wikipedia: 'Wikipedia',
  fb: 'Facebook',
  stackoverflow: 'Stack Overflow',
  linkedin: 'LinkedIn',
  techcrunch: 'TechCrunch',
  bbc: 'BBC',
  cnn: 'CNN',
  nasa: 'NASA',
  w3schools: 'W3Schools',
  geeksforgeeks: 'GeeksforGeeks',
  openai: 'OpenAI',
  medlineplus: 'MedlinePlus',
  wikivoyage: 'Wikivoyage'
};

// "bbc.co.uk": the name is the label before these, not "co".
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu']);

/**
 * A short tab title for an address: the site's name.
 *
 *   https://en.wikipedia.org/wiki/Python → "Wikipedia"
 *   https://docs.python.org/3/           → "Python"
 *   https://www.bbc.co.uk/news           → "BBC"
 *
 * @param {string} url
 * @returns {string} "New Tab" when the address has no usable host
 */
export function titleForUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'New Tab';
  }
  const labels = host
    .replace(/^www\./, '')
    .split('.')
    .filter(Boolean);
  if (labels.length === 0) return 'New Tab';
  if (labels.length === 1 || labels.every(l => /^\d+$/.test(l))) return host;

  let index = labels.length - 2;
  if (index > 0 && SECOND_LEVEL.has(labels[index]) && labels[labels.length - 1].length === 2) {
    index -= 1;
  }
  const name = labels[index];
  return SITE_NAMES[name] || name.charAt(0).toUpperCase() + name.slice(1);
}

/** The host of an address, without "www.", for messages. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * The address to put in the frame for a page.
 *
 * A YouTube watch page refuses to be framed, but YouTube publishes every
 * video at an address made for framing (/embed/ID). That is the one
 * rewrite; every other page is framed at its own address or not at all.
 */
export function embedUrlFor(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^(www|m)\./, '');
    const validId = id => (/^[\w-]{6,20}$/.test(id || '') ? id : null);
    let id = null;
    if (host === 'youtube.com' && parsed.pathname === '/watch') {
      id = validId(parsed.searchParams.get('v'));
    } else if (host === 'youtube.com' && parsed.pathname.startsWith('/shorts/')) {
      id = validId(parsed.pathname.split('/')[2]);
    } else if (host === 'youtu.be') {
      id = validId(parsed.pathname.slice(1));
    }
    if (id) return `https://www.youtube.com/embed/${id}`;
  } catch {
    // Not an address: the caller has already refused it.
  }
  return url;
}

// Map links open the map application or site itself; they are not pages to
// read in a tab, and Google Maps refuses to be framed.
const MAP_HOSTS = /(^|\.)(openstreetmap\.org|maps\.app\.goo\.gl|maps\.google\.[a-z.]+)$/i;

/** Whether a link should keep opening outside the app. */
export function opensExternally(url) {
  try {
    const parsed = new URL(url);
    if (MAP_HOSTS.test(parsed.hostname)) return true;
    return /(^|\.)google\.[a-z.]+$/i.test(parsed.hostname) && parsed.pathname.startsWith('/maps');
  } catch {
    return true;
  }
}
