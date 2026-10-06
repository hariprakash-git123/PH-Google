import React, { useState, useCallback, useEffect } from 'react';
import { ExternalLink, X, ImageOff, ChevronLeft, ChevronRight } from 'lucide-react';
import './ImageResults.css';

/**
 * Image search results.
 *
 * Every tile is a real image found on a crawled page. Images are loaded
 * straight from their origin with `referrerPolicy="no-referrer"`, and a tile
 * whose image fails to load hides itself rather than showing a broken icon.
 * Clicking a tile opens a lightbox with the source page it came from.
 */
export default function ImageResults({ results, query }) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const [broken, setBroken] = useState(() => new Set());

  const markBroken = useCallback(url => {
    setBroken(prev => {
      if (prev.has(url)) return prev;
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  }, []);

  const visible = results.filter(r => !broken.has(r.url));
  const active = activeIndex >= 0 ? visible[activeIndex] : null;

  const close = useCallback(() => setActiveIndex(-1), []);
  const step = useCallback(
    delta => {
      setActiveIndex(i => {
        if (i < 0) return i;
        const next = i + delta;
        if (next < 0 || next >= visible.length) return i;
        return next;
      });
    },
    [visible.length]
  );

  // Keyboard control for the lightbox.
  useEffect(() => {
    if (activeIndex < 0) return undefined;
    const onKey = e => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeIndex, close, step]);

  if (visible.length === 0) {
    return (
      <div className="ph-empty-state ph-card animate-fade-in">
        <ImageOff size={28} className="ph-empty-icon" />
        <h3>No images found for &quot;{query}&quot;</h3>
        <p>
          Images are indexed from the pages the crawler visits. Crawl an image-rich site from the
          admin console to grow this index.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="ph-image-grid animate-fade-in">
        {visible.map((image, index) => (
          <button
            key={image.id}
            type="button"
            className="ph-image-tile"
            onClick={() => setActiveIndex(index)}
            title={image.title}
          >
            <div className="ph-image-thumb">
              <img
                src={image.url}
                alt={image.alt || image.title || ''}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => markBroken(image.url)}
              />
            </div>
            <div className="ph-image-meta">
              <span className="ph-image-title">{image.title}</span>
              <span className="ph-image-source">
                {image.source}
                {image.dimensions && <> · {image.dimensions}</>}
              </span>
            </div>
          </button>
        ))}
      </div>

      {active && (
        <div
          className="ph-lightbox"
          onClick={close}
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
        >
          <button type="button" className="ph-lightbox-close" onClick={close} aria-label="Close">
            <X size={22} />
          </button>

          {activeIndex > 0 && (
            <button
              type="button"
              className="ph-lightbox-nav ph-lightbox-prev"
              onClick={e => {
                e.stopPropagation();
                step(-1);
              }}
              aria-label="Previous image"
            >
              <ChevronLeft size={26} />
            </button>
          )}

          {activeIndex < visible.length - 1 && (
            <button
              type="button"
              className="ph-lightbox-nav ph-lightbox-next"
              onClick={e => {
                e.stopPropagation();
                step(1);
              }}
              aria-label="Next image"
            >
              <ChevronRight size={26} />
            </button>
          )}

          <div className="ph-lightbox-inner" onClick={e => e.stopPropagation()}>
            <img
              src={active.url}
              alt={active.alt || active.title || ''}
              referrerPolicy="no-referrer"
              onError={() => {
                markBroken(active.url);
                close();
              }}
            />
            <div className="ph-lightbox-info">
              <h4>{active.title}</h4>
              {active.caption && <p className="ph-lightbox-caption">{active.caption}</p>}
              <div className="ph-lightbox-facts">
                <span>{active.source}</span>
                {active.dimensions && <span>{active.dimensions}</span>}
                {active.format && <span>{active.format}</span>}
              </div>
              <div className="ph-lightbox-links">
                <a href={active.sourcePage} target="_blank" rel="noopener noreferrer">
                  Visit page <ExternalLink size={13} />
                </a>
                <a href={active.url} target="_blank" rel="noopener noreferrer">
                  Open image <ExternalLink size={13} />
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
