const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { config } = require('../config/env');
const { sendSuccess, asyncHandler, ApiError } = require('../utils/apiResponse');
const { parseEmail, parsePassword, parseName } = require('../utils/validators');
const logger = require('../utils/logger');

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

module.exports = { register, login, getMe, changePassword, generateToken, publicUser };
