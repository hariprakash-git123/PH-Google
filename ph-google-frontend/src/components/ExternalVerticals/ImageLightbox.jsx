import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  Globe,
  ExternalLink,
  ImageOff,
  RefreshCw
} from 'lucide-react';
import { safeHttpUrl } from '../../utils/safeUrl';
import { API_BASE_URL } from '../../services/apiClient';

/**
 * The image preview that opens when an image search result is clicked.
 *
 * Shows the full image (falling back to the thumbnail if it will not load),
 * what the result says about it, and three actions: download it, visit the
 * page it is on, or open the image itself. Left/right move through the
 * images already on the page — no new search is made.
 *
 * Every address is checked with safeHttpUrl before use. Download goes
 * through the backend (GET /api/images/download), which only serves image
 * addresses it signed in the search response (`downloadToken`).
 */

const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff'
};

/** A plain file name from the image title. */
function fileNameFor(title, type) {
  const base = String(title || '')
    .replace(/[^\w .-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'image'}.${EXTENSIONS[type] || 'jpg'}`;
}

/** The backend download address for an image, or null when it cannot be downloaded. */
export function downloadUrlFor(image) {
  if (!image || !image.downloadToken || !safeHttpUrl(image.imageUrl)) return null;
  const params = new URLSearchParams({
    url: image.imageUrl,
    sig: image.downloadToken,
    name: image.title || image.sourceName || image.sourceDomain || 'image'
  });
  return `${API_BASE_URL}/images/download?${params.toString()}`;
}

/**
 * One image inside the lightbox. Keyed by image id by the parent, so moving
 * to another image starts from a clean loading state.
 */
function LightboxImage({ image, label }) {
  const full = safeHttpUrl(image.imageUrl);
  const thumb = safeHttpUrl(image.thumbnailUrl);
  // 'full' → the original; 'thumb' → the original failed (or there is none);
  // 'failed' → nothing could be shown.
  const [stage, setStage] = useState(full ? 'full' : thumb ? 'thumb' : 'failed');
  const [loaded, setLoaded] = useState(false);

  if (stage === 'failed') {
    return (
      <div className="ph-ext-lb-stage ph-ext-lb-failed" role="status">
        <ImageOff size={30} aria-hidden="true" />
        <p>This image could not be loaded.</p>
      </div>
    );
  }

  const src = stage === 'full' ? full : thumb;
  return (
    <div className="ph-ext-lb-stage">
      {/* The thumbnail is already in the browser's cache from the grid, so it
          stands in at once while the full image arrives. */}
      {stage === 'full' && thumb && !loaded && (
        <img className="ph-ext-lb-placeholder" src={thumb} alt="" aria-hidden="true" />
      )}
      <img
        key={src}
        className={`ph-ext-lb-image ${loaded ? 'is-loaded' : ''}`}
        src={src}
        alt={label}
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
        onError={() => {
          setLoaded(false);
          setStage(stage === 'full' && thumb ? 'thumb' : 'failed');
        }}
      />
      {!loaded && (
        <div className="ph-ext-lb-loading" role="status" aria-label="Loading image">
          <RefreshCw size={22} className="animate-spin" aria-hidden="true" />
        </div>
      )}
      {stage === 'thumb' && full && loaded && (
        <p className="ph-ext-lb-note">
          The full-size image could not be loaded. Showing the preview.
        </p>
      )}
    </div>
  );
}

/**
 * @param {Object} props
 * @param {Array} props.images   the images on the page, in order
 * @param {number} props.index   which one is open
 * @param {(index: number) => void} props.onNavigate
 * @param {() => void} props.onClose
 */
export default function ImageLightbox({ images, index, onNavigate, onClose }) {
  const image = images[index];
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  // { id, state }: tied to an image, so it is "idle" again on the next one.
  const [download, setDownload] = useState({ id: null, state: 'idle' });

  const hasPrevious = index > 0;
  const hasNext = index < images.length - 1;

  // Keyboard: Escape closes, arrows move, Tab stays inside the dialog.
  useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowLeft' && hasPrevious) {
        onNavigate(index - 1);
      } else if (event.key === 'ArrowRight' && hasNext) {
        onNavigate(index + 1);
      } else if (event.key === 'Tab' && dialogRef.current) {
        const focusable = [
          ...dialogRef.current.querySelectorAll('button:not([disabled]), a[href]')
        ];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!dialogRef.current.contains(document.activeElement)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, hasPrevious, hasNext, onNavigate, onClose]);

  // The page behind does not scroll while the preview is open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (!image) return null;

  const site = image.sourceName || image.sourceDomain;
  const label = image.title || (site ? `Image from ${site}` : 'Image result');
  const sourceUrl = safeHttpUrl(image.sourceUrl);
  const originalUrl = safeHttpUrl(image.imageUrl);
  const downloadUrl = downloadUrlFor(image);
  const downloadState = download.id === image.id ? download.state : 'idle';

  const handleDownload = async () => {
    if (!downloadUrl || downloadState === 'busy') return;
    setDownload({ id: image.id, state: 'busy' });
    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileNameFor(image.title || site, blob.type);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
      setDownload({ id: image.id, state: 'idle' });
    } catch {
      setDownload({ id: image.id, state: 'error' });
    }
  };

  return (
    <div className="ph-lightbox ph-ext-lb" onClick={onClose}>
      <div
        ref={dialogRef}
        className="ph-ext-lb-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Image preview: ${label}`}
        onClick={event => event.stopPropagation()}
      >
        <button
          ref={closeRef}
          type="button"
          className="ph-lightbox-close"
          onClick={onClose}
          aria-label="Close preview"
        >
          <X size={22} aria-hidden="true" />
        </button>

        {hasPrevious && (
          <button
            type="button"
            className="ph-lightbox-nav ph-lightbox-prev"
            onClick={() => onNavigate(index - 1)}
            aria-label="Previous image"
          >
            <ChevronLeft size={26} aria-hidden="true" />
          </button>
        )}
        {hasNext && (
          <button
            type="button"
            className="ph-lightbox-nav ph-lightbox-next"
            onClick={() => onNavigate(index + 1)}
            aria-label="Next image"
          >
            <ChevronRight size={26} aria-hidden="true" />
          </button>
        )}

        <div className="ph-lightbox-inner">
          <LightboxImage key={image.id} image={image} label={label} />

          <div className="ph-lightbox-info">
            {image.title && <h4 className="ph-ext-lb-title">{image.title}</h4>}
            <div className="ph-lightbox-facts">
              {site && <span>{site}</span>}
              {image.width && image.height && (
                <span>
                  {image.width} × {image.height}
                </span>
              )}
              <span>
                {index + 1} of {images.length}
              </span>
            </div>

            <div className="ph-ext-lb-actions">
              {downloadUrl && (
                <button
                  type="button"
                  className="ph-ext-place-btn primary"
                  onClick={handleDownload}
                  disabled={downloadState === 'busy'}
                >
                  <Download size={14} aria-hidden="true" />
                  {downloadState === 'busy' ? 'Downloading…' : 'Download'}
                </button>
              )}
              {sourceUrl && (
                <a
                  className="ph-ext-place-btn"
                  href={sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Globe size={14} aria-hidden="true" /> Visit site
                </a>
              )}
              {originalUrl && (
                <a
                  className="ph-ext-place-btn"
                  href={originalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open original <ExternalLink size={12} aria-hidden="true" />
                </a>
              )}
            </div>

            {downloadState === 'error' && (
              <p className="ph-ext-lb-error" role="alert">
                This image could not be downloaded.
                {originalUrl && ' Try “Open original” and save it from there.'}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
