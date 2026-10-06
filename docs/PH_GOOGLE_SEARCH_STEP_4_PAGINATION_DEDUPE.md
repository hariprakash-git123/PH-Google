# PH Google Search — Step 4: Pagination + Deduplication

Date: 2026-09-26. Scope: make `/api/search` pagination reliable and duplicate-free. Ranking, Step 3 fuzzy behaviour, the API contract and the frontend are unchanged. Not committed.

## Summary

Pages are now built from one consistently deduplicated, deterministically ordered result list, so:

- a document shown on page N never appears on another page;
- the total is the same on every page and equals what a user can actually page through;
- repeated requests return the same order, even for results with equal scores;
- asking for a page past OpenSearch's 10,000-result window returns a clear 400 instead of a vague error.

## Current flow (traced before changing anything)

```
SearchBar.jsx → navigate(/search?q=…)
  → SearchResults.jsx → searchApi.search(query, category, { page, limit, … })   (frontend/src/services/searchApi.js)
  → GET /api/search?q&page&limit&sort&domain&date&language&category
  → routes/searchRoutes.js → searchController.search
      parsePage (1..500), parseLimit (1..50, default 10), parseEnum, … (utils/validators.js)
  → searchDispatcher.webSearch()
  → services/opensearch/searchService.search()
      queryParser.parseQuery() → queryBuilder.buildSearchBody()
      → OpenSearch → dedupeHits() → formatHit()
  → controller: buildPagination({ page, limit, totalResults }) → { results, total, pagination, … }
  → frontend Pagination.jsx uses pagination.totalPages / hasNextPage only
```

## Problem identified

**Before this step**, `searchService.search()` did:

1. `from = (page - 1) × limit`, `size = min(3 × limit, 100)` (over-fetch to absorb duplicates).
2. `dedupeHits()` on **that window only** (same `urlHash`, or same `contentHash` with ≥ 10 words).
3. `slice(0, limit)` for the page, and `total = totalHits − duplicates removed in this window`.
4. No explicit sort for relevance.

## Root cause

| # | Defect | Effect |
|---|---|---|
| 1 | Deduplication only inside one page's window | If page N dropped a duplicate, it filled up with raw hits past position `N × limit`; page N+1 starts at raw `N × limit` again and **repeats** them. A duplicate pair split across a page boundary was **never collapsed** — each page showed one copy. |
| 2 | Total reduced by *this window's* duplicates only | `total` / `totalPages` **differed between pages** of the same query. |
| 3 | No tie-breaker on `_score` | Equal scores are common (79 adjacent ties for `mathematics`; ties straddling a page boundary for `cricket` and `pyhton programming`). OpenSearch then orders by internal Lucene document number, which segment merges, refreshes or a reindex can change, **moving results across page boundaries between requests**. |
| 4 | `max_result_window` (10,000) not enforced | `page × limit` over-fetched past 10,000 and OpenSearch rejected it as the generic *"That search query could not be processed."* Because of the 3× over-fetch, even legal pages inside the window failed (e.g. page 200 × limit 50). |

Defects 1–2 were reproduced on the test fixture (two copies of *The Best Electric Cars of 2026*): with `limit=1`, page 1 showed one copy and page 2 showed the other, and totals differed between pages. On the current real corpus they do not trigger, because its 859 documents contain no duplicate content hashes — but any crawl that picks up mirrored or syndicated pages would trigger them.

## Changes made

### `services/opensearch/queryBuilder.js`

- **Deterministic tie-breaker.** Relevance sort is now `[{ _score: desc }, { urlHash: asc }]`; the date sorts end with the same `urlHash` tie-breaker. `_score` stays the primary key, so the ranking itself is unchanged — only the order *within* exactly-equal scores becomes fixed. `urlHash` is the document `_id` (verified for all 859 documents), is unique, and has doc values (no fielddata on `_id` needed).
- **Optional `ids` filter** (`buildFilters` / `buildSearchBody` option): restricts a search to given document ids as a non-scoring filter.

### `services/opensearch/searchService.js`

