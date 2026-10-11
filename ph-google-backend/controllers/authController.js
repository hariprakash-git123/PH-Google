const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { config } = require('../config/env');
const { sendSuccess, asyncHandler, ApiError } = require('../utils/apiResponse');
const { parseEmail, parsePassword, parseName } = require('../utils/validators');
const logger = require('../utils/logger');
const passwordReset = require('../services/passwordResetService');

/**
 * Authentication.
 *
 * Passwords are hashed by the User model's pre-save hook (bcrypt) and are
 * never returned or logged. The JWT secret and lifetime come from the
 * environment — neither is ever hardcoded.
 */

function generateToken(userId) {
  return jwt.sign({ id: userId }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
}

function publicUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt
  };
}

/**
 * POST /api/auth/register  { name, email, password }
 */
const register = asyncHandler(async (req, res) => {
  const name = parseName(req.body.name);
  const email = parseEmail(req.body.email);
  const password = parsePassword(req.body.password);

  const existing = await User.findOne({ email }).select('_id').lean();
  if (existing) {
    throw ApiError.conflict('An account with this email already exists.');
  }

  // Self-registration only ever creates a normal user. Administrators are
  // created or promoted deliberately with `npm run create-admin` (seed.js).
  const user = await User.create({ name, email, password, role: 'user' });

  logger.info('User registered', { userId: user._id.toString(), role: user.role });

  return sendSuccess(
    res,
    {
      token: generateToken(user._id),
      user: publicUser(user)
    },
    201
  );
});

/**
 * POST /api/auth/login  { email, password }
 *
 * Returns the same message for an unknown email and a wrong password so the
 * endpoint cannot be used to enumerate accounts.
 */
const login = asyncHandler(async (req, res) => {
  const email = parseEmail(req.body.email);
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!password) throw ApiError.badRequest('Password is required.');

  const user = await User.findOne({ email });
  if (!user) {
    logger.warn('Login failed: unknown email');
    throw ApiError.unauthorized('Invalid email or password.');
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    logger.warn('Login failed: bad password', { userId: user._id.toString() });
    throw ApiError.unauthorized('Invalid email or password.');
  }

  logger.info('User signed in', { userId: user._id.toString() });

  return sendSuccess(res, {
    token: generateToken(user._id),
    user: publicUser(user)
  });
});

/**
 * GET /api/auth/me — validates the caller's token and echoes their profile.
 */
const getMe = asyncHandler(async (req, res) => {
  return sendSuccess(res, { user: publicUser(req.user) });
});

/**
 * POST /api/auth/change-password  { currentPassword, newPassword }
 */
const changePassword = asyncHandler(async (req, res) => {
  const newPassword = parsePassword(req.body.newPassword);
  const currentPassword =
    typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';

  if (!currentPassword) throw ApiError.badRequest('"currentPassword" is required.');

  const user = await User.findById(req.user._id);
  if (!user) throw ApiError.unauthorized('Not authorized.');

  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) throw ApiError.unauthorized('Current password is incorrect.');

  // Assigning triggers the model's hashing hook.
  user.password = newPassword;
  await user.save();

  logger.info('Password changed', { userId: user._id.toString() });

  // A fresh token so the old one cannot be reused elsewhere.
  return sendSuccess(res, {
    token: generateToken(user._id),
    user: publicUser(user),
    message: 'Password updated.'
  });
});

// ---------------------------------------------------------------------------
// Password recovery: an emailed six-digit code, then a one-time reset token.
// The rules (expiry, guesses, resend limits, single use) live in
// passwordResetService; these handlers only read input and shape answers.
// ---------------------------------------------------------------------------

/** The one answer to every forgot-password request that is not a 503. */
const RESET_REQUESTED =
  'If an account exists for that email address, we have sent it a 6-digit code. ' +
  'The code expires in 10 minutes.';

/** Turns the service's generic failures into API errors with the same text. */
async function recovery(task) {
  try {
    return await task();
  } catch (error) {
    if (error instanceof passwordReset.PasswordResetError) {
      throw new ApiError(error.message, error.status);
    }
    throw error;
  }
}

/**
 * POST /api/auth/forgot-password  { email }
 *
 * Always the same answer (200), whether or not the address has an account,
 * whether a code was sent or held back by the resend limits. 503 only when
 * email is not configured — which is true for every address alike.
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const email = parseEmail(req.body.email);
  await recovery(() => passwordReset.requestReset(email));
  return sendSuccess(res, { message: RESET_REQUESTED });
});

/**
 * POST /api/auth/verify-reset-code  { email, code }
 *
 * A correct code is used up and exchanged for a short-lived reset token.
 * Every failure — wrong, expired, used or locked code, unknown address —
 * gets the same 400 message.
 */
const verifyResetCode = asyncHandler(async (req, res) => {
  const email = parseEmail(req.body.email);
  const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
  const result = await recovery(() => passwordReset.verifyCode(email, code));
  return sendSuccess(res, result);
});

/**
 * POST /api/auth/reset-password  { resetToken, password, confirmPassword }
 *
 * Sets the new password once, under the same password policy as sign-up.
 * Every session issued before it stops working. No session is issued: the
 * user signs in with the new password.
 */
const resetPassword = asyncHandler(async (req, res) => {
  const resetToken = typeof req.body.resetToken === 'string' ? req.body.resetToken : '';
  if (!resetToken) throw ApiError.badRequest('The reset token is missing. Please start again.');
  const password = parsePassword(req.body.password);
  if (req.body.confirmPassword !== password) {
    throw ApiError.badRequest('The passwords do not match.');
  }
  await recovery(() => passwordReset.resetPassword(resetToken, password));
  return sendSuccess(res, {
    message: 'Your password has been reset. Sign in with your new password.'
  });
});

module.exports = {
  register,
  login,
  getMe,
  changePassword,
  forgotPassword,
  verifyResetCode,
  resetPassword,
  generateToken,
  publicUser
};
