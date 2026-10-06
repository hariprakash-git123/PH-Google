const mongoose = require('mongoose');

const websiteSchema = new mongoose.Schema(
  {
    domain: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true
    },
    status: {
      type: String,
      enum: ['pending', 'crawling', 'completed', 'error'],
      default: 'pending'
    },
    lastCrawledAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Website', websiteSchema);
