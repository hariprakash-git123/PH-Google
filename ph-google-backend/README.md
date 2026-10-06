# PH Google — Backend

A working search engine: web crawler → text processing → **OpenSearch** →
relevance ranking → search API, plus image / video / news / map verticals,
authentication, per-user history, search analytics and an admin console.

**Three stores, one job each.** MongoDB holds application and crawl data —
users, history, analytics, crawl jobs, the crawl frontier, the crawled pages
themselves and the image/video/place verticals. OpenSearch holds the web-page
search index and answers every web and news query. Redis carries the crawl
queue, and nothing durable.

**Two processes.** The API answers requests and never fetches a page; the
crawl worker does all the fetching. Deploying one does not disturb the other.

```
       ┌── API (server.js) ──────────────────────────────────────┐
User → │ Search API → Query understanding → OpenSearch → Ranking │ → Results
       │            → Filters → Deduplication → Pagination       │
       └──────────────────────────┬──────────────────────────────┘
                                  │ MongoDB: history + analytics
                                  │
  Admin → POST /crawler/start ─────→ CrawlJob + frontier (MongoDB)
                                  └→ host job (Redis)
                                         │
       ┌── Worker (worker.js) ───────────┴──────────────────────┐
       │ claim URL → robots → fetch → extract → links back into │
       │ the frontier → text processing → MongoDB + OpenSearch  │
       └────────────────────────────────────────────────────────┘
```

---

## Requirements

- Node.js 18 or newer (developed on 22)
- A MongoDB database (Atlas, or the container in the `local-db` compose profile)
- Docker, for OpenSearch and Redis, and for running the stack in containers

## Setup

Everything in containers, from the repository root one level up:

```bash
cp ph-google-backend/.env.example ph-google-backend/.env   # fill in MONGO_URI and JWT_SECRET
docker compose up -d --build
```

That starts the frontend on **8080**, the API on **5000**, OpenSearch on
**9200**, Dashboards on **5601** and Redis on **6379**. Add
`--profile local-db` for a MongoDB container too, and point `MONGO_URI` at
`mongodb://mongo:27017/ph-google`.

**`docker compose up -d` does not start the crawler.** The crawl worker is
behind the `crawler` Compose profile, because a running worker fetches pages
by itself — it resumes unfinished crawl jobs and re-crawls pages that are due
(`CRAWLER_RECRAWL_AFTER_DAYS`), with no admin action. Without a worker, a
crawl started from the admin console is only queued. Start the crawler
deliberately:

```bash
docker compose --profile crawler up -d worker     # start the crawler
docker compose --profile crawler stop worker      # stop it again
```

