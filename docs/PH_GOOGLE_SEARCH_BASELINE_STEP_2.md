# PH Google Search Quality — Step 2 Baseline

Measured 2026-09-26 (UTC). Measurement only: no ranking, query, mapping, crawler, frontend or configuration code was changed. Every number and title below comes directly from the live responses; raw JSON for each request was saved during the run.

## Environment

### State found at the start

| Item | Value |
|---|---|
| Project path | `C:\Users\hp963\OneDrive\Desktop\ph google\PH-Google-frontend\PH-Google` |
| Docker | Docker Desktop was stopped. Launching it auto-restarted the existing `ph-google` compose containers (`restart: unless-stopped`); nothing was built or recreated |
| OpenSearch (live, :9200) | Up · 2.19.1 · cluster `ph-google` · status yellow · volume `ph-google_opensearch-data` |
| Backend (live container, :5000) | Up · `NODE_ENV=production` · health `ok` |
| Redis | Up (PONG) |
| Crawl worker | Auto-restarted with the stack; **stopped by me within ~40 s, before it processed any work**, so no crawling/indexing could alter the corpus during measurement. It was not running before Docker was launched |
| Search engine | `SEARCH_ENGINE=opensearch` |
| Index name | `ph-google-pages` |
| Indexed document count (live cluster) | **0 — the `ph-google-pages` index does not exist in the live cluster's volume** |
| MongoDB (Atlas) | 862 pages · 202 crawl jobs · last crawl 2026-09-25 07:27 UTC |

The crawled index was found in a different Docker volume, `ph-google-frontend_opensearch-data` (from an earlier compose project name), holding a 38.3 MB `ph-google-pages` index.

### How the baseline was measured (approved approach)

| Item | Value |
|---|---|
| Index source | A **copy** of `ph-google-frontend_opensearch-data` in a new throwaway volume `ph-baseline-step2-os-copy`, served by a temporary `opensearchproject/opensearch:2.19.1` container `ph-baseline-os-copy` on **:9201**. The original volumes were only mounted read-only |
| Backend | The project's own, unmodified backend code run on the host (`node server.js`) on **:5001**, with `PORT=5001` and `OPENSEARCH_NODE=http://localhost:9201` set for that process only (no `.env` or file change). `NODE_ENV=development` (from `.env`), `SEARCH_ENGINE=opensearch`, index `ph-google-pages` |
| Search API | `GET http://localhost:5001/api/search?q=&page=&limit=10&sort=` — 35 requests, **all HTTP 200** |
| Admin endpoints | `/api/admin/search/sample` and `/api/admin/search/explain` exist but returned **401 (no token)**; no admin credentials were available and none were forged. `/explain` is also disabled when `NODE_ENV=production` (the live container) |
| Ranking details | Captured by calling the project's existing `searchService.search({ debug: true })` (the same call `/admin/search/sample` makes), which returns OpenSearch's `_explanation`. Read-only |
| Side effect | Each `/api/search` call writes one `SearchLog` row (built-in analytics). **35 rows were added** to the Atlas `searchlogs` collection (415 → 450). No history rows (anonymous requests) |
| Latency | `responseTimeMs` from the API (server-side) and client wall-clock. Core queries were run twice: *cold* (first queries after the copy cluster started) and *warm* |

## Index Statistics

Measured on the copy (`ph-google-pages`, 859 documents; MongoDB holds 862 pages).

| Statistic | Value |
|---|---|
| Documents | 859 (count unchanged at end of run) |
| Distinct `domain` values | 27 |
| Top root domains | wikipedia.org 634 · mozilla.org 34 · nasa.gov 31 · epa.gov 23 · wikivoyage.org 23 · medlineplus.gov 19 · who.int 19 · github.blog 12 · fb.com 10 · stackoverflow.blog 10 · techcrunch.com 10 · gutenberg.org 9 · archive.org 7 · iana.org 6 · 11 others ≤2 |
| Language | `en` 850 · empty 9 |
| `statusCode` | 200 for all 859 |
| `hasDescription` | true for all 859 |
| `isArticle` | true 124 · false 735 |
| Has `publishedAt` | 784 of 859 (38 within the last 90 days — the only ones eligible for a freshness boost) |
| Empty `headings` | 522 of 859 |
| `wordCount` percentiles | p10 ≈ 823 · p50 ≈ 4,352 · p90 ≈ 9,134 |
| `qualityScore` | min 0.41 · avg 0.876 · max 0.93 |
| `crawledAt` range | 2026-09-17 09:05 → 2026-09-25 07:27 UTC |
| Other indexes in the copy | `ph-google-pages-test` (13 docs, test fixture), `top_queries-*` (OpenSearch query insights) |

## Core Query Results

### mathematics

- HTTP 200 · success: true · page 1 · limit 10 · sort relevance
- Total results: **251** (totalPages 26)
- Latency (API `responseTimeMs` / client wall-clock): cold 509 ms / 663 ms · warm 198 ms / 261 ms
- Parsed: terms ["mathematics"], allowFuzzy true, isMultiWord false
- Recall: live `must` admits 251 docs; the exact multi_match clause alone admits 249; the fuzzy clause alone admits 251

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Mathematics - Wikipedia | en.wikipedia.org | 240.75 | yes | https://en.wikipedia.org/wiki/Mathematics |
| 2 | Abstraction (mathematics) - Wikipedia | en.wikipedia.org | 206.555 | yes | https://en.wikipedia.org/wiki/Abstraction_(mathematics) |
| 3 | Operation (mathematics) - Wikipedia | en.wikipedia.org | 204.812 | yes | https://en.wikipedia.org/wiki/Operation_(mathematics) |
| 4 | Expression (mathematics) - Wikipedia | en.wikipedia.org | 203.164 | yes | https://en.wikipedia.org/wiki/Expression_(mathematics) |
| 5 | Field (mathematics) - Wikipedia | en.wikipedia.org | 203.087 | yes | https://en.wikipedia.org/wiki/Field_(mathematics) |
| 6 | Set (mathematics) - Wikipedia | en.wikipedia.org | 202.935 | yes | https://en.wikipedia.org/wiki/Set_(mathematics) |
| 7 | Ring (mathematics) - Wikipedia | en.wikipedia.org | 197.246 | yes | https://en.wikipedia.org/wiki/Ring_(mathematics) |
| 8 | Group (mathematics) - Wikipedia | en.wikipedia.org | 197.112 | yes | https://en.wikipedia.org/wiki/Group_(mathematics) |
| 9 | Philosophy of mathematics - Wikipedia | en.wikipedia.org | 194.493 | yes | https://en.wikipedia.org/wiki/Philosophy_of_mathematics |
| 10 | Mathematical object - Wikipedia | en.wikipedia.org | 72.992 | no | https://en.wikipedia.org/wiki/Mathematical_objects |

### cricket

- HTTP 200 · success: true · page 1 · limit 10 · sort relevance
- Total results: **52** (totalPages 6)
- Latency (API `responseTimeMs` / client wall-clock): cold 219 ms / 283 ms · warm 131 ms / 230 ms
- Parsed: terms ["cricket"], allowFuzzy true, isMultiWord false
- Recall: live `must` admits 52 docs; the exact multi_match clause alone admits 35; the fuzzy clause alone admits 52

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Cricket - Wikipedia | en.wikipedia.org | 250.243 | yes | https://en.wikipedia.org/wiki/Cricket |
| 2 | Cricket ball - Wikipedia | en.wikipedia.org | 226.538 | yes | https://en.wikipedia.org/wiki/Cricket_ball |
| 3 | Cricket bat - Wikipedia | en.wikipedia.org | 220.313 | yes | https://en.wikipedia.org/wiki/Cricket_bat |
| 4 | Cricket (insect) - Wikipedia | en.wikipedia.org | 219.215 | yes | https://en.wikipedia.org/wiki/Cricket_(insect) |
| 5 | Substitute (cricket) - Wikipedia | en.wikipedia.org | 212.183 | yes | https://en.wikipedia.org/wiki/Substitute_(cricket) |
| 6 | International Cricket Council - Wikipedia | en.wikipedia.org | 204.259 | yes | https://en.wikipedia.org/wiki/International_Cricket_Council |
| 7 | Melbourne Cricket Ground - Wikipedia | en.wikipedia.org | 181.593 | yes | https://en.wikipedia.org/wiki/Melbourne_Cricket_Ground |
| 8 | Australia national cricket team - Wikipedia | en.wikipedia.org | 176.663 | yes | https://en.wikipedia.org/wiki/Australia_cricket_team |
| 9 | South Africa national cricket team - Wikipedia | en.wikipedia.org | 161.987 | yes | https://en.wikipedia.org/wiki/South_Africa_cricket_team |
| 10 | Boxing Day Test - Wikipedia | en.wikipedia.org | 35.281 | no | https://en.wikipedia.org/wiki/Boxing_Day_Test |

### photosynthesis

- HTTP 200 · success: true · page 1 · limit 10 · sort relevance
- Total results: **42** (totalPages 5)
- Latency (API `responseTimeMs` / client wall-clock): cold 177 ms / 243 ms · warm 115 ms / 184 ms
- Parsed: terms ["photosynthesis"], allowFuzzy true, isMultiWord false
- Recall: live `must` admits 42 docs; the exact multi_match clause alone admits 41; the fuzzy clause alone admits 42

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Photosynthesis - Wikipedia | en.wikipedia.org | 338.373 | yes | https://en.wikipedia.org/wiki/Photosynthesis |
| 2 | Protist - Wikipedia | en.wikipedia.org | 11.922 | no | https://en.wikipedia.org/wiki/Protist |
| 3 | Metabolism - Wikipedia | en.wikipedia.org | 11.176 | no | https://en.wikipedia.org/wiki/Metabolism |
| 4 | Ecosystem - Wikipedia | en.wikipedia.org | 11.064 | no | https://en.wikipedia.org/wiki/Ecosystem |
| 5 | History of Earth - Wikipedia | en.wikipedia.org | 10.995 | no | https://en.wikipedia.org/wiki/History_of_Earth |
| 6 | Coral reef - Wikipedia | en.wikipedia.org | 10.715 | no | https://en.wikipedia.org/wiki/Coral_reef |
| 7 | Food - Wikipedia | en.wikipedia.org | 10.454 | no | https://en.wikipedia.org/wiki/Food |
| 8 | Nutrition - Wikipedia | en.wikipedia.org | 9.759 | no | https://en.wikipedia.org/wiki/Nutrition |
| 9 | Glossary of biology - Wikipedia | en.wikipedia.org | 9.48 | no | https://en.wikipedia.org/wiki/Glossary_of_biology |
| 10 | Fungus - Wikipedia | en.wikipedia.org | 9.48 | no | https://en.wikipedia.org/wiki/Fungi |

