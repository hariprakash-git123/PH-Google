# PH Google Search — Step 3 Fuzzy Recall Fix

Date: 2026-09-26. Scope: one isolated change to how the fuzzy clause admits documents. No mapping, analyzer, boost, multiplier, synonym, pagination, dedupe, snippet, crawler, frontend or API change. Not committed.

## Problem

Step 2 measured the 859-document crawled index (an exact copy, served on a temporary cluster) with the unchanged code. For every multi-word query where fuzzy matching was allowed, the fuzzy clause alone decided which documents qualified:

| Query | Total results | Admitted by the exact clause alone |
|---|---:|---:|
| python programming | 429 | 37 |
| history of India | 762 | 277 |
| what is photosynthesis | 804 | 41 |
| pyhton programming | 431 | 0 |
| machne learning | 632 | 0 |

Examples of documents admitted only through fuzzy expansion of a single term: *US EPA Sustainability*, *MedlinePlus Alcohol* and *WHO Assistive technology* for `what is photosynthesis`; *Voyager program* for `pyhton programming`; *Physical education* for `machne learning`.

## Root Cause

Verified in `services/opensearch/queryBuilder.js` (not taken from the Step 1 audit on trust):

- **Exact clause** (`buildMustClause`): `multi_match`, `best_fields`, over `title^8, headings^5, description^4, keywords^3, url^2, content^1`, with `minimum_should_match` from `minimumShouldMatch(terms)`: `"1"` for one term, `"2<70%"` for 2–3 terms (all of up to 2, else 70%), `"70%"` for 4+.
- **Fuzzy clause** (`buildFuzzyClause`): `multi_match`, `best_fields`, over `title^8, headings^5, content`, `fuzziness: AUTO`, `prefix_length: 2`, `max_expansions: 30`, `boost: 0.4` — and **no `minimum_should_match`**, so it uses the default OR: one matching term is enough.
- **Combination** (`buildMustClause`): when `allowFuzzy` is true, `must` = `bool.should[exact, fuzzy]` with `minimum_should_match: 1` — either clause qualifies a document.
- `allowFuzzy` (`queryParser.shouldAllowFuzzy`) is true for 1–6 unquoted, non-site terms with at least one term of ≥4 characters — i.e. almost every query in the baseline.
- **Quoted queries**: `buildMustClause` returns early with a `phrase` `multi_match` (slop 0, `.exact` fields); `allowFuzzy` is false, so no fuzzy clause exists.
- **Single-word queries**: exact `minimum_should_match` is `"1"` and the fuzzy clause's default OR is equivalent, so there is no leak.

So for a multi-word query the fuzzy alternative bypasses the exact clause's term requirement: a document needs only **one** term (or a word within the fuzzy edit distance of one term) in any of title, headings or content.

Two related findings from the baseline data that this step did **not** change:

- `site:wikipedia.org mathematics` is not recognised as a site query (the parser splits it into `site`, `wikipedia.org`, `mathematics`). Its 251 baseline results came from the fuzzy leak; only 9 documents meet the 2-of-3 term rule.
- In natural-language queries, "how", "does", "work" are ordinary terms (not English stop words), so the **exact** clause alone admits 663–666 documents for `how does … work` queries. That is independent of fuzzy.

## Implementation

**Changed:** `ph-google-backend/services/opensearch/queryBuilder.js` → `buildMustClause()` only.

```diff
   const fuzzy = buildFuzzyClause(parsed);
   if (fuzzy) {
+    // Admission gate. On its own the fuzzy clause matches any one term, so a
+    // multi-word query would admit a document containing a single fuzzy
+    // term. The gate holds it to the exact clause's term requirement. It is
+    // a filter, so scoring above is untouched: it only decides who qualifies.
+    const fuzzyGate = {
+      multi_match: {
+        ...fuzzy.multi_match,
+        minimum_should_match: minimumShouldMatch(parsed.terms.length)
+      }
+    };
+
     return {
       bool: {
         should: [exactClause, fuzzy],
-        minimum_should_match: 1
+        minimum_should_match: 1,
+        filter: [{ bool: { should: [exactClause, fuzzyGate], minimum_should_match: 1 } }]
       }
     };
   }
```

