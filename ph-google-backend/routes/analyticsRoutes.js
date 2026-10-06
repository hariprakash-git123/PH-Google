const express = require('express');
const analyticsController = require('../controllers/analyticsController');
const { protect, adminOnly } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// A user's own activity — not admin-gated, but scoped to the caller.
router.get('/me', analyticsController.getMyAnalytics);

// Platform-wide analytics are admin-only.
router.get('/overview', adminOnly, analyticsController.getOverview);
router.get('/searches', adminOnly, analyticsController.listSearches);
router.get('/top-queries', adminOnly, analyticsController.getTopQueries);
router.get('/zero-result-queries', adminOnly, analyticsController.getZeroResultQueries);

module.exports = router;
