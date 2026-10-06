# 0003. BullMQ and a MongoDB frontier for crawling

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

Crawling ran inside the Express process. `crawlerJobService.startJob` created
a `CrawlJob` row and then called `startCrawler` without awaiting it, so the
crawl continued in the background of the API process, tracked by a
module-level `Map` of cancellation flags.

Four problems followed from that, and they are the reason this decision exists:

- **A crawl competed with search for the event loop.** Fetching, parsing and
  indexing all happened in the process answering user queries.
- **Deploying the API killed crawls.** `reconcileInterruptedJobs` ran at
  startup and marked every queued or running job failed, on the assumption
  that a job still marked running had to be a leftover from a dead process.
- **The frontier was memory.** `UrlQueue` held the pending list and the
  visited set for the length of one run. An interrupted crawl lost everything
  it had discovered but not yet fetched, and two crawls could not share
  knowledge — the same URL was re-fetched once per job.
- **Work could not be spread.** The crawl loop awaited each fetch in turn, so
  a crawl of ten hosts ran no faster than a crawl of one.

## Decision

Split the crawler into its own process, scheduled by BullMQ on Redis, with
the frontier persisted in MongoDB.

**The unit of queued work is one host, and the BullMQ job id is the
hostname.** BullMQ will not hold two jobs with the same id, so "one request
at a time per host" is a property of the design rather than something
enforced at runtime — and it holds across crawl jobs too, which matters,
because a site does not care which of our crawls is hitting it. Worker
concurrency is then exactly "how many different sites at once".

A host lease handles at most `CRAWLER_HOST_SLICE_PAGES` pages and re-queues
itself if work remains, with the host's politeness delay as the queue delay.

**MongoDB holds the frontier** (`CrawlFrontier`): every URL known, its host,
depth, priority, status and next-crawl time. Claiming is a single
`findOneAndUpdate`, so two workers racing for the same URL cannot both get it.
Rows are keyed by `canonicalKey` — the same identity function OpenSearch uses
for document ids — so `/article` and `/article?utm_source=twitter` are one
page rather than two crawls.

Redis holds scheduling only. Nothing durable lives there.

## Alternatives considered

**A queue job per URL.** The obvious shape, and how most examples are
written. Rejected on two counts: per-group rate limiting — the feature that
would give per-domain politeness — is in BullMQ Pro, so we would hand-roll a
distributed lock per host; and a crawl of 50,000 pages becomes 50,000 Redis
jobs, where the host-lease design needs one job per site.

**A queue job per crawl run.** The smallest change: move `startCrawler` into
a worker unaltered. Rejected because it gives no parallelism across sites —
one slow host stalls everything behind it — and because a worker dying
mid-crawl loses the run's position, which is the problem the frontier exists
to fix.

**Keeping the frontier in Redis** alongside the queue. Fewer moving parts,
and the natural place for a work list. Rejected because the frontier is not
scheduling state, it is crawl state: what we know about the web, when each
page was last fetched and when it is next due. Losing it to an `FLUSHALL` or
an eviction policy would mean re-crawling everything, and it needs the
queries — "hosts with pending work", "pages due for re-crawl", "counts by
status for this job" — that a database is for.

**Agenda or a MongoDB-backed queue,** avoiding Redis entirely. Attractive
given MongoDB is already a dependency, and it would have made this a
one-store system. Rejected because polling a collection for work is
materially worse than a blocking pop under any load, and because BullMQ's
retry, backoff, delayed-job and repeatable-job handling is exactly what a
crawler needs and would otherwise be written by hand.

**`node-cron` in the API process for re-crawls.** Rejected for the same
reason the crawler is moving out: it puts periodic work back in the process
serving users, and it does not survive more than one API instance.

## Consequences

**Redis is a new runtime dependency.** It is in `docker-compose.yml` with a
health check, and the API degrades rather than fails without it: starting a
crawl still records the job and seeds the frontier, and the worker's next
maintenance sweep picks it up when Redis returns. `/api/health` reports the
queue separately so an outage is visible.

**Two new dependencies.** `bullmq`, and `ioredis` — which BullMQ 6 made an
optional peer rather than bundling, so it has to be installed explicitly.

**Stopping a crawl is now asynchronous.** The API cannot reach into the
worker, so `POST /crawler/stop` sets `stopRequested` and the worker reads it
between pages. The endpoint answers "stopping", not "stopped".

**Detecting an abandoned crawl changed.** Failing every running job at API
startup would now kill crawls a healthy worker is part-way through. The
trigger is a silent heartbeat instead: a job whose worker has not reported
progress for several lease timeouts.

**A second crawl of the same site does much less.** The frontier is shared
and durable, so URLs crawled recently are skipped until their re-crawl falls
due. This is the intended behaviour and it is what makes crawling cheap at
scale, but it surprises anyone expecting the old "crawl everything again"
semantics — hence `force: true` on the start endpoint.

**One layer is not covered by the default test suite.** The frontier, the
drain loop, politeness, depth limits, budgets and stop handling all run
against an in-memory MongoDB with no Redis, because `processHost` is exported
and the tests call it directly. Only BullMQ's delivery needs a live Redis,
and that suite is skipped — never silently passed — when none is reachable.
There is deliberately no "run the crawler inside the API" switch, because it
would quietly recreate the arrangement this decision removes.
