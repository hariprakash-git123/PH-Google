const mongoose = require('mongoose');

/**
 * An image or video discovered on a crawled page.
 *
 * `terms` is the searchable token list (alt text, caption, filename words and
 * the host page's title). A multikey index on that array *is* an inverted
 * index — the same retrieval model the web vertical uses, expressed with the
 * database's own indexing rather than a separate Term collection, because a
 * media item's searchable text is short and fixed.
 */
const mediaSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['image', 'video'],
      required: true,
      index: true
    },
    // The media file / watch URL. Unique so the same asset on many pages is
    // stored once.
    url: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },

    // The page it was found on.
    pageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Page',
      required: true
    },
    pageUrl: { type: String, required: true, trim: true },
    pageTitle: { type: String, default: '' },
    domain: { type: String, default: '', lowercase: true, trim: true },

    title: { type: String, default: '' },
    alt: { type: String, default: '' },
    caption: { type: String, default: '' },

    // Tokens used for retrieval (multikey-indexed).
    terms: { type: [String], default: [] },

    // Images
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    format: { type: String, default: '' },

    // Videos
    provider: { type: String, default: '' }, // youtube | vimeo | dailymotion | native
    providerId: { type: String, default: '' },
    thumbnailUrl: { type: String, default: '' },
    durationSeconds: { type: Number, default: null },

    language: { type: String, default: '', lowercase: true, trim: true },
    lastCrawledAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

// The retrieval index: a query token list is matched against this array.
mediaSchema.index({ terms: 1, type: 1 });
// Vertical listings and "newest first".
mediaSchema.index({ type: 1, lastCrawledAt: -1 });
// Domain filtering, and removing a page's media when it is re-crawled.
mediaSchema.index({ domain: 1 });
mediaSchema.index({ pageId: 1 });

module.exports = mongoose.model('Media', mediaSchema);