**How it works:** the scoring part (`should: [exact, fuzzy]`) is byte-for-byte what it was. A non-scoring `filter` is added beside it: a document qualifies only if it satisfies the exact clause **or** the fuzzy clause with the same `minimum_should_match` as the exact clause. Filters contribute 0 to `_score`, so every document that still qualifies keeps exactly its previous score.

**Why typo searches still work:** the gate keeps fuzziness (`AUTO`, `prefix_length: 2`, transpositions). `pyhton` still matches `python` (one transposition) and `machne` still matches `machine` (one edit); the gate only requires that the *other* query terms also be present, as the exact clause already did.

**Unchanged:** `buildFuzzyClause`, `buildShouldClauses`, `buildFilters`, `buildScoreFunctions`, `buildSearchBody`, `FIELD_BOOSTS`, `CLAUSE_BOOSTS`, `PHRASE_SLOP`, `minimumShouldMatch`, the quoted-phrase and site branches, `queryParser.js`, `searchService.js`, mappings, analyzers, synonyms.

### Design note — first attempt (v1) rejected

The first implementation added `minimum_should_match` directly to the scoring fuzzy clause in `buildFuzzyClause`. It admitted exactly the same documents as the final version, but it also **changed the scores of documents that remained**, because the old fuzzy clause had been adding partial-match score. Measured effects: *Machine learning - Wikipedia* fell from #2 (134.24) to #4 (96.96) for `how does machine learning work`; *Photosynthesis - Wikipedia* fell 90.17 → 67.24 for `what is photosynthesis`; every `history of India` top-10 score dropped ~7%. That broke the requirement to preserve the existing scoring, so v1 was reverted and replaced with the filter gate above (v2), which changes 0 surviving scores across all 19 distinct queries.

## Tests

**Added (7 tests), using the existing structure:**

`tests/unit/openSearchQuery.test.js` → `describe('fuzzy clause')`:
1. *gates a single-word query on its one term* — gate present, fuzzy, `minimum_should_match` `"1"`.
2. *gates a multi-word query on as many terms as the exact clause requires* — for `python programming`, `pyhton programming`, `what is photosynthesis`.
3. *leaves the scoring clauses exactly as they were* — scoring fuzzy clause equals `buildFuzzyClause()` output, with no `minimum_should_match`.
4. *leaves the field and clause weights unchanged* — `FIELD_BOOSTS` and `CLAUSE_BOOSTS` equal their current literal values.

`tests/opensearch/relevance.test.js` → `describe('typo tolerance')` (fixture corpus, live cluster):
5. *does not admit a page matching only one term of a multi-word query* — `python programming` excludes the snake page and the keyword-stuffed spam page (both mention python, never programming).
6. *"pyhton programming" finds the python programming pages and nothing else* — includes python.org and the tutorial; excludes snake and spam.
7. *"machne learning" still finds the machine learning page first.*

Existing tests that cover the other required cases and still pass: single-word fuzzy (`"pyhton" still finds the python pages`, `a correct spelling still outranks a fuzzy match`), exact multi-word ranking (`ranks an exact title above a page that merely mentions the word`, `proximity`), quoted phrase (`a quoted phrase requires the words together, in order`, `a multi-word phrase query works for a longer phrase`), `lets fuzzy admit documents, not merely reorder them`.

**Results:**

| Run | Suites | Tests | Notes |
|---|---|---|---|
| Full suite **before** the change | 21/21 passed | 686/686 passed, 0 skipped | OpenSearch and Redis live, so the relevance and queue suites ran |
| New tests against the **original** code | — | 4 failed / 124 passed | Fail as intended: tests 1, 2, 5, 6. Test 7 passes on both (it guards typo recall) |
| Unit + relevance suites **after** | 2/2 passed | 128/128 passed | |
| Full suite after, run 1 | 20/21 | 692 passed, **1 failed** | `frontier.test.js › adding URLs › ignores a URL it already knows` (expected 0 added, got 1). Crawl frontier / in-memory MongoDB; imports no search code |
| That suite alone, 3 runs | 1/1 each | 30/30 each | Passes in isolation |
| Full suite after, run 2 | **21/21 passed** | **693/693 passed**, 0 skipped | 686 original + 7 new |

