# AI answers

An answer shown above the web results, written by a language model **from the documents the search engine retrieved for the query**, with the sources it cites. This is retrieval-augmented generation (RAG): the model is given the evidence and told to use only that.

The web results underneath are unchanged. If the answer cannot be produced for any reason, the page shows a one-line note and the results as usual.

## How a request flows

```
browser ── GET /api/search ─────────────► results (as before)
        └─ GET /api/ai-answer ──────────► answer + sources      (after results are on screen)

GET /api/ai-answer
  1. validate        controllers/aiAnswerController.js   same validators as /api/search
  2. intent          services/ai/intentService.js        definition, how-to, comparison, …
  3. retrieve        services/ai/retrievalService.js     the existing search, then page text
  4. build context   services/ai/contextService.js       clean, de-duplicate, number, trim
  5. prompt          services/ai/promptBuilder.js        instructions | sources | query, kept apart
  6. generate        services/ai/llm/                    the configured provider
  7. map citations   services/ai/citationService.js      numbers → the retrieved documents
  8. respond         services/ai/aiAnswerService.js      orchestration, cache, logging
```

**Retrieval reuses the search engine.** Candidates come from `searchDispatcher.webSearch` — the same call that fills the results page — so the answer is built from the same parsed, ranked, de-duplicated documents the user sees listed. A search result carries only a snippet, so the text of the chosen documents is then read from the OpenSearch index (`content`, `description`), or from the `Page` collection on the legacy engine. Nothing is stored a second time.

Candidates scoring below `AI_MIN_RELATIVE_SCORE` of the best match are dropped: a weak match is noise, not evidence.

**Index results only.** Retrieval calls `webSearch(…, { includeExternal: false })`, so the external Google results that can appear on the results page (see [SERPAPI.md](SERPAPI.md)) are never used as evidence and never cost a SerpApi search: they carry a snippet, not the page text an answer is written from.

**The context builder** removes page furniture (cookie banners, navigation, legal footers, repeated lines), picks the passages that talk about the query, removes duplicate pages (same address in another spelling, or the same text at another address), and trims to the per-source and total character budgets.

**The model is only called when there is evidence.** No search results, or nothing usable in them, ends the request before any model call.

## API

### `GET /api/ai-answer`

| Parameter  | Required | Meaning                                                             |
| ---------- | -------- | ------------------------------------------------------------------- |
| `q`        | yes      | The query. Same length limit as search (`SEARCH_MAX_QUERY_LENGTH`). |
| `domain`   | no       | Restrict to one site, as in search.                                 |
| `language` | no       | Language code, as in search.                                        |
| `date`     | no       | `any`, `hour`, `day`, `week`, `month`, `year`.                      |
| `sources`  | no       | Use at most this many sources (never more than `AI_MAX_SOURCES`).   |
| `refresh`  | no       | `true` to bypass the cache ("Regenerate").                          |

Works for guests, like search. Rate limited separately (`RATE_LIMIT_AI_*`).

A valid request always returns **200** in the usual envelope; `status` says what happened:

```json
{
  "success": true,
  "data": {
    "answerId": "3f2b8c1e-9d4a-4b7e-8a11-5c6d7e8f9a0b",
    "query": "What is OpenSearch?",
    "intent": "definition",
    "status": "ok",
    "generated": true,
    "answer": "OpenSearch is an open-source search and analytics suite [1]. It began as a fork of Elasticsearch [2].",
    "summary": "OpenSearch is an open-source search and analytics suite.",
    "keyPoints": ["Distributed full-text search [1]"],
    "sources": [
      {
        "index": 1,
        "title": "About OpenSearch",
        "url": "https://opensearch.org/docs/latest/about",
        "domain": "opensearch.org",
        "snippet": "OpenSearch is an open-source search and analytics suite…",
        "relevanceScore": 12.5,
        "publishedAt": null,
        "crawledAt": "2026-10-05T07:15:00.000Z"
      }
    ],
    "message": null,
    "reason": null,
    "provider": "anthropic",
    "model": "claude-opus-5-5",
    "cached": false,
    "retrieval": { "totalResults": 42, "retrieved": 8, "used": 5 },
    "timings": { "retrievalMs": 35, "generationMs": 2100 },
    "processingTimeMs": 2140
  }
}
```

