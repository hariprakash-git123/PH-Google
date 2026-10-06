const mongoose = require('mongoose');

const searchResultSchema = new mongoose.Schema({
  queryTopic: [String],
  domain: String,
  favicon: String,
  publishedAgo: String,
  title: String,
  url: String,
  snippet: String,
  category: String,
  saved: { type: Boolean, default: false },
  latency: String,
  metrics: {
    rating: Number,
    reviews: Number
  }
});

module.exports = mongoose.model('SearchResult', searchResultSchema);
