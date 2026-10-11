const trendingService = require('../services/trendingService');
const { sendSuccess, asyncHandler, ApiError } = require('../utils/apiResponse');
const logger = require('../utils/logger');

/**
 * GET /api/trending?region=IN
 *
 * Current trending searches for a country, for the homepage card. Always
 * answers 200 for a supported country: when the provider cannot be asked,
 * `trends` is the last good list (`stale: true`) or empty, with a `reason` —
 * never an error the homepage would have to handle.
 *
 * { region, updatedAt, trends: [{ title, query }], source, stale, reason? }
 */
const trending = asyncHandler(async (req, res) => {
  const requested = typeof req.query.region === 'string' ? req.query.region : '';
  const region = trendingService.resolveRegion(requested);
  if (!region) {
    throw ApiError.badRequest(
      `Unsupported "region". Use one of: ${[...trendingService.REGIONS].join(', ')}.`
    );
  }
  const outcome = await trendingService.getTrending(region);
  // Who supplied the card (LOG_LEVEL=debug): the provider, or nobody and why.
  logger.debug('Trending served', {
    region,
    servedBy: outcome.source,
    trends: outcome.trends.length,
    stale: outcome.stale,
    reason: outcome.reason
  });
  return sendSuccess(res, outcome);
});

module.exports = { trending };
