import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  Globe,
  ExternalLink,
  ImageOff,
  RefreshCw,
  Share2
} from 'lucide-react';
import { safeHttpUrl } from '../../utils/safeUrl';
import { faviconUrlFor } from '../../utils/favicon';
import { API_BASE_URL } from '../../services/apiClient';

/**
 * The image preview that opens beside the grid when an image result is
 * clicked. The grid stays in view and usable next to it on a wide screen;
 * on a narrow one the preview covers the page until it is closed.
 *
 * Shows the full image (falling back to the thumbnail if it will not load),
 * what the result says about it, and its actions:
 *
 *   Visit    the page the image is on, in the current PH tab (a search
 *            result link, see BrowserShell); Ctrl/middle-click as usual
 *   Share    the page's address, through the device's share sheet, or
 *            copied to the clipboard where there is none
 *   Save     the image file, downloaded through the backend
 *            (GET /api/images/download), which only serves image
 *            addresses it signed in the search response (`downloadToken`)
 *   Open original   the image file itself
 *
 * Previous/next and the arrow keys move through the images already on the
 * page; "More from" lists the other images on the page from the same site.
 * No new search is made. Every address is checked with safeHttpUrl first.
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

/** How many other images from the same site the preview offers. */
const MORE_FROM_SITE = 6;

/** Below this width the preview covers the page instead of sitting beside the grid. */
export const NARROW_QUERY = '(max-width: 899px)';

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

/** The name of the site an image is from. */
export const siteOf = image => image.sourceName || image.sourceDomain || '';

/** A keyboard event typed into a field is the field's, not the preview's. */
function isTyping(event) {
  const target = event.target;
  if (!target || !target.tagName) return false;
  return (
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || Boolean(target.isContentEditable)
  );
}

/**
 * The site's own icon, from its own origin. A generic globe stands in, once,
 * when there is none or it will not load (some sites refuse to let other
 * pages show their icon).
 */
export function SiteIcon({ url }) {
  const src = faviconUrlFor(url);
  const [failed, setFailed] = useState(null);
  if (!src || failed === src) {
    return <Globe size={14} className="ph-site-icon ph-site-icon-generic" aria-hidden="true" />;
  }
  return (
    <img
      className="ph-site-icon"
      src={src}
      alt=""
      width={16}
      height={16}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(src)}
    />
  );
}

/**
 * One image inside the preview. Keyed by image id by the parent, so moving
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

const SHARE_MESSAGES = {
  shared: 'Shared.',
  copied: 'Link copied.',
  error: 'This link could not be shared or copied.'
};

/**
 * @param {Object} props
 * @param {Array} props.images   the images on the page, in order
 * @param {number} props.index   which one is open
 * @param {(index: number) => void} props.onNavigate
 * @param {() => void} props.onClose
 */
