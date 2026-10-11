import { api } from './apiClient';

/**
 * Authentication calls.
 *
 * Errors arrive as an ApiError whose `message` is the server's own text, so
 * the login and signup screens can display it directly.
 */
export const authApi = {
  /**
   * POST /api/auth/register
   * @returns {Promise<{token: string, user: Object}>}
   */
  register(name, email, password) {
    return api.post('/auth/register', { name, email, password }, { auth: false });
  },

  /**
   * POST /api/auth/login
   * @returns {Promise<{token: string, user: Object}>}
   */
  login(email, password) {
    return api.post('/auth/login', { email, password }, { auth: false });
  },

  /**
   * GET /api/auth/me — validates the stored token and returns the profile.
   */
  getProfile() {
    return api.get('/auth/me');
  },

  /**
   * POST /api/auth/change-password
   */
  changePassword(currentPassword, newPassword) {
    return api.post('/auth/change-password', { currentPassword, newPassword });
  },

  /**
   * POST /api/auth/forgot-password — asks for a reset code by email. The
   * answer is the same whether or not the address has an account.
   * @returns {Promise<{message: string}>}
   */
  forgotPassword(email) {
    return api.post('/auth/forgot-password', { email }, { auth: false });
  },

  /**
   * POST /api/auth/verify-reset-code — exchanges the emailed code for a
   * short-lived reset token (kept in memory only, never stored).
   * @returns {Promise<{resetToken: string, expiresInSeconds: number}>}
   */
  verifyResetCode(email, code) {
    return api.post('/auth/verify-reset-code', { email, code }, { auth: false });
  },

  /**
   * POST /api/auth/reset-password — sets the new password, once.
   * @returns {Promise<{message: string}>}
   */
  resetPassword(resetToken, password, confirmPassword) {
    return api.post(
      '/auth/reset-password',
      { resetToken, password, confirmPassword },
      { auth: false }
    );
  }
};
