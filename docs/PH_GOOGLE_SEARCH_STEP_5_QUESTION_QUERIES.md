# PH Google Search — Step 5: Question Queries

Date: 2026-09-26. Scope: make question-style queries ("how does gravity work") match on their topic. Query-time only — no OpenSearch data, mapping, analyzer, crawler, `searchService.js` or Step 4 pagination change. Not committed; Docker not rebuilt.

## Problem

`queryParser` computed `isQuestion` but nothing used it. Words such as *how, does, what, who, why, work* are not English stop words, so they were searched as content. The word requirement (`minimum_should_match`, and the Step 3 fuzzy gate) then counted them: for `how does gravity work` a page needed only 2 of 4 words, so "how" + "work" qualified it.

Live evidence (859-document index): `how does gravity work` → #1 *Improve how you use GitHub at work*; `how do vaccines work` → #1 *How Much Exercise Do I Need?*; `what is photosynthesis` → *Photosynthesis* at score 90 versus 338 for `photosynthesis`, because its title clause needed 2 of *what / is / photosynthesis*.

## Implementation

### `services/opensearch/queryParser.js`

- New `questionCoreTerms(terms, isQuestion)`: when the query is a question, strips a leading **interrogative + auxiliary** pair (`what/why/how/when/where/who/which` + `is/are/was/were/do/does/did/can/could/should/would/will/has/have/had`), an optional following `the/a/an`, and — for `how do/does/did …` with a topic word before it — a trailing `work`/`works`.
- A leading auxiliary alone is never stripped (`can opener reviews`, `will smith movies`); nor an interrogative without an auxiliary (`who covid guidelines`, `how to cook rice`).
- If what remains has no meaningful word — nothing, or only words from OpenSearch's `_english_` stop list (the same 33 words; verified with `_analyze`) — the full query is kept (`what is?`, `how does it work`).
- `parseQuery` adds `questionStripped`, `coreTerms`, `coreText`. For every non-stripped query, `coreTerms` **is** `terms` and `coreText` **is** `text`. `allowFuzzy` and `isMultiWord` are computed on `coreTerms` (identical for non-stripped queries). Quoted phrases are unchanged; an opener around a phrase is dropped (`what is "machine learning"?` searches the phrase).

### `services/opensearch/queryBuilder.js`

- Recall clause, Step 3 fuzzy clause and fuzzy gate, `titleExactTerms`, and the phrase/proximity clauses use `coreText` and `coreTerms.length`.
- New clause, only when a question was stripped: `match_phrase` of the **full** question on `title.exact` (slop 1) at `CLAUSE_BOOSTS.questionTitle = 4` (below `phraseContent` 5), so a title that is the question itself still gains.
- Unchanged on the full query: exact whole-title (`title.raw`), URL path, site/domain clauses. All existing boosts unchanged.

## Tests

| Run | Result |
|---|---|
| New/updated unit + relevance tests against the **original** parser/builder | 19 failed — including the relevance tests *"how does a search engine work"* and *"what is python"* (*"what is machine learning"* already passed) |
| Same files, new code | 163/163 |
| Step 3 fuzzy tests (`typo tolerance`, `fuzzy clause`) | 11/11 |
| Step 4 pagination/sort tests | 14/14 |
| Step 5 question tests | 27/27 |
| Full backend suite | **21/21 suites, 728/728**, 0 failed, 0 skipped (702 + 26 new) |
| ESLint / Prettier on changed files | pass |

Added: 12 parser tests (topic extraction, article, trailing *work*, fallbacks, `?`, quoted phrase, 4 protected queries, fuzzy on topic, non-question identity), 11 builder tests (topic recall, fuzzy gate on topic, title/phrase clauses on topic, full-question clause, 6 non-question/protected queries built on the full text), 3 relevance tests (`what is machine learning`, `how does a search engine work`, `what is python`).

Updated (existing values unchanged): the Step 3 weight-lock test now also lists `questionTitle: 4`; the Step 3 gate test counts `coreTerms` instead of `terms` — identical for its two non-question queries, and still asserts gate requirement = exact-clause requirement.

## Before vs after (live `ph-google-pages`, 859 documents, unchanged)

| Query | Total before → after | #1 before | #1 after |
|---|---:|---|---|
| how does gravity work | 702 → 80 | Improve how you use GitHub at work | Geophysics (then Sun – NASA, Theory of relativity) |
| how do vaccines work | 699 → 28 | How Much Exercise Do I Need? | COVID-19 |
| why is the sky blue | 226 → 48 | Raising a Flag over the Reichstag | Science (still weak — no page on the topic) |
| what is the capital of india | 461 → 143 | Gateway of India | Gateway of India; *Delhi* now #3, *Capital asset/appreciation* gone |
| who is lionel messi | 376 → 15 | Forward (association football) | Forward (association football); *Lion* gone |
| what is photosynthesis | 42 → 42 | Photosynthesis (90.2) | Photosynthesis (338.3) |
| what is machine learning | 814 → 80 | Machine learning (503.7) | Machine learning (843.8) |
| how does machine learning work | 707 → 80 | The latest on machine learning – GitHub | Machine learning (843.8) |
| what is life | 710 → 738 | Life (75.1) | Life (275.1) |

The corpus has no page titled gravity, vaccine, sky or Messi, so those improve to topical pages rather than to a definitive answer.

**Unchanged — byte-identical request body, top-10, scores, totals and page 1–3 ids:** all 16 non-question baseline queries (including `pyhton programming` 39, `machne learning` 292, `"machine learning"` 46, `site:wikipedia.org mathematics` 9) and the protected queries `can opener reviews`, `will smith movies`, `who covid guidelines`, `how to cook rice`.

**Pagination on changed queries:** pages 1/2/3 overlap 0/0/0 and the total is identical on every page for all 9 changed queries.

## Limitations

- `what is life` (a possible title) is stripped to `life`; *Life – Wikipedia* stays #1, and the full-question clause protects a title literally containing "what is life". Its total rose 710 → 738 because single-word fuzzy on "life" is broader than the old 2-of-3 rule.
- Yes/no questions (`is coffee healthy`) are intentionally not rewritten; their auxiliary is already a stop word in the text fields.
- Question detection is unchanged (`?` suffix, or ≥ 3 terms starting with a question word).
- The running `ph-google-backend` container still runs its previous image; Step 5 takes effect there after `docker compose up -d --build backend`.