- `search()` now runs **two passes**:
  1. **Ranking pass (light).** Fetches only `urlHash`, `contentHash`, `wordCount` for the ranked results from the top, deduplicating **across the whole prefix** (pages 1…N), until `page × limit` unique results exist or the matching set is exhausted. The same request carries an aggregation that counts every hidden duplicate across the **entire** matching set.
  2. **Page pass.** Fetches just that page's documents (with `_source`, highlights, optional `explain`) through the `ids` filter, and returns them in ranking-pass order. Because the filter does not score, every document keeps exactly the score it was ranked by.
- `total = totalHits − all hidden duplicates` — exact and identical on every page.
- **Deep pagination:** `page × limit > 10,000` → HTTP 400 *"Only the first 10,000 results can be paged through. Refine the search to narrow them down."* in the existing `{ success: false, message }` format. `max_result_window` was **not** raised.
- `dedupeHits(hits, seen?)` accepts shared state so duplicates are caught across batches (backward-compatible signature).
- The request/error handling moved unchanged into a small `runSearch()` helper.

No change to: the query/ranking clauses, boosts, function_score, quality/freshness, Step 3 fuzzy gate, mappings, validators, controller, API response shape, frontend.

## Deduplication strategy

- **Identity, not title.** Two results are duplicates only if they share `urlHash` (same canonical URL = same `_id`, so this cannot happen inside the index) or share `contentHash` with at least 10 words (the same body text at different URLs). Pages with similar or identical titles but different content are kept.
- **The highest-ranked copy wins**, and it is chosen over the whole ranked prefix, so the choice is the same no matter which page is requested.
- **Total** uses an aggregation (`contentHash` groups with ≥ 2 eligible documents; the index has one shard, so it is exact) with the same eligibility rule as `dedupeHits`.

## Stable ordering strategy

`_score` descending, then `urlHash` ascending (date sorts: date, crawl date, `_score`, `urlHash`). Every document has a unique `urlHash`, so the order is total: the same request always yields the same order while the index is unchanged, and page boundaries never shift.

## Deep-pagination handling

OpenSearch cannot return results beyond `index.max_result_window` (default 10,000; this index uses the default). The existing validators allow `page ≤ 500` and `limit ≤ 50`, i.e. up to 25,000. Rather than raising the window (which only moves the limit and makes deep requests expensive), the API now rejects `page × limit > 10,000` with a clear 400. The existing page/limit contract is unchanged; `search_after` was not needed because every reachable page lies inside the window. Pages past the end of the results (e.g. `mathematics` page 30) still return `200` with an empty `results` array and the correct total.

## Tests performed

### New / updated automated tests

`tests/opensearch/relevance.test.js` → `describe('pagination')` (fixture corpus on the live test cluster):

| Test | Covers |
|---|---|
| never repeats a document across pages 1, 2 and 3 | A, B, C, D |
| never shows both copies of a duplicated article on different pages | cross-page dedupe |
| reports the deduplicated total, identical on every page | F |
| returns the same order for the same request (3× pages 1 and 2) | E |
| returns each document at most once within a page | single-page dedupe |
| rejects a page beyond the result window with a clear 400 | deep pagination |
| still serves the last page inside the result window | page 200 × 50 no longer errors |
| keeps the total stable across pages | **tightened** from "within ±2" to exact equality |

`tests/unit/openSearchQuery.test.js`:

- *sorts relevance by score, with the url hash only breaking ties* — replaces *has no explicit sort for relevance, so scoring decides*, which asserted the old behaviour; the new test still requires `_score` to be the primary sort.
- *ends every date sort with the same deterministic tie-breaker*
- *can restrict the search to known document ids without scoring them*

Already covered by existing tests, unchanged and passing: invalid `page` (0, −1, abc, 1.5) and `limit` (0, −5, abc) → 400; limit above 50 → 400; page above 500 → 400 (G, H, I); Step 3 fuzzy tests (J); domain/language/date filters (K); quoted phrase (L); site/domain queries (M).

All new tests were first run against the **unchanged** code: 7 failed — 4 service-level (both copies shown across pages; totals differing between pages; vague deep-page error; page 200 × 50 erroring) and the 3 unit tests (no tie-breaker; no ids filter). The other 3 new service-level tests (no repeats with `limit=1`, repeat stability, uniqueness within a page) already passed on the small fixture and guard against regressions. All pass after the change.

