import React from 'react';
import { Newspaper, ExternalLink, Clock, User } from 'lucide-react';
import './NewsResults.css';

/**
 * News results.
 *
 * These are crawled pages that carry article markup (og:type=article or
 * JSON-LD NewsArticle/BlogPosting), ordered newest first. Reference pages
 * such as encyclopedia entries are deliberately excluded upstream, so this
 * vertical stays news rather than "any page with a date".
 */
export default function NewsResults({ results, query }) {
  if (results.length === 0) {
    return (
      <div className="ph-empty-state ph-card animate-fade-in">
        <Newspaper size={28} className="ph-empty-icon" />
        <h3>No news found for &quot;{query}&quot;</h3>
        <p>
          News is built from crawled pages that publishers mark as articles. Crawl a news site or
          blog from the admin console to grow this index.
        </p>
      </div>
    );
  }

  return (
    <div className="ph-news-list animate-fade-in">
      {results.map(article => (
        <article key={article.id} className="ph-news-card">
          {article.imageUrl && (
            <a
              className="ph-news-image"
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              tabIndex={-1}
              aria-hidden="true"
            >
              <img
                src={article.imageUrl}
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
              <a href={article.url} target="_blank" rel="noopener noreferrer">
                {article.title}
              </a>
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
              <a
                className="ph-news-fact ph-news-visit"
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Read <ExternalLink size={12} />
              </a>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
