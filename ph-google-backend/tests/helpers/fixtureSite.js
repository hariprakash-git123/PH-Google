const http = require('http');

/**
 * A tiny local website used by the crawler tests.
 *
 * Automated tests must never depend on a real external site, so the crawler
 * is pointed at this server instead. It deliberately includes the awkward
 * cases the crawler has to survive: a robots.txt with a Disallow rule, a
 * 404, a redirect, a non-HTML response, relative and absolute links,
 * duplicate links and an off-site link.
 */

const PAGES = {
  '/': {
    status: 200,
    type: 'text/html; charset=utf-8',
    body: `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Fixture Home - Search Engine Testing</title>
  <meta name="description" content="The home page of the crawler fixture site about search engines.">
  <meta name="keywords" content="fixture, search, crawler">
  <style>body { color: #333 }</style>
  <script>console.log('should never be indexed');</script>
</head>
<body>
  <h1>Search Engine Fixture</h1>
  <p>This fixture site exists to test the crawler pipeline end to end. It talks about search engines, indexing and ranking.</p>
  <a href="/about">About this fixture</a>
  <a href="/about">About this fixture (duplicate link)</a>
  <a href="about">About again, relative</a>
  <a href="/blog/indexing">How indexing works</a>
  <a href="/private/secret">Disallowed by robots</a>
  <a href="/missing">Broken link</a>
  <a href="/redirect-me">Redirected page</a>
  <a href="/data.json">Not HTML</a>
  <a href="#section">Fragment only</a>
  <a href="mailto:someone@example.com">Mail link</a>
  <a href="https://external.example.org/page">Off-site link</a>
  <a href="/nofollow" rel="nofollow">Nofollow link</a>
</body>
</html>`
  },

  '/about': {
    status: 200,
    type: 'text/html; charset=utf-8',
    body: `<!DOCTYPE html>
<html lang="en">
<head>
  <title>About the Fixture Site</title>
  <meta name="description" content="Background on the fixture site used for crawler tests.">
</head>
<body>
  <h1>About</h1>
  <p>The fixture site is served from memory during tests. Crawling it requires no network access.</p>
  <a href="/">Home</a>
</body>
</html>`
  },

  '/blog/indexing': {
    status: 200,
    type: 'text/html; charset=utf-8',
    body: `<!DOCTYPE html>
<html lang="en">
<head>
  <title>How Indexing Works</title>
  <meta name="description" content="An explanation of inverted indexes and term frequency.">
</head>
<body>
  <h1>Indexing</h1>
  <p>An inverted index maps each term to the documents containing it. Term frequency drives the ranking score.</p>
  <p>Indexing indexing indexing: this word is repeated so frequency scoring is observable.</p>
  <a href="/">Home</a>
</body>
</html>`
  },

  '/private/secret': {
    status: 200,
    type: 'text/html; charset=utf-8',
    body: '<html lang="en"><head><title>Secret</title></head><body><p>robots.txt disallows this path.</p></body></html>'
  },

  '/nofollow': {
    status: 200,
    type: 'text/html; charset=utf-8',
    body: '<html lang="en"><head><title>Nofollow Target</title></head><body><p>Reached only if nofollow is ignored.</p></body></html>'
  },

  '/redirect-target': {
    status: 200,
    type: 'text/html; charset=utf-8',
    body: `<html lang="en">
<head><title>Redirect Target</title><meta name="description" content="The page a redirect lands on."></head>
<body><p>This page was reached through a 302 redirect.</p></body>
</html>`
  },

  '/data.json': {
    status: 200,
    type: 'application/json',
    body: '{"not":"html"}'
  }
};

const ROBOTS = `User-agent: *
Disallow: /private/
Crawl-delay: 0
`;

/**
 * Starts the fixture server on an ephemeral port.
 *
 * With `{ sitemaps: true }` the site also serves sitemap files: `site.robots`
 * (the robots.txt text) and `site.files` (path -> {status, type, body}) are
 * then the test's to change, and start out as a robots.txt naming
 * /sitemap.xml and a sitemap listing the fixture's pages. Without it the
 * site is exactly what it always was.
 *
 * @returns {Promise<{url: string, port: number, close: Function, requestLog: Array,
 *                    robots?: string, files?: Object}>}
 */
async function startFixtureSite({ sitemaps = false } = {}) {
  const requestLog = [];
  const site = { requestLog };

  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    requestLog.push({
      path,
      host: req.headers.host || '',
      userAgent: req.headers['user-agent'] || ''
    });

    if (path === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(sitemaps ? site.robots : ROBOTS);
      return;
    }

    if (sitemaps && site.files[path]) {
      const file = site.files[path];
      res.writeHead(file.status || 200, { 'Content-Type': file.type || 'application/xml' });
      res.end(file.body);
      return;
    }

    if (path === '/redirect-me') {
      res.writeHead(302, { Location: '/redirect-target' });
      res.end();
      return;
    }

    const page = PAGES[path];
    if (!page) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>404 Not Found</h1></body></html>');
      return;
    }

    res.writeHead(page.status, { 'Content-Type': page.type });
    res.end(page.body);
  });

  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;

  if (sitemaps) {
    site.robots = `${ROBOTS}Sitemap: ${url}/sitemap.xml\n`;
    site.files = {
      '/sitemap.xml': { body: urlsetXml(['/', '/about', '/blog/indexing'].map(p => `${url}${p}`)) }
    };
  }

  return Object.assign(site, {
    port,
    url,
    close: () =>
      new Promise(resolve => {
        server.close(resolve);
      })
  });
}

/**
 * A <urlset> document. Entries are URLs, or {loc, lastmod} pairs.
 */
function urlsetXml(entries) {
  const items = entries
    .map(e => (typeof e === 'string' ? { loc: e } : e))
    .map(
      ({ loc, lastmod }) =>
        `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`
    );
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="${SITEMAP_NS}">${items.join('')}</urlset>`;
}

/** A <sitemapindex> document listing the given sitemap URLs. */
function sitemapIndexXml(locs) {
  const items = locs.map(loc => `<sitemap><loc>${loc}</loc></sitemap>`);
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="${SITEMAP_NS}">${items.join('')}</sitemapindex>`;
}

const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9';

module.exports = { startFixtureSite, PAGES, ROBOTS, urlsetXml, sitemapIndexXml };
