import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  DEFAULT_SHORTCUTS,
  MAX_SHORTCUTS,
  SHORTCUTS_STORAGE_KEY,
  loadShortcuts,
  parseShortcutUrl,
  saveShortcuts,
  shortcutKey,
  shortcutName
} from './shortcuts';

/** Homepage shortcuts: what may be one, and how they are kept in this browser. */

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('what may be a shortcut', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    ['http://example.com/a?b=1', 'http://example.com/a?b=1'],
    ['example.com', 'https://example.com/'],
    ['  en.wikipedia.org/wiki/Python  ', 'https://en.wikipedia.org/wiki/Python'],
    ['example.com:8080/x', 'https://example.com:8080/x'],
    ['localhost:3000', 'https://localhost:3000/'],
    ['HTTPS://Example.COM/Path', 'https://example.com/Path']
  ])('%s → %s', (input, url) => {
    expect(parseShortcutUrl(input)).toEqual({ ok: true, url });
  });

  it.each([
    ['javascript:alert(1)', /Only web addresses/],
    ['JavaScript:alert(1)', /Only web addresses/],
    ['data:text/html,<b>x</b>', /Only web addresses/],
    ['file:///etc/passwd', /Only web addresses/],
    ['ftp://files.example.com', /Only web addresses/],
    ['mailto:someone@example.com', /Only web addresses/],
    ['https://user:pass@example.com', /user name or password/],
    ['', /Enter the website/],
    ['   ', /Enter the website/],
    ['not a url', /no spaces/],
    ['nodots', /not a valid web address/],
    ['https://', /not a valid web address/]
  ])('%s is refused', (input, message) => {
    const parsed = parseShortcutUrl(input);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(message);
  });

  it('one site, however its address is written, is one shortcut', () => {
    const key = shortcutKey('https://www.youtube.com/');
    for (const same of [
      'https://youtube.com',
      'http://youtube.com/',
      'https://WWW.YouTube.com',
      'https://youtube.com/#top'
    ]) {
      expect(shortcutKey(same)).toBe(key);
    }
    // A different page, or a path differing in case, is a different shortcut.
    expect(shortcutKey('https://youtube.com/feed')).not.toBe(key);
    expect(shortcutKey('https://example.com/Docs')).not.toBe(
      shortcutKey('https://example.com/docs')
    );
  });

  it('a shortcut with no name is named after its site; a long name is cut short', () => {
    expect(shortcutName('', 'https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
    expect(shortcutName('  My   site ', 'https://example.com/')).toBe('My site');
    expect(shortcutName('x'.repeat(40), 'https://example.com/')).toHaveLength(24);
  });
});

describe('keeping them in this browser', () => {
  it('shows the defaults until the list has been changed', () => {
    expect(loadShortcuts()).toEqual(DEFAULT_SHORTCUTS);
    expect(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)).toBeNull();
  });

  it('saves a versioned list and reads it back', () => {
    const items = [{ id: 'a', name: 'Example', url: 'https://example.com/' }];
    expect(saveShortcuts(items)).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(SHORTCUTS_STORAGE_KEY))).toEqual({
      version: 1,
      items
    });
    expect(loadShortcuts()).toEqual(items);
  });

  it('an emptied list stays empty: the defaults do not come back', () => {
    saveShortcuts([]);
    expect(loadShortcuts()).toEqual([]);
  });

  it('what is stored is checked again: unsafe, malformed and repeated items are dropped', () => {
    window.localStorage.setItem(
      SHORTCUTS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        items: [
          { id: 'ok', name: 'Fine', url: 'https://example.com/' },
          { id: 'js', name: 'Bad', url: 'javascript:alert(1)' },
          { id: 'data', name: 'Bad', url: 'data:text/html,x' },
          { id: 'again', name: 'Repeat', url: 'http://www.example.com' },
          { name: 'No id', url: 'https://other.example/' },
          'not an object',
          null
        ]
      })
    );
    expect(loadShortcuts()).toEqual([{ id: 'ok', name: 'Fine', url: 'https://example.com/' }]);
  });

  it('keeps at most the maximum', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      id: `s${i}`,
      name: `Site ${i}`,
      url: `https://site${i}.example/`
    }));
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify({ version: 1, items: many }));
    expect(loadShortcuts()).toHaveLength(MAX_SHORTCUTS);
  });

  it('broken or unknown stored data falls back to the defaults', () => {
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, '{not json');
    expect(loadShortcuts()).toEqual(DEFAULT_SHORTCUTS);
    window.localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify({ version: 99, items: [] }));
    expect(loadShortcuts()).toEqual(DEFAULT_SHORTCUTS);
  });

  it('storage that cannot be written is reported, not thrown', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(saveShortcuts([])).toBe(false);
  });
});
