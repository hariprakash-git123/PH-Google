import React, { useState } from 'react';
import { Bookmark, Share2, Check, ExternalLink } from 'lucide-react';
import { safeHttpUrl } from '../../utils/safeUrl';
import './SearchResult.css';

export default function SearchResult({ result }) {
  const [saved, setSaved] = useState(result.saved || false);
  const [copied, setCopied] = useState(false);
  // Results can come from an external provider, so only http(s) is linked.
  const href = safeHttpUrl(result.url);

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
          {result.favicon || '🌐'}
        </span>
        <div className="ph-result-domain-wrap">
          <span className="ph-result-domain">{result.domain}</span>
          <span className="ph-result-dot">•</span>
          <span className="ph-result-date">{result.publishedAgo || 'Recently updated'}</span>
        </div>
        {result.category && <span className="ph-result-category-badge">{result.category}</span>}
      </div>

      {/* Main Title Link */}
      <h3 className="ph-result-title">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {result.title}
          </a>
        ) : (
          result.title
        )}
      </h3>

      {/* URL Display */}
      <div className="ph-result-url">
        <span>{result.url}</span>
        <ExternalLink size={12} className="ph-result-ext-icon" />
      </div>

      {/* Snippet Paragraph */}
      <p className="ph-result-snippet">{result.snippet}</p>

      {/* Action Bar: Save & Share */}
      <div className="ph-result-actions">
        <button
          type="button"
          className={`ph-result-action-btn ${saved ? 'saved' : ''}`}
          onClick={() => setSaved(!saved)}
          aria-label={saved ? 'Saved result' : 'Save result'}
        >
          <Bookmark size={14} fill={saved ? 'currentColor' : 'none'} />
          <span>{saved ? 'Saved' : 'Save'}</span>
        </button>

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
