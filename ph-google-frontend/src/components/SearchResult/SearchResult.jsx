import React, { useState } from 'react';
import { Share2, Check, ExternalLink } from 'lucide-react';
import { safeHttpUrl } from '../../utils/safeUrl';
import { faviconUrlFor } from '../../utils/favicon';
import './SearchResult.css';

/** The generic icon, shown when a site's own icon cannot be. */
const GENERIC_ICON = '🌐';

export default function SearchResult({ result }) {
  const [copied, setCopied] = useState(false);
  // The icon address that failed to load, if any. Remembering which one
  // means a failure switches to the generic icon exactly once, and a result
  // shown later for another site still gets its own try.
  const [failedIcon, setFailedIcon] = useState(null);
  // Results can come from an external provider, so only http(s) is linked.
  const href = safeHttpUrl(result.url);
  const iconUrl = faviconUrlFor(result.url);
  const showSiteIcon = Boolean(iconUrl) && failedIcon !== iconUrl;
  // The backend's `favicon` field is a text icon (an emoji); it is the
  // fallback. Anything that looks like an address is not text, so not used.
  const fallbackIcon =
    typeof result.favicon === 'string' && result.favicon.trim() && !/[:/.]/.test(result.favicon)
      ? result.favicon
      : GENERIC_ICON;

  const handleShare = e => {
    e.preventDefault();
    navigator.clipboard.writeText(result.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <article className="ph-search-result-card animate-fade-in">
      {/* Meta Top Header: Favicon + Domain + Date */}
      <div className="ph-result-meta-header">
        <span className="ph-result-favicon" role="img" aria-label="site icon">
          {showSiteIcon ? (
            <img
              src={iconUrl}
              alt=""
              width={16}
              height={16}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              draggable="false"
              onError={() => setFailedIcon(iconUrl)}
            />
          ) : (
            fallbackIcon
          )}
        </span>
        <div className="ph-result-domain-wrap">
          <span className="ph-result-domain">{result.domain}</span>
          <span className="ph-result-dot">•</span>
          <span className="ph-result-date">{result.publishedAgo || 'Recently updated'}</span>
        </div>
        {result.category && <span className="ph-result-category-badge">{result.category}</span>}
      </div>

      {/* Main Title Link — inside PH Spectrum, a plain click opens it in the
          current PH tab (data-ph-result, see BrowserShell); Ctrl/Cmd- and
          middle-click still open a new browser tab. */}
      <h3 className="ph-result-title">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" data-ph-result="">
            {result.title}
          </a>
        ) : (
          result.title
        )}
      </h3>

      {/* URL Display — one line; the whole address on hover */}
      <div className="ph-result-url" title={result.url}>
        <span className="ph-result-url-text">{result.url}</span>
        <ExternalLink size={12} className="ph-result-ext-icon" />
      </div>

      {/* Snippet Paragraph */}
      <p className="ph-result-snippet">{result.snippet}</p>

      {/* Action Bar: Share. (A Save button was here; nothing stored what it
          saved, so it is gone until saving exists.) */}
      <div className="ph-result-actions">
        <button
          type="button"
          className="ph-result-action-btn"
          onClick={handleShare}
          aria-label="Share URL"
        >
          {copied ? <Check size={14} className="ph-text-success" /> : <Share2 size={14} />}
          <span>{copied ? 'Link copied!' : 'Share'}</span>
        </button>
      </div>
    </article>
  );
}
