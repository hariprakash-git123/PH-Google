const aiAnswerService = require('../services/ai/aiAnswerService');
const AiAnswerFeedback = require('../models/AiAnswerFeedback');
const { sendSuccess, asyncHandler, ApiError } = require('../utils/apiResponse');
const {
  parseSearchQuery,
  parseEnum,
  parseDomain,
  parseLanguage,
  sanitizeString,
  DATE_OPTIONS
} = require('../utils/validators');
const { config } = require('../config/env');

const RATINGS = ['up', 'down'];

/** Optional cap on sources, never above the server's own limit. */
function parseMaxSources(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw ApiError.badRequest('"sources" must be a positive whole number.');
  }
  return Math.min(n, config.ai.maxSources);
}

/**
 * GET /api/ai-answer?q=&domain=&language=&date=&sources=&refresh=
 *
 * An answer to the query written from the documents the search engine
 * retrieves for it, with the sources it cites. Takes the same filters as
 * /api/search, validated by the same functions, so the answer is grounded
 * in the same results the page lists.
 *
 * Always 200 for a valid request: `status` says whether there is an answer
 * ("ok") or why not. A request that is itself wrong is a 400, and a search
 * engine outage is a 503, exactly as on /api/search.
 */
const getAnswer = asyncHandler(async (req, res) => {
  const query = parseSearchQuery(req.query.q);
  if (!query) throw ApiError.badRequest('"q" is required.');

  const dateWindow = parseEnum(req.query.date, DATE_OPTIONS, 'any', 'date');
  const domain = parseDomain(req.query.domain);
  const language = parseLanguage(req.query.language);
  const maxSources = parseMaxSources(req.query.sources);
  const refresh = req.query.refresh === 'true' || req.query.refresh === '1';

  const answer = await aiAnswerService.answerQuery({
    query,
    domain,
    language,
    dateWindow,
    maxSources,
    refresh
  });

  return sendSuccess(res, answer);
});

/**
 * POST /api/ai-answer/feedback  { answerId, query, rating, comment?, model?, provider? }
 *
 * Records whether an answer was useful. Works for guests; a signed-in user's
 * feedback is attached to their account. Sending it again for the same
 * answer changes the rating rather than adding a second row.
 */
const submitFeedback = asyncHandler(async (req, res) => {
  const answerId = sanitizeString(req.body.answerId, 64);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(answerId)) {
    throw ApiError.badRequest('"answerId" is required.');
  }
  const query = parseSearchQuery(req.body.query);
  if (!query) throw ApiError.badRequest('"query" is required.');

  const rating = sanitizeString(req.body.rating, 10).toLowerCase();
  if (!RATINGS.includes(rating)) {
    throw ApiError.badRequest(`"rating" must be one of: ${RATINGS.join(', ')}.`);
  }

  const userId = req.user ? req.user._id : null;
  const feedback = await AiAnswerFeedback.findOneAndUpdate(
    { answerId, userId },
    {
      $set: {
        query,
        normalizedQuery: query.toLowerCase(),
        rating,
        comment: sanitizeString(req.body.comment, 500),
        provider: sanitizeString(req.body.provider, 64),
        model: sanitizeString(req.body.model, 128)
      }
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  ).lean();

  return sendSuccess(res, { answerId: feedback.answerId, rating: feedback.rating }, 201);
});

module.exports = { getAnswer, submitFeedback };