The frontier failure is intermittent and unrelated to this change (it passed in the pre-change run, in 3 isolated runs and in the second full run). It is reported, not fixed. ESLint and Prettier pass on all three changed files.

## Before vs After

Same 20 queries as Step 2, same 859-document index copy (verified: 859 docs). "Before" was re-run with the original code in this session and matched the saved Step 2 responses exactly for **20/20 queries** (totals, top-10 URLs, scores). Both runs call the project's `searchService.search()` — the function `/api/search` calls — directly, so no `SearchLog` rows were written this time.

Latency: the per-request `responseTimeMs` varied ±150 ms between identical runs (the machine was also running the live stack), so the table uses OpenSearch's server-side `took`, median of 9 runs per query, alternating before/after bodies. The "before" body was verified identical to the original builder's output for 19/19 distinct queries.

| Query | Before Total | After Total | Before #1 | After #1 |
|---|---:|---:|---|---|
| mathematics | 251 | 251 | Mathematics - Wikipedia | Mathematics - Wikipedia |
| cricket | 52 | 52 | Cricket - Wikipedia | Cricket - Wikipedia |
| photosynthesis | 42 | 42 | Photosynthesis - Wikipedia | Photosynthesis - Wikipedia |
| machine learning | 80 | 80 | Machine learning - Wikipedia | Machine learning - Wikipedia |
| python programming | 429 | 37 | Python (programming language) - Wikipedia | Python (programming language) - Wikipedia |
| history of India | 762 | 339 | Cinema of India - Wikipedia | Cinema of India - Wikipedia |
| physics | 412 | 412 | Physics - Wikipedia | Physics - Wikipedia |
| football | 58 | 58 | Blind football - Wikipedia | Blind football - Wikipedia |
| geography | 267 | 267 | Geography - Wikipedia | Geography - Wikipedia |
| computer science | 550 | 198 | Computer science - Wikipedia | Computer science - Wikipedia |
| climate change | 685 | 228 | Climate change - Wikipedia | Climate change - Wikipedia |
| artificial intelligence | 156 | 156 | AI News & Artificial Intelligence \| TechCrunch | AI News & Artificial Intelligence \| TechCrunch |
| what is photosynthesis | 804 | 42 | Photosynthesis - Wikipedia | Photosynthesis - Wikipedia |
| how does machine learning work | 811 | 707 | The latest on machine learning - The GitHub Blog | The latest on machine learning - The GitHub Blog |
| how does gravity work | 811 | 702 | Improve how you use GitHub at work - The GitHub Blog | Improve how you use GitHub at work - The GitHub Blog |
| "machine learning" | 46 | 46 | Machine learning - Wikipedia | Machine learning - Wikipedia |
| pyhton programming | 431 | 39 | Python (programming language) - Wikipedia | Python (programming language) - Wikipedia |
| site:wikipedia.org mathematics | 251 | 9 | Mathematics - Wikipedia | Mathematics - Wikipedia |
| cricket | 52 | 52 | Cricket - Wikipedia | Cricket - Wikipedia |
| machne learning | 632 | 292 | Machine learning - Wikipedia | Machine learning - Wikipedia |

**Full comparison** (score, top-10 overlap, domains, latency):

