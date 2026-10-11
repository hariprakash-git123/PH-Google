import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
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
import ImageLightbox, { SiteIcon, siteOf } from './ImageLightbox';
import PlacesMap from './PlacesMap';
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
 * opens a preview beside the grid first (ImageLightbox). Nothing is embedded.
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

/**
 * The tab's search service is switched off and the crawler's own index has
 * nothing for it either. Not "no results": the search this tab normally runs
 * was never made, and the page says so rather than suggesting other keywords.
 *
 * @param {{kind: 'Image'|'Video'|'Map'}} props
 */
export function VerticalServiceOff({ kind }) {
  return (
    <div className="ph-empty-state ph-card animate-fade-in" role="status">
      <CloudOff size={28} className="ph-empty-icon" aria-hidden="true" />
      <h3>{kind} search is temporarily unavailable.</h3>
      <p>
        This search service is switched off right now, so there is nothing to show here. Your search
        still works on the All tab.
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

/** Narrowest a grid column may be, and the space between columns, in pixels. */
const MIN_COLUMN = 190;
const GAP = 14;
/** The grid's row unit: a tile spans as many of these as its height needs. */
const ROW = 4;
/** The caption under each image: the site line and up to two title lines. */
const CAPTION = 62;
/** Very tall or very wide images are cropped to these width/height ratios. */
const MIN_RATIO = 0.5;
const MAX_RATIO = 2.2;
const DEFAULT_RATIO = 4 / 3;

/** An image's width/height ratio, from the result or as loaded; cropped to a sensible range. */
function ratioOf(image, measured) {
  const known =
    image.width > 0 && image.height > 0 ? image.width / image.height : measured.get(image.id);
  const ratio = known > 0 ? known : DEFAULT_RATIO;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

/** How many columns fit the grid's width, kept up to date as it changes. */
function useColumns(ref, shown) {
  const [layout, setLayout] = useState({ columns: 2, width: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const width = element.clientWidth;
      const columns = Math.max(2, Math.floor((width + GAP) / (MIN_COLUMN + GAP)));
      setLayout(prev =>
        prev.columns === columns && prev.width === width ? prev : { columns, width }
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, shown]);
  return layout;
}

/**
 * Where each tile goes: in order, into the shortest column so far. Tiles
 * stay in result order in the page (and for the keyboard); only their place
 * on screen is chosen. Appending images never moves the ones already placed.
 */
function placeTiles(images, { columns, width }, measured) {
  const columnWidth = width > 0 ? (width - GAP * (columns - 1)) / columns : MIN_COLUMN;
  const heights = new Array(columns).fill(0);
  return images.map(image => {
    const ratio = ratioOf(image, measured);
    const rows = Math.ceil((columnWidth / ratio + CAPTION + GAP) / ROW);
    const column = heights.indexOf(Math.min(...heights));
    const row = heights[column];
    heights[column] += rows;
    return { image, ratio, column, row, rows };
  });
}

export function ExternalImageResults({ results, unavailable }) {
  const [broken, markBroken] = useBroken();
  // The open preview is remembered by id, so it survives a tile dropping out
  // of the grid when its thumbnail fails.
  const [openId, setOpenId] = useState(null);
  // Width/height ratios of images whose result did not give their size.
  const [measured, setMeasured] = useState(() => new Map());
  const gridRef = useRef(null);
  const visible = results.filter(image => !broken.has(image.id) && safeHttpUrl(image.thumbnailUrl));
  const layout = useColumns(gridRef, visible.length > 0);
  const openIndex = visible.findIndex(image => image.id === openId);
  const open = openIndex >= 0;

  const closePreview = useCallback(() => {
    // Hand focus back to the tile the preview was opened from.
    const tile = [...document.querySelectorAll('[data-image-id]')].find(
      element => element.dataset.imageId === String(openId)
    );
    setOpenId(null);
    if (tile) tile.focus();
  }, [openId]);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const navigatePreview = useCallback(next => {
    setOpenId(current => {
      const image = visibleRef.current[next];
      return image ? image.id : current;
    });
  }, []);

  const noteSize = (image, element) => {
    if (image.width > 0 && image.height > 0) return;
    if (!element.naturalWidth || !element.naturalHeight) return;
    const ratio = element.naturalWidth / element.naturalHeight;
    setMeasured(prev => (prev.get(image.id) === ratio ? prev : new Map(prev).set(image.id, ratio)));
  };

  if (visible.length === 0) {
    return (
      <VerticalEmpty
        icon={ImageOff}
        unavailable={unavailable}
        emptyText="No images found for this search."
      />
    );
  }

  const tiles = placeTiles(visible, layout, measured);

  return (
    <div className={`ph-img-view animate-fade-in${open ? ' has-preview' : ''}`}>
      <div
        ref={gridRef}
        className="ph-masonry"
        style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))` }}
        data-columns={layout.columns}
      >
        {tiles.map(({ image, ratio, column, row, rows }) => {
          const site = siteOf(image);
          const label = image.title || (site ? `Image from ${site}` : 'Image result');
          const selected = image.id === openId;
          return (
            // A button, not a link: clicking opens the preview and stays on
            // the page. The preview holds the links to the site and the image.
            <button
              key={image.id}
              type="button"
              className={`ph-masonry-tile${selected ? ' is-selected' : ''}`}
              style={{ gridColumn: column + 1, gridRow: `${row + 1} / span ${rows}` }}
              data-image-id={image.id}
              onClick={() => setOpenId(image.id)}
              aria-haspopup="dialog"
              aria-pressed={selected}
              aria-label={site && image.title ? `${image.title}, from ${site}` : label}
              title={label}
            >
              <span className="ph-masonry-thumb" style={{ aspectRatio: String(ratio) }}>
                <img
                  src={safeHttpUrl(image.thumbnailUrl)}
                  alt={label}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onLoad={event => noteSize(image, event.currentTarget)}
                  onError={() => markBroken(image.id)}
                />
              </span>
              <span className="ph-masonry-caption">
                <span className="ph-masonry-site">
                  <SiteIcon url={image.sourceUrl || image.imageUrl} />
                  <span className="ph-image-source">{site}</span>
                </span>
                {image.title && <span className="ph-image-title">{image.title}</span>}
              </span>
            </button>
          );
        })}
      </div>

      {open && (
        <ImageLightbox
          images={visible}
          index={openIndex}
          onNavigate={navigatePreview}
          onClose={closePreview}
        />
      )}
    </div>
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
    <>
      {/* A small map of the places below, drawn from the coordinates they
          already carry. Absent when none of them has a location. */}
      <PlacesMap places={results} />
      <ol className="ph-ext-place-list animate-fade-in">
        {results.map(place => {
          const mapsUrl = safeHttpUrl(place.mapsUrl);
          const website = safeHttpUrl(place.website);
          // The page these details were read from, when the result says.
          const sourceUrl = safeHttpUrl(place.sourceUrl);
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
                {/* Why a place has no pin: its page gave a position that could
                    not be checked against anything independent, or gave none. */}
                {!hasCoords && place.locationStatus === 'unverified' && (
                  <p className="ph-ext-place-line ph-ext-place-coords">
                    <Compass size={13} aria-hidden="true" /> Location could not be verified, so it
                    is not shown on the map
                  </p>
                )}
                {!hasCoords && place.locationStatus !== 'unverified' && sourceUrl && (
                  <p className="ph-ext-place-line ph-ext-place-coords">
                    <Compass size={13} aria-hidden="true" /> No map location published for this
                    place
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
                  {sourceUrl && (
                    <a
                      className="ph-ext-place-btn"
                      href={sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="The page these details come from"
                    >
                      Source{place.sourceDomain ? `: ${place.sourceDomain}` : ''}
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
    </>
  );
}

// ---------------------------------------------------------------------------
// Loading skeletons, one per layout
// ---------------------------------------------------------------------------

export function VerticalSkeleton({ tab }) {
  if (tab === 'images') {
    // Varied heights, like the masonry grid it stands in for.
    const heights = [180, 240, 150, 210, 260, 170, 230, 160, 200, 250, 175, 220];
    return (
      <div className="ph-masonry-skeleton animate-pulse" aria-label="Loading images" role="status">
        {heights.map((height, i) => (
          <div key={i} className="ph-masonry-skeleton-tile">
            <div className="ph-ext-skeleton-block" style={{ height }} />
            <div className="ph-skeleton-line ph-ext-skeleton-text" />
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
