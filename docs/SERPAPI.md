# External web search: SerpApi

Google web results from [SerpApi](https://serpapi.com/), added to the first page of a web search **after** the results from PH's own index. The index stays the search engine: its results, their order, their scores and its pages are unchanged. SerpApi only adds results the index does not have.

It is off by default. While it is off, or has no key, no request is made and search works exactly as it did before.

## How a search flows

```
GET /api/search?q=…
  searchController.search
    searchDispatcher.webSearch(params)                          includeExternal: true
      externalSearch.searchWithExternal(params, runIndexSearch)
        ├─ off / no key / not eligible ─────► index results + external: {status: disabled|skipped}
        └─ eligible
             ├─ index search (OpenSearch) ─┐   in parallel (or index first, see SERPAPI_MIN_INTERNAL_RESULTS)
             └─ SerpApi (cache → client) ──┤
                                           ▼
             map organic_results → PH result schema, drop unsafe links,
             re-check site:/-site:/inurl:, drop pages the index already has,
             append after the index's results (at most SERPAPI_MAX_RESULTS)
```

| File                                       | Role                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `services/searchDispatcher.js`             | `webSearch(params, { includeExternal })` — the one switch.                  |
| `services/externalSearch.js`               | When to ask, cache, in-flight sharing, limits, pause after failures, merge. |
| `services/external/serpApiClient.js`       | The HTTP call: timeout, error mapping, nothing secret in errors.            |
| `services/external/serpApiQuery.js`        | The PH query, translated for Google from the parser's output.               |
| `services/external/serpApiMapper.js`       | `organic_results` → the result schema the page already renders.             |
| `services/external/externalSearchError.js` | The failure vocabulary.                                                     |

## Settings

In `ph-google-backend/.env`, read only by `config/env.js` (`config.serpapi`).

| Variable                                       | Default               | Meaning                                                                                          |
| ---------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| `SERPAPI_API_KEY`                              | —                     | The key alone (64 characters), not a whole search URL. Server-side only.                         |
| `SERPAPI_ENABLED`                              | `false`               | `true` switches it on.                                                                           |
| `SERPAPI_ENGINE`                               | `google`              | Only Google web search is implemented.                                                           |
| `SERPAPI_TIMEOUT_MS`                           | `3000`                | Give up after this; the index results are shown anyway. 500–15000.                               |
| `SERPAPI_VERTICAL_TIMEOUT_MS`                  | `8000`                | The timeout for the Images, Videos and Maps tabs, where SerpApi is the whole result. 1000–20000. |
| `SERPAPI_MAX_RESULTS`                          | `10`                  | Google results shown on page 1 (1–10).                                                           |
| `SERPAPI_LOCATION`, `SERPAPI_GL`, `SERPAPI_HL` | —, —, `en`            | Location name, country code, interface language.                                                 |
| `SERPAPI_CACHE_TTL_MS`                         | `600000`              | Identical requests reuse the response for this long. `0` disables.                               |
| `SERPAPI_CACHE_MAX_ENTRIES`                    | `200`                 | Responses kept.                                                                                  |
| `SERPAPI_DAILY_LIMIT`                          | `8`                   | Successful requests per UTC day from this process (failures are not counted). `0` = no cap.      |
| `SERPAPI_MIN_INTERNAL_RESULTS`                 | `0`                   | `0`: ask on every eligible page 1, in parallel. `N`: ask only when the index found fewer than N. |
| `SERPAPI_MAX_CONCURRENT`                       | `2`                   | Requests in flight at once; more skip SerpApi rather than wait.                                  |
| `SERPAPI_BASE_URL`                             | `https://serpapi.com` | Tests and proxies only.                                                                          |

**Enable:** set `SERPAPI_API_KEY` and `SERPAPI_ENABLED=true`, then recreate the backend so it reads them (`docker compose up -d --no-deps --force-recreate backend` — this does not start the crawl worker).
**Disable:** `SERPAPI_ENABLED=false` (or remove the key) and recreate the backend. No rebuild, no data change.

## When SerpApi is asked

Only for the **first page of a web search sorted by relevance**, and never for:

| Case                                                          | `external.reason`      |
| ------------------------------------------------------------- | ---------------------- |
| page 2 or later                                               | `not_first_page`       |
| `sort=newest` / `oldest` (Google has no date sort)            | `date_sort`            |
| a query with nothing to look for, or exclusions only          | `empty_query`          |
| only `site:` or `lang:` with no words                         | `no_search_text`       |
| `-lang:` (no Google equivalent)                               | `unsupported_operator` |
| `lang:` and the language filter disagree                      | `conflicting_filters`  |
| `SERPAPI_MIN_INTERNAL_RESULTS` set and the index found enough | `enough_index_results` |
| the daily limit is reached                                    | `daily_limit`          |
| `SERPAPI_MAX_CONCURRENT` requests already in flight           | `busy`                 |

The rules above are for web search (the **All** tab). The Images, Videos and Maps tabs use SerpApi in their own way — see [Images, Videos and Maps](#images-videos-and-maps). News never uses it.

## Query translation

Built from the parser's structured output (`queryParser.parseQuery`), never the raw text — so anything the parser dropped (a `site:` that is not a domain, a bare `-site:`) is not sent either.

| PH query                                | Sent to Google                                           |
| --------------------------------------- | -------------------------------------------------------- |
| `site:developer.mozilla.org javascript` | `javascript site:developer.mozilla.org`                  |
| `"climate change"`                      | `"climate change"`                                       |
| `python -java`                          | `python -java`                                           |
| `intitle:javascript`                    | `intitle:javascript`                                     |
| `inurl:python`                          | `inurl:python`                                           |
| `python OR javascript`                  | `python OR javascript`                                   |
| `python AND programming`                | `python programming` (Google requires every word anyway) |
| `lang:en machine learning`              | `machine learning` with `lr=lang_en`                     |
| domain filter                           | `site:<domain>`                                          |
| language filter                         | `lr=lang_<code>`                                         |
| date filter hour/day/week/month/year    | `tbs=qdr:h/d/w/m/y`                                      |

Google results are re-checked against what the address can show: `site:`, `-site:`, the domain filter and `inurl:`.

**Limitations.** Index-only behaviour does not carry over to Google results: `-word` excludes a page from the index if the word is anywhere in its text, but for a Google result we only have Google's word for it; question-opener stripping, fuzzy matching and field weights shape the index's ranking only.

## Result format

Each Google result has every field an index result has, so the frontend renders both with the same component:

| Field                          | Google result                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `id`                           | `serpapi:` + sha1 of the canonical URL key — never collides with an index id                                                 |
| `url`                          | the link, normalised (`normalizeUrl`); a non-http(s) link drops the result                                                   |
| `displayUrl`                   | `toDisplayUrl(url)`, as for index results                                                                                    |
| `domain`                       | the link's hostname                                                                                                          |
| `favicon`                      | 🌐, as for index results                                                                                                     |
| `title`, `snippet`             | as returned (snippet capped at 300 characters)                                                                               |
| `publishedAt` / `publishedAgo` | from SerpApi's `date` when it is a real date; relative text ("3 days ago") is shown as written; otherwise `null` / `Unknown` |
| `crawledAt`, `language`        | `null`, `''` — never crawled, language unknown                                                                               |
| `category`                     | `Google Web` (the badge on the result card)                                                                                  |
| `score`                        | `null` — Google's order is not a score                                                                                       |
| `source`, `sourceRank`         | `serpapi`, Google's position                                                                                                 |

Index results gain `source: "index"` and `sourceRank` (their position in the whole result list). No other field changes.

## Duplicates

Identity is the project's own canonical key, `canonicalKey(url)` in `utils/urlNormalizer.js` — the key whose sha1 is the index document id. It ignores the scheme, `www.`, a trailing slash, the fragment and tracking parameters (`utm_*`, `gclid`, `fbclid`, …), so `https://example.com/page`, `https://www.example.com/page/` and `http://example.com/page?utm_source=x` are one page.

1. A Google result for a page already on the page: dropped, the index's copy kept.
2. A Google result for a page in the index but not on this page: dropped — checked with one read-only id lookup (`mget`) on the index.
3. The same page twice in Google's list: the first kept.

## Ranking, pagination and totals

The two lists are never scored against each other: an OpenSearch score (BM25 with field and phrase boosts, multiplied by quality and freshness) changes scale with every query, and Google's list has no score at all. So the merge is by position: **all of the index's results for the page first, in their order, then Google's, in Google's order.**

- **Page 1** holds the index's full page (`limit` results) and then up to `SERPAPI_MAX_RESULTS` Google results, so it can be longer than `limit`. No index result moves to another page.
- **Pages 2+** are the index's, exactly as without SerpApi. No SerpApi call.
- **`pagination`** is the index's own (`buildPagination` over the index's total): `pagination.totalResults` is the index's count. One adjustment: when the index found nothing but Google results are shown, `totalPages` is 1, not 0.
- **`total`** = the index's exact count + the Google results actually shown on the page. Google's own "About N results" estimate is not used anywhere.
- Search analytics (`SearchLog.resultCount`) count the index's results only.

## Failures

SerpApi never fails a search. Whatever happens, the index's results are returned, with a status:

```json
"external": { "provider": "serpapi", "status": "unavailable", "count": 0, "reason": "auth" }
```

| What happened                                      | `status` / `reason`                | Afterwards                                   |
| -------------------------------------------------- | ---------------------------------- | -------------------------------------------- |
| Key rejected (401, 403, "Invalid API key")         | `unavailable` / `auth`             | SerpApi left alone for 10 minutes            |
| Rate limited, or the plan's searches used up (429) | `unavailable` / `rate_limited`     | left alone for `Retry-After`, else 5 minutes |
| Server error (5xx)                                 | `unavailable` / `unavailable`      |                                              |
| No answer within `SERPAPI_TIMEOUT_MS`              | `unavailable` / `timeout`          |                                              |
| DNS failure, refused connection                    | `unavailable` / `network`          |                                              |
| Not JSON, or `organic_results` not a list          | `unavailable` / `invalid_response` |                                              |
| Another 4xx                                        | `unavailable` / `bad_request`      |                                              |
| Google found nothing                               | `ok`, `count: 0`                   |                                              |

Three failures in a row leave SerpApi alone for a minute. If the **index** is down, the search fails with 503 as before — SerpApi never silently replaces it.

Every status value: `ok`, `disabled` (reasons `disabled`, `not_configured`), `skipped` (see "When SerpApi is asked"), `unavailable`.

## API usage

Each request to SerpApi is one search from the plan (the free plan: 250 a month). Usage is held down by:

- page 1 of relevance-sorted web searches only, and none of the cases above;
- an in-memory cache (10 minutes) and sharing of identical requests in flight;
- AI answers never calling SerpApi;
- `SERPAPI_DAILY_LIMIT` (8 by default — about the free plan spread over a month);
- `SERPAPI_MAX_CONCURRENT`, and the pause after failures;
- optionally `SERPAPI_MIN_INTERNAL_RESULTS`, to ask only when the index finds little.

The cache and the daily count belong to the backend process: a restart clears them, and several backend instances would each have their own.

## AI answers

AI answers are unchanged and do not use SerpApi. `retrievalService` calls `webSearch(…, { includeExternal: false })`, so the answer is still written from the page text the index holds, with the same sources, citations and response. A Google result is a short snippet, not a page, and is not used as evidence. Using SerpApi results in answers would need its own decision (evidence quality, and SerpApi's and Google's terms for that use).

## Security

- The key is read only in `config/env.js` and used only in `serpApiClient.js`. It is not in any `VITE_*` variable; the browser never calls SerpApi.
- SerpApi takes the key as the `api_key` URL parameter, so the request URL is secret: it is built inside the client and never logged; no error carries it, its message, or fetch's own error.
- Responses carry only `external` (provider, status, count, reason, cached). The admin view reports `configured: true/false`, never the key.
- The logger redacts any field whose name looks like a key or token.
- `.env` is in `.gitignore` and `.dockerignore`; Docker passes it to the container at runtime (`env_file`), so it is not in any image.
- Nothing from SerpApi is written to MongoDB or OpenSearch.

## Images, Videos and Maps

With SerpApi on, three tabs are served by Google instead of the crawler's own media and places:

| Tab    | Request                               | SerpApi engine  | Result fields                                                                                                                    |
| ------ | ------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Images | `GET /api/search?q=…&category=images` | `google_images` | `id, title, imageUrl, thumbnailUrl, sourceUrl, sourceDomain, sourceName, width, height, position`                                |
| Videos | `GET /api/search?q=…&category=videos` | `google_videos` | `id, title, thumbnailUrl, videoUrl, sourceUrl, sourceDomain, sourceName, duration, publishedAt, publishedAgo, snippet, position` |
| Maps   | `GET /api/search?q=…&category=maps`   | `google_maps`   | `id, title, address, rating, reviews, phone, website, category, latitude, longitude, hours, thumbnailUrl, mapsUrl, position`     |

Every result also has `source: "serpapi"`. Code: `services/externalVerticals.js`, `services/external/serpApi{Image,Video,Maps}Mapper.js`, `buildVerticalRequest` in `serpApiQuery.js`; frontend `components/ExternalVerticals/`.

- **Off means unchanged.** With `SERPAPI_ENABLED=false` or no key, these tabs are the crawler's verticals (`verticalSearchService`) exactly as before, and the response says `external.status: "disabled"`. The **News** tab is always the crawler's.
- **One request per query and tab.** Each tab's first view sends one SerpApi request; the response is cached for `SERPAPI_CACHE_TTL_MS` under a key that starts with the tab, so "python" on Images, Videos, Maps and the web are four separate entries and never answer for each other.
- **Paging costs nothing.** Later pages are cut from that one cached response. `total` and `pagination` count what SerpApi actually returned (about 100 images, 10 videos, 20 places) — never an estimate. If the cache has expired when page 2 is opened, the same single request is sent again.
- **Queries.** Images and videos take the same Google query as web search (operators, the domain, language and date filters). Maps takes the query's plain words only — operators and filters mean nothing to a map search. A sort order does not apply to these tabs.
- **Only safe values.** Every URL must be absolute `http(s)` or it is dropped (an image with no usable thumbnail, or a video with no usable link, is dropped entirely); numbers must be in range; text is kept as plain text. A field SerpApi did not send is `null`, never guessed. The frontend checks every link and image address again before using it.
- **Maps links.** `mapsUrl` is a Google Maps link built from the place's name, address and place id — no map is embedded and no Google Maps API key exists anywhere.
- **Failures.** A SerpApi failure is `200` with `results: []` and `external: { status: "unavailable", reason }` — the same reasons as web search. The page then says "No results available right now" rather than "No … found".
- **Shared limits.** These tabs share `SERPAPI_DAILY_LIMIT`, `SERPAPI_MAX_CONCURRENT` and the pause after failures with web search.
- **Not stored, not for AI.** Nothing is written to MongoDB or OpenSearch, images and videos are loaded by the browser from their own addresses, and AI answers never see these results.

### Image preview and download

Clicking an image opens a preview on the page (`ImageLightbox.jsx`) instead of leaving for the source site. It shows the full image (`imageUrl`; the thumbnail if that will not load), the title, source and dimensions the result has, and three actions: **Download**, **Visit site** (`sourceUrl`) and **Open original** (`imageUrl`). Left/right move through the images already on the page; no search request is made.

**Download** goes through the backend, because a browser will not save a file from another site with a plain link:

```
GET /api/images/download?url=<imageUrl>&sig=<downloadToken>&name=<title>
```

- **Not an open proxy.** Each image result carries `downloadToken`, the server's signature (HMAC, keyed from `JWT_SECRET`) of its `imageUrl`. The endpoint fetches nothing without a matching signature, so it serves the images search returned and no other address.
- **Public addresses only**, signature or not (`utils/publicAddress.js`, `services/imageDownloadService.js`): http/https on the default ports, no credentials in the URL; no `localhost`, single-label names (`redis`, `mongo`, `opensearch`, `backend`) or internal suffixes; the name is resolved and **every** address must be public (loopback, private ranges, link-local and the cloud metadata address `169.254.169.254`, IPv6 local ranges and IPv4-mapped forms are refused); the connection goes to the address that was checked, not back to DNS.
- **Redirects** are followed by hand, at most `IMAGE_DOWNLOAD_MAX_REDIRECTS` (3), and every hop is checked the same way.
- **Images only.** The reply must be a JPEG, PNG, GIF, WebP, AVIF, BMP or TIFF by its own bytes, whatever `Content-Type` it claims (SVG is refused: it can carry script). Larger than `IMAGE_DOWNLOAD_MAX_BYTES` (15 MB) or slower than `IMAGE_DOWNLOAD_TIMEOUT_MS` (8 s) is refused.
- **The response** is `Content-Disposition: attachment` with a file name reduced to letters, digits, spaces, dots, hyphens and underscores, `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`.
- **Failures** are a plain message: 403 (no valid signature), 400 (address not allowed), 415 (not an image), 413 (too large), 504 (timeout), 502 (the site failed). Only the host is logged, never the image address.
- Limited to `RATE_LIMIT_IMAGE_MAX` (30) requests a minute per client. It uses no SerpApi searches and stores nothing.

The page keeps the tab in the URL as `category` (`/search?q=python&category=images`), so tabs work with back/forward, reload and direct links; the older `?tab=` form is still read.

## Tests

```bash
cd ph-google-backend
npx jest tests/unit/serpApiClient.test.js tests/unit/serpApiQuery.test.js \
         tests/unit/serpApiMapper.test.js tests/unit/externalSearch.test.js \
         tests/integration/externalSearch.test.js          tests/unit/serpApiVerticals.test.js tests/unit/externalVerticals.test.js          tests/integration/externalVerticals.test.js
```

No test calls SerpApi: they use a local stand-in (`tests/helpers/serpApiStandIn.js`) or a mocked client.