| # | Query | Before Total | After Total | Before #1 | After #1 | #1 score (before → after) | Top-10 same URLs | Top-10 identical order | Domains in top 10 (before → after) | OpenSearch `took` median ms (before → after) |
|---:|---|---:|---:|---|---|---|---:|:---:|---|---|
| 1 | mathematics | 251 | 251 | Mathematics - Wikipedia | Mathematics - Wikipedia | 240.75 → 240.75 | 10/10 | yes | 1 → 1 | 337 → 358 |
| 2 | cricket | 52 | 52 | Cricket - Wikipedia | Cricket - Wikipedia | 250.243 → 250.243 | 10/10 | yes | 1 → 1 | 265 → 246 |
| 3 | photosynthesis | 42 | 42 | Photosynthesis - Wikipedia | Photosynthesis - Wikipedia | 338.373 → 338.373 | 10/10 | yes | 1 → 1 | 244 → 241 |
| 4 | machine learning | 80 | 80 | Machine learning - Wikipedia | Machine learning - Wikipedia | 843.895 → 843.895 | 10/10 | yes | 3 → 3 | 222 → 213 |
| 5 | python programming | 429 | 37 | Python (programming language) - Wikipedia | Python (programming language) - Wikipedia | 761.346 → 761.346 | 7/10 | no | 1 → 3 | 282 → 266 |
| 6 | history of India | 762 | 339 | Cinema of India - Wikipedia | Cinema of India - Wikipedia | 256.666 → 256.666 | 10/10 | yes | 1 → 1 | 437 → 418 |
| 7 | physics | 412 | 412 | Physics - Wikipedia | Physics - Wikipedia | 276.349 → 276.349 | 10/10 | yes | 1 → 1 | 355 → 360 |
| 8 | football | 58 | 58 | Blind football - Wikipedia | Blind football - Wikipedia | 221.123 → 221.123 | 10/10 | yes | 1 → 1 | 208 → 235 |
| 9 | geography | 267 | 267 | Geography - Wikipedia | Geography - Wikipedia | 229.585 → 229.585 | 10/10 | yes | 1 → 1 | 413 → 423 |
| 10 | computer science | 550 | 198 | Computer science - Wikipedia | Computer science - Wikipedia | 809.876 → 809.876 | 10/10 | yes | 1 → 1 | 347 → 349 |
| 11 | climate change | 685 | 228 | Climate change - Wikipedia | Climate change - Wikipedia | 789.138 → 789.138 | 10/10 | yes | 1 → 1 | 398 → 383 |
| 12 | artificial intelligence | 156 | 156 | AI News & Artificial Intelligence \| TechCrunch | AI News & Artificial Intelligence \| TechCrunch | 876.078 → 876.078 | 10/10 | yes | 7 → 7 | 222 → 231 |
| 13 | what is photosynthesis | 804 | 42 | Photosynthesis - Wikipedia | Photosynthesis - Wikipedia | 90.167 → 90.167 | 7/10 | no | 4 → 1 | 303 → 294 |
| 14 | how does machine learning work | 811 | 707 | The latest on machine learning - The GitHub Blog | The latest on machine learning - The GitHub Blog | 209.057 → 209.057 | 10/10 | yes | 3 → 3 | 456 → 407 |
| 15 | how does gravity work | 811 | 702 | Improve how you use GitHub at work - The GitHub Blog | Improve how you use GitHub at work - The GitHub Blog | 246.985 → 246.985 | 10/10 | yes | 4 → 4 | 299 → 308 |
| 16 | "machine learning" | 46 | 46 | Machine learning - Wikipedia | Machine learning - Wikipedia | 3383.712 → 3383.712 | 10/10 | yes | 4 → 4 | 250 → 245 |
| 17 | pyhton programming | 431 | 39 | Python (programming language) - Wikipedia | Python (programming language) - Wikipedia | 62.401 → 62.401 | 6/10 | no | 1 → 2 | 256 → 271 |
| 18 | site:wikipedia.org mathematics | 251 | 9 | Mathematics - Wikipedia | Mathematics - Wikipedia | 68.895 → 68.895 | 9/10 | no | 1 → 1 | 216 → 203 |
| 19 | cricket | 52 | 52 | Cricket - Wikipedia | Cricket - Wikipedia | 250.243 → 250.243 | 10/10 | yes | 1 → 1 | 265 → 246 |
| 20 | machne learning | 632 | 292 | Machine learning - Wikipedia | Machine learning - Wikipedia | 75.625 → 75.625 | 6/10 | no | 3 → 2 | 368 → 325 |

### What changed in the top 10, and why

Only 6 of 20 queries have any top-10 change. In every case the removed documents do not contain one of the required terms, and the documents that moved up keep their original scores:

- **python programming:** removed *Procedural programming*, *Programming language theory*, *Event-driven programming* — verified to contain no "python" in any field. Moved up: *Extension modules – MDN*, *Algebraic operation*, *The Heap – Stack Overflow* (baseline ranks 13, 14, 16, same scores 11.656 / 11.422 / 10.514; each contains both "python" and "programming").
- **what is photosynthesis:** removed *Sustainability | US EPA*, *Alcohol | Drinking | MedlinePlus*, *Assistive technology* (WHO) — verified to contain no "photosynthesis". The new top 10 are all pages that contain "photosynthesis".
- **pyhton programming:** removed the same three programming pages plus *Voyager program*.
- **machne learning:** removed *Student-centered learning*, two MDN "learn" pages, *Physical education*.
- **site:wikipedia.org mathematics:** 9 results remain (the 9 mathematics-titled pages, ranks 1–9 unchanged); #10 *Mathematical analysis* removed.

