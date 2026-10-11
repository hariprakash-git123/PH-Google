/**
 * Shared HTTP client for the PH Spectrum backend.
 *
 * The API answers with a consistent envelope:
 *   success -> { success: true,  data: ... }
 *   failure -> { success: false, message: "..." }
 *
 * This module unwraps that envelope so callers work with the payload
 * directly, attaches the stored JWT, and turns a failure into an Error
 * carrying the server's message and status.
 */

// Vite exposes build-time config on import.meta.env.
//
// Production: VITE_API_BASE_URL, or "/api" — the same origin as the page,
// which nginx proxies to the backend (nginx.conf). Nothing else is tried.
//
// Development (`npm run dev`, tests): VITE_API_BASE_URL or
// http://localhost:5000/api, then the next ports the backend moves to when
// 5000 is taken. `import.meta.env.DEV` is written out literally so Vite
// replaces it with a constant: a production bundle does not contain these
// localhost addresses at all.
const DEFAULT_API_BASE_URLS = (
  import.meta.env.DEV
    ? [
        import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api',
        'http://localhost:5001/api',
        'http://localhost:5002/api',
        'http://localhost:5003/api'
      ]
    : [import.meta.env.VITE_API_BASE_URL || '/api']
).filter(Boolean);

const API_BASE_URLS = [...new Set(DEFAULT_API_BASE_URLS)];
export const API_BASE_URL = API_BASE_URLS[0];

const TOKEN_KEY = 'ph_token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private browsing / storage disabled.
    return null;
  }
}

/** Error thrown for any non-2xx response, carrying the server's message. */
export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  get isUnauthorized() {
    return this.status === 401;
  }

  get isForbidden() {
    return this.status === 403;
  }
}

/**
 * Performs a request and returns the unwrapped `data` payload.
 *
 * @param {string} path            Path below /api, e.g. "/search"
 * @param {Object} [options]
 * @param {string} [options.method]
 * @param {Object} [options.body]   JSON body
 * @param {Object} [options.params] Query parameters (empty values are dropped)
 * @param {boolean} [options.auth]  Attach the stored token (default true)
 */
export async function apiRequest(path, { method = 'GET', body, params, auth = true, signal } = {}) {
  let lastError = null;

  for (const baseUrl of API_BASE_URLS) {
    let url = `${baseUrl}${path}`;

    if (params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        search.append(key, String(value));
      }
      const qs = search.toString();
      if (qs) url += `?${qs}`;
    }

    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    if (auth) {
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok || (payload && payload.success === false)) {
        const message = (payload && payload.message) || `Request failed (${response.status})`;
        if (response.status === 404 && baseUrl !== API_BASE_URLS[0]) {
          continue;
        }
        throw new ApiError(message, response.status, payload);
      }

      // Unwrap { success, data }; tolerate a bare payload just in case.
      return payload && Object.prototype.hasOwnProperty.call(payload, 'data')
        ? payload.data
        : payload;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      // The server answered, so it is reachable: surface its real error
      // instead of falling through to the fallback ports.
      if (error instanceof ApiError) throw error;
      lastError = error;
      if (baseUrl !== API_BASE_URLS[API_BASE_URLS.length - 1]) continue;
    }
  }

  if (lastError instanceof ApiError) throw lastError;

  throw new ApiError(
    'Cannot reach the PH Spectrum API. Make sure the backend is running and reachable on the configured port.',
    0,
    null
  );
}

export const api = {
  get: (path, options) => apiRequest(path, { ...options, method: 'GET' }),
  post: (path, body, options) => apiRequest(path, { ...options, method: 'POST', body }),
  put: (path, body, options) => apiRequest(path, { ...options, method: 'PUT', body }),
  delete: (path, options) => apiRequest(path, { ...options, method: 'DELETE' })
};
