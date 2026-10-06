const mongoose = require('mongoose');

const pageSchema = new mongoose.Schema(
  {
    websiteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Website',
      required: true
    },
    url: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    // Denormalised hostname so domain filtering is an indexed equality match
    // instead of a regex over the url. Backfilled for pre-existing pages by
    // scripts/backfillPageFields.js.
    domain: {
      type: String,
      default: '',
      lowercase: true,
      trim: true
    },
    title: {
      type: String,
      default: ''
    },
    content: {
      type: String, // Extracted visible text (older rows may hold raw HTML)
      default: ''
    },
    description: {
      type: String,
      default: ''
    },
    keywords: {
      type: String,
      default: ''
    },
    // ISO language code taken from <html lang="...">; '' when unknown.
    language: {
      type: String,
      default: '',
      lowercase: true,
      trim: true
    },
    // The address the page declares as its own (<link rel="canonical">),
    // when it declares one the crawl accepts. '' otherwise. A hint that is
    // recorded, not a replacement for `url`.
    canonicalUrl: {
      type: String,
      default: '',
      trim: true
    },
    status: {
      type: String,
      enum: ['discovered', 'crawled', 'indexed', 'error'],
      default: 'discovered'
    },
    lastCrawledAt: {
      type: Date,
      default: null
    },

    // --- News vertical -------------------------------------------------
    // Set when the crawled page carries article markup (og:type=article,
    // JSON-LD Article/NewsArticle, or a published date).
    isArticle: {
      type: Boolean,
      default: false
    },
    publishedAt: {
      type: Date,
      default: null
    },
    author: { type: String, default: '' },
    section: { type: String, default: '' },
    siteName: { type: String, default: '' },
    // The page's hero/social image, used as the news card thumbnail.
    imageUrl: { type: String, default: '' },

    // --- Vertical counts, for the admin dashboard ----------------------
    imageCount: { type: Number, default: 0 },
    videoCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

// Domain filter (Phase 7) and the admin "pages by domain" view.
pageSchema.index({ domain: 1 });
// 'newest' sort and the date filter.
pageSchema.index({ lastCrawledAt: -1 });
// Language filter, only useful combined with recency.
pageSchema.index({ language: 1, lastCrawledAt: -1 });
// Admin index-health counts.
pageSchema.index({ status: 1 });
pageSchema.index({ websiteId: 1 });
// News vertical: articles, newest first.
pageSchema.index({ isArticle: 1, publishedAt: -1 });

module.exports = mongoose.model('Page', pageSchema);
