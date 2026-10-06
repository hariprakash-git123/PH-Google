# 0004. Add SerpApi as a query-time external source, appended after the index

- **Status:** Accepted
- **Date:** 2026-10-06

## Context

The index holds about a thousand crawled pages, so many queries find little or nothing in it. Google results from SerpApi would fill that gap. The index, its ranking, its parser and its pagination already work and are tested; AI answers are written from the page text the index holds. SerpApi returns an ordered list of Google results with a title and a snippet — no score and no page text — and the free plan allows 250 searches a month.

## Decision

SerpApi is an optional, query-time source behind `searchDispatcher.webSearch`. On page 1 of a relevance-sorted web search, its results are appended after the index's results, after dropping pages the index already has (same canonical URL key). Pages 2+, totals and pagination stay the index's. AI answers do not use it. Nothing from it is stored. It is off by default, and every failure falls back to the index's results.

## Alternatives considered

- **Replace or interleave by score.** OpenSearch scores change scale with every query and Google's list has none; adding or normalising them has no meaning, and would move index results.
- **Reciprocal rank fusion.** Interleaving would push index results down and, with offset-based pages, off page 1 entirely unless page sizes changed. Possible later, with the page-1 layout this decision already allows.
- **Call SerpApi on every page.** Google results cannot be paged in step with the index's offsets, and each page would cost a search.
- **Store Google results in the index.** Would mix pages never crawled with crawled ones and raise terms-of-use questions; left for an explicit decision.
- **Feed Google snippets to AI answers.** A snippet is not a document; answers would be thinner and harder to check.

## Consequences

- Page 1 can be longer than the page size; `total` counts what is shown, while `pagination` counts the index alone.
- Google results never outrank index results, however good they are.
- Usage is bounded by a per-process daily limit and cache; several backend instances would each count separately.
- `-word` and other full-text operators are exact for index results only.
- Turning it off is a setting, with no data to clean up.