### machine learning

- HTTP 200 · success: true · page 1 · limit 10 · sort relevance
- Total results: **80** (totalPages 8)
- Latency (API `responseTimeMs` / client wall-clock): cold 195 ms / 264 ms · warm 119 ms / 176 ms
- Parsed: terms ["machine","learning"], allowFuzzy true, isMultiWord true
- Recall: live `must` admits 80 docs; the exact multi_match clause alone admits 80; the fuzzy clause alone admits 80

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Machine learning - Wikipedia | en.wikipedia.org | 843.895 | yes | https://en.wikipedia.org/wiki/Machine_learning |
| 2 | The latest on machine learning - The GitHub Blog | github.blog | 698.688 | yes | https://github.blog/ai-and-ml/machine-learning |
| 3 | The latest on AI & ML - The GitHub Blog | github.blog | 185.423 | no | https://github.blog/ai-and-ml |
| 4 | AI News & Artificial Intelligence \| TechCrunch | techcrunch.com | 163.154 | no | https://techcrunch.com/category/artificial-intelligence |
| 5 | Theoretical computer science - Wikipedia | en.wikipedia.org | 152.057 | no | https://en.wikipedia.org/wiki/Theoretical_computer_science |
| 6 | Type safety - Wikipedia | en.wikipedia.org | 131.925 | no | https://en.wikipedia.org/wiki/Strong_and_weak_typing |
| 7 | Home - The GitHub Blog | github.blog | 75.933 | no | https://github.blog |
| 8 | The latest on Generative AI - The GitHub Blog | github.blog | 70.896 | no | https://github.blog/ai-and-ml/generative-ai |
| 9 | The latest on GitHub Copilot - The GitHub Blog | github.blog | 70.896 | no | https://github.blog/ai-and-ml/github-copilot |
| 10 | Learning - Wikipedia | en.wikipedia.org | 69.331 | no | https://en.wikipedia.org/wiki/Learning |

### python programming

- HTTP 200 · success: true · page 1 · limit 10 · sort relevance
- Total results: **429** (totalPages 43)
- Latency (API `responseTimeMs` / client wall-clock): cold 190 ms / 265 ms · warm 137 ms / 197 ms
- Parsed: terms ["python","programming"], allowFuzzy true, isMultiWord true
- Recall: live `must` admits 429 docs; the exact multi_match clause alone admits 37; the fuzzy clause alone admits 429

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Python (programming language) - Wikipedia | en.wikipedia.org | 761.346 | yes | https://en.wikipedia.org/wiki/Python_(programming_language) |
| 2 | Functional programming - Wikipedia | en.wikipedia.org | 74.24 | no | https://en.wikipedia.org/wiki/Functional_programming |
| 3 | Java (programming language) - Wikipedia | en.wikipedia.org | 65.056 | no | https://en.wikipedia.org/wiki/Java_(programming_language) |
| 4 | Programming paradigm - Wikipedia | en.wikipedia.org | 56.966 | no | https://en.wikipedia.org/wiki/Programming_paradigm |
| 5 | Imperative programming - Wikipedia | en.wikipedia.org | 55.66 | no | https://en.wikipedia.org/wiki/Imperative_programming |
| 6 | Object-oriented programming - Wikipedia | en.wikipedia.org | 51.333 | no | https://en.wikipedia.org/wiki/Object-oriented_programming |
| 7 | Procedural programming - Wikipedia | en.wikipedia.org | 50.39 | no | https://en.wikipedia.org/wiki/Procedural_programming |
| 8 | Programming language theory - Wikipedia | en.wikipedia.org | 45.23 | no | https://en.wikipedia.org/wiki/Programming_language_theory |
| 9 | Event-driven programming - Wikipedia | en.wikipedia.org | 44.666 | no | https://en.wikipedia.org/wiki/Event-driven_programming |
| 10 | Comparison of multi-paradigm programming languages - Wikipedia | en.wikipedia.org | 21.104 | no | https://en.wikipedia.org/wiki/Multi-paradigm |

### history of India

- HTTP 200 · success: true · page 1 · limit 10 · sort relevance
- Total results: **762** (totalPages 77)
- Latency (API `responseTimeMs` / client wall-clock): cold 213 ms / 284 ms · warm 191 ms / 248 ms
- Parsed: terms ["history","of","India"], allowFuzzy true, isMultiWord true
- Recall: live `must` admits 762 docs; the exact multi_match clause alone admits 277; the fuzzy clause alone admits 762

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Cinema of India - Wikipedia | en.wikipedia.org | 256.666 | no | https://en.wikipedia.org/wiki/Cinema_of_India |
| 2 | Gateway of India - Wikipedia | en.wikipedia.org | 255.193 | no | https://en.wikipedia.org/wiki/Gateway_of_India |
| 3 | Outline of history - Wikipedia | en.wikipedia.org | 220.152 | no | https://en.wikipedia.org/wiki/Outline_of_history |
| 4 | History of cartography - Wikipedia | en.wikipedia.org | 219.997 | no | https://en.wikipedia.org/wiki/History_of_cartography |
| 5 | History of geography - Wikipedia | en.wikipedia.org | 216.556 | no | https://en.wikipedia.org/wiki/History_of_geography |
| 6 | Glossary of history - Wikipedia | en.wikipedia.org | 216.394 | no | https://en.wikipedia.org/wiki/Glossary_of_history |
| 7 | History of biology - Wikipedia | en.wikipedia.org | 216.34 | no | https://en.wikipedia.org/wiki/History_of_biology |
| 8 | History of Earth - Wikipedia | en.wikipedia.org | 215.695 | no | https://en.wikipedia.org/wiki/History_of_Earth |
| 9 | Index of history articles - Wikipedia | en.wikipedia.org | 211.337 | no | https://en.wikipedia.org/wiki/Index_of_history_articles |
| 10 | History of computer science - Wikipedia | en.wikipedia.org | 195.338 | no | https://en.wikipedia.org/wiki/History_of_computer_science |

## Ranking Details (OpenSearch `_explanation`, top 3 per core query)

Columns: final score = bool score × quality multiplier × freshness multiplier. Clause values are the per-clause contributions to the bool score (first = `must` recall clause, rest = `should` precision clauses that fired).

### mathematics

| Rank | Title | Final | Bool | Quality × | Freshness × | Clauses that fired (value) |
|---:|---|---:|---:|---:|---:|---|
| 1 | Mathematics - Wikipedia | 240.75 | 204.038 | 1.1799 | 1.0 | must 72.561; titleExactTerms 99.217; urlPath 32.26 |
| 2 | Abstraction (mathematics) - Wikipedia | 206.555 | 172.136 | 1.2 | 1.0 | must 56.891; titleExactTerms 87.122; urlPath 28.124 |
| 3 | Operation (mathematics) - Wikipedia | 204.812 | 170.684 | 1.2 | 1.0 | must 55.438; titleExactTerms 87.122; urlPath 28.124 |

### cricket

| Rank | Title | Final | Bool | Quality × | Freshness × | Clauses that fired (value) |
|---:|---|---:|---:|---:|---:|---|
| 1 | Cricket - Wikipedia | 250.243 | 212.083 | 1.1799 | 1.0 | must 80.607; titleExactTerms 99.217; urlPath 32.26 |
| 2 | Cricket ball - Wikipedia | 226.538 | 191.992 | 1.1799 | 1.0 | must 76.747; titleExactTerms 87.122; urlPath 28.124 |
| 3 | Cricket bat - Wikipedia | 220.313 | 186.717 | 1.1799 | 1.0 | must 71.472; titleExactTerms 87.122; urlPath 28.124 |

### photosynthesis

| Rank | Title | Final | Bool | Quality × | Freshness × | Clauses that fired (value) |
|---:|---|---:|---:|---:|---:|---|
| 1 | Photosynthesis - Wikipedia | 338.373 | 286.774 | 1.1799 | 1.0 | must 101.453; titleExactTerms 139.831; urlPath 45.489 |
| 2 | Protist - Wikipedia | 11.922 | 10.104 | 1.1799 | 1.0 | must 10.104 |
| 3 | Metabolism - Wikipedia | 11.176 | 9.472 | 1.1799 | 1.0 | must 9.472 |

### machine learning

| Rank | Title | Final | Bool | Quality × | Freshness × | Clauses that fired (value) |
|---:|---|---:|---:|---:|---:|---|
| 1 | Machine learning - Wikipedia | 843.895 | 715.207 | 1.1799 | 1.0 | must 151.588; titleExactTerms 207.369; phraseTitle 161.287; phraseDescription 85.775; phraseContent 41.183; urlPath 68.004 |
| 2 | The latest on machine learning - The GitHub Blog | 698.688 | 571.154 | 1.165 | 1.05 | must 131.425; titleExactTerms 128.838; phraseTitle 100.207; phraseDescription 108.651; phraseContent 47.908; urlPath 54.125 |
| 3 | The latest on AI & ML - The GitHub Blog | 185.423 | 142.861 | 1.1799 | 1.1 | must 67.731; must(recall multi_match) 30.262; phraseContent 44.869 |

### python programming

| Rank | Title | Final | Bool | Quality × | Freshness × | Clauses that fired (value) |
|---:|---|---:|---:|---:|---:|---|
| 1 | Python (programming language) - Wikipedia | 761.346 | 645.246 | 1.1799 | 1.0 | must 133.474; titleExactTerms 185.375; phraseTitle 144.18; phraseDescription 27.305; phraseContent 94.835; urlPath 60.078 |
| 2 | Functional programming - Wikipedia | 74.24 | 62.919 | 1.1799 | 1.0 | must 21.485; phraseContent 13.31; urlPath 28.124 |
| 3 | Java (programming language) - Wikipedia | 65.056 | 55.135 | 1.1799 | 1.0 | must 17.599; phraseContent 12.609; urlPath 24.928 |

### history of India

