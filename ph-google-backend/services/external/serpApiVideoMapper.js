const { sha1 } = require('../opensearch/documentMapper');
const { canonicalKey } = require('../../utils/urlNormalizer');
const { readDate } = require('./serpApiMapper');
const { text, httpUrl, positiveInt, domainOf } = require('./fields');

/**
 * SerpApi Google Videos (`video_results`) → the video result schema:
 *
 *   { id, title, thumbnailUrl, videoUrl, sourceUrl, sourceDomain,
 *     sourceName, duration, publishedAt, publishedAgo, snippet, position,
 *     source: 'serpapi' }
 *
 * Results link out to the original page; nothing is embedded or stored.
 */

/** "4:05", "1:02:33" — Google's own duration labels. Anything else is dropped. */
const DURATION = /^\d{1,2}(?::\d{2}){1,2}$/;

/** SerpApi gives the thumbnail as a URL, or occasionally as { static, rich }. */
function thumbnailOf(raw) {
  if (typeof raw.thumbnail === 'string') return httpUrl(raw.thumbnail);
  if (raw.thumbnail && typeof raw.thumbnail === 'object') {
    return httpUrl(raw.thumbnail.static) || httpUrl(raw.thumbnail.rich);
  }
  return null;
}

/**
 * @param {Object} raw  one entry of `video_results`
 * @param {number} index  its position in the list (fallback for `position`)
 * @returns {Object|null}
 */
function mapVideoResult(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;

  const sourceUrl = httpUrl(raw.link);
  if (!sourceUrl) return null;
  // SerpApi's `video_link` is Google's short preview clip, not the video:
  // a result always opens the page the video is on.
  const videoUrl = sourceUrl;
  const duration = text(raw.duration, 12);
  const date = readDate(raw.date);
  const channel = raw.channel && typeof raw.channel === 'object' ? raw.channel.name : raw.channel;

  return {
    id: `serpapi-video:${sha1(canonicalKey(sourceUrl) || sourceUrl)}`,
    title: text(raw.title, 200) || domainOf(sourceUrl),
    thumbnailUrl: thumbnailOf(raw),
    videoUrl,
    sourceUrl,
    sourceDomain: domainOf(sourceUrl),
    sourceName: text(raw.source || channel, 100),
    duration: DURATION.test(duration) ? duration : null,
    publishedAt: date.publishedAt,
    publishedAgo: date.publishedAgo === 'Unknown' ? null : date.publishedAgo,
    snippet: text(raw.snippet, 240),
    position: positiveInt(raw.position) || index + 1,
    source: 'serpapi'
  };
}

/** Maps a list, keeping SerpApi's order and the first copy of each video. */
function mapVideoResults(rawResults) {
  const seen = new Set();
  const out = [];
  (Array.isArray(rawResults) ? rawResults : []).forEach((raw, i) => {
    const video = mapVideoResult(raw, i);
    if (!video || seen.has(video.id)) return;
    seen.add(video.id);
    out.push(video);
  });
  return out;
}

module.exports = { mapVideoResult, mapVideoResults };
