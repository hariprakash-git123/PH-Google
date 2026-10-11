const http = require('http');

/**
 * A local stand-in for SerpApi, so no test ever reaches the real service.
 *
 * Records every request (path and query, including api_key, so tests can
 * check how the key is sent) and answers according to `mode`:
 *
 *   ok          200 with the list for the requested engine: `organic`
 *               (google), `images` (google_images), `videos`
 *               (google_videos), `places` (google_maps — or `placeResult`
 *               as place_results when set)
 *   no_results  200 with SerpApi's "hasn't returned any results" error
 *   status      `status` with `body` (default an error object)
 *   slow        waits `delayMs` before answering ok
 *   malformed   200 with a body that is not JSON
 */

const organic = (n, { host = 'external.example', start = 1 } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    position: start + i,
    title: `External result ${start + i}`,
    link: `https://${host}/page-${start + i}`,
    displayed_link: `${host} › page-${start + i}`,
    snippet: `Snippet for external result ${start + i}.`
  }));

const images = (n, { host = 'pics.example' } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    position: i + 1,
    title: `Image ${i + 1}`,
    thumbnail: `https://thumbs.example/t${i + 1}.jpg`,
    original: `https://${host}/full-${i + 1}.jpg`,
    original_width: 1200,
    original_height: 800,
    link: `https://${host}/page-${i + 1}`,
    source: 'Pics Example'
  }));

const videos = (n, { host = 'www.youtube.com' } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    position: i + 1,
    title: `Video ${i + 1}`,
    link: `https://${host}/watch?v=vid${i + 1}`,
    thumbnail: `https://i.ytimg.example/vi/${i + 1}/hq.jpg`,
    duration: '12:34',
    date: 'Mar 3, 2025',
    source: 'YouTube'
  }));

const places = n =>
  Array.from({ length: n }, (_, i) => ({
    position: i + 1,
    title: `Place ${i + 1}`,
    place_id: `ChIJplace${String(i + 1).padStart(6, '0')}`,
    address: `${i + 1} Anna Salai, Chennai`,
    rating: 4.4,
    reviews: 1245,
    phone: '+91 44 1234 5678',
    website: `https://place${i + 1}.example`,
    type: 'Restaurant',
    gps_coordinates: { latitude: 13.06 + i / 100, longitude: 80.25 },
    open_state: 'Open ⋅ Closes 11 PM',
    thumbnail: `https://maps.example/thumb${i + 1}.jpg`
  }));

const trending = n =>
  Array.from({ length: n }, (_, i) => ({
    query: `trend ${i + 1}`,
    search_volume: 1000 * (n - i),
    increase_percentage: 500,
    categories: [{ id: 1, name: 'Other' }]
  }));

const LIST_FOR = {
  google: ['organic_results', 'organic'],
  google_images: ['images_results', 'images'],
  google_videos: ['video_results', 'videos'],
  google_maps: ['local_results', 'places'],
  google_trends_trending_now: ['trending_searches', 'trending']
};

async function startSerpApiStandIn() {
  const state = {
    mode: 'ok',
    organic: organic(3),
    images: images(3),
    videos: videos(3),
    places: places(3),
    trending: trending(5),
    placeResult: null,
    status: 500,
    body: null,
    delayMs: 3000,
    headers: {},
    requests: []
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stand-in');
    state.requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });

    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    const ok = () => {
      const engine = url.searchParams.get('engine') || 'google';
      if (engine === 'google_maps' && state.placeResult) {
        return send(200, {
          search_metadata: { status: 'Success' },
          place_results: state.placeResult
        });
      }
      const [key, field] = LIST_FOR[engine] || LIST_FOR.google;
      return send(200, { search_metadata: { status: 'Success' }, [key]: state[field] });
    };

    switch (state.mode) {
      case 'no_results':
        return send(200, {
          search_metadata: { status: 'Success' },
          error: "Google hasn't returned any results for this query."
        });
      case 'status':
        return send(state.status, state.body || { error: 'Something went wrong.' }, state.headers);
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
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    state,
    baseUrl,
    reset() {
      Object.assign(state, {
        mode: 'ok',
        organic: organic(3),
        images: images(3),
        videos: videos(3),
        places: places(3),
        trending: trending(5),
        placeResult: null,
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

module.exports = { startSerpApiStandIn, organic, images, videos, places, trending };
