const { text, httpUrl } = require('./fields');

/**
 * Video pages on the platforms this application can verify.
 *
 * A web-search provider returns addresses. An address is offered as a video
 * only when both of these hold:
 *
 *   - it has the shape of one video's page on a known platform — not a
 *     channel, a playlist, a hashtag or a search page, and not an article
 *     that happens to mention a video;
 *   - the platform itself confirms it. Each platform publishes an oEmbed
 *     endpoint that answers for a public video with its title, its channel
 *     and its thumbnail, and refuses one that is private, removed or made up.
 *
 * The oEmbed endpoints are fixed addresses on the platforms' own hosts, so
 * nothing a search result contains decides where this server connects.
 */

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

const PLATFORMS = {
  youtube: {
    label: 'YouTube',
    domains: ['youtube.com', 'youtu.be'],
    watchUrl: id => `https://www.youtube.com/watch?v=${id}`,
    oembed: url => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`
  },
  vimeo: {
    label: 'Vimeo',
    domains: ['vimeo.com'],
    watchUrl: id => `https://vimeo.com/${id}`,
    oembed: url => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`
  },
  dailymotion: {
    label: 'Dailymotion',
    domains: ['dailymotion.com'],
    watchUrl: id => `https://www.dailymotion.com/video/${id}`,
    oembed: url =>
      `https://www.dailymotion.com/services/oembed?format=json&url=${encodeURIComponent(url)}`
  }
};

/** The domains to restrict a video search to. */
const DOMAINS = Object.values(PLATFORMS).flatMap(platform => platform.domains);

/**
 * The video an address is the page of, or null.
 *
 * @param {string} rawUrl
 * @returns {{platform: string, id: string, key: string, videoUrl: string,
 *            label: string}|null}
 */
function parseVideoUrl(rawUrl) {
  const safe = httpUrl(rawUrl);
  if (!safe) return null;
  const url = new URL(safe);
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);

  let platform = null;
  let id = null;
  if (host === 'youtube.com') {
    if (parts[0] === 'watch' && parts.length === 1) id = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live'].includes(parts[0]) && parts.length === 2) id = parts[1];
    platform = 'youtube';
    if (!id || !YOUTUBE_ID.test(id)) return null;
  } else if (host === 'youtu.be') {
    platform = 'youtube';
    id = parts.length === 1 ? parts[0] : null;
    if (!id || !YOUTUBE_ID.test(id)) return null;
  } else if (host === 'vimeo.com') {
    platform = 'vimeo';
    // vimeo.com/123456789, or the same video listed under a channel.
    const last = parts[parts.length - 1];
    const direct = parts.length === 1 || (parts[0] === 'channels' && parts.length === 3);
    id = direct && /^\d{6,12}$/.test(last || '') ? last : null;
    if (!id) return null;
  } else if (host === 'dailymotion.com') {
    platform = 'dailymotion';
    id =
      parts[0] === 'video' && parts.length === 2 && /^[a-z0-9]{5,12}$/i.test(parts[1])
        ? parts[1]
        : null;
    if (!id) return null;
  } else {
    return null;
  }

  const { label, watchUrl } = PLATFORMS[platform];
  return { platform, id, key: `${platform}:${id}`, videoUrl: watchUrl(id), label };
}

/**
 * Asks the platform about one video.
 *
 * @param {{platform: string, videoUrl: string}} video  from parseVideoUrl
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.fetchImpl]  overrides global fetch (tests)
 * @returns {Promise<{ok: true, title: string, channel: string,
 *                    thumbnailUrl: string|null}
 *                  | {ok: false, reason: string}>}
 */
async function lookup(video, { timeoutMs = 3500, fetchImpl = fetch } = {}) {
  const platform = video && PLATFORMS[video.platform];
  if (!platform) return { ok: false, reason: 'unknown_platform' };

  let response;
  try {
    response = await fetchImpl(platform.oembed(video.videoUrl), {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { ok: false, reason: timedOut ? 'timeout' : 'network' };
  }
  // 401 private, 403 embedding off, 404 gone or never existed.
  if (!response.ok) return { ok: false, reason: 'not_confirmed' };

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'invalid_response' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'invalid_response' };
  }
  const title = text(body.title, 200);
  if (!title || (body.type && body.type !== 'video')) return { ok: false, reason: 'not_a_video' };

  return {
    ok: true,
    title,
    channel: text(body.author_name, 100),
    thumbnailUrl: httpUrl(body.thumbnail_url)
  };
}

module.exports = { parseVideoUrl, lookup, PLATFORMS, DOMAINS };
