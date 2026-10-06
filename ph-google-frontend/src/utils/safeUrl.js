/**
 * Returns the URL when it is safe to put in a link, otherwise null.
 *
 * Only absolute http(s) addresses qualify. Anything else — `javascript:`,
 * `data:`, a relative path, a malformed string — is refused, so a source
 * link can only ever open a web page.
 */
export function safeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}
