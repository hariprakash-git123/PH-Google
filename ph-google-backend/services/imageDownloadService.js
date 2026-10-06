const http = require('http');
const https = require('https');
const { config } = require('../config/env');
const { resolvePublicAddress } = require('../utils/publicAddress');

/**
 * Fetches one remote image so it can be handed to the browser as a download.
 *
 * This is the only place the API fetches an address a request supplied, so
 * it is deliberately narrow:
 *
 *   - http/https on the default ports only, no credentials in the URL;
 *   - the host must be a public name, and every address it resolves to must
 *     be public (utils/publicAddress.js) — loopback, private ranges, link-
 *     local/cloud-metadata and single-label names such as "redis" or
 *     "opensearch" are all refused;
 *   - the connection goes to the address that was checked, never back to
 *     DNS, so a name cannot answer differently the second time;
 *   - redirects are followed by hand and each hop is checked the same way;
 *   - the whole exchange has one deadline and one size limit;
 *   - what comes back must actually be an image: the bytes are recognised by
 *     their signature, whatever Content-Type the server claimed.
 *
 * Errors carry a code and a message written here — never the remote
 * server's text.
 */

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_PORT = { 'http:': '80', 'https:': '443' };

class ImageDownloadError extends Error {
  /**
   * @param {'invalid_url'|'blocked'|'upstream'|'not_image'|'too_large'|'timeout'|'network'|'redirects'} code
   * @param {string} message  safe to show and to log
   * @param {number} [upstreamStatus]
   */
  constructor(code, message, upstreamStatus) {
    super(message);
    this.name = 'ImageDownloadError';
    this.code = code;
    this.upstreamStatus = upstreamStatus || null;
  }
}

/** Recognises an image by its first bytes. SVG is left out: it can carry script. */
function sniffImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const hex = buffer.subarray(0, 4).toString('hex');
  const ascii = buffer.subarray(0, 12).toString('latin1');
  if (hex.startsWith('ffd8ff')) return { type: 'image/jpeg', ext: 'jpg' };
  if (hex === '89504e47') return { type: 'image/png', ext: 'png' };
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a'))
    return { type: 'image/gif', ext: 'gif' };
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP')
    return { type: 'image/webp', ext: 'webp' };
  if (ascii.slice(4, 12) === 'ftypavif' || ascii.slice(4, 12) === 'ftypavis') {
    return { type: 'image/avif', ext: 'avif' };
  }
  if (ascii.startsWith('BM')) return { type: 'image/bmp', ext: 'bmp' };
  if (hex === '49492a00' || hex === '4d4d002a') return { type: 'image/tiff', ext: 'tiff' };
  return null;
}

/**
 * Parses and checks an address before anything is resolved or fetched.
 * @returns {URL}
 * @throws {ImageDownloadError}
 */
function parseImageUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) {
    throw new ImageDownloadError('invalid_url', 'That is not a valid image address.');
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ImageDownloadError('invalid_url', 'That is not a valid image address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImageDownloadError(
      'invalid_url',
      'Only http and https image addresses can be downloaded.'
    );
  }
  if (url.username || url.password) {
    throw new ImageDownloadError('invalid_url', 'That is not a valid image address.');
  }
  if (url.port && url.port !== DEFAULT_PORT[url.protocol]) {
    throw new ImageDownloadError('blocked', 'That image address cannot be downloaded.');
  }
  return url;
}

/** One GET to an address already checked. Resolves with the response stream. */
function requestOnce(url, target, { signal, connect }) {
  return new Promise((resolve, reject) => {
    const secure =
      connect && connect.protocol ? connect.protocol === 'https:' : url.protocol === 'https:';
    const transport = secure ? https : http;
    const pinned = (hostname, options, callback) =>
      options && options.all
        ? callback(null, [{ address: target.address, family: target.family }])
        : callback(null, target.address, target.family);

    const request = transport.request(
      {
        method: 'GET',
        // `connect` exists for tests only: it sends the request to a local
        // stand-in after the address checks have run on the real target.
        host: connect ? connect.host : url.hostname.replace(/^\[|\]$/g, ''),
        port: connect ? connect.port : url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: {
          host: url.host,
          accept: 'image/*',
          'user-agent': config.crawler.userAgent,
          'accept-encoding': 'identity'
        },
        // The name is not resolved again: the socket goes to the address
        // that was checked. TLS still verifies the certificate for the name.
        lookup: connect ? undefined : pinned,
        agent: false,
        signal
      },
      resolve
    );
    request.on('error', reject);
    request.end();
  });
}

/** Reads a response body, refusing to hold more than `maxBytes`. */
function readBody(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.destroy();
      reject(new ImageDownloadError('too_large', 'That image is too large to download here.'));
      return;
    }
    const chunks = [];
    let size = 0;
    response.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        response.destroy();
        reject(new ImageDownloadError('too_large', 'That image is too large to download here.'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', reject);
  });
}

/**
 * @param {string} rawUrl
 * @param {Object} [options]
 * @param {Function} [options.lookup]   DNS lookup (tests)
 * @param {Function} [options.connect]  (url) => {host, port, protocol} (tests)
 * @param {Object} [options.settings]   overrides config.imageDownload (tests)
 * @returns {Promise<{buffer: Buffer, contentType: string, extension: string, finalUrl: string}>}
 * @throws {ImageDownloadError}
 */
async function fetchImage(rawUrl, options = {}) {
  const settings = { ...config.imageDownload, ...(options.settings || {}) };
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), settings.timeoutMs);

  try {
    let url = parseImageUrl(rawUrl);

    for (let hop = 0; hop <= settings.maxRedirects; hop += 1) {
      const target = await resolvePublicAddress(url.hostname, options.lookup);
      if (!target) {
        throw new ImageDownloadError('blocked', 'That image address cannot be downloaded.');
      }

      const response = await requestOnce(url, target, {
        signal: controller.signal,
        connect: options.connect ? options.connect(url) : null
      });

      if (REDIRECTS.has(response.statusCode)) {
        response.resume();
        const location = response.headers.location;
        if (!location) {
          throw new ImageDownloadError('upstream', 'The image could not be fetched from its site.');
        }
        let next;
        try {
          next = new URL(location, url);
        } catch {
          throw new ImageDownloadError('upstream', 'The image could not be fetched from its site.');
        }
        // Every hop is parsed and resolved again: a public address may not
        // redirect this server somewhere private.
        url = parseImageUrl(next.toString());
        continue;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        throw new ImageDownloadError(
          'upstream',
          'The image could not be fetched from its site.',
          response.statusCode
        );
      }

      const buffer = await readBody(response, settings.maxBytes);
      const image = sniffImage(buffer);
      if (!image) {
        throw new ImageDownloadError('not_image', 'That address did not return an image.');
      }
      return { buffer, contentType: image.type, extension: image.ext, finalUrl: url.toString() };
    }

    throw new ImageDownloadError('redirects', 'The image could not be fetched from its site.');
  } catch (error) {
    if (error instanceof ImageDownloadError) throw error;
    if (controller.signal.aborted) {
      throw new ImageDownloadError('timeout', 'The image took too long to download.');
    }
    throw new ImageDownloadError('network', 'The image could not be fetched from its site.');
  } finally {
    clearTimeout(deadline);
  }
}

module.exports = { fetchImage, parseImageUrl, sniffImage, ImageDownloadError };
