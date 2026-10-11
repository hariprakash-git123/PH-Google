import { useEffect, useState } from 'react';
import { searchApi } from '../services/searchApi';

/**
 * Related searches for a query: the backend's own suggestions for it
 * (GET /api/suggestions — searches people made that found something, and
 * words in the index), without the query itself and without repeats. There
 * are none when the backend has none; nothing is made up.
 */

const normalise = text =>
  String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();

/**
 * @param {string} query
 * @param {number} [limit=8]
 * @returns {string[]} the suggestions for this query (empty while they load)
 */
export function useRelatedSearches(query, limit = 8) {
  const [related, setRelated] = useState({ for: null, items: [] });

  useEffect(() => {
    let current = true;
    const asked = normalise(query);
    if (!asked) return undefined;
    searchApi.getSuggestions(query).then(list => {
      if (!current) return;
      const seen = new Set([asked]);
      const items = [];
      for (const suggestion of Array.isArray(list) ? list : []) {
        const text =
          suggestion && typeof suggestion.text === 'string' ? suggestion.text.trim() : '';
        const key = normalise(text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push(text);
        if (items.length >= limit) break;
      }
      setRelated({ for: asked, items });
    });
    return () => {
      current = false;
    };
  }, [query, limit]);

  return related.for === normalise(query) ? related.items : [];
}
