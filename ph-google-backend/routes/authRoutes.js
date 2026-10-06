const express = require('express');
const authController = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const { authLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Register/login are rate limited to blunt credential-stuffing attempts.
router.post('/register', authLimiter, authController.register);
router.post('/login', authLimiter, authController.login);

router.get('/me', protect, authController.getMe);
router.post('/change-password', protect, authLimiter, authController.changePassword);

module.exports = router;
