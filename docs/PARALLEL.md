# External web search: Parallel

PH Google can take its external web results from the [Parallel Search API](https://docs.parallel.ai). Parallel is a third provider beside SerpApi (Google) and Bing — see [SERPAPI.md](SERPAPI.md) for how external results work in general. Only the choice of provider is new: the index, the relevance gate, result validation, pagination and the result format are unchanged.

## What Parallel is used for

| | Provider |
|---|---|
| Web search, page 1, relevance order | the provider named by `EXTERNAL_SEARCH_PROVIDER` (or `SEARCH_PROVIDER`): `serpapi`, `bing` or `parallel` |
| Images, Videos, Maps | SerpApi; or, while it is off and `PARALLEL_VERTICALS_ENABLED=true`, verified results found through Parallel (see below) |
| Trending now | SerpApi — never Parallel |
| News | the index |
| AI answers | the index only |

## Enabling Parallel, and switching back

In `ph-google-backend/.env`:

```
EXTERNAL_SEARCH_PROVIDER=parallel
PARALLEL_ENABLED=true
PARALLEL_API_KEY=<your key>
SEARCH_PROVIDER_FALLBACK=false
```

`SEARCH_PROVIDER_FALLBACK=false` makes Parallel the **only** provider web search asks. With it on (the default), a Parallel failure is covered by the other configured providers — SerpApi, then Bing — and the response says so (`fallbackFrom`).

Then rebuild and recreate the backend from the project root:

```
docker compose build backend
docker compose up -d --no-deps --force-recreate backend
```

To switch back, change one line and recreate the backend again:

```
EXTERNAL_SEARCH_PROVIDER=serpapi      # or bing; or remove the line to use SEARCH_PROVIDER
```

`EXTERNAL_SEARCH_PROVIDER` and `SEARCH_PROVIDER` are the same setting; the first wins when both are set.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `EXTERNAL_SEARCH_PROVIDER` | – | `parallel`, `serpapi` or `bing`. Overrides `SEARCH_PROVIDER`. |
| `PARALLEL_API_KEY` | – | Server-side only. Sent in the `x-api-key` header. |
| `PARALLEL_ENABLED` | `false` | Parallel is asked only when this is `true` and a key is set — as the chosen provider or as a fallback. |
| `PARALLEL_MODE` | `fast` | `turbo`, `fast`, `basic` or `advanced`. |
| `PARALLEL_TIMEOUT_MS` | `4000` | 500–15000. |
| `PARALLEL_MAX_RESULTS` | `10` | 1–10 results asked for and shown. |
| `PARALLEL_DAILY_LIMIT` | `100` | Requests sent per UTC day by one process. `0` = no cap. |
| `PARALLEL_MAX_CONCURRENT` | `2` | Requests in flight; a search beyond this skips Parallel. |
| `PARALLEL_CACHE_TTL_MS` | `600000` | Identical requests reuse the response. `0` disables. |
| `PARALLEL_CACHE_MAX_ENTRIES` | `200` | |
| `PARALLEL_BASE_URL` | `https://api.parallel.ai` | Tests or a proxy only. |

Settings shared by every provider apply to Parallel too: `SERPAPI_MIN_INTERNAL_RESULTS` (ask only when the index found fewer than N), `EXTERNAL_RELEVANCE_GATE` and `EXTERNAL_RESULT_VALIDATION`.

## When Parallel is asked

Exactly when any external provider is: page 1 of a web search in relevance order, and then

- always, if `SERPAPI_MIN_INTERNAL_RESULTS=0`; otherwise
- when the index found fewer results than that, **or** the relevance gate found no indexed page about the query — in which case Parallel's results are placed before the index's.

So with the gate on and a threshold set, a query the index answers well gets no Parallel request (`status: "skipped", reason: "enough_index_results"`).

## The request

Verified against Parallel's API reference (`POST /v1/search`) and live requests:

```json
{
  "objective": "how does gravity work",
  "search_queries": ["gravity"],
  "mode": "fast",
  "advanced_settings": {
    "max_results": 10,
    "source_policy": { "include_domains": ["nasa.gov"] }
  }
}
```

- `search_queries` is the required field; `objective` is optional and always sent.
- A question keeps its wording in `objective`; its topic (what the query parser extracts for the index) is the keyword query.
- `mode` is sent explicitly, because the API's own default is `advanced` (about 3 s).

## Query translation

Parallel has no search operators. What it can be told is translated; what it cannot honour is **not sent**, so a result is never shown as matching a query it ignores part of.

| PH query | Parallel | |
|---|---|---|
| words, questions | `objective` + `search_queries` | sent |
| `"a phrase"` | sent in quotes; a result is kept only if the phrase is in its title or excerpts | sent, checked |
| `a OR b` | sent as written | sent |
| `site:` / domain filter | `source_policy.include_domains` (re-checked on each address) | sent, checked |
| `-site:` | `source_policy.exclude_domains` (re-checked) | sent, checked |
| date filter: day, week, month, year | `source_policy.after_date`; undated or older results are left out | sent, checked |
| date filter: past hour | — | skipped: `unsupported_filter` |
| language filter, `lang:`, `-lang:` | — | skipped |
| `intitle:`, `inurl:` and their negations | — | skipped: `unsupported_operator` |
| `-word`, `-"a phrase"` | — | skipped: `unsupported_operator` |
| sort newest / oldest | — | skipped: `date_sort` |
| page 2 and later | — | skipped: `not_first_page` |

With fallback on, a search Parallel declines goes to the next provider that can take it. With fallback off it is answered by the index alone, and the response says why.

## Result format

Each Parallel result is the same object an index, SerpApi or Bing result is:

| Field | From Parallel |
|---|---|
| `id` | `parallel:` + SHA-1 of the canonical URL |
| `url`, `displayUrl`, `domain` | `url`, normalised |
| `title` | `title`, or the URL when it is null |
| `snippet` | the first excerpt, markdown removed, at most 300 characters |
| `publishedAt`, `publishedAgo` | `publish_date` (`YYYY-MM-DD`) when present, otherwise `null` / "Unknown" |
| `category` | `Web` |
| `source`, `sourceRank` | `parallel`, position in Parallel's list |
| `score`, `crawledAt`, `language` | `null`, `null`, `''` |

## Failures

| What happened | `external.reason` | Then |
|---|---|---|
| 401 / 403 | `auth` | Parallel paused 10 minutes |
| 429 (or 402) | `rate_limited` | paused for `Retry-After`, or 5 minutes |
| 422 / other 4xx | `bad_request` | |
| 5xx | `unavailable` | |
| no answer within `PARALLEL_TIMEOUT_MS` | `timeout` | |
| connection failure | `network` | |
| reply is not the documented JSON | `invalid_response` | |
| results do not cover the query (validation) | `irrelevant_results` | not shown, not cached |
| three failures in a row | | Parallel web search paused 1 minute |

Every one returns HTTP 200 with the index's results and `"external": {"provider": "parallel", "status": "unavailable", "reason": …}`. Only the failure code, HTTP status and the searched words are logged — never the key or the provider's message.

## API usage and cost

- One request per uncached, eligible first-page web search that the count rule and relevance gate let through.
- Identical searches within 10 minutes reuse the response; identical searches in flight share one request.
- `PARALLEL_DAILY_LIMIT` (default 100) is a safety cap chosen here, **not** a figure from Parallel's pricing: their public reference states no rate limit or price. Set it to your plan.
- Every request sent counts against the limit, including failed ones (unlike SerpApi and Bing), because how Parallel bills a failure is not documented.
- Counters are per backend process and reset on restart. Each provider has its own.

## Limitations

- **Latency:** live `fast` requests took about 0.75–1.5 s.
- **Dates:** Parallel often returns no `publish_date`, so date-filtered searches may show few Parallel results.
- **Operators and language:** see the table above.
- **AI answers** do not use Parallel.

## Files

| File | Role |
|---|---|
| `services/external/parallelClient.js` | the HTTP request and error mapping |
| `services/external/parallelQuery.js` | PH query → Parallel request, and when to skip |
| `services/external/parallelMapper.js` | Parallel result → PH result, and the post-checks |
| `services/externalSearch.js` | the `parallel` entry in `WEB_PROVIDERS`; shared cache, limits, pauses, gate |
| `config/env.js` | `externalSearch.provider`, `parallel.*` |

## Tests

```
npx jest tests/unit/parallelClient.test.js tests/unit/parallelQuery.test.js \
         tests/unit/parallelMapper.test.js tests/unit/externalSearchParallel.test.js \
         tests/integration/parallelSearch.test.js
```

All run against mocks or a local stand-in (`tests/helpers/parallelStandIn.js`). `tests/helpers/setupTests.js` clears the provider override and blanks the Parallel key, so no test can reach the real API whatever `.env` says.

## Images and Videos (`PARALLEL_VERTICALS_ENABLED`)

Parallel is a web search. Its answers are pages — `url`, `title`, `publish_date`, `excerpts` — with no image
address and no video metadata, and its Extract endpoint returns page text without images. So for the Images and
Videos tabs it is used only to find pages, and nothing is shown until it has been checked against the thing itself
(`services/parallelVerticals.js`):

- **Videos.** The search is restricted to YouTube, Vimeo and Dailymotion. A result is kept only if its address is
  one video's page (not a channel, playlist, hashtag or article) and the platform's own oEmbed endpoint confirms
  it. Title, channel and thumbnail are the platform's. Duration is not available this way and is left empty.
- **Images.** The pages found that are about the subject are fetched (public hosts only, `external/safeFetch.js`).
  A picture is kept only if its own alt text, caption or file name mentions the subject — the page's declared lead
  image is taken on the page's title — it does not call itself a logo, icon, avatar or advert, and its address
  really serves an image at least 160 px on its short side and no more than 4:1. There is no separate thumbnail:
  the grid loads the picture itself.

The crawler's own images and videos for the query come first, in the same result shape, and Parallel's follow
without repeats. This path is used only while SerpApi cannot serve these tabs. Trending is never served from a web search. Parallel returns at most 20 pages per request, so one search of a tab sends several at once — three for Videos,
two for Images — and merges the answers. Every request is counted in `PARALLEL_DAILY_LIMIT`; the verified list is
cached like web search. The first image search for a query takes several seconds because pages and pictures are
fetched; pictures not checked within 9 seconds are left out.

**Load more on Images and Videos.** Parallel's Search API has no page, offset or cursor parameter: a request takes
`objective`, `search_queries`, `mode` and `max_results` (at most 20), and the same question returns the same pages.
So the first page shows the first round's verified list, and Load more cuts the next batch from it. Once that list
has been shown, Load more sends a further **round** — the same subject asked in other words (for example
"<query> pictures", "<query> photography" for Images; "<query> videos", "<query> youtube", "watch <query>" for
Videos), never words an earlier round used — verifies what it finds, and appends only what no earlier round found
(by image address, or by the video's platform id). The round count travels in the Load more cursor (`r`), and each
round is cached under its own words, so going on with a list does not ask the earlier rounds again.

- Images has at most **6 rounds** (2 requests each, up to 12 in all); Videos at most **3 rounds** (3 requests each, up
  to 9). Maps has one. The list ends after the last round, or as soon as a round adds nothing new — so the same
  batch is never offered as new, and there is no claim of unlimited results.
- **Images** fills each page from as many rounds as it takes: the first page asks for 60 pictures (the one tab
  allowed a `limit` above `SEARCH_MAX_LIMIT`, up to 60) and Load more for 20. After the first round, further rounds
  go two at a time (`PARALLEL_MAX_CONCURRENT`'s default), and only as many as the shortfall looks to need, judged
  by what the last round added. A first page that needs every round takes several rounds' time (about 7 seconds
  each, two at once) and up to 12 requests. **Videos** is unchanged: the first page asks one round, and each Load
  more at most one more.
- Rounds after those a page needs are sent only when Load more needs them, and count against
  `PARALLEL_DAILY_LIMIT` like any request. When a round cannot be had (the provider fails, is paused, or the day's limit is reached), Load more
  answers 503 with the reason and the cursor stays valid, so **Try again** asks for the same round.
- Later rounds are other phrasings of the same search, checked by the same rules; they tend to be a little less
  central to the query than the first round.

Turn it off with `PARALLEL_VERTICALS_ENABLED=false` (the default): the tabs go back to the crawler's own verticals.

### Maps

A web search has no places, and a page's prose is not one: an address read out of a paragraph, or a pin put where a
town happens to be, would be a guess. What a page can state exactly is its structured data — the schema.org JSON-LD
that restaurant, hotel, shop and directory pages publish. For the Maps tab the pages Parallel finds are read for
that and nothing else (`external/pagePlaces.js`):

- A node counts as a place when its type is somewhere a person can go (`Restaurant`, `Hotel`, `Hospital`, `Store`,
  `TouristAttraction`, `LocalBusiness`, `Place`, …) and it has a name and an address or a position. An
  `Organization` or `WebSite` with an address is a publisher's letterhead and is ignored.
- Name, address, phone, rating (only when out of five), opening hours (quoted as written) and the place's own site
  are what the page states; a field it does not state is empty. Nothing is looked up or worked out.
- Coordinates are kept only when both are finite numbers inside the globe, not 0,0 and not a pair of whole numbers.
  A place without them is listed with its details and its source link, and gets no pin.
- The same name within 300 m — or, with one position missing, the same phone number or address — is one place.
  Branches of a chain are different places.
- A page about one place is taken on Parallel having found it for the search; on a page listing many, each place's
  own name, address and type must mention at least half of the query's words.

The map is drawn by the browser from OpenStreetMap's standard tiles (`PlacesMap.jsx`), credited on the map; there is
no key and no map library. "View on Maps" opens openstreetmap.org at the place's coordinates, or a search for its
name and address when it has none. There are no directions, distances or "open now".

How many places a search finds depends on how many of the pages publish structured data: often a handful, sometimes
none. That is the limit of doing this without a places provider.

### Whether a pin can be trusted

A page's coordinates and its address are two separate statements. In testing, a listing gave a restaurant a precise
position 20 km outside the city its address named. Precision is necessary and proves nothing, so a pin is drawn only
when something independent of the page agrees with it (`external/placeTrust.js`):

| Evidence | When | What it shows |
|---|---|---|
| `openstreetmap` | `MAPS_OSM_ENABLED=true` | The coordinates fall inside the town or suburb the address names, as OpenStreetMap places it. One lookup per distinct town (at most three a search), cached for a week. |
| `sources` | OpenStreetMap is off, failing, or does not know the town | Another website describes a place in the same town within 15 km. Weaker: two sites can be wrong together. |
| `map` | `MAPS_OSM_ENABLED=true` | The place is OpenStreetMap's own, at OpenStreetMap's position. |

Anything else is `locationStatus: "unverified"`: the place keeps its card, every detail and its source link, its
coordinates are withheld, and the card says the location could not be verified. A page's coordinates are never moved
or replaced. A place whose page gave no coordinates at all is `"missing"`.

This is a check of the town, not of the street: a pin in the right town on the wrong road passes.

### OpenStreetMap (Nominatim)

Optional, no key (`external/nominatimClient.js`). The public service's
[usage policy](https://operations.osmfoundation.org/policies/nominatim/) allows this kind of use — a search a person
makes — at no more than one request a second, with results cached, the application identified in `User-Agent`,
attribution shown, and the service address changeable without a new build. It forbids auto-complete, systematic
queries and bulk downloads. The client is built to those rules: a single queue with at least 1.1 s between requests,
a week's cache, a daily cap (500), and `NOMINATIM_BASE_URL` for switching to your own instance.

One Maps search sends one place search and one lookup per distinct town in the results (at most three) — in practice
one or two requests, none on a repeat. Its place search understands some phrasings ("hospitals in Chennai") and not
others ("coffee shops in Bangalore"), so it adds places for some searches and none for others.

Overpass, OpenStreetMap's query API, would find places by category far more reliably. Its public instances are not
used: their guidelines say an app for more than OpenStreetMap mappers that relies on them as a backend should run its
own instance.
