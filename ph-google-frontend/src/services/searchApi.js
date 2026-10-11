import { api, ApiError } from './apiClient';

/**
 * Search, suggestions, history and admin/analytics calls.
 *
 * Every method talks to the real backend. UI-level filter labels are
 * translated here into the API's parameter vocabulary, so components keep
 * using the wording they already display.
 */

/** "Past 24 hours" -> "day", etc. */
const DATE_LABEL_TO_PARAM = {
  'any time': 'any',
  'past hour': 'hour',
  'past 24 hours': 'day',
  'past week': 'week',
  'past month': 'month',
  'past year': 'year'
};

/** "English" -> "en", etc. */
const LANGUAGE_LABEL_TO_CODE = {
  'any language': '',
  english: 'en',
  tamil: 'ta',
  hindi: 'hi',
  spanish: 'es',
  french: 'fr'
};

const SORT_LABEL_TO_PARAM = {
  relevance: 'relevance',
  'most relevant': 'relevance',
  newest: 'newest',
  'newest first': 'newest',
  oldest: 'oldest',
  'oldest first': 'oldest'
};

function mapDate(value) {
  if (!value) return '';
  const key = String(value).trim().toLowerCase();
  if (DATE_LABEL_TO_PARAM[key]) return DATE_LABEL_TO_PARAM[key];
  // Already an API value such as "week".
  return ['any', 'hour', 'day', 'week', 'month', 'year'].includes(key) ? key : '';
}

function mapLanguage(value) {
  if (!value) return '';
  const key = String(value).trim().toLowerCase();
  if (key in LANGUAGE_LABEL_TO_CODE) return LANGUAGE_LABEL_TO_CODE[key];
  // Already a code such as "en".
  return /^[a-z]{2,3}$/.test(key) ? key : '';
}

function mapSort(value) {
  if (!value) return 'relevance';
  const key = String(value).trim().toLowerCase();
  return SORT_LABEL_TO_PARAM[key] || 'relevance';
}

/** The shape components render when a request fails. */
function emptySearchResult(query, category, message) {
  return {
    query,
    category,
    results: [],
    total: 0,
    latency: '0.000s',
    pagination: {
      page: 1,
      limit: 10,
      totalResults: 0,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false
    },
    hasMore: false,
    nextCursor: null,
    error: message || null
  };
}

