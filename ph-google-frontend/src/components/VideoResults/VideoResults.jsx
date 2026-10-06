import React, { useState } from 'react';
import { Play, ExternalLink, VideoOff, X } from 'lucide-react';
import './VideoResults.css';

/**
 * Video search results.
 *
 * Each card is a real video found on a crawled page — a YouTube/Vimeo embed
 * or a native <video> file. Third-party videos play in an inline privacy
 * embed (youtube-nocookie / Vimeo player); native files play with the
 * browser's own player.
 */
export default function VideoResults({ results, query }) {
  const [playing, setPlaying] = useState(null);

  if (results.length === 0) {
    return (
      <div className="ph-empty-state ph-card animate-fade-in">
        <VideoOff size={28} className="ph-empty-icon" />
        <h3>No videos found for &quot;{query}&quot;</h3>
        <p>
          Videos are indexed from embeds and video tags on crawled pages. Crawl a site that hosts or
          embeds video to grow this index.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="ph-video-grid animate-fade-in">
        {results.map(video => (
          <article key={video.id} className="ph-video-card">
            <button
              type="button"
              className="ph-video-thumb"
              onClick={() => setPlaying(video)}
              aria-label={`Play ${video.title}`}
            >
              {video.thumbnailUrl ? (
                <img
                  src={video.thumbnailUrl}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={e => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              ) : (
                <div className="ph-video-thumb-fallback">
                  <Play size={26} />
                </div>
              )}

              <span className="ph-video-play">
                <Play size={18} fill="currentColor" />
              </span>
              {video.duration && <span className="ph-video-duration">{video.duration}</span>}
            </button>

            <div className="ph-video-body">
              <h3 className="ph-video-title" title={video.title}>
                {video.title}
              </h3>
              <div className="ph-video-meta">
                {video.provider && video.provider !== 'native' && (
                  <span className="ph-video-provider">{video.provider}</span>
                )}
                <span className="ph-video-source">{video.source}</span>
              </div>
              <a
                className="ph-video-link"
                href={video.sourcePage}
                target="_blank"
                rel="noopener noreferrer"
              >
                Found on {video.sourceTitle || video.source} <ExternalLink size={12} />
              </a>
            </div>
          </article>
        ))}
      </div>

      {playing && (
        <div
          className="ph-lightbox"
          onClick={() => setPlaying(null)}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            className="ph-lightbox-close"
            onClick={() => setPlaying(null)}
            aria-label="Close player"
          >
            <X size={22} />
          </button>

          <div className="ph-video-player" onClick={e => e.stopPropagation()}>
            {playing.embedUrl ? (
              <iframe
                src={playing.embedUrl}
                title={playing.title}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                referrerPolicy="no-referrer"
              />
            ) : (
              // A native video file plays directly.
              <video src={playing.url} controls autoPlay poster={playing.thumbnailUrl || undefined}>
                <track kind="captions" />
              </video>
            )}

            <div className="ph-video-player-info">
              <h4>{playing.title}</h4>
              <div className="ph-video-player-links">
                <a href={playing.url} target="_blank" rel="noopener noreferrer">
                  Open video <ExternalLink size={13} />
                </a>
                <a href={playing.sourcePage} target="_blank" rel="noopener noreferrer">
                  Visit page <ExternalLink size={13} />
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
