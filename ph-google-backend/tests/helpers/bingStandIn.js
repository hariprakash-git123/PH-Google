const http = require('http');

/**
 * A local stand-in for the RapidAPI Bing search endpoint, so no test ever
 * reaches the real service.
 *
 * Answers GET /api/rapid/web_search in the provider's own shape and records
 * every request — path, query and headers — so tests can check what was
 * sent and how the key travelled. `mode`:
 *
 *   ok         200 with `items`
 *   status     `status` with `body` (default a RapidAPI-style message)
 *   slow       waits `delayMs`, then answers ok
 *   malformed  200 with a body that is not JSON
 */

const items = (n, { host = 'bing.example', start = 1 } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    title: `Bing result ${start + i}`,
    link: `https://${host}/page-${start + i}`,
    description: `Description for Bing result ${start + i}.`,
    img: null
  }));

async function startBingStandIn() {
  const fresh = () => ({
    mode: 'ok',
    items: items(3),
    status: 500,
    body: null,
    delayMs: 3000,
    headers: {},
    requests: []
  });
  const state = fresh();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stand-in');
    const query = Object.fromEntries(url.searchParams);
    state.requests.push({ method: req.method, path: url.pathname, query, headers: req.headers });

    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    const ok = () =>
      send(200, {
        request: {
          keyword: query.keyword,
          page: Number(query.page),
          size: Number(query.size),
          cc: query.cc
        },
        data: { items: state.items, keyword_related: [], question: [] },
        in_seconds: 0.19
      });

    if (url.pathname !== '/api/rapid/web_search') return send(404, { message: 'no such endpoint' });
    switch (state.mode) {
      case 'status':
        return send(
          state.status,
          state.body || { message: 'Something went wrong.' },
          state.headers
        );
      case 'slow':
        return setTimeout(ok, state.delayMs);
      case 'malformed':
        return send(200, '<html>not json</html>');
      default:
        return ok();
    }
  });

  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    state,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    reset() {
      Object.assign(state, fresh());
    },
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

module.exports = { startBingStandIn, items };