export const searchApi = {
  /**
   * GET /api/search
   *
   * @param {string} query
   * @param {string} category  all | images | news | videos | maps
   * @param {Object} filters   { date, language, domain, sort, page, limit, cursor }
   *        `cursor` ("Load more") comes from the previous response's
   *        `nextCursor` and asks for the batch after it; `page` is then not sent.
   */
  async search(query = '', category = 'all', filters = {}) {
    try {
      return await api.get('/search', {
        params: {
          q: query,
          category,
          ...(filters.cursor ? { cursor: filters.cursor } : { page: filters.page || 1 }),
          limit: filters.limit || 10,
          sort: mapSort(filters.sort),
          domain: filters.domain || '',
          date: mapDate(filters.date),
          language: mapLanguage(filters.language)
        }
      });
    } catch (error) {
      console.error('Search API error:', error.message);
      return emptySearchResult(query, category, error.message);
    }
  },

  /** GET /api/search/config — server-published limits and filter options. */
  async getSearchConfig() {
    try {
      return await api.get('/search/config');
    } catch {
      return null;
    }
  },

  /**
   * GET /api/trending — current trending searches for a country, for the
   * homepage card. Resolves with `{ region, updatedAt, trends: [{ title,
   * query }], stale }`, or null when the request failed: the card has its
   * own fallback, so a failure here is never an error to show.
   *
   * @param {string} [region]  ISO country code (IN, US, GB, …)
   */
  async getTrending(region = 'IN') {
    try {
      const data = await api.get('/trending', { params: { region }, auth: false });
      return data && Array.isArray(data.trends) ? data : null;
    } catch {
      return null;
    }
  },

  /** GET /api/suggestions */
  async getSuggestions(query = '') {
    if (!query.trim()) return [];
    try {
      const data = await api.get('/suggestions', { params: { q: query } });
      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.error('Suggestions API error:', error.message);
      return [];
    }
  },

  // -------------------------------------------------------------------
  // AI answer — written by the backend from the retrieved documents.
  // -------------------------------------------------------------------

  /**
   * GET /api/ai-answer
   *
   * Always resolves. `status` says what came back: "ok" (an answer and its
   * sources), or why there is none — "no_results", "insufficient_evidence",
   * "not_configured", "disabled", "unavailable". A request that fails
   * outright (network, rate limit, server error) is reported as
   * "unavailable" too, so the caller has one shape to render.
   *
   * @param {string} query
   * @param {Object} [filters]  { domain, date, language } as the UI shows them
   * @param {Object} [options]  { signal, refresh }
   */
  async getAiAnswer(query, filters = {}, { signal, refresh = false } = {}) {
    try {
      return await api.get('/ai-answer', {
        params: {
          q: query,
          domain: filters.domain || '',
          date: mapDate(filters.date),
          language: mapLanguage(filters.language),
          refresh: refresh ? 'true' : ''
        },
        signal
      });
    } catch (error) {
      // The search was replaced before the answer arrived: nothing to show.
      if (error.name === 'AbortError') throw error;
      console.error('AI answer API error:', error.message);
      return {
        query,
        status: 'unavailable',
        reason:
          error instanceof ApiError && error.status === 429 ? 'rate_limited' : 'request_failed',
        generated: false,
        answer: '',
        keyPoints: [],
        sources: [],
        message: 'AI answer is temporarily unavailable.'
      };
    }
  },

  /**
   * POST /api/ai-answer/feedback
   * @returns {Promise<boolean>} whether the rating was stored
   */
  async sendAiFeedback({ answerId, query, rating, model, provider }) {
    try {
      await api.post('/ai-answer/feedback', { answerId, query, rating, model, provider });
      return true;
    } catch (error) {
      console.error('AI feedback API error:', error.message);
      return false;
    }
  },

  // -------------------------------------------------------------------
  // Search history — requires a signed-in user.
  // -------------------------------------------------------------------

  /**
   * GET /api/history
   * @returns {{history: Array, requiresAuth: boolean, error: string|null}}
   */
  async getHistory(params = {}) {
    try {
      const data = await api.get('/history', {
        params: { page: params.page, limit: params.limit, q: params.q }
      });
      return {
        history: data.history || [],
        pagination: data.pagination,
        requiresAuth: false,
        error: null
      };
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        return { history: [], requiresAuth: true, error: null };
      }
      console.error('Get history API error:', error.message);
      return { history: [], requiresAuth: false, error: error.message };
    }
  },

  /** POST /api/history */
  async addHistory(query) {
    try {
      const data = await api.post('/history', { query });
      return data.history || [];
    } catch (error) {
      // A guest search simply is not recorded; that is expected, not an error.
      if (!(error instanceof ApiError && error.isUnauthorized)) {
        console.error('Add history API error:', error.message);
      }
      return [];
    }
  },

  /** DELETE /api/history/:id */
  async removeHistory(id) {
    const data = await api.delete(`/history/${id}`);
    return data.history || [];
  },

  /** DELETE /api/history */
  async clearHistory() {
    const data = await api.delete('/history');
    return data.history || [];
  },

  // -------------------------------------------------------------------
  // Admin — all of these require an admin token.
  // -------------------------------------------------------------------

  /** GET /api/admin/dashboard */
  getAdminDashboard: () => api.get('/admin/dashboard'),

  /** GET /api/admin/metrics */
  getAdminMetrics: () => api.get('/admin/metrics'),

  /** GET /api/admin/pages */
  getAdminPages: (params = {}) => api.get('/admin/pages', { params }),

  /** GET /api/admin/websites */
  getAdminWebsites: (params = {}) => api.get('/admin/websites', { params }),

  /** GET /api/admin/users */
  getAdminUsers: (params = {}) => api.get('/admin/users', { params }),

  // Crawler controls
  getCrawlerStatus: () => api.get('/admin/crawler/status'),
  getCrawlerJobs: (params = {}) => api.get('/admin/crawler/jobs', { params }),
  getCrawlerSeeds: () => api.get('/admin/crawler/seeds'),
  startCrawl: payload => api.post('/admin/crawler/start', payload),
  stopCrawl: jobId => api.post('/admin/crawler/stop', jobId ? { jobId } : {}),

  // Search engine (OpenSearch)
  getSearchStatus: () => api.get('/admin/search/status'),
  getReindexStatus: () => api.get('/admin/search/reindex'),
  startReindex: (recreate = false) => api.post('/admin/search/reindex', { recreate }),

  // Analytics
  getAnalyticsOverview: (params = {}) => api.get('/analytics/overview', { params }),
  getTopQueries: (params = {}) => api.get('/analytics/top-queries', { params }),
  getZeroResultQueries: (params = {}) => api.get('/analytics/zero-result-queries', { params }),
  getRecentSearches: (params = {}) => api.get('/analytics/searches', { params }),
  getMyAnalytics: () => api.get('/analytics/me')
};

export { ApiError };