| Rank | Title | Final | Bool | Quality × | Freshness × | Clauses that fired (value) |
|---:|---|---:|---:|---:|---:|---|
| 1 | Cinema of India - Wikipedia | 256.666 | 217.526 | 1.1799 | 1.0 | must 33.967; titleExactTerms 134.666; phraseContent 3.48; urlPath 45.414 |
| 2 | Gateway of India - Wikipedia | 255.193 | 216.278 | 1.1799 | 1.0 | must 33.969; titleExactTerms 134.666; phraseContent 2.229; urlPath 45.414 |
| 3 | Outline of history - Wikipedia | 220.152 | 186.58 | 1.1799 | 1.0 | must 28.039; titleExactTerms 117.072; phraseContent 3.106; urlPath 38.364 |

## Additional Query Results

Query #19 (`cricket`, ambiguous) is the same string as core query #2; its results are the `cricket` table above.

### Single-term: physics

- HTTP 200 · total **412** · latency 159 ms (wall 215 ms) · page 1 · limit 10 · sort relevance

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Physics - Wikipedia | en.wikipedia.org | 276.349 | yes | https://en.wikipedia.org/wiki/Physics |
| 2 | Particle physics - Wikipedia | en.wikipedia.org | 234.431 | yes | https://en.wikipedia.org/wiki/Particle_physics |
| 3 | Branches of physics - Wikipedia | en.wikipedia.org | 226.46 | yes | https://en.wikipedia.org/wiki/Branches_of_physics |
| 4 | Index of physics articles - Wikipedia | en.wikipedia.org | 207.566 | yes | https://en.wikipedia.org/wiki/Index_of_physics_articles |
| 5 | Information - Wikipedia | en.wikipedia.org | 38.846 | no | https://en.wikipedia.org/wiki/Information |
| 6 | Geophysics - Wikipedia | en.wikipedia.org | 36.602 | yes | https://en.wikipedia.org/wiki/Geophysics |
| 7 | Science education - Wikipedia | en.wikipedia.org | 36.446 | no | https://en.wikipedia.org/wiki/Science_education |
| 8 | Double-slit experiment - Wikipedia | en.wikipedia.org | 33.061 | no | https://en.wikipedia.org/wiki/Double-slit_experiment |
| 9 | Optics - Wikipedia | en.wikipedia.org | 26.024 | no | https://en.wikipedia.org/wiki/Optics |
| 10 | Biophysics - Wikipedia | en.wikipedia.org | 25.612 | yes | https://en.wikipedia.org/wiki/Biophysics |

### Single-term: football

- HTTP 200 · total **58** · latency 110 ms (wall 169 ms) · page 1 · limit 10 · sort relevance

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Blind football - Wikipedia | en.wikipedia.org | 221.123 | yes | https://en.wikipedia.org/wiki/Blind_football |
| 2 | Association football - Wikipedia | en.wikipedia.org | 212.344 | yes | https://en.wikipedia.org/wiki/Association_football |
| 3 | Football boot - Wikipedia | en.wikipedia.org | 210.92 | yes | https://en.wikipedia.org/wiki/Football_boot |
| 4 | CP football - Wikipedia | en.wikipedia.org | 208.11 | yes | https://en.wikipedia.org/wiki/CP_football |
| 5 | Football pitch - Wikipedia | en.wikipedia.org | 203.427 | yes | https://en.wikipedia.org/wiki/Football_pitch |
| 6 | Ball (association football) - Wikipedia | en.wikipedia.org | 188.348 | yes | https://en.wikipedia.org/wiki/Ball_(association_football) |
| 7 | Defender (association football) - Wikipedia | en.wikipedia.org | 181.982 | yes | https://en.wikipedia.org/wiki/Defender_(association_football) |
| 8 | Kit (association football) - Wikipedia | en.wikipedia.org | 178.999 | yes | https://en.wikipedia.org/wiki/Kit_(association_football) |
| 9 | Forward (association football) - Wikipedia | en.wikipedia.org | 178.902 | yes | https://en.wikipedia.org/wiki/Forward_(association_football) |
| 10 | Goalkeeper (association football) - Wikipedia | en.wikipedia.org | 178.762 | yes | https://en.wikipedia.org/wiki/Goalkeeper_(association_football) |

### Single-term: geography

- HTTP 200 · total **267** · latency 185 ms (wall 243 ms) · page 1 · limit 10 · sort relevance

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Geography - Wikipedia | en.wikipedia.org | 229.585 | yes | https://en.wikipedia.org/wiki/Geography |
| 2 | Cultural geography - Wikipedia | en.wikipedia.org | 211.018 | yes | https://en.wikipedia.org/wiki/Cultural_geography |
| 3 | Cognitive geography - Wikipedia | en.wikipedia.org | 207.483 | yes | https://en.wikipedia.org/wiki/Cognitive_geography |
| 4 | Behavioral geography - Wikipedia | en.wikipedia.org | 205.455 | yes | https://en.wikipedia.org/wiki/Behavioral_geography |
| 5 | Critical geography - Wikipedia | en.wikipedia.org | 205.24 | yes | https://en.wikipedia.org/wiki/Critical_geography |
| 6 | Historical geography - Wikipedia | en.wikipedia.org | 204.516 | yes | https://en.wikipedia.org/wiki/Historical_geography |
| 7 | Regional geography - Wikipedia | en.wikipedia.org | 202.349 | yes | https://en.wikipedia.org/wiki/Regional_geography |
| 8 | Human geography - Wikipedia | en.wikipedia.org | 197.698 | yes | https://en.wikipedia.org/wiki/Human_geography |
| 9 | History of geography - Wikipedia | en.wikipedia.org | 184.85 | yes | https://en.wikipedia.org/wiki/History_of_geography |
| 10 | Outline of geography - Wikipedia | en.wikipedia.org | 183.833 | yes | https://en.wikipedia.org/wiki/Outline_of_geography |

### Multi-word: computer science

- HTTP 200 · total **550** · latency 171 ms (wall 236 ms) · page 1 · limit 10 · sort relevance

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Computer science - Wikipedia | en.wikipedia.org | 809.876 | yes | https://en.wikipedia.org/wiki/Computer_science |
| 2 | Theoretical computer science - Wikipedia | en.wikipedia.org | 638.598 | yes | https://en.wikipedia.org/wiki/Theoretical_computer_science |
| 3 | Outline of computer science - Wikipedia | en.wikipedia.org | 598.839 | yes | https://en.wikipedia.org/wiki/Outline_of_computer_science |
| 4 | History of computer science - Wikipedia | en.wikipedia.org | 594.822 | yes | https://en.wikipedia.org/wiki/History_of_computer_science |
| 5 | Glossary of computer science - Wikipedia | en.wikipedia.org | 593.796 | yes | https://en.wikipedia.org/wiki/Glossary_of_computer_science |
| 6 | Computer scientist - Wikipedia | en.wikipedia.org | 235.104 | no | https://en.wikipedia.org/wiki/Computer_scientist |
| 7 | Computer architecture - Wikipedia | en.wikipedia.org | 216.033 | no | https://en.wikipedia.org/wiki/Computer_architecture |
| 8 | Computational complexity theory - Wikipedia | en.wikipedia.org | 154.025 | no | https://en.wikipedia.org/wiki/Computational_complexity_theory |
| 9 | Theory of computation - Wikipedia | en.wikipedia.org | 149.53 | no | https://en.wikipedia.org/wiki/Theory_of_computation |
| 10 | Programming language theory - Wikipedia | en.wikipedia.org | 147.217 | no | https://en.wikipedia.org/wiki/Programming_language_theory |

### Multi-word: climate change

- HTTP 200 · total **685** · latency 184 ms (wall 244 ms) · page 1 · limit 10 · sort relevance

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Climate change - Wikipedia | en.wikipedia.org | 789.138 | yes | https://en.wikipedia.org/wiki/Climate_change |
| 2 | Scientific consensus on climate change - Wikipedia | en.wikipedia.org | 621.704 | yes | https://en.wikipedia.org/wiki/Scientific_consensus_on_climate_change |
| 3 | Climate variability and change - Wikipedia | en.wikipedia.org | 512.783 | yes | https://en.wikipedia.org/wiki/Climate_variability_and_change |
| 4 | Coal - Wikipedia | en.wikipedia.org | 119.008 | no | https://en.wikipedia.org/wiki/Coal |
| 5 | Climate - Wikipedia | en.wikipedia.org | 90.39 | no | https://en.wikipedia.org/wiki/Climate |
| 6 | Climate system - Wikipedia | en.wikipedia.org | 81.784 | no | https://en.wikipedia.org/wiki/Climate_system |
| 7 | Environmental determinism - Wikipedia | en.wikipedia.org | 30.441 | no | https://en.wikipedia.org/wiki/Environmental_determinism |
| 8 | Asia - Wikipedia | en.wikipedia.org | 27.44 | no | https://en.wikipedia.org/wiki/Asia |
| 9 | Global surface temperature - Wikipedia | en.wikipedia.org | 27.371 | no | https://en.wikipedia.org/wiki/Global_surface_temperature |
| 10 | Fossil fuel - Wikipedia | en.wikipedia.org | 26.277 | no | https://en.wikipedia.org/wiki/Fossil_fuel |

### Multi-word: artificial intelligence

- HTTP 200 · total **156** · latency 102 ms (wall 157 ms) · page 1 · limit 10 · sort relevance

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | AI News & Artificial Intelligence \| TechCrunch | techcrunch.com | 876.078 | yes | https://techcrunch.com/category/artificial-intelligence |
| 2 | Artificial intelligence - Wikipedia | en.wikipedia.org | 844.87 | yes | https://en.wikipedia.org/wiki/Artificial_intelligence |
| 3 | Ethics of Artificial Intelligence and Robotics (Stanford Encyclopedia of Philosophy/Fall 2023 Edition) | plato.stanford.edu | 416.755 | yes | https://plato.stanford.edu/archives/fall2023/entries/ethics-ai |
| 4 | The latest on Generative AI - The GitHub Blog | github.blog | 280.843 | no | https://github.blog/ai-and-ml/generative-ai |
| 5 | Exclusive: Multiple AI companies bypassing web standard to scrape publisher sites, licensing firm says \| Reuters | web.archive.org | 254.298 | no | https://web.archive.org/web/20241110223415/https://www.reuters.com/technology/artificial-intelligence/multiple-ai-companies-bypassing-web-standard-scrape-publisher-sites-licensing-2024-06-21 |
| 6 | Big tech and the pursuit of AI dominance | web.archive.org | 218.576 | no | https://web.archive.org/web/20231229021351/https://www.economist.com/business/2023/03/26/big-tech-and-the-pursuit-of-ai-dominance |
| 7 | Where the battle to dominate AI may be won \| CNN Business | web.archive.org | 194.533 | no | https://web.archive.org/web/20240113053332/https://www.cnn.com/2023/12/19/tech/cloud-competition-and-ai/index.html |
| 8 | Open Source Archives - Engineering at Meta | engineering.fb.com | 175.504 | no | https://engineering.fb.com/category/open-source |
| 9 | Several AI companies said to be ignoring robots dot txt exclusion, scraping content without permission: report \| Tom's Hardware | www.tomshardware.com | 174.223 | no | https://www.tomshardware.com/tech-industry/artificial-intelligence/several-ai-companies-said-to-be-ignoring-robots-dot-txt-exclusion-scraping-content-without-permission-report |
| 10 | Machine learning - Wikipedia | en.wikipedia.org | 168.299 | no | https://en.wikipedia.org/wiki/Machine_learning |

