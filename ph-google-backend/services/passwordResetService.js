const crypto = require('crypto');
const User = require('../models/User');
const PasswordReset = require('../models/PasswordReset');
const mailService = require('./mailService');
const { config } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Password reset by an emailed six-digit code.
 *
 *   1. requestReset(email)    a code is emailed — if the account exists. The
 *                             caller gets the same answer either way.
 *   2. verifyCode(email, otp) a correct, unexpired code is exchanged for a
 *                             one-time reset token (15 minutes).
 *   3. resetPassword(token, password)
 *                             the token sets a new password, once; the reset
 *                             request is then deleted.
 *
 * Every rule is enforced here, on the server:
 *   - the code is random (crypto.randomInt), 6 digits, and stored only as an
 *     HMAC keyed with a server secret; the reset token only as a SHA-256 hash;
 *   - a code works for 10 minutes and for 5 guesses, then never again; a new
 *     code replaces the old one; a used code is gone;
 *   - a new code at most once a minute and 5 times an hour per account;
 *   - comparisons are constant-time;
 *   - nothing here logs or returns a code or a token.
 *
 * Errors carry `publicMessage`-style generic text: whether an address has an
 * account is never revealed by an answer, its wording, or its status.
 */

const GENERIC_BAD_CODE = 'The code is incorrect or has expired. Request a new code and try again.';
const GENERIC_BAD_TOKEN =
  'This password reset link has expired or was already used. Please start again.';
const RETENTION_MS = 24 * 60 * 60 * 1000;

const settings = () => config.passwordReset;

/** A uniformly random six-digit code, as text ("004217"). */
function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * The stored form of a code: an HMAC keyed with the JWT secret and bound to
 * the account, so a database copy alone cannot be brute-forced offline and a
 * hash cannot be moved to another account.
 */
function hashCode(userId, code) {
  return crypto
    .createHmac('sha256', config.jwt.secret)
    .update(`password-reset-otp:${userId}:${code}`)
    .digest('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Constant-time equality for two hex strings. */
function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

class PasswordResetError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PasswordResetError';
    this.status = status;
  }
}

