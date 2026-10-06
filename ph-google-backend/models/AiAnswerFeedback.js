const mongoose = require('mongoose');

/**
 * One row per thumbs-up / thumbs-down on an AI answer.
 *
 * Like SearchLog, it stores no IP address or user agent: the query, the
 * rating, which model wrote the answer, and the signed-in user if there was
 * one. The answer text itself is not stored — it can be regenerated, and
 * keeping it would duplicate crawled content.
 */
const aiAnswerFeedbackSchema = new mongoose.Schema(
  {
    // The id the answer was served with, so repeat clicks update one row.
    answerId: { type: String, required: true, trim: true, maxlength: 64, index: true },
    query: { type: String, required: true, trim: true, maxlength: 200 },
    normalizedQuery: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 200,
      index: true
    },
    rating: { type: String, required: true, enum: ['up', 'down'] },
    comment: { type: String, default: '', trim: true, maxlength: 500 },
    provider: { type: String, default: '', trim: true, maxlength: 64 },
    model: { type: String, default: '', trim: true, maxlength: 128 },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true }
  },
  { timestamps: true }
);

// One opinion per answer per person; a guest's is keyed by the answer alone.
aiAnswerFeedbackSchema.index({ answerId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('AiAnswerFeedback', aiAnswerFeedbackSchema);
