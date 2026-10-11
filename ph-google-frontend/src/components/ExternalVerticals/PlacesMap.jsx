import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Plus, Minus, X, Navigation, MapPin } from 'lucide-react';
import { safeHttpUrl } from '../../utils/safeUrl';

/**
 * The small map above the place results.
 *
 * Drawn from the coordinates the Maps results already carry — it makes no
 * request of its own to the search API. There is no map library and no API
 * key: the picture is OpenStreetMap's standard tiles laid out with the usual
 * Web Mercator arithmetic, with a numbered marker per place on top. The
 * numbers follow the order of the cards below.
 *
 * A place without usable coordinates gets no marker; with no usable
 * coordinates at all, the map is not shown.
 */

const TILE = 256;
const TILE_URL = 'https://tile.openstreetmap.org';
const MIN_ZOOM = 3;
const MAX_ZOOM = 18;
/** How close the map goes by itself: one place, or several on one street. */
const MAX_FIT_ZOOM = 16;
/** Web Mercator stops short of the poles. */
const MAX_LATITUDE = 85.0511;
const DEFAULT_WIDTH = 640;
const PADDING = 44;

/** Whether a result has coordinates a marker can be drawn at. */
export function hasValidCoordinates(place) {
  if (!place) return false;
  const { latitude, longitude } = place;
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= MAX_LATITUDE &&
    Math.abs(longitude) <= 180 &&
    // 0,0 is a missing value far more often than a place in the Gulf of Guinea.
    !(latitude === 0 && longitude === 0)
  );
}