/** The email that carries a code. Plain text and HTML; the code appears only here. */
function codeEmail(code) {
  const minutes = Math.round(settings().otpTtlMs / 60000);
  const text = [
    'Your PH Spectrum password reset code is:',
    '',
    `    ${code}`,
    '',
    `It expires in ${minutes} minutes and can be used once.`,
    '',
    'If you did not ask to reset your password, you can ignore this email —',
    'your password has not been changed. Never share this code with anyone.'
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f5f0;font-family:Arial,Helvetica,sans-serif;color:#171717">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border:1px solid #ddd9d0;border-radius:12px" cellspacing="0" cellpadding="0"><tr><td style="padding:28px">
<p style="margin:0 0 6px;font-size:18px;font-weight:bold">PH Spectrum</p>
<p style="margin:0 0 20px;font-size:15px">Your password reset code is:</p>
<p style="margin:0 0 20px;font-size:32px;font-weight:bold;letter-spacing:8px;font-family:'Courier New',monospace">${code}</p>
<p style="margin:0 0 12px;font-size:14px;color:#444">It expires in ${minutes} minutes and can be used once.</p>
<p style="margin:0;font-size:13px;color:#666">If you did not ask to reset your password, you can ignore this email — your password has not been changed. Never share this code with anyone.</p>
</td></tr></table></td></tr></table></body></html>`;
  return { subject: 'Your PH Spectrum password reset code', text, html };
}

// Deliveries run after the response is sent (see requestReset); tests can
// wait for them.
const inFlight = new Set();

function deliverInBackground(task) {
  const job = Promise.resolve()
    .then(task)
    .catch(() => {})
    .finally(() => inFlight.delete(job));
  inFlight.add(job);
}

/** For tests: wait for codes still being sent. */
async function flushDeliveries() {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

/**
 * Step 1. Emails a code to the account's address, if the account exists and
 * its sending limits allow it. Resolves the same way in every case — the
 * caller always answers with the same generic message.
 *
 * The email itself is sent after this resolves (in the background), so the
 * response time does not depend on whether an account exists.
 *
 * @throws {PasswordResetError} 503 only when email is not configured at all
 *         — the same for every address, so it reveals nothing.
 */
async function requestReset(email) {
  if (!mailService.isConfigured()) {
    throw new PasswordResetError(
      'Password reset by email is not available right now. Please try again later.',
      503
    );
  }

  const user = await User.findOne({ email }).select('_id email').lean();
  if (!user) {
    logger.info('Password reset requested', { outcome: 'no_account' });
    return;
  }

  const now = Date.now();
  const policy = settings();
  const existing = await PasswordReset.findOne({ userId: user._id });

  // Per-account sending limits. Over them, nothing is sent; the answer is the same.
  if (
    existing &&
    existing.lastSentAt &&
    now - existing.lastSentAt.getTime() < policy.resendCooldownMs
  ) {
    logger.info('Password reset requested', { outcome: 'cooldown', userId: String(user._id) });
    return;
  }
  const windowOpen =
    existing &&
    existing.sendWindowStart &&
    now - existing.sendWindowStart.getTime() < 60 * 60 * 1000;
  const sentThisHour = windowOpen ? existing.sendCount : 0;
  if (sentThisHour >= policy.maxSendsPerHour) {
    logger.info('Password reset requested', { outcome: 'hourly_limit', userId: String(user._id) });
    return;
  }

  // A new code replaces any earlier one (and any reset token not yet used).
  const code = generateCode();
  await PasswordReset.findOneAndUpdate(
    { userId: user._id },
    {
      $set: {
        otpHash: hashCode(user._id, code),
        otpExpiresAt: new Date(now + policy.otpTtlMs),
        attempts: 0,
        lastSentAt: new Date(now),
        sendWindowStart: windowOpen ? existing.sendWindowStart : new Date(now),
        sendCount: sentThisHour + 1,
        resetTokenHash: null,
        resetTokenExpiresAt: null,
        expireAt: new Date(now + RETENTION_MS)
      }
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  const message = codeEmail(code);
  const userId = String(user._id);
  deliverInBackground(async () => {
    try {
      await mailService.send({ to: user.email, ...message });
      logger.info('Password reset code sent', { userId });
    } catch (error) {
      // The code cannot reach its owner, so it must not stay usable; the
      // send still counts towards the limits.
      await PasswordReset.updateOne(
        { userId: user._id },
        { $set: { otpHash: null, otpExpiresAt: null } }
      );
      logger.error('Password reset code could not be sent', {
        userId,
        code: error.code || null
      });
    }
  });
}

/**
 * Step 2. Checks a code. A correct one is used up and exchanged for a reset
 * token; a wrong one counts against the code's guesses.
 *
 * @returns {Promise<{resetToken: string, expiresInSeconds: number}>}
 * @throws {PasswordResetError} the same message for a wrong, expired, used or
 *         locked code and for an address with no account
 */
async function verifyCode(email, code) {
  const fail = () => {
    throw new PasswordResetError(GENERIC_BAD_CODE, 400);
  };
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) fail();

  const user = await User.findOne({ email }).select('_id').lean();
  if (!user) {
    // Same work as a real check, so the answer takes as long.
    hashCode('no-account', code);
    fail();
  }

  const record = await PasswordReset.findOne({ userId: user._id });
  const now = Date.now();
  if (
    !record ||
    !record.otpHash ||
    !record.otpExpiresAt ||
    record.otpExpiresAt.getTime() <= now ||
    record.attempts >= settings().maxAttempts
  ) {
    fail();
  }

  const maxAttempts = settings().maxAttempts;
  if (!sameHash(hashCode(user._id, code), record.otpHash)) {
    // Count the guess atomically ($inc, only while under the limit), so
    // guesses sent all at once cannot each read the same count and slip
    // past it. The guess that reaches the limit also ends the code.
    const counted = await PasswordReset.findOneAndUpdate(
      { _id: record._id, otpHash: record.otpHash, attempts: { $lt: maxAttempts } },
      { $inc: { attempts: 1 } },
      { new: true }
    );
    const locked = !counted || counted.attempts >= maxAttempts;
    if (locked) {
      await PasswordReset.updateOne(
        { _id: record._id, otpHash: record.otpHash },
        { $set: { otpHash: null, otpExpiresAt: null } }
      );
    }
    logger.warn('Password reset code rejected', {
      userId: String(user._id),
      attempts: counted ? counted.attempts : maxAttempts,
      locked
    });
    fail();
  }

  // Correct. Use the code up — atomically, so the same code cannot be
  // exchanged twice by two requests at once, and only while it is still
  // under its guess limit — and issue the reset token.
  const resetToken = crypto.randomBytes(32).toString('base64url');
  const used = await PasswordReset.findOneAndUpdate(
    { _id: record._id, otpHash: record.otpHash, attempts: { $lt: maxAttempts } },
    {
      $set: {
        otpHash: null,
        otpExpiresAt: null,
        attempts: 0,
        resetTokenHash: hashToken(resetToken),
        resetTokenExpiresAt: new Date(now + settings().resetTokenTtlMs)
      }
    },
    { new: true }
  );
  if (!used) fail();

  logger.info('Password reset code accepted', { userId: String(user._id) });
  return {
    resetToken,
    expiresInSeconds: Math.round(settings().resetTokenTtlMs / 1000)
  };
}

/**
 * Step 3. Sets the new password with a reset token, once. Ends the reset
 * request and every existing session (User.passwordChangedAt).
 *
 * @param {string} resetToken
 * @param {string} password  already checked against the password policy
 * @throws {PasswordResetError} for an unknown, expired or used token
 */
async function resetPassword(resetToken, password) {
  const fail = () => {
    throw new PasswordResetError(GENERIC_BAD_TOKEN, 400);
  };
  if (typeof resetToken !== 'string' || resetToken.length < 20 || resetToken.length > 200) fail();

  // Take the token atomically: two requests with the same token cannot both use it.
  const record = await PasswordReset.findOneAndDelete({
    resetTokenHash: hashToken(resetToken),
    resetTokenExpiresAt: { $gt: new Date() }
  });
  if (!record) fail();

  const user = await User.findById(record.userId);
  if (!user) fail();

  user.password = password; // hashed by the model's pre-save hook (bcrypt)
  await user.save();

  logger.info('Password reset completed', { userId: String(user._id) });
}

module.exports = {
  requestReset,
  verifyCode,
  resetPassword,
  flushDeliveries,
  PasswordResetError,
  // For tests.
  generateCode,
  hashCode,
  hashToken,
  codeEmail
};
