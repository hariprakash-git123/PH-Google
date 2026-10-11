const express = require('express');
const trendingController = require('../controllers/trendingController');
const { searchLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// The homepage's "Trending now" card. Public, like search.
router.get('/', searchLimiter, trendingController.trending);

module.exports = router;
