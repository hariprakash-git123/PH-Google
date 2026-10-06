import React, { useState, useEffect } from 'react';
import { MapPin, ExternalLink, Navigation, Compass } from 'lucide-react';
import './MapResults.css';

/**
 * Map results.
 *
 * Places come from geographic data embedded in crawled pages (JSON-LD
 * Place/LocalBusiness, geo meta tags, or the `.geo` microformat). The map
 * itself is an OpenStreetMap embed, which needs no API key and sets no
 * tracking cookies.
 */
export default function MapResults({ results, query }) {
  const [selectedId, setSelectedId] = useState(null);

  // Select the top result whenever a new result set arrives.
  useEffect(() => {
    setSelectedId(results.length > 0 ? results[0].id : null);
  }, [results]);

  if (results.length === 0) {
    return (
      <div className="ph-empty-state ph-card animate-fade-in">
        <MapPin size={28} className="ph-empty-icon" />
        <h3>No places found for &quot;{query}&quot;</h3>
        <p>
          Places are extracted from coordinates published on crawled pages. Crawl pages about
          locations to grow this index.
        </p>
      </div>
    );
  }

  const selected = results.find(p => p.id === selectedId) || results[0];

  return (
    <div className="ph-map-layout animate-fade-in">
      <div className="ph-map-list">
        {results.map(place => (
          <button
            key={place.id}
            type="button"
            className={`ph-place-card ${place.id === selected.id ? 'active' : ''}`}
            onClick={() => setSelectedId(place.id)}
          >
            <div className="ph-place-pin">
              <MapPin size={16} />
            </div>
            <div className="ph-place-body">
              <h3 className="ph-place-name">{place.name}</h3>
              {place.address && <p className="ph-place-address">{place.address}</p>}
              <div className="ph-place-facts">
                <span className="ph-place-coords">
                  <Compass size={11} /> {place.latitude.toFixed(4)}, {place.longitude.toFixed(4)}
                </span>
                {place.category && <span className="ph-place-category">{place.category}</span>}
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="ph-map-panel">
        <div className="ph-map-frame">
          {/* key forces the iframe to reload when the selection changes */}
          <iframe
            key={selected.id}
            title={`Map of ${selected.name}`}
            src={selected.embedUrl}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        </div>

        <div className="ph-map-details">
          <h4>{selected.name}</h4>
          {selected.address && <p className="ph-map-address">{selected.address}</p>}

          <div className="ph-map-links">
            <a href={selected.mapUrl} target="_blank" rel="noopener noreferrer">
              <Navigation size={13} /> Open in OpenStreetMap
            </a>
            <a href={selected.sourcePage} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={13} /> Source: {selected.domain}
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
