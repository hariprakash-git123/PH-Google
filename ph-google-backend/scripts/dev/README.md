# Developer scratch scripts

Ad-hoc scripts kept for convenience. They are **not** part of the application,
are not covered by the test suite, and are not run in CI.

| Script                 | What it does                                                                    |
| ---------------------- | ------------------------------------------------------------------------------- |
| `bigCrawl.js`          | Crawls 13 hardcoded Wikipedia/MDN seeds to fill an empty database               |
| `testCrawler.js`       | Crawls `example.com`, 5 pages — a smoke test for the crawler (`npm run crawl`)  |
| `testSearch.js`        | Prints index stats and scores one query against the legacy MongoDB `Term` index |
| `testTextProcessor.js` | Prints tokens and frequencies for a fixed HTML snippet                          |

Each connects to whatever `MONGO_URI` points at, so check your `.env` before
running one.

Two of these are superseded:

- `testSearch.js` reads the `Term` collection, which OpenSearch replaced. It
  only tells you about the legacy engine behind `SEARCH_ENGINE=mongo`.
- `bigCrawl.js` and `testCrawler.js` bypass `CrawlJob` entirely, so their work
  is invisible to the admin dashboard. The crawl worker introduced in Phase 2
  replaces both; for broad coverage across many topics use
  `npm run crawl:topics` (see "Crawling by topic" in the backend README).

For anything reproducible, prefer the supported commands: `npm run seed-index`,
`npm run reindex`, `npm run search:reindex`, `npm run verify`.
