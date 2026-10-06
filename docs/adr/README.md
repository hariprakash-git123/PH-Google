# Architecture decision records

Short notes on decisions that were not obvious at the time and that someone
will otherwise re-litigate in six months. Each one records what we chose, what
we rejected, and what it costs — not a tutorial on the technology.

Write one when a choice is hard to reverse, when a reasonable engineer would
have picked differently, or when the reasoning lives only in someone's head.
Do not write one for a routine change.

An ADR is immutable once merged. If a decision is overturned, add a new record
and mark the old one superseded, so the history of the system stays readable.

| # | Decision | Status |
|---|---|---|
| [0001](0001-use-architecture-decision-records.md) | Use architecture decision records | Accepted |
| [0002](0002-containerise-the-stack-with-docker-compose.md) | Containerise the stack with Docker Compose | Accepted |
| [0003](0003-bullmq-and-a-mongodb-frontier-for-crawling.md) | BullMQ and a MongoDB frontier for crawling | Accepted |
| [0004](0004-serpapi-as-a-query-time-external-source.md) | Add SerpApi as a query-time external source, appended after the index | Accepted |

Copy [`0000-template.md`](0000-template.md) to start a new one. Number it with
the next free integer and add a row above.
