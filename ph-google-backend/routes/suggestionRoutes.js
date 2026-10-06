const express = require('express');
const searchController = require('../controllers/searchController');
const { optionalAuth } = require('../middleware/authMiddleware');
const { searchLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

router.get('/', searchLimiter, optionalAuth, searchController.suggestions);

module.exports = router;
