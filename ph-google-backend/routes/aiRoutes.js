const express = require('express');
const aiAnswerController = require('../controllers/aiAnswerController');
const { optionalAuth } = require('../middleware/authMiddleware');
const { aiLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Like search, AI answers work for guests. They are limited more tightly
// than search because each uncached answer is a paid model call.
router.get('/', aiLimiter, optionalAuth, aiAnswerController.getAnswer);
router.post('/feedback', aiLimiter, optionalAuth, aiAnswerController.submitFeedback);

module.exports = router;