| `status`                | Meaning                                                                                                                                 | Model called? |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `ok`                    | A grounded answer; `sources` are the documents it cites.                                                                                | yes           |
| `no_results`            | The search found nothing.                                                                                                               | no            |
| `insufficient_evidence` | Nothing usable to answer from, the model said the sources are not enough, or it answered without citing anything (`reason` says which). | sometimes     |
| `not_configured`        | No API key.                                                                                                                             | no            |
| `disabled`              | `AI_ANSWERS_ENABLED=false`.                                                                                                             | no            |
| `unavailable`           | The provider failed. `reason`: `timeout`, `rate_limited`, `auth`, `refused`, `bad_request`, `invalid_response`, `unavailable`.          | yes           |

For every status other than `ok`, `answer` is empty, `sources` is `[]` and `message` is a sentence that can be shown to the user.

Errors use the normal envelope: **400** for a bad request (missing or too-long `q`, bad filter), **429** when rate limited, **503** when the search engine itself is down — exactly as `/api/search`.

### `POST /api/ai-answer/feedback`

```json
{
  "answerId": "3f2b8c1e-…",
  "query": "What is OpenSearch?",
  "rating": "up",
  "model": "claude-opus-5-5",
  "provider": "anthropic"
}
```

`rating` is `up` or `down`. Returns **201**. Stored in the `aianswerfeedbacks` collection with the signed-in user if there is one; sending it again for the same answer changes the rating. No IP address or user agent is stored, and the answer text is not stored.

## How citations work

The model never produces a link or a title. It is given sources numbered `1..n` and writes `[n]` after each claim. `citationService` then:

1. looks each number up in the evidence set the backend built — a number that is not in it is deleted;
2. deletes any web address the model wrote anyway;
3. renumbers the cited sources `1..k` in the order the answer first cites them, and rewrites the markers to match;
4. returns only the cited sources, each with the title and URL **from the search index**.

So a citation can only ever point at a page the search engine returned, and only `http`/`https` addresses are accepted. An answer that ends up with no valid citation is not shown (`insufficient_evidence`, reason `uncited_answer`). The frontend renders citations and sources from this data and re-checks every URL before linking it.

## Hallucination and prompt-injection controls

- The system prompt tells the model to use only the sources, to cite every claim, not to write URLs, and to set `sufficient_evidence: false` rather than guess.
- The reply is constrained to a JSON schema (`sufficient_evidence`, `answer`, `key_points`, `cited_sources`).
- Retrieved pages are **untrusted**. Instructions live only in the system prompt; the query sits in `<user_query>`; each page sits in its own `<source index="n">` block. Angle brackets in page text, titles and the query are replaced with look-alike characters, so a page cannot close its block or open one that looks like an instruction. The system prompt says that text inside sources is material to read, never instructions to follow.
- The evidence text, the prompt, token counts and the API key never leave the server.

## Configuration

Set these in `ph-google-backend/.env`. Only the key is needed to switch the feature on.