### Natural-language: what is photosynthesis

- HTTP 200 · total **804** · latency 124 ms (wall 180 ms) · page 1 · limit 10 · sort relevance

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Photosynthesis - Wikipedia | en.wikipedia.org | 90.167 | yes | https://en.wikipedia.org/wiki/Photosynthesis |
| 2 | Food - Wikipedia | en.wikipedia.org | 24.989 | no | https://en.wikipedia.org/wiki/Food |
| 3 | Sustainability \| US EPA | www.epa.gov | 12.336 | no | https://www.epa.gov/sustainability |
| 4 | Protist - Wikipedia | en.wikipedia.org | 12.055 | no | https://en.wikipedia.org/wiki/Protist |
| 5 | Alcohol \| Drinking \| MedlinePlus | medlineplus.gov | 11.919 | no | https://medlineplus.gov/alcohol.html |
| 6 | Metabolism - Wikipedia | en.wikipedia.org | 11.309 | no | https://en.wikipedia.org/wiki/Metabolism |
| 7 | Ecosystem - Wikipedia | en.wikipedia.org | 11.242 | no | https://en.wikipedia.org/wiki/Ecosystem |
| 8 | History of Earth - Wikipedia | en.wikipedia.org | 11.147 | no | https://en.wikipedia.org/wiki/History_of_Earth |
| 9 | Coral reef - Wikipedia | en.wikipedia.org | 10.867 | no | https://en.wikipedia.org/wiki/Coral_reef |
| 10 | Assistive technology | www.who.int | 10.255 | no | https://www.who.int/news-room/fact-sheets/detail/assistive-technology |

### Natural-language: how does machine learning work

- HTTP 200 · total **811** · latency 192 ms (wall 261 ms) · page 1 · limit 10 · sort relevance

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | The latest on machine learning - The GitHub Blog | github.blog | 209.057 | no | https://github.blog/ai-and-ml/machine-learning |
| 2 | Machine learning - Wikipedia | en.wikipedia.org | 134.242 | no | https://en.wikipedia.org/wiki/Machine_learning |
| 3 | How Much Exercise Do I Need?: MedlinePlus | medlineplus.gov | 114.508 | no | https://medlineplus.gov/howmuchexercisedoineed.html |
| 4 | Improve how you use GitHub at work - The GitHub Blog | github.blog | 109.142 | no | https://github.blog/developer-skills/github |
| 5 | Calcium \| MedlinePlus | medlineplus.gov | 95.419 | no | https://medlineplus.gov/calcium.html |
| 6 | Reference work - Wikipedia | en.wikipedia.org | 71.99 | no | https://en.wikipedia.org/wiki/Reference_work |
| 7 | Jessie Buckley - Wikipedia | en.wikipedia.org | 62.641 | no | https://en.wikipedia.org/wiki/Jessie_Buckley |
| 8 | How AI code generation works - The GitHub Blog | github.blog | 58.645 | no | https://github.blog/ai-and-ml/generative-ai/how-ai-code-generation-works |
| 9 | Alcohol \| Drinking \| MedlinePlus | medlineplus.gov | 55.55 | no | https://medlineplus.gov/alcohol.html |
| 10 | Learning - Wikipedia | en.wikipedia.org | 51.556 | no | https://en.wikipedia.org/wiki/Learning |

### Natural-language: how does gravity work

- HTTP 200 · total **811** · latency 140 ms (wall 201 ms) · page 1 · limit 10 · sort relevance

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Improve how you use GitHub at work - The GitHub Blog | github.blog | 246.985 | no | https://github.blog/developer-skills/github |
| 2 | How Much Exercise Do I Need?: MedlinePlus | medlineplus.gov | 114.508 | no | https://medlineplus.gov/howmuchexercisedoineed.html |
| 3 | Calcium \| MedlinePlus | medlineplus.gov | 95.419 | no | https://medlineplus.gov/calcium.html |
| 4 | Reference work - Wikipedia | en.wikipedia.org | 71.99 | no | https://en.wikipedia.org/wiki/Reference_work |
| 5 | Jessie Buckley - Wikipedia | en.wikipedia.org | 62.641 | no | https://en.wikipedia.org/wiki/Jessie_Buckley |
| 6 | Alcohol \| Drinking \| MedlinePlus | medlineplus.gov | 55.55 | no | https://medlineplus.gov/alcohol.html |
| 7 | Bosnia and Herzegovina – Travel guide at Wikivoyage | en.wikivoyage.org | 49.388 | no | https://en.wikivoyage.org/wiki/Bosnia_and_Herzegovina |
| 8 | How AI code generation works - The GitHub Blog | github.blog | 48.483 | no | https://github.blog/ai-and-ml/generative-ai/how-ai-code-generation-works |
| 9 | Albania – Travel guide at Wikivoyage | en.wikivoyage.org | 45.316 | no | https://en.wikivoyage.org/wiki/Albania |
| 10 | Software design - Wikipedia | en.wikipedia.org | 44.313 | no | https://en.wikipedia.org/wiki/Software_design |

### Phrase: "machine learning"

- HTTP 200 · total **46** · latency 126 ms (wall 210 ms) · page 1 · limit 10 · sort relevance

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Machine learning - Wikipedia | en.wikipedia.org | 3383.712 | yes | https://en.wikipedia.org/wiki/Machine_learning |
| 2 | The latest on machine learning - The GitHub Blog | github.blog | 2289.1 | yes | https://github.blog/ai-and-ml/machine-learning |
| 3 | AI News & Artificial Intelligence \| TechCrunch | techcrunch.com | 1578.192 | no | https://techcrunch.com/category/artificial-intelligence |
| 4 | Theoretical computer science - Wikipedia | en.wikipedia.org | 1269.755 | no | https://en.wikipedia.org/wiki/Theoretical_computer_science |
| 5 | Learning - Wikipedia | en.wikipedia.org | 297.843 | no | https://en.wikipedia.org/wiki/Learning |
| 6 | The latest on AI & ML - The GitHub Blog | github.blog | 212.82 | no | https://github.blog/ai-and-ml |
| 7 | Production Engineering Archives - Engineering at Meta | engineering.fb.com | 173.575 | no | https://engineering.fb.com/category/production-engineering |
| 8 | Home - The GitHub Blog | github.blog | 172.225 | no | https://github.blog |
| 9 | The latest on Generative AI - The GitHub Blog | github.blog | 171.113 | no | https://github.blog/ai-and-ml/generative-ai |
| 10 | The latest on GitHub Copilot - The GitHub Blog | github.blog | 170.149 | no | https://github.blog/ai-and-ml/github-copilot |

### Typo: pyhton programming

- HTTP 200 · total **431** · latency 154 ms (wall 259 ms) · page 1 · limit 10 · sort relevance

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Python (programming language) - Wikipedia | en.wikipedia.org | 62.401 | no | https://en.wikipedia.org/wiki/Python_(programming_language) |
| 2 | Procedural programming - Wikipedia | en.wikipedia.org | 50.39 | no | https://en.wikipedia.org/wiki/Procedural_programming |
| 3 | Programming paradigm - Wikipedia | en.wikipedia.org | 49.549 | no | https://en.wikipedia.org/wiki/Programming_paradigm |
| 4 | Functional programming - Wikipedia | en.wikipedia.org | 49.549 | no | https://en.wikipedia.org/wiki/Functional_programming |
| 5 | Imperative programming - Wikipedia | en.wikipedia.org | 49.549 | no | https://en.wikipedia.org/wiki/Imperative_programming |
| 6 | Programming language theory - Wikipedia | en.wikipedia.org | 45.23 | no | https://en.wikipedia.org/wiki/Programming_language_theory |
| 7 | Event-driven programming - Wikipedia | en.wikipedia.org | 44.666 | no | https://en.wikipedia.org/wiki/Event-driven_programming |
| 8 | Java (programming language) - Wikipedia | en.wikipedia.org | 43.921 | no | https://en.wikipedia.org/wiki/Java_(programming_language) |
| 9 | Object-oriented programming - Wikipedia | en.wikipedia.org | 43.921 | no | https://en.wikipedia.org/wiki/Object-oriented_programming |
| 10 | Voyager program - Wikipedia | en.wikipedia.org | 16.365 | no | https://en.wikipedia.org/wiki/Voyager_program |

### Site: site:wikipedia.org mathematics

- HTTP 200 · total **251** · latency 166 ms (wall 296 ms) · page 1 · limit 10 · sort relevance

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Mathematics - Wikipedia | en.wikipedia.org | 68.895 | yes | https://en.wikipedia.org/wiki/Mathematics |
| 2 | Abstraction (mathematics) - Wikipedia | en.wikipedia.org | 61.842 | yes | https://en.wikipedia.org/wiki/Abstraction_(mathematics) |
| 3 | Operation (mathematics) - Wikipedia | en.wikipedia.org | 61.842 | yes | https://en.wikipedia.org/wiki/Operation_(mathematics) |
| 4 | Expression (mathematics) - Wikipedia | en.wikipedia.org | 60.811 | yes | https://en.wikipedia.org/wiki/Expression_(mathematics) |
| 5 | Set (mathematics) - Wikipedia | en.wikipedia.org | 60.811 | yes | https://en.wikipedia.org/wiki/Set_(mathematics) |
| 6 | Field (mathematics) - Wikipedia | en.wikipedia.org | 60.811 | yes | https://en.wikipedia.org/wiki/Field_(mathematics) |
| 7 | Ring (mathematics) - Wikipedia | en.wikipedia.org | 59.527 | yes | https://en.wikipedia.org/wiki/Ring_(mathematics) |
| 8 | Group (mathematics) - Wikipedia | en.wikipedia.org | 59.527 | yes | https://en.wikipedia.org/wiki/Group_(mathematics) |
| 9 | Philosophy of mathematics - Wikipedia | en.wikipedia.org | 56.337 | yes | https://en.wikipedia.org/wiki/Philosophy_of_mathematics |
| 10 | Mathematical analysis - Wikipedia | en.wikipedia.org | 16.365 | no | https://en.wikipedia.org/wiki/Mathematical_analysis |