export default function ImageLightbox({ images, index, onNavigate, onClose }) {
  const image = images[index];
  const panelRef = useRef(null);
  const closeRef = useRef(null);
  // Tied to an image, so each is "idle" again on the next one.
  const [download, setDownload] = useState({ id: null, state: 'idle' });
  const [share, setShare] = useState({ id: null, state: 'idle' });

  const hasPrevious = index > 0;
  const hasNext = index < images.length - 1;

  // Keyboard: Escape closes, the arrows move — unless the keys are being
  // typed into a field (the search box stays usable beside the preview).
  useEffect(() => {
    const onKey = event => {
      if (event.defaultPrevented || isTyping(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (event.key === 'ArrowLeft' && hasPrevious) {
        event.preventDefault();
        onNavigate(index - 1);
      } else if (event.key === 'ArrowRight' && hasNext) {
        event.preventDefault();
        onNavigate(index + 1);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [index, hasPrevious, hasNext, onNavigate, onClose]);

  // Opening moves focus into the preview. On a narrow screen it covers the
  // page, which then does not scroll behind it.
  useEffect(() => {
    closeRef.current?.focus();
    const narrow =
      typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
    if (!narrow) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Another image: the preview starts at its top.
  useEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [index]);

  if (!image) return null;

  const site = siteOf(image);
  const label = image.title || (site ? `Image from ${site}` : 'Image result');
  const sourceUrl = safeHttpUrl(image.sourceUrl);
  const originalUrl = safeHttpUrl(image.imageUrl);
  const shareUrl = sourceUrl || originalUrl;
  const downloadUrl = downloadUrlFor(image);
  const downloadState = download.id === image.id ? download.state : 'idle';
  const shareState = share.id === image.id ? share.state : 'idle';
  const fromSite = image.sourceDomain
    ? images
        .map((other, at) => ({ other, at }))
        .filter(
          ({ other }) =>
            other.id !== image.id &&
            other.sourceDomain === image.sourceDomain &&
            safeHttpUrl(other.thumbnailUrl)
        )
        .slice(0, MORE_FROM_SITE)
    : [];

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
      setDownload({ id: image.id, state: 'saved' });
    } catch {
      setDownload({ id: image.id, state: 'error' });
    }
  };

  const handleShare = async () => {
    if (!shareUrl) return;
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: label, url: shareUrl });
        setShare({ id: image.id, state: 'shared' });
      } else if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(shareUrl);
        setShare({ id: image.id, state: 'copied' });
      } else {
        throw new Error('No way to share');
      }
    } catch (error) {
      // Closing the share sheet is not a failure.
      if (error && error.name === 'AbortError') return;
      setShare({ id: image.id, state: 'error' });
    }
  };

  return (
    <>
      {/* On a narrow screen: the page behind, dimmed; a tap on it closes. */}
      <div className="ph-img-panel-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        className="ph-img-panel"
        role="dialog"
        aria-modal="false"
        aria-label={`Image preview: ${label}`}
      >
        <div className="ph-img-panel-bar">
          <span className="ph-img-panel-site">
            <SiteIcon url={sourceUrl || originalUrl} />
            <span>{site || 'Image'}</span>
          </span>
          <span className="ph-img-panel-count" aria-live="polite">
            {index + 1} of {images.length}
          </span>
          <button
            type="button"
            className="ph-img-panel-btn"
            onClick={() => onNavigate(index - 1)}
            disabled={!hasPrevious}
            aria-label="Previous image"
            title="Previous image"
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ph-img-panel-btn"
            onClick={() => onNavigate(index + 1)}
            disabled={!hasNext}
            aria-label="Next image"
            title="Next image"
          >
            <ChevronRight size={18} aria-hidden="true" />
          </button>
          <button
            ref={closeRef}
            type="button"
            className="ph-img-panel-btn"
            onClick={onClose}
            aria-label="Close preview"
            title="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <LightboxImage key={image.id} image={image} label={label} />

        <div className="ph-img-panel-body">
          {image.title && <h2 className="ph-ext-lb-title">{image.title}</h2>}
          {image.width && image.height && (
            <p className="ph-img-panel-facts">
              {image.width} × {image.height}
            </p>
          )}

          <div className="ph-ext-lb-actions">
            {sourceUrl && (
              <a
                className="ph-ext-place-btn primary"
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-ph-result=""
              >
                <Globe size={14} aria-hidden="true" /> Visit
              </a>
            )}
            {shareUrl && (
              <button type="button" className="ph-ext-place-btn" onClick={handleShare}>
                <Share2 size={14} aria-hidden="true" /> Share
              </button>
            )}
            {downloadUrl && (
              <button
                type="button"
                className="ph-ext-place-btn"
                onClick={handleDownload}
                disabled={downloadState === 'busy'}
                aria-label="Save image to your device"
              >
                <Download size={14} aria-hidden="true" />
                {downloadState === 'busy' ? 'Saving…' : 'Save'}
              </button>
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

          {shareState !== 'idle' && (
            <p
              className={shareState === 'error' ? 'ph-ext-lb-error' : 'ph-img-panel-note'}
              role={shareState === 'error' ? 'alert' : 'status'}
            >
              {SHARE_MESSAGES[shareState]}
            </p>
          )}
          {downloadState === 'saved' && (
            <p className="ph-img-panel-note" role="status">
              Image saved to your downloads.
            </p>
          )}
          {downloadState === 'error' && (
            <p className="ph-ext-lb-error" role="alert">
              This image could not be saved.
              {originalUrl && ' Try “Open original” and save it from there.'}
            </p>
          )}

          {fromSite.length > 0 && (
            <section className="ph-img-panel-related" aria-label={`More from ${site}`}>
              <h3>More from {site}</h3>
              <div className="ph-img-panel-related-grid">
                {fromSite.map(({ other, at }) => (
                  <button
                    key={other.id}
                    type="button"
                    className="ph-img-panel-related-item"
                    onClick={() => onNavigate(at)}
                    aria-label={`Show ${other.title || `image ${at + 1}`}`}
                  >
                    <img
                      src={safeHttpUrl(other.thumbnailUrl)}
                      alt=""
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
