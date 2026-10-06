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
  }
};
