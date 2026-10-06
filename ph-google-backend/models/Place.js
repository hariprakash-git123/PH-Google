const mongoose = require('mongoose');

/**
 * A geographic place found on a crawled page — from JSON-LD Place /
 * LocalBusiness data, geo meta tags, or the `.geo` microformat.
 *
 * Coordinates are stored twice: as plain numbers for display, and as a
 * GeoJSON point so MongoDB's 2dsphere index can answer "near me" queries.
 */
const placeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 },

    // GeoJSON [longitude, latitude] — note the order.
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }
    },

    address: { type: String, default: '' },
    category: { type: String, default: '' },

    // Where it came from.
    pageId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Page',
      required: true
    },
    pageUrl: { type: String, required: true, trim: true },
    pageTitle: { type: String, default: '' },
    domain: { type: String, default: '', lowercase: true, trim: true },

    // Retrieval tokens (name + address + page title), multikey-indexed.
    terms: { type: [String], default: [] },

    lastCrawledAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

// The same place can be described by several pages; one row per page.
placeSchema.index({ pageId: 1, latitude: 1, longitude: 1 }, { unique: true });
placeSchema.index({ terms: 1 });
placeSchema.index({ location: '2dsphere' });
placeSchema.index({ domain: 1 });

/** Keeps the GeoJSON point in step with the plain coordinates. */
placeSchema.pre('validate', function syncLocation() {
  if (Number.isFinite(this.latitude) && Number.isFinite(this.longitude)) {
    this.location = { type: 'Point', coordinates: [this.longitude, this.latitude] };
  }
});

module.exports = mongoose.model('Place', placeSchema);
