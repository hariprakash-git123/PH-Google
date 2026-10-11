const { asyncHandler, sendSuccess, sendError } = require('../utils/apiResponse');
const embedCheckService = require('../services/embedCheckService');

/**
 * GET /api/embed-check?url=
 *
 * Says whether a web page may be shown in a frame, for the in-app browser
 * tabs: `{ embeddable: true | false | null, reason? }` (`null`: could not be
 * found out). Only the site's response headers are read; no part of the
 * page is returned. See services/embedCheckService.js.
 */
const check = asyncHandler(async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url) return sendError(res, '"url" is required.', 400);

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  return sendSuccess(res, await embedCheckService.check(url, { origin }));
});

module.exports = { check };
