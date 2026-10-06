const analyticsService = require('../services/analyticsService');
const SearchLog = require('../models/SearchLog');
const { sendSuccess, asyncHandler } = require('../utils/apiResponse');
const { parsePage, parseLimit, sanitizeString } = require('../utils/validators');

/**
 * Search analytics APIs.
 *
 * All figures come from MongoDB aggregations over the SearchLog collection.
 * Everything here is admin-only except /api/analytics/me, which reports a
 * signed-in user's own activity.
 */

function parseDays(raw, def = 30, max = 365) {
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return def;
  return Math.min(n, max);
}

/**
 * GET /api/analytics/overview?days=
 */
const getOverview = asyncHandler(async (req, res) => {
  const days = parseDays(req.query.days);

  const [overview, topQueries, zeroResults, perDay, perHour] = await Promise.all([
    analyticsService.getOverview(),
    analyticsService.getTopQueries({ limit: 10, days }),
    analyticsService.getZeroResultQueries({ limit: 10, days }),
    analyticsService.getSearchesPerDay({ days: Math.min(days, 30) }),
    analyticsService.getSearchesPerHour({ hours: 24 })
  ]);

  return sendSuccess(res, {
    ...overview,
    topQueries,
    zeroResultQueries: zeroResults,
    searchesPerDay: perDay,
    searchesPerHour: perHour,
    windowDays: days,
    generatedAt: new Date()
  });
});

/**
 * GET /api/analytics/searches?page=&limit=&q=
 * Raw search log, newest first.
 */
const listSearches = asyncHandler(async (req, res) => {
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, { def: 25, max: 100 });
  const query = sanitizeString(req.query.q, 100);

  const { searches, total } = await analyticsService.listSearches({ page, limit, query });

  return sendSuccess(res, {
    searches,
    pagination: {
      page,
      limit,
      totalResults: total,
      totalPages: total === 0 ? 0 : Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPreviousPage: page > 1
    }
  });
});

/**
 * GET /api/analytics/top-queries?limit=&days=
 */
const getTopQueries = asyncHandler(async (req, res) => {
  const limit = parseLimit(req.query.limit, { def: 10, max: 100 });
  const days = parseDays(req.query.days);

  const topQueries = await analyticsService.getTopQueries({ limit, days });
  return sendSuccess(res, { topQueries, windowDays: days });
});

/**
 * GET /api/analytics/zero-result-queries?limit=&days=
 */
const getZeroResultQueries = asyncHandler(async (req, res) => {
  const limit = parseLimit(req.query.limit, { def: 20, max: 100 });
  const days = parseDays(req.query.days);

  const zeroResultQueries = await analyticsService.getZeroResultQueries({ limit, days });
  return sendSuccess(res, { zeroResultQueries, windowDays: days });
});

/**
 * GET /api/analytics/me — a signed-in user's own search activity.
 * Not admin-gated: the filter is the caller's own id.
 */
const getMyAnalytics = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [totalSearches, recentSearches, topQueries] = await Promise.all([
    SearchLog.countDocuments({ userId }),
    SearchLog.countDocuments({ userId, createdAt: { $gte: monthAgo } }),
    SearchLog.aggregate([
      { $match: { userId, createdAt: { $gte: monthAgo } } },
      {
        $group: {
          _id: '$normalizedQuery',
          count: { $sum: 1 },
          lastSearchedAt: { $max: '$createdAt' }
        }
      },
      { $sort: { count: -1, lastSearchedAt: -1 } },
      { $limit: 10 }
    ])
  ]);

  return sendSuccess(res, {
    totalSearches,
    searchesLast30Days: recentSearches,
    topQueries: topQueries.map(t => ({
      query: t._id,
      count: t.count,
      lastSearchedAt: t.lastSearchedAt
    }))
  });
});

module.exports = {
  getOverview,
  listSearches,
  getTopQueries,
  getZeroResultQueries,
  getMyAnalytics
};