/** Latitude/longitude → pixel position on the whole world at a zoom level. */
export function project(latitude, longitude, zoom) {
  const size = TILE * 2 ** zoom;
  const sin = Math.sin((latitude * Math.PI) / 180);
  return {
    x: ((longitude + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size
  };
}

/**
 * The view that shows every point: the closest zoom at which they all fit
 * inside the padded box, centred on the middle of them. One point is simply
 * centred.
 *
 * @returns {{zoom: number, center: {x: number, y: number}}} centre in world
 *          pixels at zoom 0 (so it survives zooming)
 */
export function fitView(points, width, height) {
  const at = zoom => points.map(p => project(p.latitude, p.longitude, zoom));
  const box = pixels => ({
    minX: Math.min(...pixels.map(p => p.x)),
    maxX: Math.max(...pixels.map(p => p.x)),
    minY: Math.min(...pixels.map(p => p.y)),
    maxY: Math.max(...pixels.map(p => p.y))
  });

  let zoom = MAX_FIT_ZOOM;
  const roomX = Math.max(1, width - PADDING * 2);
  const roomY = Math.max(1, height - PADDING * 2);
  for (; zoom > MIN_ZOOM; zoom -= 1) {
    const b = box(at(zoom));
    if (b.maxX - b.minX <= roomX && b.maxY - b.minY <= roomY) break;
  }

  const base = box(at(0));
  return {
    zoom,
    center: { x: (base.minX + base.maxX) / 2, y: (base.minY + base.maxY) / 2 }
  };
}

/** The tiles that cover the viewport, with where each one goes. */
function tilesFor(view, zoom, width, height) {
  const scale = 2 ** zoom;
  const left = view.center.x * scale - width / 2;
  const top = view.center.y * scale - height / 2;
  const tiles = [];
  for (let ty = Math.floor(top / TILE); ty * TILE < top + height; ty += 1) {
    if (ty < 0 || ty >= scale) continue;
    for (let tx = Math.floor(left / TILE); tx * TILE < left + width; tx += 1) {
      const wrapped = ((tx % scale) + scale) % scale;
      tiles.push({
        key: `${zoom}/${tx}/${ty}`,
        src: `${TILE_URL}/${zoom}/${wrapped}/${ty}.png`,
        left: Math.round(tx * TILE - left),
        top: Math.round(ty * TILE - top)
      });
    }
  }
  return tiles;
}

/**
 * @param {Object} props
 * @param {Array} props.places  the Maps results on the page, in card order
 */
export default function PlacesMap({ places }) {
  const frameRef = useRef(null);
  const [size, setSize] = useState({ width: DEFAULT_WIDTH, height: 260 });
  const [zoomDelta, setZoomDelta] = useState(0);
  const [selectedId, setSelectedId] = useState(null);

  // Numbered by position in the list, so marker 3 is the third card.
  const points = useMemo(
    () =>
      places
        .map((place, index) => ({ place, number: index + 1 }))
        .filter(entry => hasValidCoordinates(entry.place))
        .map(entry => ({
          ...entry,
          latitude: entry.place.latitude,
          longitude: entry.place.longitude
        })),
    [places]
  );

  // The map is as wide as its column; measure it rather than assume.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    const measure = () => {
      const { clientWidth, clientHeight } = frame;
      if (clientWidth > 0 && clientHeight > 0) {
        setSize(prev =>
          prev.width === clientWidth && prev.height === clientHeight
            ? prev
            : { width: clientWidth, height: clientHeight }
        );
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [points.length]);

  const view = useMemo(
    () => (points.length > 0 ? fitView(points, size.width, size.height) : null),
    [points, size.width, size.height]
  );

  if (!view) return null;

  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom + zoomDelta));
  const scale = 2 ** zoom;
  const originX = view.center.x * scale - size.width / 2;
  const originY = view.center.y * scale - size.height / 2;
  const tiles = tilesFor(view, zoom, size.width, size.height);
  const selected = points.find(point => point.place.id === selectedId) || null;
  const missing = places.length - points.length;

  return (
    <section className="ph-ext-map" aria-label="Map of the places found">
      <div className="ph-ext-map-frame" ref={frameRef}>
        <div className="ph-ext-map-tiles" aria-hidden="true">
          {tiles.map(tile => (
            <img
              key={tile.key}
              src={tile.src}
              alt=""
              width={TILE}
              height={TILE}
              draggable="false"
              style={{ left: tile.left, top: tile.top }}
              onError={event => {
                event.currentTarget.style.visibility = 'hidden';
              }}
            />
          ))}
        </div>

        {points.map(point => {
          const pixel = project(point.latitude, point.longitude, zoom);
          const left = pixel.x - originX;
          const top = pixel.y - originY;
          // After zooming in, a place can be outside the picture.
          if (left < 0 || top < 0 || left > size.width || top > size.height) return null;
          const isSelected = selected && selected.place.id === point.place.id;
          return (
            <button
              key={point.place.id}
              type="button"
              className={`ph-ext-map-marker ${isSelected ? 'is-selected' : ''}`}
              style={{ left, top }}
              onClick={() => setSelectedId(isSelected ? null : point.place.id)}
              aria-label={`${point.number}. ${point.place.title}`}
              aria-pressed={Boolean(isSelected)}
              title={point.place.title}
            >
              {point.number}
            </button>
          );
        })}

        <div className="ph-ext-map-zoom">
          <button
            type="button"
            onClick={() => setZoomDelta(delta => delta + 1)}
            disabled={zoom >= MAX_ZOOM}
            aria-label="Zoom in"
          >
            <Plus size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setZoomDelta(delta => delta - 1)}
            disabled={zoom <= MIN_ZOOM}
            aria-label="Zoom out"
          >
            <Minus size={16} aria-hidden="true" />
          </button>
        </div>

        {selected && (
          <div className="ph-ext-map-popup" role="group" aria-label={selected.place.title}>
            <button
              type="button"
              className="ph-ext-map-popup-close"
              onClick={() => setSelectedId(null)}
              aria-label="Close place details"
            >
              <X size={14} aria-hidden="true" />
            </button>
            <strong className="ph-ext-map-popup-title">
              {selected.number}. {selected.place.title}
            </strong>
            {(Number.isFinite(selected.place.rating) || selected.place.category) && (
              <span className="ph-ext-map-popup-line">
                {Number.isFinite(selected.place.rating) && (
                  <>
                    <span className="ph-ext-stars" aria-hidden="true">
                      ★
                    </span>{' '}
                    <span aria-label={`Rated ${selected.place.rating} out of 5`}>
                      {selected.place.rating.toFixed(1)}
                    </span>
                  </>
                )}
                {Number.isFinite(selected.place.rating) && selected.place.category && ' · '}
                {selected.place.category}
              </span>
            )}
            {selected.place.address && (
              <span className="ph-ext-map-popup-line">{selected.place.address}</span>
            )}
            {safeHttpUrl(selected.place.mapsUrl) && (
              <a
                className="ph-ext-map-popup-link"
                href={safeHttpUrl(selected.place.mapsUrl)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Navigation size={12} aria-hidden="true" /> View on Maps
              </a>
            )}
            {safeHttpUrl(selected.place.sourceUrl) && (
              <a
                className="ph-ext-map-popup-link"
                href={safeHttpUrl(selected.place.sourceUrl)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Source{selected.place.sourceDomain ? `: ${selected.place.sourceDomain}` : ''}
              </a>
            )}
          </div>
        )}

        <a
          className="ph-ext-map-credit"
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
        >
          © OpenStreetMap contributors
        </a>
      </div>

      <p className="ph-ext-map-caption">
        <MapPin size={13} aria-hidden="true" />
        {points.length === 1 ? '1 place on the map' : `${points.length} places on the map`}
        {missing > 0 && ` · ${missing} without a location`}
      </p>
    </section>
  );
}
