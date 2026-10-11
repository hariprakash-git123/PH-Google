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

/**
 * Returns the URL when it may be shown in an iframe: https, on one of the
 * given hosts (the players and map the backend builds embeds for); otherwise
 * null, and nothing is framed.
 *
 * @param {string} value
 * @param {string[]} hosts  exact host names, e.g. ['player.vimeo.com']
 */
export function safeEmbedUrl(value, hosts) {
  const url = safeHttpUrl(value);
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  return hosts.includes(parsed.hostname.toLowerCase()) ? url : null;
}
