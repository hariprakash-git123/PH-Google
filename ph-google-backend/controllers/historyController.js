const History = require('../models/History');
const analyticsService = require('../services/analyticsService');
const { sendSuccess, asyncHandler, ApiError } = require('../utils/apiResponse');
const {
  parsePage,
  parseLimit,
  parseObjectId,
  parseSearchQuery,
  sanitizeString
} = require('../utils/validators');
const logger = require('../utils/logger');

/**
 * Per-user search history.
 *
 * Every route requires authentication and is scoped to req.user._id, so one
 * user can never read or delete another user's history. An admin may read or
 * clear a specific user's history by passing ?userId=, which is the only way
 * to reach someone else's rows.
 */

/** Resolves whose history the request is allowed to operate on. */
function resolveTargetUserId(req) {
  const requested = req.query.userId || req.body.userId;
  if (!requested) return req.user._id;

  const targetId = parseObjectId(String(requested), 'userId');
  const isSelf = targetId === req.user._id.toString();

  if (!isSelf && req.user.role !== 'admin') {
    throw ApiError.forbidden('You can only access your own search history.');
  }
  return targetId;
}

function formatEntry(h) {
  return {
    id: h._id.toString(),
    query: h.query,
    timestamp: h.timestamp,
    category: h.category,
    device: h.device,
    createdAt: h.createdAt
  };
}

/**
 * GET /api/history?page=&limit=&q=
 */
const getHistory = asyncHandler(async (req, res) => {
  const userId = resolveTargetUserId(req);
  const page = parsePage(req.query.page);
  const limit = parseLimit(req.query.limit, { def: 30, max: 100 });
  const search = sanitizeString(req.query.q, 100);

  const filter = { userId };
  if (search) {
    filter.query = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  }

  const [items, total] = await Promise.all([
    History.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    History.countDocuments(filter)
  ]);

  return sendSuccess(res, {
    history: items.map(formatEntry),
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
 * POST /api/history  { query }
 *
 * Search already records history automatically; this exists so the frontend
 * can record a query it did not route through /api/search.
 */
const addHistory = asyncHandler(async (req, res) => {
  const query = parseSearchQuery(req.body.query);
  if (!query) throw ApiError.badRequest('A non-empty "query" is required.');

  await analyticsService.recordHistory({ query, userId: req.user._id });

  const items = await History.find({ userId: req.user._id })
    .sort({ createdAt: -1 })
    .limit(30)
    .lean();

  return sendSuccess(res, { history: items.map(formatEntry) }, 201);
});

/**
 * DELETE /api/history/:id — deletes one entry the caller owns.
 */
const deleteHistoryItem = asyncHandler(async (req, res) => {
  const id = parseObjectId(req.params.id, 'id');

  // The userId in the filter is the authorization check: a mismatched owner
  // simply finds nothing to delete.
  const filter = { _id: id, userId: req.user._id };
  if (req.user.role === 'admin' && req.query.userId) {
    filter.userId = parseObjectId(String(req.query.userId), 'userId');
  }

  const deleted = await History.findOneAndDelete(filter);
  if (!deleted) {
    throw ApiError.notFound('History entry not found.');
  }

  const items = await History.find({ userId: filter.userId })
    .sort({ createdAt: -1 })
    .limit(30)
    .lean();
  return sendSuccess(res, { history: items.map(formatEntry), deletedId: id });
});

/**
 * DELETE /api/history — clears the caller's own history.
 */
const clearHistory = asyncHandler(async (req, res) => {
  const userId = resolveTargetUserId(req);

  const result = await History.deleteMany({ userId });
  logger.info('Search history cleared', { count: result.deletedCount });

  return sendSuccess(res, { history: [], deletedCount: result.deletedCount });
});

module.exports = { getHistory, addHistory, deleteHistoryItem, clearHistory };
