const { resolvePublicAddress } = require('../../utils/publicAddress');
const { requestOnce, parseImageUrl } = require('../imageDownloadService');

/**
 * One GET to an address that came from somewhere else — a search provider's
 * result, or a page that result pointed at — under the same rules as the
 * image download (services/imageDownloadService.js):
 *
 *   - http/https on the default ports, no credentials in the URL;
 *   - public hosts only, and the connection goes to the address that was
 *     checked, so a name cannot answer differently the second time;
 *   - redirects are followed by hand and every hop is checked the same way;
 *   - one deadline for the whole exchange, and no more than `maxBytes` of
 *     the body is ever held.
 *
 * Never throws: a fetch that cannot be made, or goes wrong, is `{ ok: false,
 * reason }`. The caller is inspecting other people's pages at query time, and
 * one that does not load is an everyday event, not an error.
 */

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

/** Reads up to `maxBytes` of a body, then lets go of the connection. */
function readUpTo(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = truncated => {
      if (done) return;
      done = true;
      resolve({ buffer: Buffer.concat(chunks).subarray(0, maxBytes), truncated });
    };
    response.on('data', chunk => {
      if (done) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size >= maxBytes) {
        finish(true);
        response.destroy();
      }
    });
    response.on('end', () => finish(false));
    response.on('close', () => finish(size >= maxBytes));
    response.on('error', error => (done ? undefined : reject(error)));
  });
}

/**
 * @param {string} rawUrl
 * @param {Object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]   body bytes kept; the rest is not read
 * @param {string} [options.accept]     the Accept header
 * @param {Function} [options.lookup]   DNS lookup (tests)
 * @param {Function} [options.connect]  (url) => {host, port, protocol} (tests)
 * @returns {Promise<{ok: true, status: number, headers: Object, buffer: Buffer,
 *                    truncated: boolean, finalUrl: string}
 *                  | {ok: false, reason: string, status?: number}>}
 */
async function get(rawUrl, options = {}) {
  const { timeoutMs = 4000, maxBytes = 1024 * 1024, accept = '*/*' } = options;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let url;
    try {
      url = parseImageUrl(rawUrl);
    } catch {
      return { ok: false, reason: 'invalid_url' };
    }

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const target = await resolvePublicAddress(url.hostname, options.lookup);
      if (!target) return { ok: false, reason: 'blocked' };

      const response = await requestOnce(url, target, {
        signal: controller.signal,
        connect: options.connect ? options.connect(url) : null,
        accept
      });

      if (REDIRECTS.has(response.statusCode)) {
        response.resume();
        try {
          url = parseImageUrl(new URL(response.headers.location || '', url).toString());
        } catch {
          return { ok: false, reason: 'bad_redirect' };
        }
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        return { ok: false, reason: 'upstream', status: response.statusCode };
      }

      const { buffer, truncated } = await readUpTo(response, maxBytes);
      return {
        ok: true,
        status: response.statusCode,
        headers: response.headers,
        buffer,
        truncated,
        finalUrl: url.toString()
      };
    }
    return { ok: false, reason: 'redirects' };
  } catch {
    return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(deadline);
  }
}

module.exports = { get };
