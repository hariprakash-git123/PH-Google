const mongoose = require('mongoose');

/**
 * One row per executed search — the source of truth for all analytics.
 *
 * Deliberately stores no IP address, user agent or other identifying
 * metadata; only the query, the optional owning user, and performance data.
 */
const searchLogSchema = new mongoose.Schema(
  {
    query: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200
    },
    // Lowercased/trimmed form used for grouping in aggregations.
    normalizedQuery: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 200,
      index: true
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true
    },
    resultCount: { type: Number, default: 0 },
    responseTimeMs: { type: Number, default: 0 },
    page: { type: Number, default: 1 },

    filters: {
      domain: { type: String, default: '' },
      date: { type: String, default: 'any' },
      language: { type: String, default: '' },
      category: { type: String, default: 'all' },
      sort: { type: String, default: 'relevance' }
    }
  },
  { timestamps: true }
);

// Time-window queries ("today", "this week") and zero-result reporting.
searchLogSchema.index({ createdAt: -1 });
searchLogSchema.index({ resultCount: 1, createdAt: -1 });
searchLogSchema.index({ normalizedQuery: 1, createdAt: -1 });

module.exports = mongoose.model('SearchLog', searchLogSchema);
