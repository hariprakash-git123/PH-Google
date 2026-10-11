import React, { useState } from 'react';
import { Play, ExternalLink, VideoOff, X } from 'lucide-react';
import { safeEmbedUrl, safeHttpUrl } from '../../utils/safeUrl';
import './VideoResults.css';

/**
 * Video search results.
 *
 * Each card is a real video found on a crawled page — a YouTube/Vimeo embed
 * or a native <video> file. Third-party videos play in an inline privacy
 * embed (youtube-nocookie / Vimeo player); native files play with the
 * browser's own player.
 *
 * Addresses come from crawled pages, so every one is checked before use:
 * links and media only for plain http(s) (safeHttpUrl), and a player is
 * framed only from the two hosts the backend builds embeds for, over https,
 * in a sandbox that allows what a player needs and nothing else.
 */

/** The hosts whose players the backend embeds (verticalSearchService.embedUrlFor). */
const PLAYER_HOSTS = ['www.youtube-nocookie.com', 'player.vimeo.com'];

/**
 * A player runs its own scripts and storage (allow-scripts, allow-same-origin
 * on its own origin), goes full screen (allow-presentation), and opens
 * "Watch on YouTube" in a new tab (allow-popups, which escape the sandbox so
 * that page works normally). It cannot navigate this page.
 */
const PLAYER_SANDBOX =
  'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox';

export default function VideoResults({ results, query }) {
  const [playing, setPlaying] = useState(null);

  if (results.length === 0) {
    return (
      <div className="ph-empty-state ph-card animate-fade-in">
        <VideoOff size={28} className="ph-empty-icon" />
        <h3>No videos found for &quot;{query}&quot;</h3>
        <p>Try different or fewer keywords, or look on the All tab.</p>
      </div>
    );
  }

  const player = playing && safeEmbedUrl(playing.embedUrl, PLAYER_HOSTS);
  const file = playing && safeHttpUrl(playing.url);
  const page = playing && safeHttpUrl(playing.sourcePage);

  return (
    <>
      <div className="ph-video-grid animate-fade-in">
        {results.map(video => {
          const thumbnail = safeHttpUrl(video.thumbnailUrl);
          const sourcePage = safeHttpUrl(video.sourcePage);
          return (
            <article key={video.id} className="ph-video-card">
              <button
                type="button"
                className="ph-video-thumb"
                onClick={() => setPlaying(video)}
                aria-label={`Play ${video.title}`}
              >
                {thumbnail ? (
                  <img
                    src={thumbnail}
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
                {sourcePage && (
                  <a
                    className="ph-video-link"
                    href={sourcePage}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Found on {video.sourceTitle || video.source} <ExternalLink size={12} />
                  </a>
                )}
              </div>
            </article>
          );
        })}
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
            {player ? (
              <iframe
                src={player}
                title={playing.title}
                sandbox={PLAYER_SANDBOX}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                referrerPolicy="no-referrer"
              />
            ) : file && !playing.embedUrl ? (
              // A native video file plays directly.
              <video
                src={file}
                controls
                autoPlay
                poster={safeHttpUrl(playing.thumbnailUrl) || undefined}
              >
                <track kind="captions" />
              </video>
            ) : (
              <p className="ph-video-unplayable" role="status">
                This video cannot be played here. Open it on its own page instead.
              </p>
            )}

            <div className="ph-video-player-info">
              <h4>{playing.title}</h4>
              <div className="ph-video-player-links">
                {file && (
                  <a href={file} target="_blank" rel="noopener noreferrer">
                    Open video <ExternalLink size={13} />
                  </a>
                )}
                {page && (
                  <a href={page} target="_blank" rel="noopener noreferrer">
                    Visit page <ExternalLink size={13} />
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
