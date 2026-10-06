const SearchLog = require('../models/SearchLog');
const History = require('../models/History');
const logger = require('../utils/logger');

/**
 * Search analytics + per-user history recording.
 *
 * Analytics rows are written for every search (including anonymous ones);
 * history rows are written only for signed-in users, so a guest's queries
 * are never attributed to anyone.
 */

/**
 * Records one executed search. Never throws: a logging failure must not turn
 * a successful search into a 500.
 */
async function recordSearch({
  query,
  userId = null,
  resultCount = 0,
  responseTimeMs = 0,
  page = 1,
  filters = {}
}) {
  const normalizedQuery = String(query || '')
    .trim()
    .toLowerCase();
  if (!normalizedQuery) return null;

  try {
    return await SearchLog.create({
      query: String(query).trim().slice(0, 200),
      normalizedQuery: normalizedQuery.slice(0, 200),
      userId,
      resultCount,
      responseTimeMs,
      page,
      filters: {
        domain: filters.domain || '',
        date: filters.date || 'any',
        language: filters.language || '',
        category: filters.category || 'all',
        sort: filters.sort || 'relevance'
      }
    });
  } catch (error) {
    logger.error('Failed to record search analytics', { message: error.message });
    return null;
  }
}

const HISTORY_LIMIT_PER_USER = 50;

/**
 * Adds a query to a user's history, de-duplicating repeats and trimming the
 * list to the newest HISTORY_LIMIT_PER_USER entries.
 */
async function recordHistory({ query, userId, category = 'Recent', device = 'Desktop · Web' }) {
  if (!userId) return null; // history is a signed-in feature only

  const clean = String(query || '').trim();
  if (!clean) return null;

  try {
    // Move a repeated query back to the top instead of duplicating it.
    await History.deleteMany({ userId, query: clean });

    const entry = await History.create({
      userId,
      query: clean,
      timestamp: 'Just now',
      category,
      device
    });

    const count = await History.countDocuments({ userId });
    if (count > HISTORY_LIMIT_PER_USER) {
      const stale = await History.find({ userId })
        .sort({ createdAt: 1 })
        .limit(count - HISTORY_LIMIT_PER_USER)
        .select('_id')
        .lean();
      if (stale.length > 0) {
        await History.deleteMany({ _id: { $in: stale.map(s => s._id) } });
      }
    }

    return entry;
  } catch (error) {
    logger.error('Failed to record search history', { message: error.message });
    return null;
  }
}

/** Start of the current UTC day. */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

/**
 * Headline analytics numbers, all derived from SearchLog.
 */
async function getOverview() {
  const today = startOfToday();
  const week = daysAgo(7);
  const month = daysAgo(30);

  const [totalSearches, searchesToday, searchesThisWeek, zeroResultCount, timing, uniqueQueries] =
    await Promise.all([
      SearchLog.countDocuments(),
      SearchLog.countDocuments({ createdAt: { $gte: today } }),
      SearchLog.countDocuments({ createdAt: { $gte: week } }),
      SearchLog.countDocuments({ resultCount: 0, createdAt: { $gte: month } }),
      SearchLog.aggregate([
        { $match: { createdAt: { $gte: month } } },
        {
          $group: {
            _id: null,
            avgResponseTimeMs: { $avg: '$responseTimeMs' },
            maxResponseTimeMs: { $max: '$responseTimeMs' },
            avgResultCount: { $avg: '$resultCount' }
          }
        }
      ]),
      SearchLog.distinct('normalizedQuery', { createdAt: { $gte: month } })
    ]);

  const t = timing[0] || {};
  const searchesLast30Days = await SearchLog.countDocuments({ createdAt: { $gte: month } });

  return {
    totalSearches,
    searchesToday,
    searchesThisWeek,
    searchesLast30Days,
    uniqueQueries: uniqueQueries.length,
    zeroResultSearches: zeroResultCount,
    zeroResultRate:
      searchesLast30Days > 0
        ? Number(((zeroResultCount / searchesLast30Days) * 100).toFixed(2))
        : 0,
    avgResponseTimeMs: Math.round(t.avgResponseTimeMs || 0),
    maxResponseTimeMs: Math.round(t.maxResponseTimeMs || 0),
    avgResultCount: Number((t.avgResultCount || 0).toFixed(2))
  };
}