### Real OpenSearch data (`ph-google-pages`, 859 documents; count unchanged before/after)

Via `searchService.search()` against the live index:

| Query | Total p1 / p2 / p3 | Results p1 / p2 / p3 | Overlap p1∩p2 / p2∩p3 / p1∩p3 | Repeat ×3 p1 / p2 | limit 20 / 50 | p1+p2+p3 = one limit-30 request | vs pre-Step-4 ranking |
|---|---|---|---|---|---|---|---|
| mathematics | 251 / 251 / 251 | 10 / 10 / 10 | 0 / 0 / 0 | stable / stable | 20 / 50 | yes | same docs, same scores |
| cricket | 52 / 52 / 52 | 10 / 10 / 10 | 0 / 0 / 0 | stable / stable | 20 / 50 | yes | same docs, same scores |
| machine learning | 80 / 80 / 80 | 10 / 10 / 10 | 0 / 0 / 0 | stable / stable | 20 / 50 | yes | same docs, same scores |
| python programming | 37 / 37 / 37 | 10 / 10 / 10 | 0 / 0 / 0 | stable / stable | 20 / 37 | yes | same docs, same scores |
| history of India | 339 / 339 / 339 | 10 / 10 / 10 | 0 / 0 / 0 | stable / stable | 20 / 50 | yes | same docs, same scores |
| photosynthesis | 42 / 42 / 42 | 10 / 10 / 10 | 0 / 0 / 0 | stable / stable | 20 / 42 | yes | same docs, same scores |

"vs pre-Step-4 ranking": the top 30 of each query were compared with the Step 3 query builder on the same index — identical document set and scores, scores non-increasing, and 0 positions where the order differs outside a group of equal scores.

Step 3 fuzzy behaviour on the real index (unchanged): `python programming` 37, `pyhton programming` 39, `machine learning` 80, `machne learning` 292, `history of India` 339, `what is photosynthesis` 42; the intended page is #1 in each typo case.

Via the HTTP API (current code on a temporary host process on port 5001, pointed at the real index):

| Request | Response |
|---|---|
| `page=0`, `page=-1` | 400 `Invalid "page" parameter: must be an integer of 1 or greater.` |
| `limit=0`, `limit=-1` | 400 `Invalid "limit" parameter: must be an integer of 1 or greater.` |
| `limit=51` | 400 `Invalid "limit" parameter: maximum is 50.` |
| `page=501` | 400 `Invalid "page" parameter: maximum is 500.` |
| `page=201&limit=50` | 400 `Only the first 10,000 results can be paged through. Refine the search to narrow them down.` |
| `mathematics` pages 1–3 | 200; `total` 251 on each; `pagination` `{page, limit:10, totalResults:251, totalPages:26, hasNextPage, hasPreviousPage}` correct per page |

The three successful API requests each wrote one `SearchLog` row (built-in analytics); the rejected ones wrote none.

### Test results

| Run | Result |
|---|---|
| Focused pagination tests | **10/10** |
| Search-related suites (unit query/ranking, OpenSearch relevance + crawl pipeline, search, verticals, end-to-end) | **7/7 suites, 267/267** |
| Complete backend suite | **21/21 suites, 702/702**, 0 failed, 0 skipped (693 before this step + 9 net new) |
| ESLint / Prettier on changed files | pass |

## Limitations

- **Near-duplicate pages remain separate results.** On the real index, *Mathematical object* appears as page 1 #10 and page 2 #1, and *Axiom* twice on page 2. They are **different documents** (different ids and URLs — `/Mathematical_objects` vs `/Mathematical_object`, `/Axiom` vs `/Axioms` — and different content hashes because the text differs by a few words). Identity-based dedupe correctly keeps them; collapsing near-duplicates would need similarity hashing and is out of scope.
- **Cost grows with page depth.** The ranking pass reads `page × limit × 3` light hits (ids and two small fields, no bodies or highlights) plus one terms aggregation. Page 1 latency on the real index was ~100–190 ms; the upper bound is the 10,000-result window.
- **Only the first 10,000 ranked results are reachable**, by design (matches OpenSearch's window).
- **The running `ph-google-backend` container uses its previously built image.** It serves the new behaviour only after the image is rebuilt (`docker compose up -d --build backend`), which was not done in this step.
