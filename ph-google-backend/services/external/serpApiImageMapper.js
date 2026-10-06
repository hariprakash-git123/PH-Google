const { sha1 } = require('../opensearch/documentMapper');
const { signUrl } = require('../../utils/urlSigner');
const { text, httpUrl, positiveInt, domainOf } = require('./fields');

/** What the signature is for; the download endpoint checks the same value. */
const DOWNLOAD_PURPOSE = 'image-download';

/**
 * SerpApi Google Images (`images_results`) → the image result schema:
 *
 *   { id, title, imageUrl, thumbnailUrl, sourceUrl, sourceDomain,
 *     sourceName, width, height, position, downloadToken, source: 'serpapi' }
 *
 * `downloadToken` is this server's signature of `imageUrl`. The download
 * endpoint only fetches an address that comes with it, so it can serve the
 * images search returned and nothing else. Null when there is no full image.
 *
 * A result needs a thumbnail to show and somewhere to go when clicked (the
 * page it is on, or the image itself); anything else is dropped. Images are
 * not downloaded or stored — the browser loads the remote thumbnail.
 */

/**
 * @param {Object} raw  one entry of `images_results`
 * @param {number} index  its position in the list (fallback for `position`)
 * @returns {Object|null}
 */
function mapImageResult(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;

  const thumbnailUrl = httpUrl(raw.thumbnail);
  const imageUrl = httpUrl(raw.original);
  const sourceUrl = httpUrl(raw.link);
  if (!thumbnailUrl || !(sourceUrl || imageUrl)) return null;

  const position = positiveInt(raw.position) || index + 1;
  return {
    id: `serpapi-image:${sha1(imageUrl || thumbnailUrl)}`,
    title: text(raw.title, 200),
    imageUrl,
    thumbnailUrl,
    sourceUrl,
    sourceDomain: domainOf(sourceUrl || imageUrl),
    sourceName: text(raw.source, 100),
    width: positiveInt(raw.original_width),
    height: positiveInt(raw.original_height),
    position,
    downloadToken: imageUrl ? signUrl(DOWNLOAD_PURPOSE, imageUrl) : null,
    source: 'serpapi'
  };
}

/** Maps a list, keeping SerpApi's order and the first copy of each image. */
function mapImageResults(rawResults) {
  const seen = new Set();
  const out = [];
  (Array.isArray(rawResults) ? rawResults : []).forEach((raw, i) => {
    const image = mapImageResult(raw, i);
    if (!image || seen.has(image.id)) return;
    seen.add(image.id);
    out.push(image);
  });
  return out;
}

module.exports = { mapImageResult, mapImageResults, DOWNLOAD_PURPOSE };
