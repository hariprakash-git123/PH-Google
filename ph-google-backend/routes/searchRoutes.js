const express = require('express');
const searchController = require('../controllers/searchController');
const { optionalAuth } = require('../middleware/authMiddleware');
const { searchLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Search works for guests; optionalAuth attaches req.user when a token is
// supplied so the query can be saved to that user's history.
router.get('/', searchLimiter, optionalAuth, searchController.search);
router.get('/config', searchController.searchConfig);

module.exports = router;
