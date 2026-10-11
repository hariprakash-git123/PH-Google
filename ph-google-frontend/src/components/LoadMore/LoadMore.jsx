import React from 'react';
import { Loader2, RotateCw } from 'lucide-react';
import './LoadMore.css';

/**
 * The control under a result list or grid that asks for the next batch.
 *
 * Its states come from the search page: loading (button disabled, so a
 * second click cannot send a second request), failed (the results stay and a
 * retry is offered), more available, or the end of the results.
 *
 * @param {boolean} hasMore   the server says there may be more
 * @param {boolean} loading   a batch is being fetched
 * @param {string|null} error the last batch failed, with this message
 * @param {Function} onLoadMore
 */
export default function LoadMore({ hasMore, loading, error, onLoadMore }) {
  if (error) {
    return (
      <div className="ph-load-more" role="alert">
        <p className="ph-load-more-note">
          Couldn&apos;t load more results.
          {typeof error === 'string' && error.trim() && <> {error.trim()}</>}
        </p>
        <button type="button" className="ph-load-more-btn" onClick={onLoadMore} disabled={loading}>
          <RotateCw size={15} aria-hidden="true" /> Try again
        </button>
      </div>
    );
  }

  if (!hasMore) {
    return (
      <div className="ph-load-more">
        <p className="ph-load-more-note" role="status">
          You&apos;ve reached the end of the results.
        </p>
      </div>
    );
  }

  return (
    <div className="ph-load-more">
      <button
        type="button"
        className="ph-load-more-btn"
        onClick={onLoadMore}
        disabled={loading}
        aria-busy={loading}
      >
        {loading ? (
          <>
            <Loader2 size={15} className="ph-load-more-spin" aria-hidden="true" /> Loading…
          </>
        ) : (
          'Load more results'
        )}
      </button>
    </div>
  );
}