### Typo (extra): machne learning

- HTTP 200 · total **632** · latency 173 ms (wall 234 ms) · page 1 · limit 10 · sort relevance

| Rank | Title | Domain | Score | Title has query terms | URL |
|---:|---|---|---:|:---:|---|
| 1 | Machine learning - Wikipedia | en.wikipedia.org | 75.625 | no | https://en.wikipedia.org/wiki/Machine_learning |
| 2 | Learning - Wikipedia | en.wikipedia.org | 64.753 | no | https://en.wikipedia.org/wiki/Learning |
| 3 | The latest on machine learning - The GitHub Blog | github.blog | 62.413 | no | https://github.blog/ai-and-ml/machine-learning |
| 4 | Student-centered learning - Wikipedia | en.wikipedia.org | 51.534 | no | https://en.wikipedia.org/wiki/Student-centered_learning |
| 5 | Learn web development writing guidelines - MDN Web Docs \| MDN | developer.mozilla.org | 25.309 | no | https://developer.mozilla.org/en-US/docs/MDN/Writing_guidelines/Learning_content |
| 6 | Nonformal learning - Wikipedia | en.wikipedia.org | 19.242 | no | https://en.wikipedia.org/wiki/Non-formal_education |
| 7 | Theoretical computer science - Wikipedia | en.wikipedia.org | 17.892 | no | https://en.wikipedia.org/wiki/Theoretical_computer_science |
| 8 | Machu Picchu - Wikipedia | en.wikipedia.org | 13.802 | no | https://en.wikipedia.org/wiki/Machu_Picchu |
| 9 | Core learning modules - Learn web development \| MDN | developer.mozilla.org | 12.942 | no | https://developer.mozilla.org/en-US/docs/Learn_web_development/Core |
| 10 | Physical education - Wikipedia | en.wikipedia.org | 11.315 | no | https://en.wikipedia.org/wiki/Physical_education |

## Pagination Results

### mathematics

| Page | Returned | totalResults | totalPages | Titles |
|---:|---:|---:|---:|---|
| 1 | 10 | 251 | 26 | Mathematics - Wikipedia<br>Abstraction (mathematics) - Wikipedia<br>Operation (mathematics) - Wikipedia<br>Expression (mathematics) - Wikipedia<br>Field (mathematics) - Wikipedia<br>Set (mathematics) - Wikipedia<br>Ring (mathematics) - Wikipedia<br>Group (mathematics) - Wikipedia<br>Philosophy of mathematics - Wikipedia<br>Mathematical object - Wikipedia |
| 2 | 10 | 251 | 26 | Mathematical object - Wikipedia<br>Mathematical proof - Wikipedia<br>Mathematical analysis - Wikipedia<br>Computation - Wikipedia<br>Axiom - Wikipedia<br>Axiom - Wikipedia<br>Structure - Wikipedia<br>Secondary source - Wikipedia<br>Finance - Wikipedia<br>Quantum mechanics - Wikipedia |
| 3 | 10 | 251 | 26 | Theoretical computer science - Wikipedia<br>Set theory - Wikipedia<br>MathML \| MDN<br>India - Wikipedia<br>Number theory - Wikipedia<br>Geometry - Wikipedia<br>Algebraic operation - Wikipedia<br>Information theory - Wikipedia<br>Euclid's Elements - Wikipedia<br>Algebraic equation - Wikipedia |

- URL overlap p1∩p2: 0, p2∩p3: 0, p1∩p3: 0
- Title overlap p1∩p2: 1, p2∩p3: 0, p1∩p3: 0
- Repeated titles anywhere across the 3 pages: Mathematical object - Wikipedia; Axiom - Wikipedia

### cricket

| Page | Returned | totalResults | totalPages | Titles |
|---:|---:|---:|---:|---|
| 1 | 10 | 52 | 6 | Cricket - Wikipedia<br>Cricket ball - Wikipedia<br>Cricket bat - Wikipedia<br>Cricket (insect) - Wikipedia<br>Substitute (cricket) - Wikipedia<br>International Cricket Council - Wikipedia<br>Melbourne Cricket Ground - Wikipedia<br>Australia national cricket team - Wikipedia<br>South Africa national cricket team - Wikipedia<br>Boxing Day Test - Wikipedia |
| 2 | 10 | 52 | 6 | Michael Hussey - Wikipedia<br>1900 Summer Olympics - Wikipedia<br>Bat-and-ball games - Wikipedia<br>Shaun Pollock - Wikipedia<br>Shin guard - Wikipedia<br>List of ball games - Wikipedia<br>Team sport - Wikipedia<br>Sam Mendes - Wikipedia<br>Sports governing body - Wikipedia<br>Herefordshire - Wikipedia |
| 3 | 10 | 52 | 6 | Kirsty Coventry - Wikipedia<br>Kit (association football) - Wikipedia<br>Contact sport - Wikipedia<br>South Asia - Wikipedia<br>Croquet - Wikipedia<br>The Overflow - Stack Overflow<br>Casting (performing arts) - Wikipedia<br>1896 Summer Olympics - Wikipedia<br>Emmy's Picks Bookshelf \| Project Gutenberg<br>Developmental biology - Wikipedia |

- URL overlap p1∩p2: 0, p2∩p3: 0, p1∩p3: 0
- Title overlap p1∩p2: 0, p2∩p3: 0, p1∩p3: 0
- Repeated titles anywhere across the 3 pages: none

### machine learning

| Page | Returned | totalResults | totalPages | Titles |
|---:|---:|---:|---:|---|
| 1 | 10 | 80 | 8 | Machine learning - Wikipedia<br>The latest on machine learning - The GitHub Blog<br>The latest on AI & ML - The GitHub Blog<br>AI News & Artificial Intelligence \| TechCrunch<br>Theoretical computer science - Wikipedia<br>Type safety - Wikipedia<br>Home - The GitHub Blog<br>The latest on Generative AI - The GitHub Blog<br>The latest on GitHub Copilot - The GitHub Blog<br>Learning - Wikipedia |
| 2 | 10 | 80 | 8 | The latest on LLMs - The GitHub Blog<br>How AI code generation works - The GitHub Blog<br>Developer career growth guides - The GitHub Blog<br>Improve how you use GitHub at work - The GitHub Blog<br>Resources to grow as a software developer - The GitHub Blog<br>Production Engineering Archives - Engineering at Meta<br>The latest on application development - The GitHub Blog<br>How to Stop Your Data From Being Used to Train AI \| WIRED<br>Productivity - Stack Overflow<br>Open Source - Stack Overflow |
| 3 | 10 | 80 | 8 | The Stack Overflow Blog - Stack Overflow<br>Programming paradigm - Wikipedia<br>Engineering at Meta - Engineering at Meta Blog<br>Security & Privacy Archives - Engineering at Meta<br>Android Archives - Engineering at Meta<br>iOS Archives - Engineering at Meta<br>Python (programming language) - Wikipedia<br>Quantum mechanics - Wikipedia<br>Functional programming - Wikipedia<br>Java (programming language) - Wikipedia |

- URL overlap p1∩p2: 0, p2∩p3: 0, p1∩p3: 0
- Title overlap p1∩p2: 0, p2∩p3: 0, p1∩p3: 0
- Repeated titles anywhere across the 3 pages: none

### Pagination observations

