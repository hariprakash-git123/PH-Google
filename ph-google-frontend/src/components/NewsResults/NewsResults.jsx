import React from 'react';
import { Newspaper, ExternalLink, Clock, User } from 'lucide-react';
import { safeHttpUrl } from '../../utils/safeUrl';
import './NewsResults.css';

/**
 * News results.
 *
 * These are crawled pages that carry article markup (og:type=article or
 * JSON-LD NewsArticle/BlogPosting), ordered newest first. Reference pages
 * such as encyclopedia entries are deliberately excluded upstream, so this
 * vertical stays news rather than "any page with a date".
 *
 * Addresses come from crawled pages, so each one is checked with safeHttpUrl
 * before it becomes a link or an image: anything that is not plain http(s)
 * is not linked (the title is still shown) and no image is loaded.
 */
export default function NewsResults({ results, query }) {
  if (results.length === 0) {
    return (
      <div className="ph-empty-state ph-card animate-fade-in">
        <Newspaper size={28} className="ph-empty-icon" />
        <h3>No news found for &quot;{query}&quot;</h3>
        <p>Try different or fewer keywords, or look on the All tab.</p>
      </div>
    );
  }

  return (
    <div className="ph-news-list animate-fade-in">
      {results.map(article => {
        const href = safeHttpUrl(article.url);
        const image = safeHttpUrl(article.imageUrl);
        return (
          <article key={article.id} className="ph-news-card">
            {href && image && (
              <a
                className="ph-news-image"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                tabIndex={-1}
                aria-hidden="true"
              >
                <img
                  src={image}
                  alt=""
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={e => {
                    e.currentTarget.closest('.ph-news-image').style.display = 'none';
                  }}
                />
              </a>
            )}

            <div className="ph-news-body">
              <div className="ph-news-source-row">
                <span className="ph-news-source">{article.source}</span>
                {article.section && <span className="ph-news-section">{article.section}</span>}
              </div>

              <h3 className="ph-news-title">
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {article.title}
                  </a>
                ) : (
                  article.title
                )}
              </h3>

              {article.snippet && <p className="ph-news-snippet">{article.snippet}</p>}

              <div className="ph-news-footer">
                {article.time && (
                  <span className="ph-news-fact">
                    <Clock size={12} /> {article.time}
                  </span>
                )}
                {article.author && (
                  <span className="ph-news-fact">
                    <User size={12} /> {article.author}
                  </span>
                )}
                {href && (
                  <a
                    className="ph-news-fact ph-news-visit"
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Read <ExternalLink size={12} />
                  </a>
                )}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
