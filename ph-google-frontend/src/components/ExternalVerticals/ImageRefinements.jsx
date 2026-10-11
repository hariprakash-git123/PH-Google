import React from 'react';
import { Search } from 'lucide-react';
import { useRelatedSearches } from '../../hooks/useRelatedSearches';

/**
 * Above the image grid: category chips that narrow the search, and related
 * searches. Both run a real image search — nothing here only changes how a
 * chip looks.
 *
 *   A category chip searches "<query> <category>" ("cats" → "cats wallpaper");
 *   the chip in use is shown pressed, and pressing it again goes back to the
 *   query without it.
 *
 *   Related searches are the backend's own suggestions for the query
 *   (useRelatedSearches). There are none when it has none; nothing is made up.
 */

export const IMAGE_CATEGORIES = [
  'Wallpaper',
  'Nature',
  'Art',
  'Cute',
  'Animal',
  'City',
  'Space',
  'Food'
];

/** How many related searches are offered. */
const RELATED_LIMIT = 8;

/** The category a query ends with, if any, and the query without it. */
export function splitCategory(query) {
  const text = String(query || '')
    .trim()
    .replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  for (const category of IMAGE_CATEGORIES) {
    const suffix = ` ${category.toLowerCase()}`;
    if (lower.endsWith(suffix) && lower.length > suffix.length) {
      return { base: text.slice(0, -suffix.length).trim(), category };
    }
  }
  return { base: text, category: null };
}

/** The search a category chip runs from the current query. */
export function categoryQuery(query, category) {
  const { base, category: current } = splitCategory(query);
  return current === category ? base : `${base} ${category.toLowerCase()}`;
}

/**
 * @param {Object} props
 * @param {string} props.query
 * @param {(query: string) => void} props.onSearch  runs an image search
 */
export default function ImageRefinements({ query, onSearch }) {
  const { category: active } = splitCategory(query);
  const relatedItems = useRelatedSearches(query, RELATED_LIMIT);

  return (
    <div className="ph-img-refine">
      <div className="ph-img-chips" role="group" aria-label="Image categories">
        {IMAGE_CATEGORIES.map(category => {
          const pressed = category === active;
          return (
            <button
              key={category}
              type="button"
              className={`ph-img-chip${pressed ? ' is-active' : ''}`}
              aria-pressed={pressed}
              title={
                pressed
                  ? `Search images without “${category.toLowerCase()}”`
                  : `Search “${categoryQuery(query, category)}” images`
              }
              onClick={() => onSearch(categoryQuery(query, category))}
            >
              {category}
            </button>
          );
        })}
      </div>

      {relatedItems.length > 0 && (
        <nav className="ph-img-related" aria-label="Related searches">
          <span className="ph-img-related-label">Related searches</span>
          <div className="ph-img-related-list">
            {relatedItems.map(text => (
              <button
                key={text}
                type="button"
                className="ph-img-related-item"
                onClick={() => onSearch(text)}
              >
                <Search size={13} aria-hidden="true" />
                <span>{text}</span>
              </button>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}
