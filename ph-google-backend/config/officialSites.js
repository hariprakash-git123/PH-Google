/**
 * Official websites for searches that name a site or service and nothing
 * else ("youtube", "gmail", "google maps"): a navigational search, where the
 * person wants to go to that site.
 *
 * Each entry lists what people type for it and where its official site is.
 * Only sites whose official addresses are well established belong here; a
 * search for anything not listed is ranked exactly as before.
 *
 *   host       the site's own host name; "www." is ignored when comparing
 *   subdomains true when any subdomain of it is also the official site
 *              (m.youtube.com, music.youtube.com) — never for a host that
 *              many unrelated services share, such as google.com
 *   path       when only part of a host is the official site
 *              (google.com/maps is Maps; google.com/search is not)
 *
 * To add a site: its names, lower case, and its official addresses. A brand
 * that is only a common word ("apple", "amazon") is still a clear search
 * for its site when typed on its own, which is the only case this covers.
 */
module.exports = [
  {
    names: ['youtube', 'you tube'],
    sites: [{ host: 'youtube.com', subdomains: true }, { host: 'youtu.be' }]
  },
  {
    names: ['gmail', 'google mail'],
    sites: [
      { host: 'gmail.com', subdomains: true },
      { host: 'mail.google.com' },
      { host: 'google.com', path: '/gmail' }
    ]
  },
  {
    names: ['google maps', 'maps google'],
    sites: [
      { host: 'maps.google.com' },
      { host: 'google.com', path: '/maps' },
      { host: 'google.co.in', path: '/maps' },
      { host: 'google.co.uk', path: '/maps' }
    ]
  },
  { names: ['google'], sites: [{ host: 'google.com' }, { host: 'google.co.in' }] },
  { names: ['github'], sites: [{ host: 'github.com' }] },
  { names: ['wikipedia'], sites: [{ host: 'wikipedia.org', subdomains: true }] },
  { names: ['stack overflow', 'stackoverflow'], sites: [{ host: 'stackoverflow.com' }] },
  { names: ['facebook'], sites: [{ host: 'facebook.com', subdomains: true }] },
  { names: ['instagram'], sites: [{ host: 'instagram.com' }] },
  { names: ['linkedin'], sites: [{ host: 'linkedin.com', subdomains: true }] },
  { names: ['reddit'], sites: [{ host: 'reddit.com', subdomains: true }] },
  { names: ['twitter', 'x twitter'], sites: [{ host: 'x.com' }, { host: 'twitter.com' }] },
  { names: ['whatsapp', 'whatsapp web'], sites: [{ host: 'whatsapp.com', subdomains: true }] },
  { names: ['netflix'], sites: [{ host: 'netflix.com' }] },
  { names: ['spotify'], sites: [{ host: 'spotify.com', subdomains: true }] },
  { names: ['amazon'], sites: [{ host: 'amazon.in' }, { host: 'amazon.com' }] },
  { names: ['flipkart'], sites: [{ host: 'flipkart.com' }] },
  { names: ['microsoft'], sites: [{ host: 'microsoft.com' }] },
  { names: ['apple'], sites: [{ host: 'apple.com' }] },
  { names: ['openstreetmap'], sites: [{ host: 'openstreetmap.org' }] },
  { names: ['mozilla', 'firefox'], sites: [{ host: 'mozilla.org' }] }
];