Run more crawl workers with
`docker compose --profile crawler up -d --scale worker=3 worker`. Per-host
politeness is unaffected — see [Crawler](#crawler).

Or run the Node processes on the host and containerise only the services:

```bash
# 1. Start OpenSearch and Redis (from the repository root, one level up)
docker compose up -d opensearch redis

# 2. Install and configure the backend
npm install
cp .env.example .env     # then fill in MONGO_URI and JWT_SECRET

# 3. Build the search index from the pages already in MongoDB
npm run search:reindex

# 4. Run the API and, in another terminal, the crawl worker
npm run dev
npm run worker:dev
```

`docker compose down` stops everything and keeps the data; `down -v` also
deletes the index and the local database. If the Docker daemon is not running,
every command that needs the cluster fails with a message telling you to start
it — nothing silently falls back to a different engine.

Generate a signing key:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Required environment variables

| Variable         | Required      | Purpose                                                  |
| ---------------- | ------------- | -------------------------------------------------------- |
| `MONGO_URI`      | yes           | MongoDB connection string                                |
| `JWT_SECRET`     | yes           | Signs JWTs. Never commit it. Min. 32 chars in production |
| `PORT`           | no (5000)     | HTTP port                                                |
| `NODE_ENV`       | no            | `development` \| `production` \| `test`                  |
| `FRONTEND_URL`   | in production | Comma-separated allowed CORS origins                     |
| `JWT_EXPIRES_IN` | no (7d)       | Token lifetime                                           |
| `LOG_LEVEL`      | no (info)     | `error` \| `warn` \| `info` \| `debug`                   |

`.env.example` documents the optional search, crawler and rate-limit settings.
The server refuses to start if `MONGO_URI` or `JWT_SECRET` is missing, or if
`FRONTEND_URL` is unset in production.

## Search engine

|            |                                                                |
| ---------- | -------------------------------------------------------------- |
| Index      | `ph-google-pages` (configurable via `OPENSEARCH_INDEX`)        |
| API        | http://localhost:9200                                          |
| Dashboards | http://localhost:5601                                          |
| Auth       | none locally — the container runs with the security plugin off |

Useful commands:

```bash
npm run search:health              # is the cluster reachable?
npm run search:reindex             # rebuild the index from MongoDB
npm run search:reindex -- --recreate   # drop it first (needed after mapping changes)
```

### Relevance

Scoring is layered rather than one formula, so each signal can be tuned
independently and `explain` shows which one fired:

| Signal                 | How                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Exact title            | `term` on `title.raw`, the heaviest boost                                                |
| Title terms            | `match` on `title.exact` (unstemmed, so literal wording wins)                            |
| Phrase                 | quoted queries become a required `phrase` match                                          |
| Proximity              | `match_phrase` with slop, so scattered words rank below adjacent ones                    |
| Headings / description | separate weighted fields                                                                 |
| Body                   | weighted lowest                                                                          |
| URL / domain           | `ph_url` analyzer; a query naming a site boosts that site hard                           |
| Typos                  | a low-weight fuzzy alternative that can admit documents but never outrank an exact match |
| Synonyms               | search-time only (`services/opensearch/synonyms.js`) — editing them needs no reindex     |
| Quality                | bounded ±25% multiplier from length, repetition, title and description                   |
| Freshness              | bounded recency buckets, max +15%; age never demotes                                     |

Field weights live in one place: `FIELD_BOOSTS` / `CLAUSE_BOOSTS` in
`services/opensearch/queryBuilder.js`.

Three analyzers do different jobs: `ph_text` (stemmed, stop-words removed)
for general matching, `ph_exact` (lowercase + fold only) so technical terms
and quoted phrases survive, and `ph_search` which adds synonyms at query
time. Stemming is `kstem` rather than `porter_stem`, which would collapse
"universal", "universe" and "university" into one token.

### Search operators

Typed in the query itself (`q`), parsed by `services/opensearch/queryParser.js`
and added to the request by `buildOperatorClauses` in `queryBuilder.js`.

| Operator                          | Meaning                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `"machine learning"`              | the exact phrase is required                               |
| `site:example.com`                | only that site and its subdomains (a full URL is accepted) |
| `-site:example.com`               | not that site                                              |
| `-java`, `-"java programming"`    | exclude a word or a phrase                                 |
| `cats OR dogs`                    | either side; binds tighter than the words around it        |
| `cats AND dogs`                   | every word is required                                     |
| `intitle:python`, `intitle:"a b"` | the word or phrase must be in the title                    |
| `inurl:docs`, `inurl:"a b"`       | the word or phrase must be in the URL                      |
| `-intitle:…`, `-inurl:…`          | must not be in the title / URL                             |
| `lang:en`, `-lang:en`             | only pages in that language / not in that language         |

`OR` and `AND` are operators only in upper case and only between two things;
"cats or dogs" and "OR gate" are ordinary text. An operator that cannot be
used (`site:` with no domain) is searched as the words that were typed, so a
query never fails because of its syntax. Two cases are dropped instead and
listed in the parser's `ignoredOperators`: a negated operator with no usable
value (`-site:`, `-site:localhost`, `-intitle:`), which must never exclude
the word "site"; and `intitle:` followed by a stop word (`intitle:the`),
which the title index does not hold.

`lang:` takes the same codes as the `language` parameter (`en`, `en-GB` →
`en`) and uses the same filter on the indexed `language` field, so it never
changes a score. Several `lang:` operators mean "any of these"; with the
`language` parameter the two narrow each other. `lang:any` is no
restriction. A page whose language is unknown is excluded by `lang:en` and
kept by `-lang:en`. A value that is not a language code follows the rule
above: `lang:english` is searched as words, `-lang:english` is ignored.

`AND` requires every searchable word in the query, not only its neighbours,
and is exact: it does not accept a typo. A question keeps its topic
(`what is python AND programming` requires python and programming). A word
typed both inside and outside an OR group stays required
(`cats OR dogs cats` is "(cats or dogs) and cats").

Stop words are never required on their own, because the text analyzer
removes them and the requirement could not be met. Beside an OR group they
are dropped (`cats OR dogs the`, and a dangling `cats OR dogs OR`, are both
`cats OR dogs`); beside a quoted phrase, `intitle:`, `inurl:` or `site:` they
are dropped when they are the only loose words (`"machine learning" the` is
`"machine learning"`, `intitle:python the` is `intitle:python`). The parser
lists them in `ignoredWords`. A query of stop words with nothing else to
match on (`the`, `the -java`) still finds nothing.

Words made only of symbols (`*`, `&`, `@`) are handled the same way, since
the tokenizer discards them too: `site:wikipedia.org *` is
`site:wikipedia.org`, `cats OR dogs &` is `cats OR dogs`, and a symbol that is
an OR alternative is dropped from its group (`cats OR &` is `cats`). Beside
real words they are left as typed (`tom & jerry`), and `*` on its own finds
nothing. Words that merely contain symbols (`c++`, `c#`, `node.js`, `.net`)
are not affected.

Known limitation: the index analyzer drops `+` and `#`, so `c++`, `c#` and
`c` are the same token. `-c++` therefore excludes pages about C and C# as
well. Fixing it needs an analyzer change and a reindex.

`site:`, the exclusions and `AND` are filters: they decide which documents
qualify and add nothing to a score, so a result that remains is ranked
exactly as it would be without them. `site:` and the `domain` parameter are
both strict and narrow each other. `intitle:` and `inurl:` score at the
existing title and URL weights. Operators apply to web and news search; the
image, video and map verticals still read the query as plain words.

### Pagination limits

Only the first 10,000 results of a search can be paged through — OpenSearch's
`index.max_result_window`, which the index leaves at its default. The last
page therefore depends on the page size: `min(SEARCH_MAX_PAGE, floor(10000 /
limit))`, which is page 500 at 10 or 20 per page and page 200 at 50. A page
beyond it is refused with a 400 that names the limit. `pagination.totalPages`
stops at the same page, so a client that follows it never asks for a page
the API would refuse, while `total` and `pagination.totalResults` stay the
exact number of matches. `GET /api/search/config` publishes `maxLimit`,
`maxPage`, `maxResultWindow` and `maxPageAtMaxLimit`.

Duplicates collapse after ranking, so when more than 10,000 documents match
and some of the first 10,000 are copies, fewer distinct results can be paged
through than `total` counts. In that case the ranking pass walks the whole
window and counts them, and `totalPages` stops at the last page that holds
results. A page inside the bounds but past the last result is an empty 200.

### Suggestions

`GET /api/suggestions?q=&limit=` completes a prefix from three MongoDB
sources, in this order: past searches that returned at least one result (most
searched first), indexed terms (the word in the most documents first), and
the legacy `Suggestion` collection. Each source is ordered before it is cut
to the limit (default 8, maximum 20). The prefix is read as text, never as a
pattern, and only its first 100 characters are used.

Known limitation: the `Term` collection is written only when
`SEARCH_ENGINE=mongo`. With OpenSearch as the engine its vocabulary is the
one it held when the engine was switched, so indexed-term suggestions do not
reflect pages crawled since.

### Deduplication

The document `_id` is a hash of the canonical URL, so `http`/`https`, `www`,
a trailing slash and tracking parameters (`utm_*`, `fbclid`, …) all resolve
to the same document instead of appearing as separate results. A
`contentHash` additionally collapses the same body text published at
genuinely different addresses (syndicated copies, mirrors).

### Debugging relevance

Development-only, admin-authenticated, and disabled in production:

```
GET /api/admin/search/explain?q=<query>&url=<page url>
GET /api/admin/search/analyze?text=<text>&analyzer=ph_search
```

The first shows how the query was parsed, the exact OpenSearch body, and
that document's score breakdown; the second shows how text is tokenised.

## AI answers

`GET /api/ai-answer?q=` returns a short answer to the query **written from the
documents the search engine retrieved for it**, with the sources it cites —
retrieval-augmented generation. The frontend shows it above the web results.

- Retrieval is the existing search (`searchDispatcher.webSearch`); the page
  text for those documents is then read from the index. No second search
  engine and no second copy of the pages.
- The model cites sources by number only. The backend maps the numbers back to
  the retrieved documents, so a citation can never be an invented link.
- Retrieved pages are treated as untrusted text and kept apart from the
  instructions, so a page cannot give the model orders.
- It is optional. Set `AI_API_KEY` to switch it on; without it the endpoint
  answers `"status": "not_configured"` and search is unaffected. A model
  failure is reported as `"status": "unavailable"`, never as a broken page.

The architecture, the response format, every setting, how citations work and
how to change the model or provider are in
[docs/AI_ANSWERS.md](../docs/AI_ANSWERS.md). Code: `services/ai/`.

## External web search (SerpApi)

Optional Google web results, from [SerpApi](https://serpapi.com/), shown
**after** the index's own results on the first page of a web search.

- Off by default. `SERPAPI_ENABLED=true` plus `SERPAPI_API_KEY` switches it on;
  while off, no request is made and search is exactly as before.
- The index's results keep their order, scores and pages. Google results are
  appended on page 1 only; pages 2+ are the index's alone. A Google result for
  a page the index already has is dropped.
- A SerpApi failure (bad key, rate limit, timeout, outage) never fails a
  search: the index's results come back with `external.status: "unavailable"`.
- AI answers do not use SerpApi; nothing from SerpApi is stored.
- With it on, the Images, Videos and Maps tabs come from Google Images, Videos
  and Maps (one cached request per query and tab); with it off they are the
  crawler's own verticals, as before.

Settings, pagination and totals, failure handling, usage limits and security
are in [docs/SERPAPI.md](../docs/SERPAPI.md). Code: `services/externalSearch.js`,
`services/external/`.

## Run

Two processes. The API answers requests; the worker crawls.

```bash
npm start            # API, production
npm run dev          # API, auto-restart on change

npm run worker       # crawl worker
npm run worker:dev   # crawl worker, auto-restart on change

npm test             # full test suite
```

The API connects to MongoDB before it listens, so it never accepts traffic
against a dead database. Nothing is crawled unless a worker is running:
starting a crawl without one records the job and leaves it queued.

The worker needs MongoDB (the frontier) and Redis (the queue). It waits
rather than dying if Redis or OpenSearch is still starting.

## Code style

```bash
npm run lint           # ESLint — correctness only
npm run lint:fix       # ...and fix what can be fixed automatically
npm run format         # Prettier — rewrite
npm run format:check   # Prettier — verify, as CI does
```

The two tools do not overlap: `eslint-config-prettier` is loaded last and
switches off every stylistic rule, so ESLint never has an opinion about a line
Prettier owns. Settings live in `eslint.config.js` and `.prettierrc.json`, and
both are enforced in CI.

## Tests

Most of the suite runs on an in-memory MongoDB and needs nothing else. Two
suites need a live service:

| Suite               | Needs      | What it covers                                        |
| ------------------- | ---------- | ----------------------------------------------------- |
| `tests/opensearch/` | OpenSearch | ranking, operators, the search API, the result window |
| `tests/queue/`      | Redis      | BullMQ delivery and the one-slice-per-host guarantee  |

When the service is not reachable, those tests are reported as **skipped**,
with a warning before the first suite. They are never reported as passing:
`tests/helpers/globalSetup.js` probes each dependency before any test file is
loaded, so a suite can choose `describe.skip` rather than running tests that
assert nothing.

```bash
npm test                                 # skips what it cannot reach
OPENSEARCH_REQUIRED=true \
  REDIS_REQUIRED=true npm test           # fails instead of skipping — what CI runs
```

Use the `_REQUIRED` flags anywhere a green run is meant to mean those parts
actually work.

The live suites create and delete their own indexes (`ph-google-pages-test`,
`-crawl-test`, `-operators-test`, `-api-test`, `-window-test`) and queue
prefixes (`ph-google-test-*`) on whatever `OPENSEARCH_NODE` and `REDIS_URL`
point at, and both default to `localhost`. On a machine that also runs the
real stack, point them at a throwaway instance first:

```bash
OPENSEARCH_NODE=http://127.0.0.1:9210 REDIS_URL=redis://127.0.0.1:6380 \
  OPENSEARCH_REQUIRED=true REDIS_REQUIRED=true npm test
```

`tests/integration/` runs the search API on the superseded MongoDB engine;
`tests/opensearch/searchApi.test.js` sends the same kind of requests with
OpenSearch behind them.

Note what this deliberately does **not** need: the crawl worker's frontier,
drain loop, politeness, depth limits, page budgets and stop handling are all
exercised without Redis, because `processHost` is exported and the tests call
it directly (`tests/helpers/crawlRunner.js`). Only BullMQ's delivery needs a
queue. There is no "run the crawler inside the API" switch, because it would
quietly recreate the arrangement Phase 2 removed.

## Create an administrator

`/api/admin/*` and platform analytics require the `admin` role.

```bash
# create a new admin
npm run create-admin -- --email you@example.com --password 'yourPassword'

# or promote an existing account without changing its password
npm run create-admin -- --email you@example.com --promote
```

Signing up through the app always creates a normal user, including the first
account on an empty database. Admin rights are only granted with the command
above.

## Populate the index

A fresh database has nothing to search. Two scripts fill it:

```bash
npm run seed-index                     # curated pages across every vertical
npm run seed-index -- --group places   # places | nature | technology | culture | news
npm run seed-index -- --dry-run

npm run reindex                        # re-fetch pages already indexed
npm run reindex -- --domain example.com
```

`seed-index` fetches a curated list of pages one at a time, with no link
following. The `news` group is different: it crawls a handful of blogs so the
article pages behind their listing pages are indexed too.

`reindex` re-fetches pages that are already in the index. It exists because
pages store extracted text rather than raw HTML, so the markup the image,
video and map verticals need can only come from a fresh fetch — run it once
after upgrading a database that predates those verticals.

Both scripts honour robots.txt and the crawl delay, and neither deletes
anything.

## Crawling by topic

The quickest way to fill the index with a broad range of subjects. The
**seed catalog**, [`config/crawlSeeds.json`](config/crawlSeeds.json), lists
17 topics (technology, science, mathematics, education, history, geography,
health, business, finance, sports, arts, music, literature, film, travel,
environment, reference) and 38 starting pages for them: mostly Wikipedia,
plus MDN, NASA Science, MedlinePlus, WHO, EPA, Project Gutenberg and
Wikivoyage.

### How seeds work

Each **seed** is a starting page. A topic crawl creates one crawl job per seed,
and each job:

1. fetches the seed page (always, even if it was crawled before),
2. extracts its text and indexes it in OpenSearch,
3. collects its links — main-content links first, navigation last — and keeps
   only those the seed is allowed to follow (see _Domain rules_),
4. crawls those breadth-first, until the seed has used its page budget or
   reached its depth limit.

All the jobs of one topic crawl share a `batchId` and count as **one** crawl
against `CRAWLER_MAX_CONCURRENT_JOBS`. Every page goes through exactly the same
pipeline as a single-URL crawl: frontier → worker → robots.txt → fetch → text
processing → MongoDB → OpenSearch.

### Start a topic crawl

MongoDB, OpenSearch, Redis and the worker must be running:

```bash
docker compose up -d opensearch redis     # from the repository root
npm run worker                            # terminal 1: the crawl worker
```

From the **admin dashboard**: Crawlers → _Crawl by topic_, tick topics, set
pages per seed, then _Crawl topics_. Each seed appears in the job table,
labelled with its topic.

From the **command line** (terminal 2):

```bash
npm run crawl:topics -- --list                                      # topics and seed counts
npm run crawl:topics -- --topics science,history --dry-run          # what would be crawled
npm run crawl:topics -- --topics all --check                        # can every seed be reached?
npm run crawl:topics -- --topics science,history --pages 3 --wait   # a small first crawl
npm run crawl:topics -- --topics all --pages 5 --wait               # every topic
```

`--wait` prints progress until every job finishes (Ctrl+C stops watching, not
the crawl). `--inline` crawls in the script's own process instead, for a
machine without Redis.

Or through the **API**:

```http
POST /api/admin/crawler/start
{ "topics": ["science", "history"], "maxPagesPerSeed": 5 }

POST /api/admin/crawler/stop
{ "batchId": "<batchId from the start response>" }
```

`"topics": "all"` selects every topic.

**Start small.** 3–5 pages per seed is enough to confirm that crawl → index →
search works end to end. Raise it once the results look right.

Running the same topic crawl again **grows** the index rather than repeating
it: the seeds are re-fetched, pages already crawled are skipped until they are
due for a re-crawl (`CRAWLER_RECRAWL_AFTER_DAYS`), and links the first run had
no budget for are crawled this time.

### Add a topic or a seed

Edit `config/crawlSeeds.json`; no code changes. A new topic:

```json
{
  "id": "food",
  "label": "Food",
  "seeds": [
    { "url": "https://en.wikipedia.org/wiki/Cooking", "source": "wikipedia" },
    { "url": "https://en.wikipedia.org/wiki/Cuisine", "source": "wikipedia" }
  ]
}
```

A seed on a new website either names no `source` (it then stays on its own
host) or gets a source of its own under `"sources"`:

```json
"example-site": {
  "allowedDomains": ["docs.example.org"],
  "excludePatterns": ["/login", "[?&]page="]
}
```

A seed can also opt in to [sitemap discovery](#sitemap-discovery), which then
runs for its crawls whenever `CRAWLER_SITEMAPS=true`. Leave the flag out to opt
out; only `true` or `false` is accepted:

```json
{ "url": "https://docs.example.org/guide/", "source": "example-site", "sitemaps": true }
```

Then check it before crawling:

```bash
npm run crawl:topics -- --topics food --check
```

The catalog is validated whenever it is loaded. Unknown sources, duplicate
seeds, invalid regular expressions and seeds outside their own allowed domains
are rejected with a message naming the problem. The API reads the file once,
so restart the API after editing it. To use a different catalog altogether,
point `CRAWLER_SEEDS_FILE` at another JSON file of the same shape.

### Domain rules

A seed never wanders across the web:

- `allowedDomains` — the domains (and their subdomains) a seed may follow
  links to. Taken from the seed, else its source, else the seed's own host.
  `www.` is ignored. `en.wikipedia.org` does **not** allow `de.wikipedia.org`
  or `en.m.wikipedia.org`.
- `excludePatterns` — regular expressions, case-insensitive and matched
  against the full URL, for links never to follow. `defaultExcludePatterns`
  apply to every seed. For Wikipedia the source excludes talk, user, file,
  category, template, special and help pages, edit links and disambiguation
  pages. In JSON a backslash is written twice.
- `maxDepth` — optional per seed; otherwise `CRAWLER_SEED_MAX_DEPTH`.

robots.txt is honoured for every page, and links to non-HTML files, `mailto:`,
`javascript:` and `rel="nofollow"` are never followed.

### Crawl limits

All set in `.env` (defaults shown; see `.env.example`):

| Variable                                 | Default | Meaning                                                                                         |
| ---------------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `CRAWLER_SEED_PAGES_PER_SEED`            | 5       | Pages each seed may crawl (a request may choose another number)                                 |
| `CRAWLER_MAX_PAGES_PER_CRAWL`            | 300     | Ceiling on a whole topic crawl: seeds × pages per seed                                          |
| `CRAWLER_SEED_MAX_DEPTH`                 | 2       | Link depth from a seed                                                                          |
| `CRAWLER_MAX_LINKS_PER_PAGE`             | 100     | Links one page may add to the frontier                                                          |
| `CRAWLER_MAX_PAGE_BYTES`                 | 5242880 | Largest page downloaded (5 MB)                                                                  |
| `CRAWLER_MAX_PAGES_LIMIT`                | 10000   | Hard cap on any one job, including pages per seed                                               |
| `CRAWLER_DELAY_MS`                       | 1000    | Delay between two requests to one host                                                          |
| `CRAWLER_TIMEOUT_MS`                     | 8000    | Request timeout                                                                                 |
| `CRAWLER_WORKER_CONCURRENCY`             | 4       | Different hosts crawled at once; never two requests to one host                                 |
| `CRAWLER_MAX_ATTEMPTS_PER_URL`           | 3       | Attempts for a failing URL, with 1/4/9-minute backoff                                           |
| `CRAWLER_MAX_CONCURRENT_JOBS`            | 2       | Crawls open at once; a topic crawl counts as one                                                |
| `CRAWLER_CONTINUOUS`                     | false   | Continue a crawl past its budget in new bounded jobs (below)                                    |
| `CRAWLER_CONTINUOUS_MAX_CONTINUATIONS`   | 10      | Continuation jobs one crawl may chain                                                           |
| `CRAWLER_SITEMAPS`                       | false   | Read sitemaps for crawls whose seed opts in (`"sitemaps": true`), once per crawl chain and host |
| `CRAWLER_SITEMAP_DISCOVERY_LEASE_MS`     | 900000  | A sitemap discovery still running after this long may be taken over                             |
| `CRAWLER_SITEMAP_DISCOVERY_MAX_ATTEMPTS` | 2       | Attempts per crawl chain and host; only temporary failures are retried                          |

### Continuous crawl

Off by default. With `CRAWLER_CONTINUOUS=false`, a job that spends its page
budget skips every URL it discovered but never reached.

With `CRAWLER_CONTINUOUS=true`, the job still stops at its budget, but those
URLs stay `pending`. The next maintenance sweep closes the job and starts a
**continuation**: a new job with the same seed, domain scope, exclude patterns,
depth limit, delay and page budget. The pending URLs move to it, and the worker
crawls them against the new budget. When that budget is spent the same thing
happens again, until the frontier is drained, the crawl is stopped, or it
reaches `CRAWLER_CONTINUOUS_MAX_CONTINUATIONS`.

- One sweep creates at most one continuation per crawl, so there is no
  recursive job loop.
- A continuation takes over its parent's crawl slot, so `CRAWLER_MAX_CONCURRENT_JOBS`
  still holds. If no slot is free, the URLs are skipped as they would be with
  continuous crawl off.
- robots.txt refusals, unsupported content types and permanent failures stay
  skipped or failed. Only URLs that are still `pending` carry forward.
- Re-crawls of pages already fetched are not affected; they stay on
  `CRAWLER_RECRAWL_AFTER_DAYS`.
- Stopping any job in the chain ends the chain.

### Sitemap discovery

Off by default, and opted into per seed. Once a crawl has indexed its first
page on a host, the worker reads that host's sitemaps — those named in
robots.txt, else `/sitemap.xml` — and adds the page URLs to the frontier as
ordinary pending rows of the job, at depth 1. It does so only when both say
yes:

- the global switch `CRAWLER_SITEMAPS=true`, and
- the crawl's seed: `"sitemaps": true` on the seed in `config/crawlSeeds.json`
  (see [Add a topic or a seed](#add-a-topic-or-a-seed)).

A seed without the flag is opted out, so turning the global switch on changes
nothing until a seed asks for it; turning it off disables discovery for every
seed. The choice is stored on the crawl job (`sitemaps`) and copied to every
continuation, so a chain keeps the setting it started with. A single-URL crawl
started from the admin console has no seed and is opted out, as is any job
created before the flag existed.

- It happens once per crawl chain and host. Later slices and continuation jobs
  do not repeat it; a job-less re-crawl never triggers it.
- Sitemap URLs pass the same tests as a link: domain scope, exclude patterns,
  robots.txt, no assets. They are crawled under the job's page budget, and a
  sitemap fetch itself costs no budget.
- Only hosts the job's domain rules name are read (the seed's host, or its
  `allowedDomains`), and only sitemap files on that host.
- Requests are made inside the host's slice, one at a time with the host's
  delay, and are bounded by the `CRAWLER_SITEMAP_MAX_*` settings in
  `.env.example`. No more URLs are added than the crawl could ever fetch.
- A failed discovery never fails the crawl. Temporary failures (timeouts, 5xx, 429) are retried up to `CRAWLER_SITEMAP_DISCOVERY_MAX_ATTEMPTS`; a 404 or a
  file that is not a sitemap is not.

Most seeds are on Wikipedia, which is one host, so a topic crawl's speed is set
by `CRAWLER_DELAY_MS` on that host — roughly one page every one to two seconds
— not by concurrency.

The crawler identifies itself as `PH-SearchBot/1.0`. Set `CRAWLER_CONTACT_URL`
to a page describing it. Never put "Googlebot" in `CRAWLER_USER_AGENT`: sites,
Wikipedia included, answer anything that looks like an impersonation of
Google's crawler with a 403.

### Verify indexed pages and test search

```bash
# How many documents OpenSearch holds
curl -s "localhost:9200/ph-google-pages/_count"

# The most recently crawled pages
curl -s "localhost:9200/ph-google-pages/_search?size=5&sort=crawledAt:desc&_source=title,url"

# Search through the API, as the frontend does
curl -s "localhost:5000/api/search?q=photosynthesis"
curl -s "localhost:5000/api/search?q=world+war+ii"
```

The admin dashboard shows the same: _Crawlers_ for job progress, _Index_ for
pages and the OpenSearch document count.

## Other commands

```bash
npm run migrate            # additive backfill (see below); --dry-run to preview
npm run verify             # live smoke test against a running server
npm run test:unit
npm run test:integration
npm run test:coverage
```

`npm run verify` exercises every endpoint. To include the admin and crawler
checks:

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' npm run verify
```

### Migration

`npm run migrate` is additive and never deletes anything. It:

1. derives the `domain` field for pages crawled before that field existed, and
2. promotes `status: 'crawled'` → `'indexed'` for pages that genuinely have
   postings in the inverted index.

Preview first with `npm run migrate -- --dry-run`.

---

## Architecture

```
server.js           API entry point: validate config, connect DB, listen, shutdown
worker.js           crawl worker entry point: the only process that fetches a page
app.js              builds the Express app (exported without listen, for tests)
Dockerfile          multi-stage production image, runs as the `node` user
config/             env validation, database connection
middleware/         auth, rate limiting, error handling
models/             Mongoose schemas
controllers/        request handling and validation
services/           search dispatch, ranking, analytics, crawl jobs, frontier
services/opensearch/ client, index settings, query building, search
services/queue/     Redis connection and the BullMQ crawl queue
crawler/            frontier drain loop, robots.txt, fetcher, links, indexer
utils/              text processing, validators, URL canonicalisation, logging
scripts/            migration, seeding, reindexing, live API verification
scripts/dev/        ad-hoc developer scripts, not part of the application
tests/              unit, integration, end-to-end, search-quality, queue suites
```

Decisions that were not obvious are recorded in [`docs/adr/`](../docs/adr) one
level up.

### Search pipeline

1. Validate and normalise every query parameter.
2. Parse the query: quoted phrases, site and domain terms, question form,
   whether a typo correction is safe to attempt (`services/opensearch/queryParser.js`).
3. Build one OpenSearch body — `must` decides what matches, `should` reorders,
   `filter` constrains without scoring (`services/opensearch/queryBuilder.js`).
4. Apply the domain, date, language and article filters as non-scoring clauses.
5. Let OpenSearch score and sort, with two bounded multipliers for page quality
   and recency.
6. Over-fetch, collapse near-duplicates, then cut to the requested page.
7. Build each snippet from the highlighted fragment that actually matched.
8. Record analytics, and history when the caller is signed in.

Steps 2–5 never touch MongoDB. Page text lives in the index, so ranking a wide
result set costs no database reads at all.

Images, videos and places still take the MongoDB path described under
[Verticals](#verticals).

### Verticals

One crawl fills five indexes. While a page is fetched and parsed for web
search, the same HTML is mined for the other verticals:

| Vertical | Source in the page                                                             | Stored as                        |
| -------- | ------------------------------------------------------------------------------ | -------------------------------- |
| Web      | body text, title, description                                                  | `Page` + `Term` (inverted index) |
| Images   | `<img>`, `<picture>`, `og:image`                                               | `Media` (type: image)            |
| Videos   | `<video>`, YouTube/Vimeo/Dailymotion embeds, `og:video`, JSON-LD `VideoObject` | `Media` (type: video)            |
| News     | `og:type=article`, JSON-LD `NewsArticle`/`BlogPosting`                         | article fields on `Page`         |
| Maps     | JSON-LD `Place`/`LocalBusiness`, geo meta tags, `.geo` microformat             | `Place` (2dsphere index)         |

How each behaves:

- **Images** are filtered down to content: icons, spacers, tracking pixels
  and anything under 100px are dropped. Alt text, captions and filename words
  form the searchable text.
- **Videos** are normalised to one canonical watch URL each, and third-party
  players embed through privacy-preserving hosts (youtube-nocookie, Vimeo).
- **News** excludes reference pages deliberately. A site declaring
  `og:type=website` with a generic JSON-LD `Article` (Wikipedia's shape) is
  not news; `NewsArticle`, `BlogPosting` and `og:type=article` are.
- **Maps** renders with OpenStreetMap, so no API key is required.

Images, videos and places are retrieved through a multikey index on a token
array — MongoDB's own inverted index — and ranked in process, the same way
web results are.

### Crawler

The crawler runs in its own process. The API never fetches a page — it
validates a crawl request, writes it down and enqueues it.

```
POST /crawler/start ─→ CrawlJob (MongoDB)
                    └→ seed URL  ─→ CrawlFrontier (MongoDB)
                                 └→ host job     ─→ Redis (BullMQ)
                                                       │
  worker.js ───────────────────────────────────────────┘
     └→ claim a URL for that host → robots → fetch → extract
        → new links back into the frontier → index → repeat
```

**The unit of queued work is one host, and the BullMQ job id is the
hostname.** BullMQ will not hold two jobs with the same id, so _one request
at a time per host_ is a property of the design rather than something
enforced at runtime — and it holds across crawl jobs too, because a site does
not care which of our crawls is hitting it. Worker concurrency is therefore
exactly "how many different sites at once", and scaling to three workers
(`docker compose --profile crawler up -d --scale worker=3 worker`) changes
nothing about politeness.

A lease handles `CRAWLER_HOST_SLICE_PAGES` pages and then yields, re-queuing
itself with the host's own delay if work remains. Without that, one site with
50,000 pages would hold a worker slot until it finished.

**The frontier lives in MongoDB** (`CrawlFrontier`): every URL known, with
its host, depth, priority, status and next-crawl time. Claiming is a single
atomic `findOneAndUpdate`, so two workers racing for a URL cannot both get
it. Because it is durable and shared:

- an interrupted crawl resumes where it stopped, not from the seed;
- a second crawl skips URLs a first one already fetched, until they fall due;
- re-crawls are scheduled rather than manual.

Rows are keyed by canonical URL — the same identity function the search index
uses — so `/article` and `/article?utm_source=twitter` are one page, not two
fetches.

Each crawl is still:

- **bounded** — `maxPages` per job, hard-capped by `CRAWLER_MAX_PAGES_LIMIT`,
  reserved atomically so concurrent hosts cannot overshoot it
- **polite** — honours `robots.txt` including `Crawl-delay`, and identifies
  itself with a contact URL (`CRAWLER_CONTACT_URL`)
- **scoped** — stays on the seed's domain unless `sameDomainOnly: false`,
  within `maxDepth`; a topic-crawl seed follows its explicit `allowedDomains`
  and `excludePatterns` instead (`crawler/crawlScope.js`), and no page adds
  more than `CRAWLER_MAX_LINKS_PER_PAGE` links to the frontier
- **cancellable** — `POST /api/admin/crawler/stop` sets a flag the worker
  reads between pages. It answers "stopping": the API cannot reach into
  another process, so the request travels through the database.

How the crawler treats what a site tells it:

- **robots.txt** is cached for a day. No robots.txt (any 4xx) means no rules.
  One that cannot be read (5xx, 429, timeout) means the rules are unknown:
  nothing on that host is fetched, and it is asked again a few minutes later.
- **Page directives** — `<meta name="robots">`, `<meta name="ph-searchbot">`
  and the `X-Robots-Tag` header. `noindex` pages are fetched but not indexed,
  and their links are still followed; `nofollow` pages are indexed and their
  links are not; `none` is both. A page that was indexed before and has since
  turned `noindex` is no longer updated, but is not removed.
- **Redirects** are followed up to 5 hops on the same host, each hop checked
  against robots.txt and the job's scope. A redirect to another host is never
  followed: the target joins the frontier like a link, one level deeper, to be
  fetched in that host's own slot. The address a redirect ends at is recorded,
  so the page is not fetched again through a direct link. A redirect to a
  page already crawled and not yet due is not followed at all, and costs the
  job no page.
- **Crawl-delay** is a floor. The wait between two requests to a host is the
  longer of the job's own delay and the site's `Crawl-delay`, capped at
  `CRAWLER_MAX_DELAY_MS`; a job can ask to be slower than a site requires,
  never faster.
- **Canonical links** (`<link rel="canonical">`, `Link` header) are a hint.
  The page is indexed under the URL it was fetched from; an in-scope
  canonical is stored as `canonicalUrl` and queued like a link. Conflicting,
  malformed or out-of-scope canonicals are ignored.
- **Content types** — only `text/html` and `application/xhtml+xml` are read.
  Anything else is dropped after its headers, before the body is downloaded.
- **Errors** — 408, 429, 5xx, timeouts and connection failures are retried
  with backoff (1, 4, 9 minutes, or the host's `Retry-After` if longer, up to
  an hour). 404 and other 4xx, redirect loops and empty pages are not retried.
  A 429 or 503 also ends the host's current slice.

Redis carries scheduling only. Losing it costs the queue's position, not the
crawl — the next maintenance sweep rebuilds the queue from the frontier, and
starting a crawl while Redis is down still records the job (the response says
`queued: false`).

A sweep runs every `CRAWLER_MAINTENANCE_INTERVAL_MS` to reclaim leases from
workers that died mid-fetch, re-queue pages due for a re-crawl, close out
finished jobs, and enqueue hosts with work waiting.

When a job closes — budget spent, stopped or failed — the URLs it queued but
never fetched are marked skipped, so no worker crawls them later without a
budget. A later crawl that rediscovers one of them may still fetch it.

Jobs abandoned by a dead worker are failed after `CRAWLER_ORPHAN_TIMEOUT_MS`
(30 minutes) with no progress — no heartbeat, none of the job's URLs fetched
or claimed, and no crawling on any host it is waiting on, which is the normal
state of the later seeds in a topic crawl that share one site. Silence only
counts while the crawler is running: the sweep records when it last ran, and
after a gap (a stopped worker, a sleeping laptop) the timeout starts again
from when it is back, since the durable frontier lets it resume those crawls.
Jobs with nothing left to do are closed before this check, and a finished
job is never changed by it. Note what
does _not_ happen any more: restarting the API used to mark every running
job failed, which would now kill crawls a healthy worker is part-way through.

---

## API

All responses use one envelope:

```json
{ "success": true, "data": { } }
{ "success": false, "message": "..." }
```

| Method | Endpoint                             | Auth     | Role  | Purpose                                                                                                                    |
| ------ | ------------------------------------ | -------- | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/` `/health` `/api/health`          | –        | –     | Health and DB status                                                                                                       |
| POST   | `/api/auth/register`                 | –        | –     | Create an account                                                                                                          |
| POST   | `/api/auth/login`                    | –        | –     | Sign in, returns a JWT                                                                                                     |
| GET    | `/api/auth/me`                       | yes      | any   | Current profile                                                                                                            |
| POST   | `/api/auth/change-password`          | yes      | any   | Change password                                                                                                            |
| GET    | `/api/search`                        | optional | any   | Search (`q,page,limit,sort,domain,date,language,category`)                                                                 |
| GET    | `/api/search/config`                 | –        | –     | Published limits and filter options                                                                                        |
| GET    | `/api/suggestions`                   | optional | any   | Autocomplete                                                                                                               |
| GET    | `/api/ai-answer`                     | optional | any   | AI answer written from the retrieved documents, with cited sources (see [AI answers](#ai-answers))                         |
| POST   | `/api/ai-answer/feedback`            | optional | any   | Thumbs up / down on an AI answer                                                                                           |
| GET    | `/api/images/download`               | none     | any   | One image from image search, as a file download. Needs the `downloadToken` the search response gave for that image (`?url=&sig=&name=`). |
| GET    | `/api/history`                       | yes      | own   | Your search history                                                                                                        |
| POST   | `/api/history`                       | yes      | own   | Record a query                                                                                                             |
| DELETE | `/api/history/:id`                   | yes      | own   | Delete one entry                                                                                                           |
| DELETE | `/api/history`                       | yes      | own   | Clear your history                                                                                                         |
| GET    | `/api/analytics/me`                  | yes      | own   | Your own activity                                                                                                          |
| GET    | `/api/analytics/overview`            | yes      | admin | Headline analytics                                                                                                         |
| GET    | `/api/analytics/searches`            | yes      | admin | Raw search log                                                                                                             |
| GET    | `/api/analytics/top-queries`         | yes      | admin | Most frequent queries                                                                                                      |
| GET    | `/api/analytics/zero-result-queries` | yes      | admin | Gaps in the index                                                                                                          |
| GET    | `/api/admin/dashboard`               | yes      | admin | Dashboard payload                                                                                                          |
| GET    | `/api/admin/metrics`                 | yes      | admin | Raw platform metrics                                                                                                       |
| GET    | `/api/admin/pages`                   | yes      | admin | Browse indexed pages                                                                                                       |
| GET    | `/api/admin/websites`                | yes      | admin | Domains and page counts                                                                                                    |
| GET    | `/api/admin/users`                   | yes      | admin | Accounts (no password hashes)                                                                                              |
| GET    | `/api/admin/search/status`           | yes      | admin | OpenSearch health, index size, MongoDB drift                                                                               |
| POST   | `/api/admin/search/reindex`          | yes      | admin | Rebuild the index from MongoDB                                                                                             |
| GET    | `/api/admin/search/reindex`          | yes      | admin | Reindex progress                                                                                                           |
| GET    | `/api/admin/search/sample`           | yes      | admin | Run a search and see the scores                                                                                            |
| GET    | `/api/admin/search/explain`          | yes      | admin | Scoring breakdown (dev only)                                                                                               |
| GET    | `/api/admin/search/analyze`          | yes      | admin | Tokenisation (dev only)                                                                                                    |
| GET    | `/api/admin/crawler/status`          | yes      | admin | Jobs, frontier counts, queue depth and limits                                                                              |
| GET    | `/api/admin/crawler/jobs`            | yes      | admin | Job list                                                                                                                   |
| GET    | `/api/admin/crawler/jobs/:id`        | yes      | admin | One job                                                                                                                    |
| GET    | `/api/admin/crawler/seeds`           | yes      | admin | Seed catalog: topics, seeds, domain rules and topic-crawl limits                                                           |
| POST   | `/api/admin/crawler/start`           | yes      | admin | Queue a crawl (`seedUrl,maxPages,maxDepth,sameDomainOnly,crawlDelayMs,force`), or a topic crawl (`topics,maxPagesPerSeed`) |
| POST   | `/api/admin/crawler/stop`            | yes      | admin | Ask a crawl to stop (`jobId`, `batchId`, or neither for all); ends after the page in flight                                |

---

## Security

- Passwords hashed with bcrypt; never stored, returned or logged in plaintext
- JWT secret from the environment only, with expiry and explicit error handling
- `USER` / `ADMIN` roles; `/api/admin/*` requires both authentication and the
  admin role
- Rate limiting on login, register, search, suggestions and crawler controls
  (disabled under `NODE_ENV=test`)
- `helmet` security headers; `x-powered-by` disabled
- CORS restricted to configured origins in production
- Every parameter validated; user input is never interpolated into a regular
  expression or an ObjectId
- Crawl seeds cannot target localhost or private network ranges
- Stack traces are never returned in production responses
- The logger redacts anything that looks like a secret and strips credentials
  from connection strings

---

## Deployment notes

- `Dockerfile` builds the production image: dependencies installed with
  `npm ci --omit=dev`, application files owned by and run as the unprivileged
  `node` user, and a health check that reports whether the process is serving
  HTTP
- Set `NODE_ENV=production` and a real `FRONTEND_URL`
- Use a strong `JWT_SECRET` (32+ characters); rotating it signs every user out
- Logs are JSON in production, human-readable otherwise
- `SIGINT`/`SIGTERM` trigger graceful shutdown: running crawls are asked to
  stop, the HTTP server drains, then MongoDB disconnects. Compose sets
  `init: true` so those signals actually reach the process
- `.env` is gitignored — never commit it, and never bake one into an image:
  `.dockerignore` excludes it because a layer stays readable even after a
  later layer deletes the file
- Turn OpenSearch security on before anything beyond a laptop reaches it. The
  steps are at the bottom of `docker-compose.yml`: admin password, TLS, a
  non-admin application role, and no longer publishing 9200 and 5601 to the
  host
