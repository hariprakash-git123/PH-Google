const http = require('http');

/**
 * A local site made of the awkward answers a crawler has to handle well:
 * redirects of every kind, error statuses, things that are not pages, pages
 * in other encodings, and pages that say how they want to be treated.
 *
 * Kept apart from fixtureSite.js so that adding a case here cannot change
 * what the existing crawl tests count.
 *
 * `site.robots` ({status, body}), `site.sitemap` (XML or null), `site.hits`
 * (path -> count) and `site.times` (path -> request times) are the test's to
 * read and change.
 */

const html = (title, body = '', head = '') =>
  `<!DOCTYPE html><html lang="en"><head><title>${title}</title>${head}</head>` +
  `<body><h1>${title}</h1><p>${title} has enough text to be a real page for the indexer.</p>${body}</body></html>`;

const link = (...paths) => paths.map(p => `<a href="${p}">${p}</a>`).join(' ');

const DEFAULT_ROBOTS = 'User-agent: *\nDisallow: /private/\nCrawl-delay: 0\n';

async function startHardeningSite() {
  const site = {
    hits: {},
    // "host/path" -> count, for telling apart requests made to two hostnames
    hostHits: {},
    // hostname -> {status, body}: a robots.txt of its own for that hostname
    robotsByHost: {},
    // path -> the times it was requested, for checking the spacing of requests
    times: {},
    // Served at /sitemap.xml when set.
    sitemap: null,
    requestLog: [],
    robots: { status: 200, body: DEFAULT_ROBOTS },
    // Bytes the server managed to write for the large binary responses.
    sent: {},
    flaky: {}
  };

  const page = (
    res,
    body,
    { status = 200, type = 'text/html; charset=utf-8', headers = {} } = {}
  ) => {
    res.writeHead(status, { 'Content-Type': type, ...headers });
    res.end(body);
  };

  const redirect = (res, location, status = 302) => {
    res.writeHead(status, location === null ? {} : { Location: location });
    res.end();
  };

  /** Streams `total` bytes, stopping as soon as the client hangs up. */
  const stream = (res, path, type, total) => {
    res.writeHead(200, { 'Content-Type': type });
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    site.sent[path] = 0;
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const pump = () => {
      while (!closed && site.sent[path] < total) {
        site.sent[path] += chunk.length;
        if (!res.write(chunk)) {
          res.once('drain', pump);
          return;
        }
      }
      if (!closed) res.end();
    };
    pump();
  };

  const BINARY = {
    '/bin/pdf': 'application/pdf',
    '/bin/image': 'image/png',
    '/bin/video': 'video/mp4',
    '/bin/audio': 'audio/mpeg',
    '/bin/zip': 'application/zip',
    '/bin/json': 'application/json',
    '/bin/text': 'text/plain; charset=utf-8',
    '/bin/xml': 'application/xml'
  };
  site.BINARY_BYTES = 40 * 1024 * 1024;

  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    site.hits[path] = (site.hits[path] || 0) + 1;
    site.requestLog.push(path);
    (site.times[path] = site.times[path] || []).push(Date.now());
    const origin = `http://127.0.0.1:${server.address().port}`;
    const otherHost = `http://localhost:${server.address().port}`;

    // The name the request was addressed to: one server, several hostnames.
    const reqHost = String(req.headers.host || '')
      .split(':')[0]
      .toLowerCase();
    site.hostHits[`${reqHost}${path}`] = (site.hostHits[`${reqHost}${path}`] || 0) + 1;

    if (path === '/robots.txt') {
      const robots = site.robotsByHost[reqHost] || site.robots;
      return page(res, robots.body, { status: robots.status, type: 'text/plain' });
    }

    // --- one page, two hostnames ------------------------------------------
    // The bare hostname redirects to its www. twin, as sites commonly do.
    // /xhost/ping redirects back again, for ever.
    if (path.startsWith('/xhost/')) {
      const www = reqHost.startsWith('www.');
      const port = server.address().port;
      const twin = www ? reqHost.slice(4) : `www.${reqHost}`;
      if (path === '/xhost/ping' || !www) {
        return redirect(res, `http://${twin}:${port}${path}`, 301);
      }
      return page(res, html(`Cross Host ${path}`));
    }

    if (path === '/sitemap.xml' && site.sitemap) {
      return page(res, site.sitemap, { type: 'application/xml' });
    }

    // --- redirects ------------------------------------------------------
    if (path === '/redir/same') return redirect(res, '/final');
    if (path === '/redir/absolute') return redirect(res, `${origin}/final`, 301);
    if (path === '/redir/chain1') return redirect(res, '/redir/chain2');
    if (path === '/redir/chain2') return redirect(res, '/redir/chain3', 307);
    if (path === '/redir/chain3') return redirect(res, '/final', 308);
    if (path === '/redir/loop-a') return redirect(res, '/redir/loop-b');
    if (path === '/redir/loop-b') return redirect(res, '/redir/loop-a');
    if (path === '/redir/self') return redirect(res, '/redir/self');
    if (path.startsWith('/redir/many/')) {
      return redirect(res, `/redir/many/${Number(path.split('/').pop()) + 1}`);
    }
    if (path === '/redir/cross') return redirect(res, `${otherHost}/elsewhere`);
    if (path === '/redir/cross-asset') return redirect(res, `${otherHost}/file.pdf`);
    if (path === '/redir/private') return redirect(res, '/private/secret');
    if (path === '/redir/excluded') return redirect(res, '/excluded/page');
    if (path === '/redir/no-location') return redirect(res, null);
    if (path === '/redir/mailto') return redirect(res, 'mailto:someone@example.com');
    if (path === '/redir/to-pdf') return redirect(res, '/bin/pdf');
    if (path === '/redir/to-404') return redirect(res, '/status/404');

    // --- statuses ---------------------------------------------------------
    if (path.startsWith('/status/')) {
      const status = Number(path.split('/').pop());
      const headers = {};
      if (status === 503) headers['Retry-After'] = '120';
      if (status === 429) headers['Retry-After'] = '7';
      return page(res, html(`Status ${status}`), { status, headers });
    }
    if (path === '/retry-after-date') {
      return page(res, 'busy', {
        status: 503,
        headers: { 'Retry-After': new Date(Date.now() + 90 * 1000).toUTCString() }
      });
    }
    if (path === '/retry-after-huge') {
      return page(res, 'busy', { status: 503, headers: { 'Retry-After': '999999' } });
    }
    if (path === '/flaky') {
      site.flaky[path] = (site.flaky[path] || 0) + 1;
      if (site.flaky[path] === 1) return page(res, 'try again', { status: 500 });
      return page(res, html('Flaky Recovered'));
    }

    // --- not pages --------------------------------------------------------
    if (BINARY[path]) return stream(res, path, BINARY[path], site.BINARY_BYTES);
    if (path === '/no-content-type') {
      res.writeHead(200);
      return res.end('<html><body>no type</body></html>');
    }
    if (path === '/huge-declared') {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Length': String(site.BINARY_BYTES)
      });
      return res.end();
    }
    if (path === '/huge-html') return stream(res, path, 'text/html', site.BINARY_BYTES);
    if (path === '/empty') return page(res, '');
    if (path === '/blank') return page(res, '   \n  ');

    // --- pages --------------------------------------------------------------
    if (path === '/xhtml') {
      return page(res, html('XHTML Page'), { type: 'application/xhtml+xml' });
    }
    if (path === '/upper-type') return page(res, html('Upper Type'), { type: 'TEXT/HTML' });
    if (path === '/latin1') {
      return page(res, Buffer.from(html('Café crème'), 'latin1'), {
        type: 'text/html; charset=ISO-8859-1'
      });
    }
    if (path === '/meta-charset') {
      const body = html('Straße', '', '<meta charset="windows-1252">');
      return page(res, Buffer.from(body, 'latin1'), { type: 'text/html' });
    }
    if (path === '/bad-charset') {
      return page(res, html('Bad Charset'), { type: 'text/html; charset=not-a-real-charset' });
    }

    // robots directives
    if (path === '/noindex') {
      return page(
        res,
        html('Noindex Page', link('/from-noindex'), '<meta name="robots" content="noindex">')
      );
    }
    if (path === '/nofollow-page') {
      return page(
        res,
        html('Nofollow Page', link('/hidden'), '<meta name="robots" content="nofollow">')
      );
    }
    if (path === '/none') {
      return page(res, html('None Page', link('/hidden'), '<meta name="robots" content="none">'));
    }
    if (path === '/header-noindex') {
      return page(res, html('Header Noindex', link('/from-noindex')), {
        headers: { 'X-Robots-Tag': 'noindex' }
      });
    }
    if (path === '/header-other-bot') {
      return page(res, html('Header Other Bot'), {
        headers: { 'X-Robots-Tag': 'googlebot: noindex, nofollow' }
      });
    }
    if (path === '/header-our-bot') {
      return page(res, html('Header Our Bot'), {
        headers: { 'X-Robots-Tag': 'PH-SearchBot: noindex' }
      });
    }
    if (path === '/header-two') {
      res.writeHead(200, [
        ['Content-Type', 'text/html'],
        ['X-Robots-Tag', 'googlebot: noindex'],
        ['X-Robots-Tag', 'nofollow']
      ]);
      return res.end(html('Header Two', link('/hidden')));
    }

    // canonical
    const canonical = href => `<link rel="canonical" href="${href}">`;
    if (path === '/canon/abs') {
      return page(res, html('Canon Abs', '', canonical(`${origin}/canon/target`)));
    }
    if (path === '/canon/rel') return page(res, html('Canon Rel', '', canonical('target')));
    if (path === '/canon/self') return page(res, html('Canon Self', '', canonical('/canon/self')));
    if (path === '/canon/outside') {
      return page(res, html('Canon Outside', '', canonical('https://elsewhere.test/item')));
    }
    if (path === '/canon/excluded') {
      return page(res, html('Canon Excluded', '', canonical('/excluded/page')));
    }
    if (path === '/canon/malformed') {
      return page(res, html('Canon Malformed', '', canonical('http://[bad')));
    }
    if (path === '/canon/multi') {
      return page(
        res,
        html('Canon Multi', '', canonical('/canon/target') + canonical('/canon/other'))
      );
    }
    if (path === '/canon/dup') {
      return page(
        res,
        html('Canon Dup', '', canonical('/canon/target') + canonical('/canon/target'))
      );
    }
    if (path === '/canon/header') {
      return page(res, html('Canon Header'), {
        headers: { Link: '</canon/target>; rel="canonical"' }
      });
    }
    if (path === '/canon/nofollow') {
      return page(
        res,
        html(
          'Canon Nofollow',
          link('/hidden'),
          canonical('/canon/target') + '<meta name="robots" content="nofollow">'
        )
      );
    }

    // plain pages
    const PLAIN = {
      '/': html('Home', link('/final', '/redir/same')),
      '/final': html('Final Page'),
      '/elsewhere': html('Elsewhere'),
      '/excluded/page': html('Excluded Page'),
      '/private/secret': html('Private'),
      '/canon/target': html('Canon Target'),
      '/canon/other': html('Canon Other'),
      '/from-noindex': html('From Noindex'),
      '/hidden': html('Hidden'),
      '/hub': html('Hub', link('/final', '/redir/same', '/status/404', '/noindex')),
      '/busy-hub': html('Busy Hub', link('/status/503', '/final', '/elsewhere'))
    };
    if (PLAIN[path]) return page(res, PLAIN[path]);

    return page(res, html('Not Found'), { status: 404 });
  });

  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return Object.assign(site, {
    port,
    url: `http://127.0.0.1:${port}`,
    otherHostUrl: `http://localhost:${port}`,
    DEFAULT_ROBOTS,
    reset() {
      site.hits = {};
      site.hostHits = {};
      site.robotsByHost = {};
      site.times = {};
      site.sitemap = null;
      site.requestLog.length = 0;
      site.sent = {};
      site.flaky = {};
      site.robots = { status: 200, body: DEFAULT_ROBOTS };
    },
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
      })
  });
}

module.exports = { startHardeningSite };
