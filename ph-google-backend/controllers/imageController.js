const { asyncHandler, sendError } = require('../utils/apiResponse');
const { verifyUrl } = require('../utils/urlSigner');
const { hostnameOf } = require('../utils/urlNormalizer');
const { DOWNLOAD_PURPOSE } = require('../services/external/serpApiImageMapper');
const imageDownloadService = require('../services/imageDownloadService');
const { ImageDownloadError } = require('../services/imageDownloadService');
const logger = require('../utils/logger');

/** What each failure becomes for the browser. */
const STATUS = {
  invalid_url: 400,
  blocked: 400,
  not_image: 415,
  too_large: 413,
  timeout: 504,
  upstream: 502,
  network: 502,
  redirects: 502
};

/**
 * A file name that is safe in a Content-Disposition header and on disk:
 * letters, digits, spaces, dots, hyphens and underscores only.
 */
function safeFileName(name, extension) {
  const base = String(name || '')
    .normalize('NFKD')
    .replace(/[^\w .-]+/g, ' ')
    // No ".." in a file name, even with the slashes already gone.
    .replace(/\.{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '')
    .slice(0, 80)
    .trim();
  return `${base || 'image'}.${extension}`;
}

/**
 * GET /api/images/download?url=&sig=&name=
 *
 * Returns one image from the image search results as a file download.
 *
 * `url` must carry the signature (`sig`) this server put on it in the search
 * response (`downloadToken`), so the endpoint cannot be pointed at an
 * arbitrary address. The fetch itself is restricted to public hosts and real
 * images — see services/imageDownloadService.js.
 */
const download = asyncHandler(async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  const signature = typeof req.query.sig === 'string' ? req.query.sig : '';
  const name = typeof req.query.name === 'string' ? req.query.name : '';

  // Failures are answered here rather than thrown to the shared error
  // handler, which logs the request URL — and this URL carries the image
  // address, which may hold tokens of its own.
  if (!url) return sendError(res, '"url" is required.', 400);
  if (!verifyUrl(DOWNLOAD_PURPOSE, url, signature)) {
    return sendError(res, 'This image address was not issued by image search.', 403);
  }

  let image;
  try {
    image = await imageDownloadService.fetchImage(url);
  } catch (error) {
    if (!(error instanceof ImageDownloadError)) throw error;
    // The host only: an image address can carry tokens in its path or query.
    logger.warn('Image download failed', {
      reason: error.code,
      host: hostnameOf(url),
      upstreamStatus: error.upstreamStatus || undefined
    });
    return sendError(res, error.message, STATUS[error.code] || 502);
  }

  const fileName = safeFileName(name, image.extension);
  res.set({
    'Content-Type': image.contentType,
    'Content-Length': String(image.buffer.length),
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store'
  });
  return res.status(200).end(image.buffer);
});

module.exports = { download, safeFileName };