## Typo Search Results

#### pyhton programming — 431 → 39

| Rank | Before (score) | After (score) |
|---:|---|---|
| 1 | Python (programming language) - Wikipedia (62.401) | Python (programming language) - Wikipedia (62.401) |
| 2 | Procedural programming - Wikipedia (50.39) | Programming paradigm - Wikipedia (49.549) |
| 3 | Programming paradigm - Wikipedia (49.549) | Functional programming - Wikipedia (49.549) |
| 4 | Functional programming - Wikipedia (49.549) | Imperative programming - Wikipedia (49.549) |
| 5 | Imperative programming - Wikipedia (49.549) | Java (programming language) - Wikipedia (43.921) |
| 6 | Programming language theory - Wikipedia (45.23) | Object-oriented programming - Wikipedia (43.921) |
| 7 | Event-driven programming - Wikipedia (44.666) | Comparison of multi-paradigm programming languages - Wikipedia (11.825) |
| 8 | Java (programming language) - Wikipedia (43.921) | Extension modules - Learn web development \| MDN (2.919) |
| 9 | Object-oriented programming - Wikipedia (43.921) | Algebraic operation - Wikipedia (2.856) |
| 10 | Voyager program - Wikipedia (16.365) | Type system - Wikipedia (2.757) |

- The target *Python (programming language) - Wikipedia* stays **#1** with the same score (62.401).
- 39 results, versus 37 for the correct spelling.

#### machne learning — 632 → 292

| Rank | Before (score) | After (score) |
|---:|---|---|
| 1 | Machine learning - Wikipedia (75.625) | Machine learning - Wikipedia (75.625) |
| 2 | Learning - Wikipedia (64.753) | Learning - Wikipedia (64.753) |
| 3 | The latest on machine learning - The GitHub Blog (62.413) | The latest on machine learning - The GitHub Blog (62.413) |
| 4 | Student-centered learning - Wikipedia (51.534) | Nonformal learning - Wikipedia (19.242) |
| 5 | Learn web development writing guidelines - MDN Web Docs \| MDN (25.309) | Theoretical computer science - Wikipedia (17.892) |
| 6 | Nonformal learning - Wikipedia (19.242) | Machu Picchu - Wikipedia (13.802) |
| 7 | Theoretical computer science - Wikipedia (17.892) | Language education - Wikipedia (10.415) |
| 8 | Machu Picchu - Wikipedia (13.802) | Algorithm - Wikipedia (9.209) |
| 9 | Core learning modules - Learn web development \| MDN (12.942) | Education - Wikipedia (7.318) |
| 10 | Physical education - Wikipedia (11.315) | Magic (illusion) - Wikipedia (6.125) |

