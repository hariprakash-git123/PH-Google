import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import './Pagination.css';

/**
 * Pagination control driven by the API's pagination block.
 *
 * @param {number} currentPage
 * @param {number} totalPages
 * @param {boolean} hasNextPage
 * @param {boolean} hasPreviousPage
 * @param {Function} onPageChange
 */
export default function Pagination({
  currentPage = 1,
  totalPages = 1,
  hasNextPage = false,
  hasPreviousPage = false,
  onPageChange
}) {
  if (!totalPages || totalPages <= 1) return null;

  const goTo = page => {
    if (page < 1 || page > totalPages || page === currentPage) return;
    if (onPageChange) onPageChange(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Show a sliding window of at most 5 page numbers around the current page.
  const windowSize = Math.min(5, totalPages);
  let start = Math.max(1, currentPage - Math.floor(windowSize / 2));
  const end = Math.min(totalPages, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);

  const pages = [];
  for (let p = start; p <= end; p += 1) pages.push(p);

  return (
    <div className="ph-pagination-wrapper">
      <div className="ph-pagination-pages">
        <button
          type="button"
          className="ph-page-next ph-page-prev"
          onClick={() => goTo(currentPage - 1)}
          disabled={!hasPreviousPage}
          aria-label="Previous page"
        >
          <ChevronLeft size={16} />
          <span>Prev</span>
        </button>

        {start > 1 && (
          <>
            <button
              type="button"
              className="ph-page-number"
              onClick={() => goTo(1)}
              aria-label="Go to page 1"
            >
              1
            </button>
            {start > 2 && <span className="ph-page-ellipsis">…</span>}
          </>
        )}

        {pages.map(page => (
          <button
            key={page}
            type="button"
            className={`ph-page-number ${currentPage === page ? 'active' : ''}`}
            onClick={() => goTo(page)}
            aria-label={`Go to page ${page}`}
            aria-current={currentPage === page ? 'page' : undefined}
          >
            {page}
          </button>
        ))}

        {end < totalPages && (
          <>
            {end < totalPages - 1 && <span className="ph-page-ellipsis">…</span>}
            <button
              type="button"
              className="ph-page-number"
              onClick={() => goTo(totalPages)}
              aria-label={`Go to page ${totalPages}`}
            >
              {totalPages}
            </button>
          </>
        )}

        <button
          type="button"
          className="ph-page-next"
          onClick={() => goTo(currentPage + 1)}
          disabled={!hasNextPage}
          aria-label="Next page"
        >
          <span>Next</span>
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
