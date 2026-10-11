# PH Google (PH Spectrum) — deployment handover runbook

For the team deploying PH Google. It covers what to configure, how to start
it, how to initialise it, how to check it, and what it depends on.

> **Status at handover (2026-10-11).** The production configuration below has
> been prepared and the automated test suites, lint and production build pass
> locally. **The stack has not yet been started with this production
> configuration** (Docker was unavailable during preparation), so the live
> smoke tests in [§8](#8-health-checks-and-smoke-tests) must pass on the
> target before it is called production-ready.

---

## 1. What runs

```
            HTTPS (your load balancer / reverse proxy terminates TLS)
                                  │
                                  ▼
  ┌──────────── docker-compose (one network) ─────────────────────────────┐
  │  frontend  nginx :8080  ← the ONLY published port                     │
  │     ├─ /            the React app (static files)                      │
  │     └─ /api/*  ──►  backend :5000  (Node/Express API, not published)  │
  │                       ├─► opensearch :9200   search index             │
  │                       ├─► redis :6379        crawl queue (password)   │
  │                       └─► MongoDB            MONGO_URI (managed DB)   │
  │  worker      crawl worker — NOT started (profile "crawler")           │
  │  dashboards  OpenSearch Dashboards — NOT started (profile "tools")    │
  └───────────────────────────────────────────────────────────────────────┘
```

* The browser talks only to nginx. The app calls the relative path `/api`,
  which nginx proxies to the backend, so there is no cross-origin traffic
  and the backend needs no public port.
* `docker-compose.yml` is the local-development stack (ports published,
  security relaxed). **Production always layers `docker-compose.prod.yml` on
  top of it**, which removes every published port except the web entry
  point, adds a Redis password, re-enables OpenSearch disk watermarks, and
  sets production logging.

## 2. Prerequisites

| Item | Requirement |
|---|---|
| Docker Engine + Compose | Compose **v2.24 or later** (the prod file uses `!reset` / `!override`). Check: `docker compose version`. |
| Host | ≥ 4 vCPU, ≥ 8 GB RAM, ≥ 40 GB disk for a small index. OpenSearch needs `vm.max_map_count ≥ 262144` on Linux hosts: `sudo sysctl -w vm.max_map_count=262144` (persist in `/etc/sysctl.conf`). |
| MongoDB | A managed MongoDB (e.g. Atlas) reachable from the host, with backups enabled. Its connection string goes in `MONGO_URI`. (A local `mongo` container exists behind `--profile local-db` but is meant for development.) |
| Domain + TLS | A DNS name for the site and a TLS certificate, terminated by your load balancer or reverse proxy (see [§4](#4-tls-the-domain-and-client-ips)). |
| Outbound internet | The backend calls Parallel (web, images, videos, maps), Anthropic (AI answers, optional), OpenStreetMap Nominatim (maps), YouTube/Vimeo oEmbed (video checks), and fetches result pages to verify images and places. |
| Source | Deploy from the Git commit approved for handover (see [§12](#12-rollback)). Never from a working copy with uncommitted files. |

## 3. Configuration

Two files, both created from tracked examples and **never committed**
(`.env` is ignored by Git and by both Docker builds):

### 3a. Project-root `.env` → read by Compose (`cp .env.production.example .env`)

| Variable | Required | Meaning |
|---|---|---|
| `FRONTEND_URL` | **yes** | Exact site origin, e.g. `https://search.example.com` (scheme + host, no path, no trailing slash; comma-separate several). It is the API's CORS allow-list. A wrong value makes sign-in and search fail with 403. |
| `REDIS_PASSWORD` | **yes** | Letters and digits only, 32+ characters (`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`). |
| `WEB_BIND`, `WEB_PORT` | no | Where the web entry point is published. Default `0.0.0.0:8080`. Use `WEB_BIND=127.0.0.1` when a reverse proxy on the same host terminates TLS. |
| `TRUST_PROXY` | no | Keep `1`. See [§4](#client-ips-behind-a-load-balancer). |
| `LOG_LEVEL` | no | `info` (default). `debug` only while diagnosing. |
| `OPENSEARCH_JAVA_OPTS` | no | Heap, default `-Xms1g -Xmx1g`; half of the container's memory, max ~31g. |

Compose refuses to start (with a message naming the variable) if a required
value is missing.

### 3b. `ph-google-backend/.env` → read by the API (`cp ph-google-backend/.env.example ph-google-backend/.env`)

| Variable | Required | Meaning |
|---|---|---|
| `MONGO_URI` | **yes** | MongoDB connection string. |
| `JWT_SECRET` | **yes** | 32+ characters; the server will not start in production without it. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Changing it signs every user out and invalidates image-download links. |
| `AI_API_KEY` | for AI answers | Anthropic key. Without it AI answers report "not configured"; set `AI_ANSWERS_ENABLED=false` to hide them. |
| `PARALLEL_API_KEY`, `PARALLEL_ENABLED=true`, `EXTERNAL_SEARCH_PROVIDER=parallel` | for external results | Web results beyond the index, and the Images/Videos/Maps tabs (`PARALLEL_VERTICALS_ENABLED=true`). |
| `PARALLEL_DAILY_LIMIT` | recommended | Requests per UTC day per backend process (default 100). Set it to your Parallel plan. |
| `MAPS_OSM_ENABLED`, `NOMINATIM_USER_AGENT` | for Maps | Nominatim's policy requires an identifying user agent with a contact URL. |
| `SERPAPI_ENABLED` | — | Keep `false` (SerpApi is not used; its code is retained). |
| `CRAWLER_CONTACT_URL` | if the crawler is ever enabled | Public page describing the bot. |

**Set by Compose, overriding this file:** `NODE_ENV=production`,
`LOG_LEVEL`, `FRONTEND_URL`, `REDIS_URL` (with the password),
`OPENSEARCH_NODE=http://opensearch:9200`, `TRUST_PROXY`. Every other setting,
with its default, is documented in `ph-google-backend/.env.example`.

The frontend needs **no** configuration: the image builds with
`VITE_API_BASE_URL=/api`, and a production build contains no `localhost`
address.

## 4. TLS, the domain and client IPs

TLS is terminated **outside** this stack. Point your HTTPS load balancer or
reverse proxy at the published web port (default `8080`), forward the `Host`
header, and redirect HTTP to HTTPS there. Recommended at that layer:
`Strict-Transport-Security: max-age=31536000`.

Do **not** add `X-Frame-Options: DENY` or `frame-ancestors 'none'` at the
edge: the app frames its own pages for its in-app tabs (nginx already sends
`X-Frame-Options: SAMEORIGIN`).

### Client IPs behind a load balancer

Rate limits (search, sign-in, AI answers, image downloads) count requests
per client IP. nginx sends the backend the address it sees, replacing any
`X-Forwarded-For` a client sent, and the backend trusts exactly that one hop
(`TRUST_PROXY=1`).

* **Nothing in front of nginx:** no change.
* **A load balancer / reverse proxy in front:** nginx would otherwise see
  the balancer's address for everyone. In `ph-google-frontend/nginx.conf`,
  uncomment the three `real_ip` lines and set `set_real_ip_from` to the
  balancer's address range (only that range). Rebuild the frontend image.
  **Keep `TRUST_PROXY=1`** — do not raise it.

## 5. First deployment

```bash
git clone <repository> ph-google && cd ph-google
git checkout <approved commit or tag>

cp .env.production.example .env                          # fill in (§3a)
cp ph-google-backend/.env.example ph-google-backend/.env  # fill in (§3b)

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
$COMPOSE config --quiet                                  # validates; prints nothing on success
$COMPOSE up -d --build                                   # NO --profile crawler
$COMPOSE ps                                              # all "healthy"/"running"; only frontend has a port
```

`up -d` starts opensearch, redis, backend and frontend. It does **not** start
the crawl worker or Dashboards.

## 6. Initialisation (once)

Run inside the backend container so it uses the container's configuration.

**a. Search index.** The index is created by the first (re)index, not at
API startup; until then searches return nothing from the index (external
results still work). Build it from the pages stored in MongoDB:

```bash
$COMPOSE exec backend npm run search:reindex
```

Additive. `--recreate` drops and rebuilds the index — use it only when
deliberately changing mappings. A new, empty MongoDB has no pages; see (c).

**b. Administrator account.** Pass credentials through the environment so
they stay out of shell history and logs:

```bash
$COMPOSE exec -e ADMIN_EMAIL=ops@example.com -e ADMIN_PASSWORD='<long password>' \
  -e ADMIN_NAME='Operations' backend npm run create-admin
```

Additive: creates the user or promotes an existing one; never deletes data.

**c. Seeding content — needs separate approval.** `npm run seed-index`
fetches a curated list of public pages (robots.txt honoured). It is the
crawler's fetcher run once per URL, so it falls under the crawler decision
in [§11](#11-crawler-and-worker-disabled). Do not run it without that
approval.

## 7. External services and limits

| Service | Used for | Limits / behaviour |
|---|---|---|
| **Parallel** Search API | External web results; Images, Videos and Maps tabs | Daily cap `PARALLEL_DAILY_LIMIT` (default 100) **per backend process**; resets at UTC midnight **and on restart**. At most 2 requests in flight. Answers cached in memory for 10 minutes. A full Images search may use up to 12 requests (6 rounds); a Videos search up to 9; a first web page 1. On repeated failures the provider is paused (60 s; 5–10 min on auth or rate-limit errors) and pages show "unavailable", never an error page. |
| **Anthropic** (AI answers) | The AI answer above web results | Per-IP rate limit; 10-minute answer cache. No global spend cap in the app — set a budget/alert in the Anthropic console. |
| **OpenStreetMap Nominatim** | Checking map pins | Public instance: ≤ 1 request/s, `NOMINATIM_DAILY_LIMIT` (500/day); answers cached 7 days. For more traffic, run your own Nominatim. |
| YouTube / Vimeo oEmbed | Confirming videos exist | Short timeouts; failures drop the video. |
| Result pages | Verifying images and places | Public addresses only (private/loopback/metadata IPs are refused), size and time capped. |

Caches and rate-limit counters are in memory **per process**: with more than
one backend replica, each has its own (limits multiply; caches are not
shared).

## 8. Health checks and smoke tests

* **Liveness (container):** the backend image's `HEALTHCHECK` calls
  `/health` (HTTP 200 while the process serves).
* **Readiness (public):** `GET /api/health` returns only
  `{ status: "ok" | "degraded", database, search, queue: { connected } }` —
  no hosts, names or errors. `degraded` = MongoDB or OpenSearch down. Admins
  see details at `/api/admin/search/status` and `/api/admin/crawler/status`.

After every deployment (replace `https://SITE`):

```bash
curl -fsS https://SITE/api/health                                      # "status":"ok"
curl -s -o /dev/null -w "%{http_code}\n" https://SITE/                  # 200
curl -s -o /dev/null -w "%{http_code}\n" https://SITE/search?q=test     # 200 (SPA route)
curl -s -o /dev/null -w "%{http_code}\n" -H "Origin: https://evil.example" https://SITE/api/search/config   # 403
curl -s -o /dev/null -w "%{http_code}\n" https://SITE/api/admin/search/status   # 401 (admin only)
curl -s "https://SITE/api/embed-check?url=http%3A%2F%2Fopensearch%3A9200%2F"   # refused (not "ok")
curl -s "https://SITE/api/search?q=python" | head -c 300                # results JSON
# From outside the host — each must FAIL to connect:
nc -zv HOST 9200; nc -zv HOST 6379; nc -zv HOST 5000; nc -zv HOST 5601; nc -zv HOST 27017
```

Then in a browser: All (with Load more), Images (Load more), Videos, News,
Maps, an AI answer, sign-in / sign-out, History, and clicking a result —
it opens inside the current in-app tab; Ctrl/Cmd-click opens a new browser
tab.

## 9. Backups

| Data | Where | Backup |
|---|---|---|
| Users, history, crawled pages, analytics | MongoDB (`MONGO_URI`) | **Required.** Use the managed service's scheduled backups (or `mongodump`). This is the system of record. |
| Search index | OpenSearch volume `opensearch-data` | Rebuildable from MongoDB with `npm run search:reindex`. Optional: OpenSearch snapshots to object storage for faster recovery. |
| Crawl queue | Redis volume `redis-data` | None needed (rebuilt from MongoDB by the worker). |
| Secrets | The two `.env` files | Store in your secret manager; they are not in Git. |

## 10. Security notes

* Only the web port is published. OpenSearch (security plugin disabled),
  Redis (password) and the backend are reachable **only on the compose
  network**. Never publish 9200, 9600, 5601, 6379, 5000 or 27017. If anything
  else must reach OpenSearch, enable its security plugin first (see the notes
  at the end of `docker-compose.yml`).
* Sessions are JWTs (7 days by default, `JWT_EXPIRES_IN`), stored by the
  browser and sent as a Bearer header; there is no server-side revocation —
  rotating `JWT_SECRET` signs everyone out.
* Logs redact passwords, tokens, keys and Mongo credentials. Keep
  `LOG_LEVEL=info` in production.
* Safe Search filtering is **not implemented**; the UI says so. Do not
  advertise it.

## 11. Crawler and worker (disabled)

The crawl worker (`worker` service) and anything that fetches pages for the
index (`seed-index`, admin "start crawl") are **out of scope for this
handover**. The worker is behind the `crawler` profile and is never started by
the commands above. Before it is ever enabled, it needs: a decision and
approval, `CRAWLER_CONTACT_URL`, and a fix for a known gap — the crawler's
page/robots/sitemap fetchers do not yet refuse private network addresses or
off-site redirects (the API's own fetchers do).

## 12. Updating and rollback

**Update:** check out the new approved commit, then
`$COMPOSE up -d --build`, then §8. Data volumes are kept.

**Rollback:**

```bash
git checkout <previous approved commit or tag>
$COMPOSE up -d --build          # rebuilds the previous images; data volumes untouched
```

Tag each deployed commit (`git tag deploy-YYYY-MM-DD`) so the previous one is
easy to find. No database migration is part of this release, so rolling the
code back needs no data change. Never use `docker compose down -v` in
production: `-v` deletes the index and queue volumes.

## 13. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Compose: "required variable … is missing" | §3a not filled in. |
| Backend restarts with "Invalid environment configuration" | `MONGO_URI`, `JWT_SECRET` (32+ chars) or `FRONTEND_URL` missing in production. |
| Every API call returns 403 | `FRONTEND_URL` does not exactly match the site origin (scheme, host, port). |
| `/api/*` returns 502 | Backend not running or unhealthy: `$COMPOSE logs backend`. |
| Search finds nothing from the index | Index not built yet (§6a). |
| Images/Videos/Maps say "unavailable" | Parallel key/limits (§7): `$COMPOSE logs backend | grep -i parallel`. |
| Everyone shares one rate limit | A load balancer is in front without nginx `real_ip` (§4). |
| OpenSearch read-only / index blocked | Disk above 95%: free space; the block lifts automatically when usage drops. |
