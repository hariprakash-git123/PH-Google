const mongoose = require('mongoose');

/**
 * A user's own search history.
 *
 * `userId` was added in Phase 9 — rows created before that are left in place
 * with userId = null and are treated as legacy/anonymous entries that no
 * signed-in user can read.
 */
const historySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true
    },
    query: {
      type: String,
      required: true,
      trim: true
    },
    // Human-readable label kept for backwards compatibility with the existing
    // frontend; `createdAt` is the authoritative timestamp.
    timestamp: {
      type: String,
      default: 'Just now'
    },
    category: {
      type: String,
      default: 'Recent'
    },
    device: {
      type: String,
      default: 'Desktop · Web'
    }
  },
  { timestamps: true }
);

// Per-user newest-first listing.
historySchema.index({ userId: 1, createdAt: -1 });
// De-duplicating a repeated query for one user.
historySchema.index({ userId: 1, query: 1 });

module.exports = mongoose.model('History', historySchema);
