const { hostnameOf } = require('../../utils/urlNormalizer');

/**
 * Field helpers shared by the SerpApi image, video and maps mappers.
 *
 * Everything a provider returns is untrusted: text is collapsed to plain
 * text (React escapes it again when rendering), URLs must be absolute
 * http(s), numbers must be finite. A field that fails is null — never a
 * guessed value.
 */

/** Plain text, whitespace collapsed, capped at `max` characters ('' when absent). */
function text(value, max = 300) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const clean = String(value).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max).trim()}…` : clean;
}

/** An absolute http(s) URL, or null. Rejects javascript:, data:, relative paths. */
function httpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** A finite number within [min, max], or null. Accepts numeric strings. */
function number(value, { min = -Infinity, max = Infinity } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** A positive integer, or null. */
function positiveInt(value) {
  const n = number(value, { min: 1 });
  return n === null ? null : Math.round(n);
}

/** The hostname without "www.", or ''. */
function domainOf(url) {
  return url ? hostnameOf(url).replace(/^www\./, '') : '';
}

module.exports = { text, httpUrl, number, positiveInt, domainOf };