| Variable                                        | Default           | Purpose                                                                                                      |
| ----------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `AI_API_KEY`                                    | —                 | **The one required setting.** Provider API key. `ANTHROPIC_API_KEY` is read as a fallback. Server-side only. |
| `AI_ANSWERS_ENABLED`                            | `true`            | `false` turns the feature off.                                                                               |
| `AI_PROVIDER`                                   | `anthropic`       | Which provider in `services/ai/llm/`.                                                                        |
| `AI_MODEL`                                      | `claude-opus-5-5` | Model id.                                                                                                    |
| `AI_EFFORT`                                     | `low`             | `low` … `max`. Empty for a model that does not accept it.                                                    |
| `AI_MAX_OUTPUT_TOKENS`                          | `8000`            | Ceiling on one response, reasoning included.                                                                 |
| `AI_TIMEOUT_MS`                                 | `30000`           | Wait for the model before reporting `unavailable`.                                                           |
| `AI_REFUSAL_FALLBACK`                           | `true`            | Re-run a declined request on the provider's recommended fallback model.                                      |
| `AI_BASE_URL`                                   | —                 | Proxy or gateway in front of the provider.                                                                   |
| `AI_RETRIEVAL_COUNT`                            | `8`               | Search results fetched as candidates.                                                                        |
| `AI_MAX_SOURCES`                                | `5`               | Sources given to the model.                                                                                  |
| `AI_MIN_RELATIVE_SCORE`                         | `0.3`             | Candidates below this share of the best score are dropped.                                                   |
| `AI_MAX_CHARS_PER_SOURCE`                       | `1800`            | Evidence per source.                                                                                         |
| `AI_MAX_CONTEXT_CHARS`                          | `8000`            | Evidence in total.                                                                                           |
| `AI_MIN_EVIDENCE_CHARS`                         | `200`             | Less than this and the model is not called.                                                                  |
| `AI_CACHE_TTL_MS`                               | `600000`          | Identical questions reuse the answer for this long. `0` disables.                                            |
| `AI_CACHE_MAX_ENTRIES`                          | `200`             | Answers kept in the cache.                                                                                   |
| `RATE_LIMIT_AI_WINDOW_MS` / `RATE_LIMIT_AI_MAX` | `60000` / `20`    | Requests per client per window.                                                                              |

The cache is in the backend process's memory (not Redis): an answer is cheap to regenerate, and search should not depend on the crawl queue's Redis.

## Running it

```bash
# 1. Put the key in ph-google-backend/.env
AI_API_KEY=sk-ant-...

# 2. Start or recreate the backend so it reads the setting.
#    In Docker (does not touch the crawl worker):
docker compose build backend frontend
docker compose up -d --no-deps --force-recreate backend frontend
#    Or locally:  cd ph-google-backend && npm start      cd ph-google-frontend && npm run dev

# 3. Ask
curl "http://localhost:5000/api/ai-answer?q=What%20is%20OpenSearch%3F"
```

Without a key the endpoint answers `"status": "not_configured"` and the search page shows "AI answers are not configured on this server." above the normal results.

## Testing

```bash
cd ph-google-backend
npx jest tests/unit/aiAnswerRag.test.js tests/unit/aiProvider.test.js   # context, prompt, citations, provider
npx jest tests/integration/aiAnswer.test.js                             # the endpoint over HTTP
npx jest tests/opensearch/aiAnswer.test.js                              # retrieval on a live OpenSearch (skipped without one)

cd ../ph-google-frontend
npm test                                                                # component, page and API-layer tests
```

The tests never call a real model: the provider is a stub in the endpoint tests and the SDK is mocked in the provider tests. Run the OpenSearch suite against a throwaway cluster, never the one holding real data (`OPENSEARCH_NODE=http://127.0.0.1:9210 …`).

## Changing the model or the provider

- **Another model from the same provider:** set `AI_MODEL` (and `AI_EFFORT`, `AI_REFUSAL_FALLBACK` if that model does not support them).
- **Another provider:** add a factory in `services/ai/llm/` that returns

  ```js
  {
    name: 'myprovider',
    model: '<model id>',
    isConfigured: () => Boolean(apiKey),
    // Resolve with the model's reply; throw LlmError (llm/llmError.js) for every failure.
    async generate({ system, user, schema }) {
      return { text, model, stopReason, usage: { inputTokens, outputTokens } };
    }
  }
  ```

  register it in `FACTORIES` in `services/ai/llm/index.js`, and set `AI_PROVIDER=myprovider`. Retrieval, the context builder, the prompt and citation mapping do not change. `text` should be the JSON object described by `ANSWER_SCHEMA`; a provider without structured output can return it inside prose or a code fence and it will still be read.

## Later

The pipeline is split so these can be added without rewriting it: semantic or hybrid retrieval replaces `retrievalService.retrieve` (the context builder only needs ranked documents with text); follow-up questions and answer history hang off `answerId`; source-quality and freshness signals belong in the relevance filter.
