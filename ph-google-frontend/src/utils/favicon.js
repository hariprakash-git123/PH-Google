/**
 * The address of a website's own icon, for showing beside its search result.
 *
 * Every site may serve its icon at /favicon.ico on its own origin — the
 * convention browsers themselves fall back to — so the icon comes from the
 * site the result links to, not from a third-party favicon service that would
 * learn every domain a user's results contain. It works the same for the
 * index's results and for every external provider's, because it needs only
 * the result's URL.
 *
 * Only an absolute http(s) URL on a public-looking host qualifies. Anything
 * else — `javascript:`, `data:`, a relative path, credentials in the URL, a
 * bare name such as "localhost" or "router", an IP address — gives no icon
 * address at all, so a result can never make the browser fetch something on
 * the user's own machine or network. The caller shows the generic icon then,
 * and also when the site has no favicon or the image fails to load.
 *
 * @param {string} pageUrl  the result's URL
 * @returns {string|null}   e.g. "https://www.youtube.com/favicon.ico"
 */
export function faviconUrlFor(pageUrl) {
  if (typeof pageUrl !== 'string' || !pageUrl.trim()) return null;
  let url;
  try {
    url = new URL(pageUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;

  const host = url.hostname.toLowerCase();
  // A name with no dot is a machine on the local network, not a website.
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost')) return null;
  // IP addresses (IPv4, or IPv6 in brackets) are not looked up either.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return null;

  return `${url.origin}/favicon.ico`;
}