- All 9 page requests returned HTTP 200 with 10 results; `totalResults` was identical on pages 1–3 for each query (251 / 52 / 80).
- **No URL appeared on more than one page** for any of the three queries, and `duplicatesRemoved` was 0 on every request in this run — the cross-page overlap that Step 1 identified as possible (when dedupe removes a hit) was **not triggered** in this sample.
- Two titles repeated within the `mathematics` pages, each as two **different URLs with different `contentHash` values**: *Mathematical object* (`/wiki/Mathematical_objects` p1 #10 and `/wiki/Mathematical_object` p2 #1; 3,478 vs 3,474 words) and *Axiom* (`/wiki/Axiom` and `/wiki/Axioms`, p2 #5 and #6; 5,930 vs 5,933 words). These are near-duplicate pages reachable at redirect-style URLs, which the exact `contentHash` dedupe does not collapse.

## Sorting Results

### machine learning

**sort=relevance** (HTTP 200, total 80)

| Rank | Title | publishedAt | Score |
|---:|---|---|---:|
| 1 | Machine learning - Wikipedia | 2003-05-25 | 843.895 |
| 2 | The latest on machine learning - The GitHub Blog | 2026-07-08 | 698.688 |
| 3 | The latest on AI & ML - The GitHub Blog | 2026-09-16 | 185.423 |
| 4 | AI News & Artificial Intelligence \| TechCrunch | 2026-09-17 | 163.154 |
| 5 | Theoretical computer science - Wikipedia | 2003-09-21 | 152.057 |

**sort=newest** (HTTP 200, total 80)

| Rank | Title | publishedAt | Score |
|---:|---|---|---:|
| 1 | AI News & Artificial Intelligence \| TechCrunch | 2026-09-17 | 148.322 |
| 2 | The Stack Overflow Podcast - Stack Overflow | 2026-09-17 | 29.063 |
| 3 | The Stack Overflow Blog - Stack Overflow | 2026-09-17 | 47.834 |
| 4 | The latest on GitHub Copilot - The GitHub Blog | 2026-09-16 | 64.451 |
| 5 | The latest on Generative AI - The GitHub Blog | 2026-09-16 | 64.451 |

**sort=oldest** (HTTP 200, total 80)

| Rank | Title | publishedAt | Score |
|---:|---|---|---:|
| 1 | Ethics of Artificial Intelligence and Robotics (Stanford Encyclopedia of Philosophy/Fall 2023 Edition) | (none) | 27.801 |
| 2 | Asthma | (none) | 28.598 |
| 3 | Statistics - Wikipedia | 2001-02-22 | 21.637 |
| 4 | Web crawler - Wikipedia | 2001-04-27 | 18.961 |
| 5 | Eukaryote - Wikipedia | 2001-06-25 | 24.815 |

### cricket

**sort=relevance** (HTTP 200, total 52)

| Rank | Title | publishedAt | Score |
|---:|---|---|---:|
| 1 | Cricket - Wikipedia | 2002-02-25 | 250.243 |
| 2 | Cricket ball - Wikipedia | 2004-02-12 | 226.538 |
| 3 | Cricket bat - Wikipedia | 2004-02-12 | 220.313 |
| 4 | Cricket (insect) - Wikipedia | 2002-02-21 | 219.215 |
| 5 | Substitute (cricket) - Wikipedia | 2005-08-07 | 212.183 |

**sort=newest** (HTTP 200, total 52)

| Rank | Title | publishedAt | Score |
|---:|---|---|---:|
| 1 | The Overflow - Stack Overflow | 2026-09-10 | 6.04 |
| 2 | COVID-19 pandemic - Wikipedia | 2020-01-05 | 4.039 |
| 3 | List of ball games - Wikipedia | 2011-05-10 | 11.062 |
| 4 | Scriptment - Wikipedia | 2007-03-30 | 1.413 |
| 5 | Bat-and-ball games - Wikipedia | 2007-01-27 | 30.757 |

**sort=oldest** (HTTP 200, total 52)

| Rank | Title | publishedAt | Score |
|---:|---|---|---:|
| 1 | Emmy's Picks Bookshelf \| Project Gutenberg | (none) | 5.761 |
| 2 | Statistics - Wikipedia | 2001-02-22 | 4.38 |
| 3 | South Asia - Wikipedia | 2001-03-23 | 7.142 |
| 4 | Lusaka - Wikipedia | 2001-04-10 | 1.223 |
| 5 | Melbourne Cricket Ground - Wikipedia | 2001-08-23 | 181.593 |

### Sorting observations

- `sort=newest` and `sort=oldest` returned HTTP 200 and the same totals as relevance.
- Scores under date sorts differ from relevance scores for the same page (e.g. *AI News & Artificial Intelligence | TechCrunch* 163.154 relevance vs 148.322 newest), consistent with the freshness multiplier being dropped for date sorts.
- `sort=oldest` places documents with no `publishedAt` first (*Ethics of Artificial Intelligence and Robotics …*, *Asthma*, *Emmy's Picks Bookshelf …*), then the oldest dates (2001-…).
- `sort=newest` for `cricket`: #1 *The Overflow - Stack Overflow* (2026-09-10, score 6.04), #2 *COVID-19 pandemic - Wikipedia* (2020-01-05, 4.04); *Cricket - Wikipedia* is not in the first 5.

## Snippet Results

Checks per result: **terms** = snippet contains every query term (case-insensitive; stop words "of" ignored); **opening** = snippet begins with the first 60 characters of the stored page content (i.e. it is the page start, from `no_match_size`); **desc** = snippet equals the meta description; **HTML** = snippet contains any `<…>` tag.

### photosynthesis

| Rank | Title | terms | opening | desc | HTML | Snippet (verbatim) |
|---:|---|:---:|:---:|:---:|:---:|---|
| 1 | Photosynthesis - Wikipedia | yes | no | no | no | This oxygenic photosynthesis is by far the most common type of photosynthesis used by living organisms. … chemistry of photosynthesis. … The term photosynthesis usually refe |
| 2 | Protist - Wikipedia | yes | no | no | no | combine photosynthesis with phagocytosis. … Some associations are permanent, others more transient.[120] Many protists maintain cyanobacteria or other algae as endosymbionts, to benefit from their photosynthesis—especially in |
| 3 | Metabolism - Wikipedia | yes | no | no | no | , Carbon fixation, and Chemosynthesis Plant cells (bounded by purple walls) filled with chloroplasts (green), which are the site of photosynthesis Photosynthesis is the synthesis of … fixation and CAM photosynthesis. |
| 4 | Ecosystem - Wikipedia | yes | no | no | no | This mainly occurs through photosynthesis. … These are phototrophs, which carry out photosynthesis. |
| 5 | History of Earth - Wikipedia | yes | no | no | no | on photosynthesis. … The most common form, oxygenic photosynthesis, turns carbon dioxide, water, and sunlight into food. |
| 6 | Coral reef - Wikipedia | yes | no | no | no | The light is sufficient for photosynthesis by the symbiotic zooxanthellae, and agitated water brings plankton to feed the coral. … They need sunlight for photosynthesis, which powers carbon fixation, so they are found only relatively near the surface, but they also need nutrients. |
| 7 | Food - Wikipedia | yes | no | no | no | They obtain their energy from photosynthesis or by breaking down dead organisms, waste or chemical compounds. … "Artificial photosynthesis – from sunlight to fuels and valuable products for a sustainable future". |
| 8 | Nutrition - Wikipedia | yes | no | no | no | Large-breed puppies are susceptible to overnutrition, as small-breed dog food is more energy dense than they can absorb.[50] Plant[edit] Main article: Plant nutrition Schematic of photosynthesis … Green plants absorb energy from sunlight with chloroplasts and convert it to usable energy through phot… |
| 9 | Glossary of biology - Wikipedia | yes | no | no | no | An organism capable of producing complex organic compounds from simple substances present in its surroundings, generally by using energy from sunlight (as in photosynthesis) or from … of highly specialized organelle in the cells of plants and algae, the main role of which is to conduct photosynthesi… |
| 10 | Fungus - Wikipedia | yes | no | no | no | A fungus does not perform photosynthesis. Growth is their means of motility, except for spores (a few of which are flagellated), which may travel through the air or water. … Over 90% of plants are dependent on Mycorrhizal symbiosis between plants and fungi[9] and this process also enhances photosynt… |

### machine learning

| Rank | Title | terms | opening | desc | HTML | Snippet (verbatim) |
|---:|---|:---:|:---:|:---:|:---:|---|
| 1 | Machine learning - Wikipedia | yes | no | no | no | ICML ICLR IJCAI ML JMLR Related articles Glossary of artificial intelligence List of datasets for machine-learning research List of datasets in computer vision and image processing … Their main success came in the mid-1980s with the reinvention of backpropagation.[27]: 25 Machine learning (ML), reor… |
| 2 | The latest on machine learning - The GitHub Blog | yes | yes | no | no | Skip to content / Blog Changelog Docs Customer stories Try GitHub Copilot app Attend GitHub Universe AI & ML AI & MLLearn about artificial intelligence and machine learning across the … / Machine learning Machine learning Resources and guides for developers focused on building, training, and deployi… |
| 3 | The latest on AI & ML - The GitHub Blog | yes | yes | no | no | Skip to content / Blog Changelog Docs Customer stories Try GitHub Copilot app Attend GitHub Universe AI & ML AI & MLLearn about artificial intelligence and machine learning across the … Machine learningMachine learning tips, tricks, and best practices. … GitHub engineers and industry thought leaders… |
| 4 | AI News & Artificial Intelligence \| TechCrunch | yes | no | no | no | TechCrunch Staff Events Startup Battlefield StrictlyVC Newsletters Podcasts Videos Partner Content TechCrunch Brand Studio Contact Us AI News coverage on artificial intelligence and machine … learning tech, the companies building them, and the ethical issues AI raises today. … Read the latest on art… |
| 5 | Theoretical computer science - Wikipedia | yes | no | no | no | Machine learning[edit] Main article: Machine learning Machine learning is a scientific discipline that deals with the construction and study of algorithms that can learn from data.[ … Machine Learning. 30: 271–274. doi:10.1023/A:1007411609915. 1 2 C. M. Bishop (2006). Pattern Recognition and Machine… |
| 6 | Type safety - Wikipedia | no | no | no | no | Standard ML[edit] Wikibooks has a book on the topic of: Standard ML Programming Standard ML has rigorously defined semantics and is known to be type-safe. … Another example is the SML/NJ interactive toplevel itself, which must use unsafe operations to execute ML code entered by the user. |
| 7 | Home - The GitHub Blog | yes | yes | no | no | Skip to content / Blog Changelog Docs Customer stories Try GitHub Copilot app Attend GitHub Universe AI & ML AI & MLLearn about artificial intelligence and machine learning across the … Machine learningMachine learning tips, tricks, and best practices. |
| 8 | The latest on Generative AI - The GitHub Blog | yes | yes | no | no | Skip to content / Blog Changelog Docs Customer stories Try GitHub Copilot app Attend GitHub Universe AI & ML AI & MLLearn about artificial intelligence and machine learning across the … Machine learningMachine learning tips, tricks, and best practices. |
| 9 | The latest on GitHub Copilot - The GitHub Blog | yes | yes | no | no | Skip to content / Blog Changelog Docs Customer stories Try GitHub Copilot app Attend GitHub Universe AI & ML AI & MLLearn about artificial intelligence and machine learning across the … Machine learningMachine learning tips, tricks, and best practices. |
| 10 | Learning - Wikipedia | yes | no | no | no | Machine learning[edit] Main article: Machine learning Robots can learn to cooperate. … -03-13 at the Wayback Machine, Augmented Learning: Contex … , and some machines. |

### history of India

| Rank | Title | terms | opening | desc | HTML | Snippet (verbatim) |
|---:|---|:---:|:---:|:---:|:---:|---|
| 1 | Cinema of India - Wikipedia | yes | no | no | no | Society Indians Folklore History Cultural Languages Holidays Religion Arts and literature Art Architecture Cinema Comics Dance Education Festivals Literature Poetry Music Painting … account for 12% of the industry's revenue.[38] History[edit] Main article: History of cinema of India The history of c… |
| 2 | Gateway of India - Wikipedia | yes | no | no | no | History and significance[edit] The Gateway, in 1924Departure of the last British troops from the Gateway, in 1948 The Gateway of India was built to commemorate the arrival of King George … History of Technology in India. Indian National Science Academy. Ajoy Kumar Sen (1991). Tourism in India. Moder… |
| 3 | Outline of history - Wikipedia | yes | no | no | no | [edit] Further information: Human history Regional history Ancient Egypt Babylonia India Classics Ancient Greece Ancient Rome Ancient China Mesoamerica History by continent and country … of AsiaSovereign states Afghanistan Armenia Azerbaijan Bahrain Bangladesh Bhutan Brunei Cambodia China Cyprus Egy… |
| 4 | History of cartography - Wikipedia | yes | no | no | no | Maps were produced extensively by ancient Babylon, Greece, Rome, China, and India.History of geography Graeco-Roman Chinese Islamic Age of Discovery History of cartography Historical … .[71]: 330 Mughal era[edit] Maps from the Ain-e-Akbari, a Mughal document detailing India's history and traditions,… |
| 5 | History of geography - Wikipedia | no | no | no | no | geography vte The history of geography includes many histories of geography which have differed over time and between different cultural and political groups. … A similar work, and one that mostly survives today, is Herodotus' Histories. … The history of geography includes many histories of geograph… |
| 6 | Glossary of history - Wikipedia | yes | no | no | no | with the emergence of colonialism and imperialism as practiced by European monarchies, particularly the colonization of the Americas and the establishment of oceanic trade routes to India … Buranji Written chronicles of Ahoms, a medieval kingdom of Assam, India. … period of human history. |
| 7 | History of biology - Wikipedia | no | no | no | no | in Contents move to sidebar hide (Top) 1 Prehistoric times 2 Earliest roots Toggle Earliest roots subsection 2.1 Ancient Egypt 2.2 Mesopotamia 3 Separate developments in China and India … The ancient Mesopotamians also practiced prophylaxis and took measures to prevent the spread of disease.[4] Sepa… |
| 8 | History of Earth - Wikipedia | no | no | no | no | of Earth, see Geological history of Earth. … For more detail of the biological history of Earth, see History of life. For the history of humanity, see Human history. Earth's history with time-spans of the eons to scale. … The natural history of Earth concerns the development of planet Earth from its… |
| 9 | Index of history articles - Wikipedia | yes | no | no | no | Greece Ancient history Ancient India Ancient Japan Ancient Korea Ancient Rome Ancient warfare Andorra, History of Angola, History of Anguilla, History of Antigua and Barbuda, History … history Socialism, History of Source, Primary Source, Secondary South Africa, History of South America, History of… |
| 10 | History of computer science - Wikipedia | yes | no | no | no | Abaci of a more modern design are still used as calculation tools today, such as the Chinese abacus.[5] In the 5th century BC in ancient India, the grammarian Pāṇini formulated the … Kak, Subhash : Computing Science in Ancient India; Munshiram Manoharlal Publishers Pvt. … The history of computer sci… |

### Duplicate-title detail (mathematics pages 1–3)

| Page | Rank | Title | URL | contentHash (first 12) | wordCount |
|---:|---:|---|---|---|---:|
| 1 | 10 | Mathematical object - Wikipedia | https://en.wikipedia.org/wiki/Mathematical_objects | a7df67216a5b | 3478 |
| 2 | 1 | Mathematical object - Wikipedia | https://en.wikipedia.org/wiki/Mathematical_object | fba2929b3826 | 3474 |
| 2 | 5 | Axiom - Wikipedia | https://en.wikipedia.org/wiki/Axiom | b7330486dcb4 | 5930 |
| 2 | 6 | Axiom - Wikipedia | https://en.wikipedia.org/wiki/Axioms | 3378abb31b70 | 5933 |

### Snippet observations

- **HTML/highlighting:** none of the 30 snippets contains HTML or `<mark>` tags; highlight markers are stripped before the response.
- **Query terms present:** photosynthesis 10/10; machine learning 9/10 (#6 *Type safety* contains "ML" but not "machine learning"; it matched through the `ml, machine learning` synonym); history of India 7/10 contain both "history" and "india" (#5, #7, #8 do not contain "india").
- **Page opening:** 5 of the 10 `machine learning` snippets (#2, #3, #7, #8, #9, all github.blog) start at the first characters of the stored page content, which is site navigation text: "Skip to content / Blog Changelog Docs Customer stories …". They do contain the query terms. No photosynthesis or history-of-India snippet starts at the page opening.
- **Meta description:** 0 of 30 snippets equal the page's meta description (every page has one, `hasDescription` = true for all 859).
- **Title-only matches:** none of these 30 results was a title-only match (each snippet contains a content fragment), so this case was not observed in this sample.
- **Fragments:** snippets are two or three highlight fragments joined with " … " and truncated at 300 characters, ending mid-word with "…" in several cases (e.g. *Photosynthesis*: "…usually refe").

## Fuzzy Search Results

The `must` recall clause is `bool.should[exact multi_match, fuzzy multi_match]` whenever `allowFuzzy` is true. The table counts how many documents each part admits on its own (same filters as live), measured with the project's own `buildMustClause` / `buildFuzzyClause`.

| Query | allowFuzzy | Live total | Exact clause alone | Fuzzy clause alone | Admitted only by fuzzy |
|---|:---:|---:|---:|---:|---:|
| mathematics | yes | 251 | 249 | 251 | 2 |
| cricket | yes | 52 | 35 | 52 | 17 |
| photosynthesis | yes | 42 | 41 | 42 | 1 |
| machine learning | yes | 80 | 80 | 80 | 0 |
| python programming | yes | 429 | 37 | 429 | 392 |
| history of India | yes | 762 | 277 | 762 | 485 |
| what is photosynthesis | yes | 804 | 41 | 804 | 763 |
| **pyhton programming** | yes | **431** | **0** | 431 | 431 |
| **machne learning** | yes | **632** | **0** | 632 | 632 |

**pyhton programming** — results returned: yes (HTTP 200, 431 total). #1 is *Python (programming language) - Wikipedia* (62.40, versus 761.35 for the correctly spelled query). #2–#9 are programming-paradigm/language pages (*Procedural programming*, *Programming paradigm*, *Functional programming*, …); #10 is *Voyager program - Wikipedia* (16.37). The correctly spelled `python programming` returns 429 — 2 fewer than the misspelling.

**machne learning** — results returned: yes (632 total, versus 80 for `machine learning`). #1 *Machine learning - Wikipedia* (75.63), #3 *The latest on machine learning - The GitHub Blog*. Other top-10 entries: *Learning - Wikipedia*, *Student-centered learning*, *Nonformal learning*, two MDN "learn" pages, *Theoretical computer science*, *Machu Picchu - Wikipedia* (#8, 13.80), *Physical education - Wikipedia* (#10).

**cricket** — pages 2–3 (ranks 11–30) include *Sam Mendes*, *Herefordshire*, *Kirsty Coventry*, *Casting (performing arts)*, *Developmental biology*, *Emmy's Picks Bookshelf | Project Gutenberg*. 17 of the 52 results are admitted only by the fuzzy clause. For reference, 18 indexed documents contain the word "cricketer"; which fuzzy term expansions admitted the 17 was not broken down.

## Exact Phrase Results

| | `machine learning` | `"machine learning"` |
|---|---:|---:|
| Total results | 80 | 46 |
| Latency (API) | 195 ms cold / 119 ms warm | 126 ms |
| #1 score | 843.895 | 3383.712 |
| #2 score | 698.688 | 2289.1 |

| Rank | Unquoted title (score) | Quoted title (score) |
|---:|---|---|
| 1 | Machine learning - Wikipedia (843.895) | Machine learning - Wikipedia (3383.712) |
| 2 | The latest on machine learning - The GitHub Blog (698.688) | The latest on machine learning - The GitHub Blog (2289.1) |
| 3 | The latest on AI & ML - The GitHub Blog (185.423) | AI News & Artificial Intelligence \| TechCrunch (1578.192) |
| 4 | AI News & Artificial Intelligence \| TechCrunch (163.154) | Theoretical computer science - Wikipedia (1269.755) |
| 5 | Theoretical computer science - Wikipedia (152.057) | Learning - Wikipedia (297.843) |
| 6 | Type safety - Wikipedia (131.925) | The latest on AI & ML - The GitHub Blog (212.82) |
| 7 | Home - The GitHub Blog (75.933) | Production Engineering Archives - Engineering at Meta (173.575) |
| 8 | The latest on Generative AI - The GitHub Blog (70.896) | Home - The GitHub Blog (172.225) |
| 9 | The latest on GitHub Copilot - The GitHub Blog (70.896) | The latest on Generative AI - The GitHub Blog (171.113) |
| 10 | Learning - Wikipedia (69.331) | The latest on GitHub Copilot - The GitHub Blog (170.149) |

- 9 of 10 titles are shared. *Type safety* (unquoted #6, matched via "ML") is not in the quoted top 10; *Production Engineering Archives - Engineering at Meta* appears only in the quoted top 10.
- The quoted query's scores are about 4× higher (quoted-phrase clause boost 25 over the `.exact` fields); the #1/#2 order is identical.
- The unquoted query's total (80) is not inflated by the fuzzy clause (0 fuzzy-only documents), unlike the other multi-word queries. The `ml, machine learning` synonym rule is the likely reason (a multi-word synonym turns the analysed query into a graph/phrase query), but this was not verified.

## Title Relevance Observations

Evidence from the tables above ("title has query terms" is a case-insensitive substring check on every non-stop-word query term).

- **mathematics:** ranks 1–9 have "mathematics" in the title (scores 240.75 → 194.49); #10 *Mathematical object* does not (72.99). Explain shows the title pages receive `titleExactTerms` 87–99 and `urlPath` 28–32 on top of the `must` clause.
- **cricket:** ranks 1–9 have "cricket" in the title (250.24 → 161.99); #10 *Boxing Day Test* does not (35.28).
- **photosynthesis:** only #1 *Photosynthesis - Wikipedia* has the term in its title (338.37). #2–#10 are body-only matches scoring 9.48–11.92. The index holds 41 documents containing "photosynthesis".
- **physics:** #5 *Information - Wikipedia* (38.85, no "physics" in title) ranks above #6 *Geophysics* (36.60) and #10 *Biophysics* (25.61), whose titles contain "physics" only inside a longer word.
- **python programming:** only #1 has both terms in the title; #2–#10 contain "programming" only.
- **history of India:** no top-10 title contains both "history" and "india". #1 *Cinema of India* and #2 *Gateway of India* contain "india"; #3–#10 contain "history". No indexed title contains both words; *India - Wikipedia* ranks #11 (117.65).
- **artificial intelligence:** #1 is *AI News & Artificial Intelligence | TechCrunch* (876.08), #2 *Artificial intelligence - Wikipedia* (844.87).
- **what is photosynthesis:** *Photosynthesis - Wikipedia* ranks #1 but scores 90.17 (vs 338.37 for `photosynthesis`); explain shows its `titleExactTerms` clause did not fire, because `minimum_should_match` "2<70%" on 3 terms requires 2 of "what / is / photosynthesis" in the unstemmed title.
- **how does gravity work:** no top-10 title contains "gravity"; #1 is *Improve how you use GitHub at work - The GitHub Blog* (246.99). 61 indexed documents contain "gravity".
- **Clause firing across all 100 explained hits** (top 10 × 10 queries): exact whole-title `title.raw` (boost 60) **0**; `titleExactTerms` 35; `phraseTitle` 5; `phraseHeadings` 2; `phraseDescription` 7; `phraseContent` 28; `urlPath` 59. Every top-ranked title observed carries a site suffix (" - Wikipedia", " - The GitHub Blog", " | TechCrunch"). 522 of 859 documents have empty `headings`.

## Current Search Coverage

| Query | Total results | Distinct domains in top 10 | Top-10 domains (count) |
|---|---:|---:|---|
| mathematics | 251 | 1 | en.wikipedia.org (10) |
| cricket | 52 | 1 | en.wikipedia.org (10) |
| photosynthesis | 42 | 1 | en.wikipedia.org (10) |
| machine learning | 80 | 3 | github.blog (5), en.wikipedia.org (4), techcrunch.com (1) |
| python programming | 429 | 1 | en.wikipedia.org (10) |
| history of India | 762 | 1 | en.wikipedia.org (10) |

## Baseline Findings

### Confirmed observations

1. The live stack's OpenSearch has **no `ph-google-pages` index**; the crawled 859-document index is in the volume `ph-google-frontend_opensearch-data`, not the volume the running `ph-google` compose project mounts. The live API therefore returns 0 results for every query.
2. Corpus: 859 documents from 27 domains; 634 (74%) are wikipedia.org. In the top 10 of five of the six core queries, all 10 results are `en.wikipedia.org`.
3. All 35 search requests returned HTTP 200. Server `responseTimeMs` ranged 44–509 ms; the 509 ms value was the first query after the copy cluster started; warm core-query latency was 115–198 ms.
4. For every tested query with a word of ≥4 characters, fuzzy matching was enabled. For multi-word queries other than `machine learning`, the fuzzy clause alone determines the admitted set: `python programming` 429 results vs 37 from the exact clause; `history of India` 762 vs 277; `what is photosynthesis` 804 vs 41.
5. Misspelled queries return large result sets with **zero** exact matches: `pyhton programming` 431, `machne learning` 632 (vs 80 for the correct spelling). The intended page ranked #1 in both.
6. Single-term queries (`mathematics`, `cricket`, `physics`, `football`, `geography`, `photosynthesis`) placed a page titled with the term at #1. Pages with the term in the title held ranks 1–9 for `mathematics` and `cricket`, and ranks 1–10 for `football` and `geography`.
7. Score gaps are large between title-matched and body-only results: `photosynthesis` #1 338.37 vs #2 11.92; `python programming` #1 761.35 vs #2 74.24.
8. The exact whole-title clause (`title.raw`, boost 60) fired in 0 of 100 explained hits. `titleExactTerms` fired in 35 and `urlPath` in 59.
9. Quality multipliers across the 100 explained hits were 1.155–1.215 (qualityScore ≈ 0.81–0.93); freshness multipliers (1.05 or 1.1) appeared only on github.blog, techcrunch.com, developer.mozilla.org and engineering.fb.com pages. 38 of 859 documents are within the 90-day freshness window.
10. Quoted `"machine learning"` returned 46 results vs 80 unquoted; top 2 identical; 9 of 10 top titles shared; scores ~4× higher.
11. Natural-language queries returned 804–811 results each. For `how does gravity work`, no top-10 title contains "gravity" (61 documents mention it); #1 was *Improve how you use GitHub at work*.
12. `site:wikipedia.org mathematics` is not parsed as a site query (it contains a space); it returned the same total (251) as `mathematics`, with lower scores (#1 68.90 vs 240.75).
13. Snippets contain no HTML; `<mark>` markers are removed. 5 of 10 `machine learning` snippets begin with site navigation text; 0 of 30 sampled snippets used the meta description.
14. No cross-page URL duplication occurred in pagination tests (`duplicatesRemoved` = 0 throughout). Two near-duplicate page pairs with identical titles and different URLs/hashes appeared within `mathematics` pages 1–2.
15. `sort=oldest` lists documents without `publishedAt` first.
16. 522 of 859 documents have empty `headings`; the headings phrase clause fired in 2 of 100 explained hits.

### Potential problems (need later validation)

1. The fuzzy clause in `must` appears to widen recall to OR-style matching: result totals for multi-word and misspelled queries include hundreds of documents that the exact clause does not admit (e.g. *Machu Picchu*, *Physical education* for `machne learning`; *Voyager program* for `pyhton programming`; *Sam Mendes*, *Herefordshire* on `cricket` pages 2–3). Whether these affect users beyond page 1 needs a judged evaluation.
2. `history of India`: no page in the corpus has both words in its title, and the top 10 are either "…of India" or "History of …" pages; *India - Wikipedia* is #11. Whether this is a ranking or a corpus-coverage issue is not yet separated.
3. Natural-language queries: question words ("how", "does", "work", "what") are scored as content terms (e.g. `how does gravity work` → *Improve how you use GitHub at work* #1). `isQuestion` is computed but unused (Step 1).
4. Titles with a site suffix never trigger the exact-title clause, so the strongest title signal is currently unused for the observed corpus.
5. Near-duplicate Wikipedia redirect URLs (`Axiom`/`Axioms`, `Mathematical_object`/`Mathematical_objects`) appear as separate results.
6. Empty `headings` for 61% of documents may reflect the reindex path dropping headings (Step 1 finding); not confirmed which documents came through which path.
7. Navigation boilerplate at the start of some pages (github.blog) is being returned as snippet text.
8. The live compose stack and the crawled index are out of sync (different volumes); any Step 3 measurement against the live API will show 0 results until that is resolved.

## Final Summary

### Baseline Summary

Latency = server `responseTimeMs` of the first request for that query (core queries: cold run).

| Query | Total Results | Latency | #1 Result | #1 Domain |
|---|---:|---:|---|---|
| mathematics | 251 | 509 ms (warm 198) | Mathematics - Wikipedia | en.wikipedia.org |
| cricket | 52 | 219 ms (warm 131) | Cricket - Wikipedia | en.wikipedia.org |
| photosynthesis | 42 | 177 ms (warm 115) | Photosynthesis - Wikipedia | en.wikipedia.org |
| machine learning | 80 | 195 ms (warm 119) | Machine learning - Wikipedia | en.wikipedia.org |
| python programming | 429 | 190 ms (warm 137) | Python (programming language) - Wikipedia | en.wikipedia.org |
| history of India | 762 | 213 ms (warm 191) | Cinema of India - Wikipedia | en.wikipedia.org |
| physics | 412 | 159 ms | Physics - Wikipedia | en.wikipedia.org |
| football | 58 | 110 ms | Blind football - Wikipedia | en.wikipedia.org |
| geography | 267 | 185 ms | Geography - Wikipedia | en.wikipedia.org |
| computer science | 550 | 171 ms | Computer science - Wikipedia | en.wikipedia.org |
| climate change | 685 | 184 ms | Climate change - Wikipedia | en.wikipedia.org |
| artificial intelligence | 156 | 102 ms | AI News & Artificial Intelligence \| TechCrunch | techcrunch.com |
| what is photosynthesis | 804 | 124 ms | Photosynthesis - Wikipedia | en.wikipedia.org |
| how does machine learning work | 811 | 192 ms | The latest on machine learning - The GitHub Blog | github.blog |
| how does gravity work | 811 | 140 ms | Improve how you use GitHub at work - The GitHub Blog | github.blog |
| "machine learning" | 46 | 126 ms | Machine learning - Wikipedia | en.wikipedia.org |
| pyhton programming | 431 | 154 ms | Python (programming language) - Wikipedia | en.wikipedia.org |
| site:wikipedia.org mathematics | 251 | 166 ms | Mathematics - Wikipedia | en.wikipedia.org |
| cricket (ambiguous, #19) | 52 | (same as #2) | Cricket - Wikipedia | en.wikipedia.org |
| machne learning (extra typo) | 632 | 173 ms | Machine learning - Wikipedia | en.wikipedia.org |

### Important Observations

- The live stack is not serving the crawled index (volume mismatch); this baseline was measured on an exact copy of it.
- Fuzzy matching is active for every tested query and, for most multi-word queries, admits far more documents than the exact clause (e.g. 429 vs 37, 762 vs 277, 804 vs 41; 431 and 632 with zero exact matches).
- Single-term queries place the matching-title page at #1 with a large score margin; the exact whole-title clause never fired.
- Natural-language queries return 804–811 results and rank pages matching the question words ("how", "work").
- Five of six core queries show a single domain (en.wikipedia.org) across the top 10; 74% of the corpus is Wikipedia.
- No pagination overlap occurred; two near-duplicate Wikipedia pairs appeared as separate results.
- Snippets are query-aware fragments with markup removed; some start with site navigation text.

### Step 3 Readiness

This baseline gives Step 3:

- **A fixed, repeatable query set** (19 queries + 1 extra typo) with totals, top-10 titles, URLs, domains and scores to diff against after any change.
- **Per-clause score breakdowns** (explain) for the core queries, showing which signals currently decide rank (`must` BM25, `titleExactTerms`, `urlPath`, phrase clauses, quality ×1.155–1.215, freshness rarely), so the effect of a weight or clause change can be attributed.
- **Recall measurements** (exact vs fuzzy admitted counts) that quantify the fuzzy behaviour before any change.
- **Pagination, sorting and snippet reference outputs** for regression checks.
- **An environment prerequisite:** the live stack needs to be pointed at the volume that holds the crawled index (or the index rebuilt) before live-API measurements can be compared; until then, comparisons should use the same copy-based setup described in *Environment*.

Step 2 baseline measurement complete. No ranking/search implementation was modified.
