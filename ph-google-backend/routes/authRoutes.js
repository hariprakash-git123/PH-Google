const express = require('express');
const authController = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const {
  authLimiter,
  recoveryRequestLimiter,
  recoveryVerifyLimiter
} = require('../middleware/rateLimiter');

const router = express.Router();

// Register/login are rate limited to blunt credential-stuffing attempts.
router.post('/register', authLimiter, authController.register);
router.post('/login', authLimiter, authController.login);

// Password recovery by emailed code. Each step is limited per client IP here,
// and per account (codes, guesses, resends) in passwordResetService.
router.post('/forgot-password', recoveryRequestLimiter, authController.forgotPassword);
router.post('/verify-reset-code', recoveryVerifyLimiter, authController.verifyResetCode);
router.post('/reset-password', recoveryVerifyLimiter, authController.resetPassword);

router.get('/me', protect, authController.getMe);
router.post('/change-password', protect, authLimiter, authController.changePassword);

module.exports = router;