- The target *Machine learning - Wikipedia* stays **#1** (75.625), and *The latest on machine learning* is #3.
- **Still broad (292 vs 80 for the correct spelling), and some unrelated pages remain** (*Machu Picchu* #6, *Magic (illusion)* #10). These now satisfy the two-term rule. `fuzziness: AUTO` allows **2 edits** for a 6-letter word (with the first 2 letters fixed), so "machne" matches more words than "machine" alone; which expansions admitted these pages was not broken down. This is edit-distance breadth, not the OR leak, and was not changed in this step.

## Natural Language Results

#### what is photosynthesis — 804 → 42

| Rank | Before (score) | After (score) |
|---:|---|---|
| 1 | Photosynthesis - Wikipedia (90.167) | Photosynthesis - Wikipedia (90.167) |
| 2 | Food - Wikipedia (24.989) | Food - Wikipedia (24.989) |
| 3 | Sustainability \| US EPA (12.336) | Protist - Wikipedia (12.055) |
| 4 | Protist - Wikipedia (12.055) | Metabolism - Wikipedia (11.309) |
| 5 | Alcohol \| Drinking \| MedlinePlus (11.919) | Ecosystem - Wikipedia (11.242) |
| 6 | Metabolism - Wikipedia (11.309) | History of Earth - Wikipedia (11.147) |
| 7 | Ecosystem - Wikipedia (11.242) | Coral reef - Wikipedia (10.867) |
| 8 | History of Earth - Wikipedia (11.147) | Nutrition - Wikipedia (9.961) |
| 9 | Coral reef - Wikipedia (10.867) | Glossary of biology - Wikipedia (9.613) |
| 10 | Assistive technology (10.255) | Fungus - Wikipedia (9.572) |

#### how does machine learning work — 811 → 707

Top 10 **identical** before and after (same order, same scores): #1 *The latest on machine learning – The GitHub Blog* (209.057), #2 *Machine learning – Wikipedia* (134.242), #3 *How Much Exercise Do I Need? – MedlinePlus* (114.508), #4 *Improve how you use GitHub at work* (109.142), …

#### how does gravity work — 811 → 702

Top 10 **identical** before and after: #1 *Improve how you use GitHub at work – The GitHub Blog* (246.985), #2 *How Much Exercise Do I Need?* (114.508), #3 *Calcium | MedlinePlus* (95.419), …

- `what is photosynthesis`: generic matches left the top 10, and the total fell to the 42 documents that meet the term rule.
- The two `how does … work` queries: 104–109 fuzzy-only documents were removed, but the top 10 is unchanged and still led by pages matching "how"/"work". The exact clause alone admits 666 and 663 documents for these queries, because the question words are treated as content terms. That is outside this step's scope.

## Regression Check

| Check | Query | Result |
|---|---|---|
| Exact queries | mathematics, cricket, photosynthesis, machine learning | **Unchanged**: same totals (251 / 52 / 42 / 80), identical top 10 and scores |
| Other single-term | physics, football, geography | **Unchanged**: identical totals and top 10 |
| Multi-word, exact spelling | computer science, climate change, history of India, artificial intelligence | Top 10 **identical** (order and scores). Totals fell where fuzzy-only documents were removed (550→198, 685→228, 762→339; AI unchanged 156) |
| Typo queries | pyhton programming, machne learning | Targets still **#1**, with unchanged scores |
| Natural language | what is photosynthesis / how does ML work / how does gravity work | Generic matches removed from the first query's top 10. The two "how does" top 10s are unchanged |
| Phrase | "machine learning" | **Unchanged**: 46 results, identical top 10 (no fuzzy on quoted queries) |
| Site query | site:wikipedia.org mathematics | Returns 9 (was 251). `site:` filtering **was never supported** (Step 2 #12), and the previous 251 came from the leak. The 9 are the mathematics-titled pages in the same order and with the same scores; *Mathematical analysis* (baseline #10) is no longer returned. **This is a recall reduction for this query form** and a candidate for later `site:` support |
| Scores | all 19 distinct queries | 0 surviving documents changed score |
| Pagination | mathematics, cricket, machine learning, python programming (p1–3) | Totals stable across pages, 10 results per page, 0 URL overlap |
| API response shape | — | Unchanged: `searchService` / controller not modified |
| Latency | all | No consistent change; `took` medians within ±40 ms either way, which is within run-to-run noise on this machine |

## Conclusion

The fuzzy recall leak is **reduced without disabling typo tolerance**.

- **Leak closed:** a multi-word query can no longer admit a document through a single fuzzy term. For example `what is photosynthesis` went from 804 → 42 results, `python programming` 429 → 37 and `pyhton programming` 431 → 39.
- **Typo tolerance kept:** misspellings still work, and both typo targets stay at #1 with unchanged scores.
- **Ranking untouched:** because the fix is a non-scoring gate, no remaining document's score changed. 14 of 20 queries have byte-identical top 10s.

Remaining limitations, observed and not changed in this step:
- `machne learning` is still broad (292), because 2-edit fuzziness is wide on 6-letter words.
- Natural-language question words still dominate the `how does … work` queries.
- `site:` syntax is unsupported, and it previously worked only through the leak.

Lower totals were not treated as the goal. Every removed page was verified to lack one of the query's required terms.
