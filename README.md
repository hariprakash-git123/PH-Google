# PH Google

A working search engine: a web crawler feeds an OpenSearch index, a Node API
ranks and serves results, and a React frontend presents web, image, video, news
and map search with accounts, history, analytics and an admin console.

```
ph-google/           React + Vite frontend          -> http://localhost:8080
ph-google-backend/   Node + Express API             -> http://localhost:5000
                     ...and the crawl worker, the only process that fetches pages
docker-compose.yml   the whole stack, plus OpenSearch, Redis and Dashboards
docs/adr/            architecture decision records
```

## Run it

```bash
cp ph-google-backend/.env.example ph-google-backend/.env   # fill in MONGO_URI and JWT_SECRET
docker compose up -d --build
```

> **This does not start the crawler.** The crawl worker is behind the
> `crawler` Compose profile, because a running worker fetches pages by itself:
> it resumes unfinished crawl jobs and re-crawls pages that are due, with no
> admin action. Start it only when you mean to crawl:
>
> ```bash
> docker compose --profile crawler up -d worker     # start the crawler
> docker compose --profile crawler stop worker      # stop it again
> ```

| | |
|---|---|
| Frontend | http://localhost:8080 |
| API health | http://localhost:5000/api/health |
| OpenSearch | http://localhost:9200 |
| Dashboards | http://localhost:5601 |
| Redis (crawl queue) | localhost:6379 |
| Crawl worker | not started by default — `docker compose --profile crawler up -d worker` |

MongoDB is expected to be external — an Atlas cluster, named in `MONGO_URI`.
To run one locally instead, start the stack with `--profile local-db` and point
that variable at `mongodb://mongo:27017/ph-google`.

```bash
docker compose down      # stop, keep the data
docker compose down -v   # stop and delete the index and local database
docker compose logs -f backend
```

Nothing here is a paid or managed service. OpenSearch runs in a container on
the same machine, with its security plugin off — a local-development choice
only, documented alongside the secured configuration at the bottom of
`docker-compose.yml`.

## Develop

Each application is a normal npm project and runs on the host without Docker.
Only the backing services need containers:

```bash
docker compose up -d opensearch redis

cd ph-google-backend && npm install && npm run dev        # API on :5000
cd ph-google-backend && npm run worker:dev                # crawl worker
cd ph-google         && npm install && npm run dev        # Vite on :3000
```

Both have the same four housekeeping commands:

```bash
npm run lint
npm run lint:fix
npm run format
npm run format:check
```

And the backend adds:

```bash
npm test                            # skips suites whose service is not running
OPENSEARCH_REQUIRED=true REDIS_REQUIRED=true npm test   # fail rather than skip
npm run worker                      # the crawl worker
npm run search:reindex              # rebuild the index from MongoDB
```

`ph-google-backend/README.md` documents the architecture, the API, the
relevance model and the operational commands.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request: lint, format
check, the full backend suite against real OpenSearch and Redis containers,
the frontend build, a `high`-level `npm audit` on both, and a build of both
Docker images.

The backend job sets `OPENSEARCH_REQUIRED=true` and `REDIS_REQUIRED=true`, so
a service that fails to start is a failed build rather than a quietly
shortened test run.

## Secrets

`.env` is gitignored in both applications and must stay that way. `.env.example`
documents every variable the code reads, with no real values.

Anything prefixed `VITE_` is inlined into the frontend bundle at build time and
is therefore public. Never put a credential there.
