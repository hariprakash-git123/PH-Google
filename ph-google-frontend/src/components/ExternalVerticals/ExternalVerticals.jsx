import React, { useCallback, useState } from 'react';
import {
  ExternalLink,
  ImageOff,
  VideoOff,
  MapPin,
  Phone,
  Globe,
  Clock,
  Compass,
  Play,
  CloudOff,
  Navigation
} from 'lucide-react';
import { safeHttpUrl } from '../../utils/safeUrl';
import ImageLightbox from './ImageLightbox';
import '../ImageResults/ImageResults.css';
import '../VideoResults/VideoResults.css';
import './ExternalVerticals.css';

/**
 * Image, video and map results from Google (via SerpApi on the backend).
 *
 * Everything shown is plain text from the API — React escapes it, and no
 * HTML from the provider is ever injected. Every link and image address is
 * re-checked with safeHttpUrl before it is used, even though the backend
 * already accepts only http(s): a result that fails is not linked, or not
 * shown. Videos and places open the original page in a new tab; an image
 * opens a preview first (ImageLightbox). Nothing is embedded.
 */

/** "No images found" vs "nothing available right now" — they mean different things. */
function VerticalEmpty({ icon: Icon, unavailable, emptyText }) {
  return (
    <div className="ph-empty-state ph-card animate-fade-in" role="status">
      {unavailable ? (
        <CloudOff size={28} className="ph-empty-icon" aria-hidden="true" />
      ) : (
        <Icon size={28} className="ph-empty-icon" aria-hidden="true" />
      )}
      <h3>{unavailable ? 'No results available right now.' : emptyText}</h3>
      <p>
        {unavailable
          ? 'The results service could not be reached. Try again in a little while.'
          : 'Try different or fewer keywords.'}
      </p>
    </div>
  );
}

