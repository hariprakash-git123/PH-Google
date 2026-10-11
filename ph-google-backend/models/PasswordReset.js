const mongoose = require('mongoose');

/**
 * One account's password-reset request in progress.
 *
 * Holds hashes only — never a plaintext code or token: the emailed six-digit
 * code as an HMAC (otpHash), and the reset token issued after the code is
 * accepted as a SHA-256 hash (resetTokenHash). See passwordResetService.
 *
 * There is at most one document per user: issuing a new code replaces the
 * old one, so earlier codes stop working. Documents remove themselves
 * (TTL index on expireAt) a day after their last activity.
 */
const passwordResetSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true
    },

    // The current code: its hash, when it stops working, wrong guesses so far.
    otpHash: { type: String, default: null },
    otpExpiresAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },

    // Sending limits: the last code sent, and codes sent in the current hour.
    lastSentAt: { type: Date, default: null },
    sendWindowStart: { type: Date, default: null },
    sendCount: { type: Number, default: 0 },

    // After a correct code: the one-time permission to set a new password.
    resetTokenHash: { type: String, default: null, index: true },
    resetTokenExpiresAt: { type: Date, default: null },

    expireAt: { type: Date, required: true }
  },
  { timestamps: true }
);

passwordResetSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PasswordReset', passwordResetSchema);