/**
 * Most frequent queries over a window.
 */
async function getTopQueries({ limit = 10, days = 30 } = {}) {
  const rows = await SearchLog.aggregate([
    { $match: { createdAt: { $gte: daysAgo(days) } } },
    {
      $group: {
        _id: '$normalizedQuery',
        count: { $sum: 1 },
        avgResults: { $avg: '$resultCount' },
        avgResponseTimeMs: { $avg: '$responseTimeMs' },
        lastSearchedAt: { $max: '$createdAt' }
      }
    },
    { $sort: { count: -1, lastSearchedAt: -1 } },
    { $limit: limit }
  ]);

  return rows.map(r => ({
    query: r._id,
    count: r.count,
    avgResults: Number((r.avgResults || 0).toFixed(1)),
    avgResponseTimeMs: Math.round(r.avgResponseTimeMs || 0),
    lastSearchedAt: r.lastSearchedAt
  }));
}

/**
 * Queries that returned nothing — the backlog of content the index is missing.
 */
async function getZeroResultQueries({ limit = 20, days = 30 } = {}) {
  const rows = await SearchLog.aggregate([
    { $match: { resultCount: 0, createdAt: { $gte: daysAgo(days) } } },
    {
      $group: {
        _id: '$normalizedQuery',
        count: { $sum: 1 },
        lastSearchedAt: { $max: '$createdAt' }
      }
    },
    { $sort: { count: -1, lastSearchedAt: -1 } },
    { $limit: limit }
  ]);

  return rows.map(r => ({
    query: r._id,
    count: r.count,
    lastSearchedAt: r.lastSearchedAt
  }));
}

/**
 * Search volume bucketed by day, for the analytics chart.
 */
async function getSearchesPerDay({ days = 14 } = {}) {
  const rows = await SearchLog.aggregate([
    { $match: { createdAt: { $gte: daysAgo(days) } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        count: { $sum: 1 },
        zeroResults: { $sum: { $cond: [{ $eq: ['$resultCount', 0] }, 1, 0] } },
        avgResponseTimeMs: { $avg: '$responseTimeMs' }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  return rows.map(r => ({
    date: r._id,
    count: r.count,
    zeroResults: r.zeroResults,
    avgResponseTimeMs: Math.round(r.avgResponseTimeMs || 0)
  }));
}

/**
 * Search volume by hour over the last 24h, for the dashboard chart.
 */
async function getSearchesPerHour({ hours = 24 } = {}) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await SearchLog.aggregate([
    { $match: { createdAt: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%dT%H:00', date: '$createdAt' } },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  return rows.map(r => ({ hour: r._id, count: r.count }));
}

/**
 * Paginated raw search log, newest first. Admin-only.
 */
async function listSearches({ page = 1, limit = 25, query = '' } = {}) {
  const filter = {};
  if (query) {
    filter.normalizedQuery = {
      $regex:
        '^' +
        String(query)
          .toLowerCase()
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    };
  }

  const [rows, total] = await Promise.all([
    SearchLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('query userId resultCount responseTimeMs page filters createdAt')
      .lean(),
    SearchLog.countDocuments(filter)
  ]);

  return {
    searches: rows.map(r => ({
      id: r._id.toString(),
      query: r.query,
      userId: r.userId ? r.userId.toString() : null,
      resultCount: r.resultCount,
      responseTimeMs: r.responseTimeMs,
      page: r.page,
      filters: r.filters,
      createdAt: r.createdAt
    })),
    total
  };
}

module.exports = {
  recordSearch,
  recordHistory,
  getOverview,
  getTopQueries,
  getZeroResultQueries,
  getSearchesPerDay,
  getSearchesPerHour,
  listSearches,
  HISTORY_LIMIT_PER_USER
};