/** Hides results whose image fails to load, instead of showing a broken icon. */
function useBroken() {
  const [broken, setBroken] = useState(() => new Set());
  const markBroken = useCallback(id => {
    setBroken(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  return [broken, markBroken];
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export function ExternalImageResults({ results, unavailable }) {
  const [broken, markBroken] = useBroken();
  // The open preview is remembered by id, so it survives a tile dropping out
  // of the grid when its thumbnail fails.
  const [openId, setOpenId] = useState(null);
  const visible = results.filter(image => !broken.has(image.id) && safeHttpUrl(image.thumbnailUrl));
  const openIndex = visible.findIndex(image => image.id === openId);

  const closePreview = useCallback(() => {
    // Hand focus back to the tile the preview was opened from.
    const tile = [...document.querySelectorAll('[data-image-id]')].find(
      element => element.dataset.imageId === String(openId)
    );
    setOpenId(null);
    if (tile) tile.focus();
  }, [openId]);

  if (visible.length === 0) {
    return (
      <VerticalEmpty
        icon={ImageOff}
        unavailable={unavailable}
        emptyText="No images found for this search."
      />
    );
  }

  return (
    <>
      <div className="ph-image-grid animate-fade-in">
        {visible.map(image => {
          const site = image.sourceName || image.sourceDomain;
          const label = image.title || (site ? `Image from ${site}` : 'Image result');
          return (
            // A button, not a link: clicking opens the preview and stays on
            // the page. The preview holds the links to the site and the image.
            <button
              key={image.id}
              type="button"
              className="ph-image-tile ph-ext-tile"
              data-image-id={image.id}
              onClick={() => setOpenId(image.id)}
              aria-haspopup="dialog"
              title={label}
            >
              <div className="ph-image-thumb">
                <img
                  src={safeHttpUrl(image.thumbnailUrl)}
                  alt={label}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={() => markBroken(image.id)}
                />
              </div>
              <div className="ph-image-meta">
                {image.title && <span className="ph-image-title">{image.title}</span>}
                <span className="ph-image-source">
                  {site}
                  {image.width && image.height && (
                    <>
                      {' '}
                      · {image.width}×{image.height}
                    </>
                  )}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {openIndex >= 0 && (
        <ImageLightbox
          images={visible}
          index={openIndex}
          onNavigate={next => setOpenId(visible[next].id)}
          onClose={closePreview}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

export function ExternalVideoResults({ results, unavailable }) {
  const [broken, markBroken] = useBroken();
  const visible = results.filter(video => safeHttpUrl(video.videoUrl || video.sourceUrl));

  if (visible.length === 0) {
    return (
      <VerticalEmpty
        icon={VideoOff}
        unavailable={unavailable}
        emptyText="No videos found for this search."
      />
    );
  }

  return (
    <div className="ph-video-grid animate-fade-in">
      {visible.map(video => {
        const href = safeHttpUrl(video.videoUrl) || safeHttpUrl(video.sourceUrl);
        const thumb = !broken.has(video.id) && safeHttpUrl(video.thumbnailUrl);
        const site = video.sourceName || video.sourceDomain;
        return (
          <article key={video.id} className="ph-video-card">
            <a
              className="ph-video-thumb"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Watch ${video.title}${site ? ` on ${site}` : ''}`}
            >
              {thumb ? (
                <img
                  src={thumb}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={() => markBroken(video.id)}
                />
              ) : (
                <div className="ph-video-thumb-fallback">
                  <Play size={26} aria-hidden="true" />
                </div>
              )}
              {video.duration && <span className="ph-video-duration">{video.duration}</span>}
            </a>

            <div className="ph-video-body">
              <h3 className="ph-video-title" title={video.title}>
                <a href={href} target="_blank" rel="noopener noreferrer" className="ph-ext-link">
                  {video.title}
                </a>
              </h3>
              <div className="ph-video-meta">
                {site && <span className="ph-video-source">{site}</span>}
                {video.publishedAgo && (
                  <span className="ph-video-source">· {video.publishedAgo}</span>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

/** ★★★★☆ for a 0–5 rating, with the number spoken for screen readers. */
function Stars({ rating }) {
  const full = Math.round(rating);
  return (
    <span className="ph-ext-stars" role="img" aria-label={`Rated ${rating} out of 5`}>
      <span aria-hidden="true">
        {'★'.repeat(full)}
        <span className="ph-ext-stars-empty">{'★'.repeat(5 - full)}</span>
      </span>
    </span>
  );
}

/** A tel: link only for something that is actually a phone number. */
function telHref(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '');
  return /^\+?\d{5,16}$/.test(digits) ? `tel:${digits}` : null;
}

export function ExternalPlaceResults({ results, unavailable }) {
  const [broken, markBroken] = useBroken();

  if (results.length === 0) {
    return (
      <VerticalEmpty
        icon={MapPin}
        unavailable={unavailable}
        emptyText="No places found for this search."
      />
    );
  }

  return (
    <ol className="ph-ext-place-list animate-fade-in">
      {results.map(place => {
        const mapsUrl = safeHttpUrl(place.mapsUrl);
        const website = safeHttpUrl(place.website);
        const thumb = !broken.has(place.id) && safeHttpUrl(place.thumbnailUrl);
        const tel = telHref(place.phone);
        const hasCoords = Number.isFinite(place.latitude) && Number.isFinite(place.longitude);
        return (
          <li key={place.id} className="ph-ext-place ph-card">
            <div className="ph-ext-place-body">
              <h3 className="ph-ext-place-title">{place.title}</h3>

              {(Number.isFinite(place.rating) || place.reviews || place.category) && (
                <div className="ph-ext-place-rating">
                  {Number.isFinite(place.rating) && (
                    <>
                      <strong>{place.rating.toFixed(1)}</strong>
                      <Stars rating={place.rating} />
                    </>
                  )}
                  {place.reviews && (
                    <span>
                      {place.reviews.toLocaleString()} review{place.reviews === 1 ? '' : 's'}
                    </span>
                  )}
                  {place.category && <span className="ph-place-category">{place.category}</span>}
                </div>
              )}

              {place.address && (
                <p className="ph-ext-place-line">
                  <MapPin size={13} aria-hidden="true" /> {place.address}
                </p>
              )}
              {place.hours && (
                <p className="ph-ext-place-line">
                  <Clock size={13} aria-hidden="true" /> {place.hours}
                </p>
              )}
              {place.phone && (
                <p className="ph-ext-place-line">
                  <Phone size={13} aria-hidden="true" />{' '}
                  {tel ? <a href={tel}>{place.phone}</a> : place.phone}
                </p>
              )}
              {hasCoords && (
                <p className="ph-ext-place-line ph-ext-place-coords">
                  <Compass size={13} aria-hidden="true" /> {place.latitude.toFixed(5)},{' '}
                  {place.longitude.toFixed(5)}
                </p>
              )}

              <div className="ph-ext-place-actions">
                {mapsUrl && (
                  <a
                    className="ph-ext-place-btn primary"
                    href={mapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Navigation size={13} aria-hidden="true" /> View on Maps
                  </a>
                )}
                {website && (
                  <a
                    className="ph-ext-place-btn"
                    href={website}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Globe size={13} aria-hidden="true" /> Website
                    <ExternalLink size={11} aria-hidden="true" />
                  </a>
                )}
              </div>
            </div>

            {thumb && (
              <img
                className="ph-ext-place-thumb"
                src={thumb}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => markBroken(place.id)}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Loading skeletons, one per layout
// ---------------------------------------------------------------------------

export function VerticalSkeleton({ tab }) {
  if (tab === 'images') {
    return (
      <div className="ph-image-grid animate-pulse" aria-label="Loading images" role="status">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="ph-image-tile ph-ext-skeleton-tile">
            <div className="ph-image-thumb ph-ext-skeleton-block" />
            <div className="ph-image-meta">
              <div className="ph-skeleton-line ph-ext-skeleton-text" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (tab === 'videos') {
    return (
      <div className="ph-video-grid animate-pulse" aria-label="Loading videos" role="status">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="ph-video-card">
            <div className="ph-video-thumb ph-ext-skeleton-block" />
            <div className="ph-video-body">
              <div className="ph-skeleton-line ph-ext-skeleton-text" />
              <div className="ph-skeleton-line ph-ext-skeleton-text short" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (tab === 'maps') {
    return (
      <div className="ph-ext-place-list animate-pulse" aria-label="Loading places" role="status">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="ph-ext-place ph-card">
            <div className="ph-ext-place-body">
              <div className="ph-skeleton-line title" />
              <div className="ph-skeleton-line short" />
              <div className="ph-skeleton-line snippet" />
            </div>
            <div className="ph-ext-place-thumb ph-ext-skeleton-block" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="ph-loading-skeleton animate-pulse" aria-label="Loading results" role="status">
      {[1, 2, 3].map(n => (
        <div key={n} className="ph-skeleton-card ph-card">
          <div className="ph-skeleton-line short" />
          <div className="ph-skeleton-line title" />
          <div className="ph-skeleton-line snippet" />
        </div>
      ))}
    </div>
  );
}
