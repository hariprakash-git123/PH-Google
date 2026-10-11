const http = require('http');

/**
 * A local stand-in for the Parallel Search API, so no test ever reaches the
 * real service.
 *
 * Records every request (path, method, headers and the parsed JSON body, so
 * tests can check how the key is sent and what was asked) and answers
 * according to `mode`:
 *
 *   ok         200 with `results` in Parallel's documented shape
 *   status     `status` with `body` (default Parallel's error object)
 *   slow       waits `delayMs` before answering ok
 *   malformed  200 with a body that is not JSON
 */

/** `n` results shaped like the API's: url, title, publish_date, markdown excerpts. */
const results = (n, { host = 'parallel.example', start = 1, publishDate = null } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://${host}/page-${start + i}`,
    title: `Parallel result ${start + i}`,
    publish_date: publishDate,
    excerpts: [`Excerpt for **parallel result ${start + i}** with a [link](https://x.example).`]
  }));

async function startParallelStandIn() {
  const state = {
    mode: 'ok',
    results: results(3),
    status: 500,
    body: null,
    delayMs: 3000,
    headers: {},
    requests: []
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      let body = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
      } catch {
        body = null;
      }
      state.requests.push({ path: req.url, method: req.method, headers: req.headers, body });

      const send = (status, payload, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      const ok = () =>
        send(200, {
          search_id: 'search_stand_in',
          results: state.results,
          warnings: null,
          usage: [{ name: 'sku_search', count: 1 }]
        });

      switch (state.mode) {
        case 'status':
          return send(
            state.status,
            state.body || {
              type: 'error',
              error: { ref_id: 'ref_stand_in', message: 'Something went wrong.' }
            },
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
  });

  await new Promise(resolve => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    state,
    baseUrl,
    reset() {
      Object.assign(state, {
        mode: 'ok',
        results: results(3),
        status: 500,
        body: null,
        headers: {},
        requests: []
      });
    },
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

module.exports = { startParallelStandIn, results };
