const mongoose = require('mongoose');

const termSchema = new mongoose.Schema(
  {
    word: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true // Extremely important for fast lookups
    },
    documents: [
      {
        pageId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Page',
          required: true
        },
        frequency: {
          type: Number,
          default: 1
        }
      }
    ]
  },
  { timestamps: true }
);

// Create an index on documents.pageId so we can quickly find/update a specific page's frequency
termSchema.index({ 'documents.pageId': 1 });

module.exports = mongoose.model('Term', termSchema);
