import React from 'react';
import { Search } from 'lucide-react';
import { useRelatedSearches } from '../../hooks/useRelatedSearches';
import './RelatedSearches.css';

/**
 * "Related searches" under the web results: the backend's own suggestions for
 * the query (useRelatedSearches). Nothing is shown when there are none —
 * no stand-in topics.
 *
 * @param {Object} props
 * @param {string} props.query
 * @param {(query: string) => void} props.onSearch
 */
export default function RelatedSearches({ query, onSearch }) {
  const items = useRelatedSearches(query, 8);
  if (items.length === 0) return null;
  return (
    <nav className="ph-related-searches" aria-label="Related searches">
      <h2 className="ph-related-title">Related searches</h2>
      <ul className="ph-related-list">
        {items.map(text => (
          <li key={text}>
            <button type="button" className="ph-related-item" onClick={() => onSearch(text)}>
              <Search size={15} aria-hidden="true" />
              <span>{text}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
