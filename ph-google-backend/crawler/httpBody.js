/**
 * Reading and decoding a response body the crawler asked for as a stream.
 *
 * Asking for a stream is what lets the fetchers look at the status and the
 * headers first and decide whether the body is worth downloading at all.
 */

/**
 * Reads a stream into a buffer, up to `limit` bytes.
 *
 * @param {import('stream').Readable} stream
 * @param {number} limit
 * @param {Object} [options]
 * @param {boolean} [options.truncate=false] keep the first `limit` bytes of a
 *   longer body instead of reporting it as too large
 * @param {number} [options.timeoutMs] give up when the whole body has not
 *   arrived in this long
 * @returns {Promise<{buffer: Buffer, tooLarge: boolean, truncated: boolean}>}
 */
function readCapped(stream, limit, { truncate = false, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let timer = null;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const error = new Error('Body read timed out');
        error.code = 'ETIMEDOUT';
        stream.destroy();
        finish(error);
      }, timeoutMs);
    }

    stream.on('data', chunk => {
      if (settled) return;
      if (size + chunk.length > limit) {
        if (truncate) chunks.push(chunk.subarray(0, limit - size));
        stream.destroy();
        finish(null, {
          buffer: truncate ? Buffer.concat(chunks) : Buffer.alloc(0),
          tooLarge: !truncate,
          truncated: truncate
        });
        return;
      }
      size += chunk.length;
      chunks.push(chunk);
    });
    stream.on('end', () =>
      finish(null, { buffer: Buffer.concat(chunks), tooLarge: false, truncated: false })
    );
    stream.on('error', error => finish(error));
  });
}

/** Stops a response we do not want without reading it. */
function discard(stream) {
  if (stream && typeof stream.destroy === 'function') stream.destroy();
}

/** The charset a Content-Type header names, lowercased, or ''. */
function charsetFromContentType(contentType) {
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(String(contentType || ''));
  return match ? match[1].toLowerCase() : '';
}

/**
 * The charset an HTML document declares for itself, read from its first
 * bytes: `<meta charset="...">` or the older http-equiv form.
 */
function charsetFromHtmlPrefix(buffer) {
  const head = buffer.subarray(0, 2048).toString('latin1');
  const match =
    /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_\-:.]+)/i.exec(head) ||
    /<\?xml[^>]+encoding\s*=\s*["']([a-z0-9_\-:.]+)/i.exec(head);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Decodes an HTML body. The header's charset wins, then the document's own
 * declaration, then UTF-8. A label this runtime does not know falls back to
 * UTF-8 rather than failing the page.
 */
function decodeHtml(buffer, contentType) {
  const label = charsetFromContentType(contentType) || charsetFromHtmlPrefix(buffer) || 'utf-8';
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

module.exports = { readCapped, discard, decodeHtml, charsetFromContentType };
