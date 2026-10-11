const { config } = require('../config/env');
const logger = require('../utils/logger');
const { canonicalKey, resultIdentityKey } = require('../utils/urlNormalizer');
const { parseQuery } = require('./opensearch/queryParser');
const { buildSerpApiRequest } = require('./external/serpApiQuery');
const { mapOrganicResults } = require('./external/serpApiMapper');
const serpApiClient = require('./external/serpApiClient');
const { buildBingRequest } = require('./external/bingSearchQuery');
const { mapBingItems } = require('./external/bingSearchMapper');
const bingSearchClient = require('./external/bingSearchClient');
const { buildParallelRequest } = require('./external/parallelQuery');
const { mapResults: mapParallelResults } = require('./external/parallelMapper');
const parallelClient = require('./external/parallelClient');
const { coversQuery, relevantResults } = require('./external/resultRelevance');
const navigational = require('./ranking/navigational');
const { rankResults, countAnswering } = require('./ranking/unifiedRanker');
const queryIntent = require('./ranking/queryIntent');

/**
 * Fewer index results than this that are about the query — enough of its
 * words in their titles (unifiedRanker.countAnswering) — and the index needs
 * help: a page of loose matches is not an answer, however many pages it holds.
 */
const MIN_COVERING_RESULTS = 3;

/**
 * External results for web search.
 *
 * The index answers every search exactly as before. On the first page of a
 * web search, when an external provider is available, its results are added
 * AFTER the index's results:
 *
 *   - the index's results keep their order, their scores and their pages;
 *   - an external result for a page the index already has is dropped (the
 *     index's copy wins), as is one the query's own restrictions exclude;
 *   - nothing external is stored anywhere — it is a query-time source.
 *
 * A provider's order and the index's scores are different systems, so they
 * are never added or compared: the merge is by position. The index's results
 * come first — unless the index has no page that is ABOUT the query (the
 * relevance gate, EXTERNAL_RELEVANCE_GATE), in which case the provider is
 * asked whatever the match count and its results come first, the index's
 * after them. Which results are shown, and every page after the first, are
 * the same either way.
 *
 * Three providers can supply those results: SerpApi (Google), Bing and
 * Parallel (the Parallel Search API). EXTERNAL_SEARCH_PROVIDER (or
 * SEARCH_PROVIDER) names the one asked first; when it cannot answer and
 * SEARCH_PROVIDER_FALLBACK is on, the others are asked in turn — with it
 * off, the chosen provider is used exclusively. Each provider has its own
 * cache entries, daily limit and pause after failures, so one failing never
 * blocks another. An answer that does not cover the query's words
 * (resultRelevance) is treated like a failure: not shown, not cached.
 *
 * This never throws because of a provider. Whatever happens — disabled, no
 * key, a rejected key, a timeout, an outage — the index's results are
 * returned with a short status saying what happened to the external ones.
 * An error that is not a provider failure (a bug in this application) is
 * logged as an error and never triggers the fallback.
 */

const PROVIDER = 'serpapi';

// --- Usage control ------------------------------------------------------
// Process-local by design, like the AI answer cache: external results are
// an enhancement, and search must not come to depend on Redis for them.

const cache = new Map(); // request key -> { at, results }
const inFlight = new Map(); // request key -> Promise
const states = new Map(); // provider -> counters, and the pause that covers all of it
const operationStates = new Map(); // provider + operation -> failures and its own pause

const FAILURES_BEFORE_PAUSE = 3;
const FAILURE_PAUSE_MS = 60 * 1000;
const AUTH_PAUSE_MS = 10 * 60 * 1000;
const RATE_LIMIT_PAUSE_MS = 5 * 60 * 1000;

/**
 * Parallel answers at most this many results to one request. The first page
 * shows PARALLEL_MAX_RESULTS of them as before; asking for the most the API
 * gives costs the same one request and lets "Load more" show the rest of that
 * same answer instead of inventing a second page Parallel has no way to give.
 */
const PARALLEL_RESULTS_PER_REQUEST = 20;

/** The limits and cache lifetime of each provider. */
const LIMITS = {
  serpapi: () => config.serpapi,
  bing: () => config.bing,
  parallel: () => config.parallel
};

/**
 * Providers whose failed requests stay counted against the daily limit.
 * SerpApi and Bing only charge a search that worked, so a failure hands its
 * slot back. How Parallel bills a failure is not documented, so none of its
 * requests is assumed free.
 */
const COUNTS_FAILURES = new Set(['parallel']);

/** How each provider is named in the log. */
const FAILURE_MESSAGES = {
  serpapi: 'SerpApi request failed; showing index results only',
  bing: 'Bing request failed',
  parallel: 'Parallel request failed'
};

function settings() {
  return config.serpapi;
}

function stateOf(provider) {
  if (!states.has(provider)) {
    states.set(provider, {
      active: 0,
      day: '',
      sentToday: 0,
      pausedUntil: 0,
      pausedFor: null
    });
  }
  return states.get(provider);
}

/**
 * One operation of one provider: web, images, videos, maps or trending.
 * Failures are counted here, so a slow Videos engine pauses Videos and
 * leaves web search and Images alone.
 */
function operationStateOf(provider, operation) {
  const key = `${provider}:${operation}`;
  if (!operationStates.has(key)) {
    operationStates.set(key, { consecutiveFailures: 0, pausedUntil: 0, pausedFor: null });
  }
  return operationStates.get(key);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The cache key: the provider and the vertical, then everything sent to the
 * provider except the API key — so "python" on Images never answers
 * "python" on the web, and Bing never answers for Google.
 */
function requestKey(provider, vertical, request) {
  if (provider !== 'serpapi') return JSON.stringify([provider, vertical, request]);
  const s = settings();
  return JSON.stringify([
    vertical,
    request.engine || s.engine,
    s.hl,
    s.gl,
    s.location,
    request.q,
    request.params
  ]);
}

function readCache(key, ttlMs) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry.results;
}

function writeCache(key, results, limits) {
  if (limits.cacheTtlMs <= 0) return;
  if (cache.size >= limits.cacheMaxEntries) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), results });
}

/** The words searched for, for the log. Never the request itself: it has no key, but nor is it needed. */
function queryOf(request) {
  if (!request) return undefined;
  const keywords = Array.isArray(request.searchQueries) ? request.searchQueries[0] : undefined;
  return request.q || request.keyword || keywords || undefined;
}

/**
 * Records a failure and decides what to leave alone, and for how long.
 *
 * A rejected key or a rate limit is about the account, so the whole provider
 * is paused. Anything else — a timeout, an outage, a malformed reply — is
 * counted against the operation that failed, and after a few in a row only
 * that operation is paused.
 *
 * @param {Object} details  operation, query, durationMs — for the log
 */
function recordFailure(provider, error, { operation, query, durationMs }) {
  const operationState = operationStateOf(provider, operation);
  operationState.consecutiveFailures += 1;

  let pause = 0;
  let pauseScope;
  if (error.code === 'auth' || error.code === 'rate_limited') {
    pause = error.code === 'auth' ? AUTH_PAUSE_MS : error.retryAfterMs || RATE_LIMIT_PAUSE_MS;
    pauseScope = 'provider';
    const state = stateOf(provider);
    state.pausedUntil = Date.now() + pause;
    state.pausedFor = error.code;
  } else if (operationState.consecutiveFailures >= FAILURES_BEFORE_PAUSE) {
    pause = FAILURE_PAUSE_MS;
    pauseScope = 'operation';
    operationState.pausedUntil = Date.now() + pause;
    operationState.pausedFor = error.code;
  }

  // What failed and how, in the application's own words: the provider's
  // reply, the request address and the key are never logged.
  logger.warn(FAILURE_MESSAGES[provider] || 'External request failed', {
    provider,
    operation,
    query,
    reason: error.code,
    status: error.status,
    durationMs,
    pausedForMs: pause || undefined,
    pauseScope
  });
}

/**
 * Fetches one provider result list through the cache, the in-flight table
 * and that provider's usage limits. For SerpApi it is shared by web search
 * and the image, video, map and trending requests, so they share one daily
 * limit. A pause after repeated failures covers only the operation that
 * failed; a rejected key or a rate limit pauses the provider.
 *
 * A provider failure (an ExternalSearchError) becomes `unavailable` with the
 * provider's reason. Any other error is a bug here, not a provider failure:
 * it is logged as an error and reported as `internal_error`.
 *
 * @param {string} vertical  web | images | videos | maps | trending
 * @param {Object} request   what is sent (also the cache key)
 * @param {() => Promise<{results: Array}>} send  makes the request
 * @param {'serpapi'|'bing'|'parallel'} [provider]
 * @param {Object} [options]
 * @param {(results: Array) => boolean} [options.accept]  whether the answer
 *        may be used. One that may not is reported as `unavailable` /
 *        `irrelevant_results` and is not cached.
 * @returns {Promise<{status: 'ok', results: Array, cached: boolean}
 *                  | {status: 'skipped'|'unavailable', reason: string}>}
 */
async function fetchCached(vertical, request, send, provider = 'serpapi', options = {}) {
  const limits = LIMITS[provider]();
  const state = stateOf(provider);
  const operationState = operationStateOf(provider, vertical);
  const key = requestKey(provider, vertical, request);
  const query = queryOf(request);

  const cached = readCache(key, limits.cacheTtlMs);
  if (cached) return { status: 'ok', results: cached, cached: true };
  if (inFlight.has(key)) return inFlight.get(key);

  const now = Date.now();
  const paused =
    (now < state.pausedUntil && { scope: 'provider', ...state }) ||
    (now < operationState.pausedUntil && { scope: 'operation', ...operationState });
  if (paused) {
    logger.warn('External request not sent: paused after earlier failures', {
      provider,
      operation: vertical,
      query,
      reason: paused.pausedFor || 'paused',
      pauseScope: paused.scope,
      resumesInMs: paused.pausedUntil - now
    });
    return { status: 'unavailable', reason: paused.pausedFor || 'paused' };
  }
  if (state.active >= limits.maxConcurrent) return { status: 'skipped', reason: 'busy' };

  const day = today();
  if (state.day !== day) {
    state.day = day;
    state.sentToday = 0;
  }
  if (limits.dailyLimit > 0 && state.sentToday >= limits.dailyLimit) {
    return { status: 'skipped', reason: 'daily_limit' };
  }

  // The slot is reserved before sending, so concurrent searches cannot pass
  // the limit together, and handed back on failure: a provider only charges
  // a search that worked, and a failing account must not use up the day.
  // (Except where that is not known to be true: see COUNTS_FAILURES.)
  state.active += 1;
  state.sentToday += 1;
  const startedAt = Date.now();
  const pending = Promise.resolve()
    .then(send)
    .then(({ results }) => {
      operationState.consecutiveFailures = 0;
      // The provider answered, and was charged for it, but with a list that
      // is no use: it is neither shown nor cached. Not an outage either, so
      // it counts towards no pause.
      if (options.accept && !options.accept(results)) {
        logger.warn('External results rejected: they do not cover the query', {
          provider,
          operation: vertical,
          query,
          reason: 'irrelevant_results',
          resultCount: Array.isArray(results) ? results.length : 0,
          durationMs: Date.now() - startedAt
        });
        return { status: 'unavailable', reason: 'irrelevant_results' };
      }
      writeCache(key, results, limits);
      return { status: 'ok', results, cached: false };
    })
    .catch(error => {
      if (state.day === day && !COUNTS_FAILURES.has(provider)) {
        state.sentToday = Math.max(0, state.sentToday - 1);
      }
      // A provider failure is expected and handled: counted, paused on, and
      // a reason to try the other provider. Anything else is a bug in this
      // application: it is logged as an error, is not blamed on the provider
      // (no pause, no fallback), and search carries on with the index.
      if (!error || error.name !== 'ExternalSearchError') {
        logger.error('Unexpected error in external search (not a provider failure)', {
          provider,
          operation: vertical,
          query,
          durationMs: Date.now() - startedAt,
          error
        });
        return { status: 'unavailable', reason: 'internal_error' };
      }
      recordFailure(provider, error, {
        operation: vertical,
        query,
        durationMs: Date.now() - startedAt
      });
      return { status: 'unavailable', reason: error.code };
    })
    .finally(() => {
      state.active -= 1;
      inFlight.delete(key);
    });

  inFlight.set(key, pending);
  return pending;
}

/**
 * Google's organic web results for one translated request.
 *
 * SerpApi serves a stored copy of a search for about an hour, so a bad page
 * of results would be handed back each time it is asked for. When the answer
 * is not accepted, it is therefore asked once more for a fresh one
 * (`no_cache`); the cache entry stays under the ordinary request.
 *
 * @param {Object} request
 * @param {(results: Array) => boolean} [accept]  see fetchCached
 */
async function fetchOrganic(request, accept) {
  const first = await fetchCached(
    'web',
    request,
    () => serpApiClient.searchGoogle({ q: request.q, params: request.params }),
    'serpapi',
    { accept }
  );
  if (first.status === 'ok' || first.reason !== 'irrelevant_results') return first;

  return fetchCached(
    'web',
    request,
    () =>
      serpApiClient.searchGoogle({
        q: request.q,
        params: { ...request.params, no_cache: 'true' }
      }),
    'serpapi',
    { accept }
  );
}

/**
 * Counts requests a caller sent beyond the one fetchCached reserved: a search
 * made of several provider requests is charged for each of them.
 */
function recordExtraRequests(provider, count) {
  const state = stateOf(provider);
  if (state.day === today() && count > 0) state.sentToday += count;
}

/** Whether SerpApi may be asked at all, and if not, why. */
function availability() {
  const s = settings();
  if (!s.enabled) return { ok: false, status: 'disabled', reason: 'disabled' };
  if (!s.apiKey) return { ok: false, status: 'disabled', reason: 'not_configured' };
  if (s.engine !== 'google') return { ok: false, status: 'disabled', reason: 'unsupported_engine' };
  return { ok: true };
}

/** Whether Bing may be asked: it only needs its key. */
function bingAvailability() {
  if (!config.bing.apiKey) return { ok: false, status: 'disabled', reason: 'not_configured' };
  return { ok: true };
}

/** Whether Parallel may be asked: switched on, with a key and a mode the API has. */
function parallelAvailability() {
  const s = config.parallel;
  if (!s.enabled) return { ok: false, status: 'disabled', reason: 'disabled' };
  if (!s.apiKey) return { ok: false, status: 'disabled', reason: 'not_configured' };
  if (!parallelClient.MODES.includes(s.mode)) {
    return { ok: false, status: 'disabled', reason: 'unsupported_mode' };
  }
  return { ok: true };
}

/**
 * The web-result providers. Each one says whether it can be asked, turns
 * the parsed query into its own request (or declines with a reason), fetches
 * through fetchCached, and maps what comes back onto the result schema.
 * `map` is also given the request, for a provider whose results must be
 * checked against something it was asked (Parallel's date filter).
 */
const WEB_PROVIDERS = {
  serpapi: {
    available: availability,
    build: (parsed, params) => buildSerpApiRequest(parsed, params),
    fetch: (request, accept) => fetchOrganic(request, accept),
    map: (results, parsed, filters) => mapOrganicResults(results, parsed, filters),
    maxResults: () => config.serpapi.maxResults
  },
  bing: {
    available: bingAvailability,
    build: (parsed, params) => buildBingRequest(parsed, params),
    fetch: (request, accept) => {
      const { keyword, page, size, cc } = request;
      return fetchCached(
        'web',
        { keyword, page, size, cc },
        () => bingSearchClient.searchWeb({ keyword, page, size, cc }),
        'bing',
        { accept }
      );
    },
    map: (results, parsed, filters) => mapBingItems(results, parsed, filters),
    maxResults: () => config.bing.maxResults
  },
  parallel: {
    available: parallelAvailability,
    build: (parsed, params) => buildParallelRequest(parsed, params),
    fetch: (request, accept) => {
      const { objective, searchQueries, sourcePolicy } = request;
      // The mode and the result limit change the answer, so they are part of
      // the cache key along with what is asked.
      const { mode } = config.parallel;
      const maxResults = Math.max(config.parallel.maxResults, PARALLEL_RESULTS_PER_REQUEST);
      return fetchCached(
        'web',
        { objective, searchQueries, sourcePolicy, mode, maxResults },
        () => parallelClient.search({ objective, searchQueries, sourcePolicy, maxResults }),
        'parallel',
        { accept }
      );
    },
    map: (results, parsed, filters, request) =>
      mapParallelResults(results, parsed, {
        ...filters,
        afterDate: (request && request.afterDate) || null
      }),
    maxResults: () => config.parallel.maxResults
  }
};

/** The chosen provider first, then the others when fallback is on. */
function webProviderOrder() {
  const primary = WEB_PROVIDERS[config.externalSearch.provider]
    ? config.externalSearch.provider
    : PROVIDER;
  const others = Object.keys(WEB_PROVIDERS).filter(name => name !== primary);
  return config.externalSearch.fallback ? [primary, ...others] : [primary];
}

/** Index results, labelled with where they came from. Same order. */
function labelIndexResults(results, { page = 1, limit = 10, offset: start }) {
  const offset = Number.isInteger(start) && start >= 0 ? start : (page - 1) * limit;
  return results.map((result, i) => ({ ...result, source: 'index', sourceRank: offset + i + 1 }));
}

/**
 * Appends the external results that add something new.
 *
 * @param {Object} internal  the index's outcome
 * @param {Array} external  mapped external results, the provider's order
 * @param {(keys: string[]) => Promise<Set<string>>} [indexedKeys]
 *        which of these canonical keys the index already holds (beyond the
 *        results on this page)
 * @param {number} [maxResults]  how many to add at most
 * @param {{externalFirst?: boolean}} [placement]  put the external results
 *        before the index's instead of after (the index has no page about
 *        the query). Which results are kept is the same either way.
 */
async function appendUnique(
  internal,
  external,
  params,
  indexedKeys,
  maxResults,
  { externalFirst = false } = {}
) {
  const indexResults = labelIndexResults(internal.results || [], params);
  // The same page under another form of its address (a mobile host, a stray
  // ";") is the same page: it is not added twice.
  const onPage = new Set(indexResults.map(r => resultIdentityKey(r.url)).filter(Boolean));
  const seen = new Set();
  let fresh = external.filter(r => {
    const key = resultIdentityKey(r.url);
    if (key && (onPage.has(key) || seen.has(key))) return false;
    if (key) seen.add(key);
    return true;
  });
  if (fresh.length > 0 && indexedKeys) {
    try {
      // The page's own key, and the key of the form the index would hold it
      // under (en.m.wikipedia.org → en.wikipedia.org).
      const keysOf = r => [canonicalKey(r.url), resultIdentityKey(r.url)].filter(Boolean);
      const known = await indexedKeys([...new Set(fresh.flatMap(keysOf))]);
      fresh = fresh.filter(r => !keysOf(r).some(key => known.has(key)));
    } catch (error) {
      // Only costs a possible repeat of an indexed page lower down.
      logger.warn('Could not check external results against the index', {
        message: error.message
      });
    }
  }

  const added = fresh.slice(0, maxResults || settings().maxResults);
  return {
    results: externalFirst ? [...added, ...indexResults] : [...indexResults, ...added],
    added: added.length,
    addedResults: added,
    indexResults,
    duplicatesDropped: external.length - fresh.length,
    // How many new results the answer holds in all: the rest is what "Load
    // more" can still show.
    available: fresh.length
  };
}

/**
 * Whether the index's first page answers the query, when the relevance gate
 * is on:
 *
 *   'strong'  at least MIN_COVERING_RESULTS of its results are about the
 *             query (enough of its meaningful words in their titles), and the
 *             engine found a page about it (OpenSearch's own measure)
 *   'weak'    otherwise: too few of its results are about the query, however
 *             many pages matched
 *   null      the gate is off, or the engine did not measure its answer (the
 *             legacy MongoDB engine): the count rule alone decides
 *
 * @returns {{level: 'strong'|'weak', covering: number}|null}
 */
function indexQuality(internal, parsed) {
  if (!config.externalSearch.relevanceGate) return null;
  const quality = internal && internal.quality;
  if (!quality || typeof quality.aboutMatches !== 'number') return null;
  const results = (internal && internal.results) || [];
  const covering = countAnswering(results, parsed);
  const noneAbout = quality.aboutMatches === 0;
  const level = noneAbout || covering < MIN_COVERING_RESULTS ? 'weak' : 'strong';
  return { level, covering };
}

/**
 * The index's and the provider's results as one list, best first
 * (unifiedRanker): neither source's block is put before the other's.
 * A search sorted by date keeps its dates' order: that sort is the point.
 * `language` is the language filter: with one set, it decides the language.
 */
function ranked(results, parsed, intent, sort = 'relevance', language = '') {
  if (sort && sort !== 'relevance') return results;
  return rankResults(results, parsed, {
    timeSensitive: Boolean(intent && intent.timeSensitive),
    language
  });
}

/**
 * Asks the providers in order until one answers.
 *
 * @param {Array<{name: string, request: Object}>} plans  providers that can
 *        take this search, chosen one first
 * @returns {Promise<Object>} the first `ok` outcome, with `provider` and — if
 *          an earlier provider failed — `fallbackFrom`/`fallbackReason`; or
 *          the first provider's failure when none answered
 */
async function fetchFromProviders(plans) {
  let firstFailure = null;
  for (const plan of plans) {
    const outcome = await WEB_PROVIDERS[plan.name].fetch(plan.request, plan.accept);
    if (outcome.status === 'ok') {
      return {
        ...outcome,
        provider: plan.name,
        ...(firstFailure
          ? { fallbackFrom: firstFailure.provider, fallbackReason: firstFailure.reason }
          : {})
      };
    }
    if (!firstFailure) firstFailure = { ...outcome, provider: plan.name };
    // A bug in this application is not something another provider fixes.
    if (outcome.reason === 'internal_error') break;
  }
  return firstFailure;
}

/**
 * Runs a web search with external results.
 *
 * @param {Object} params  webSearch's parameters
 * @param {() => Promise<Object>} runInternal  the index search
 * @param {Object} [options]
 * @param {(keys: string[]) => Promise<Set<string>>} [options.indexedKeys]
 * @param {{sites: Array}|null} [options.navigational]  the search names one
 *        site (ranking/navigational.js). When the index's page has none of
 *        that site's pages, the index has not answered it, however many pages
 *        matched the word — so the provider is asked, as for a weak index.
 * @returns {Promise<Object>} the index's outcome, with `results` extended and
 *          an `external` status; totalResults/reachableResults stay the
 *          index's own (pagination is the index's)
 */
async function searchWithExternal(params, runInternal, options = {}) {
  const order = webProviderOrder();
  const primary = order[0];
  const status = (s, extra = {}, provider = primary) => ({
    provider,
    status: s,
    count: 0,
    ...extra
  });
  // Where "Load more" picks the external results up: none shown, none left.
  const noContinuation = { externalOffset: 0, externalMore: false, placement: null };
  const parsed = parseQuery(params.query);
  const intent = queryIntent.classify(params.query);
  // The index's page alone is ranked the same way: a loose match it holds
  // does not lead pages that are about the query.
  const withStatus = (internal, external) => ({
    ...internal,
    results: ranked(
      labelIndexResults(internal.results || [], params),
      parsed,
      intent,
      params.sort,
      params.language
    ),
    external,
    continuation: noContinuation
  });

  // Providers that are switched on and have a key, chosen one first.
  const usable = order.filter(name => WEB_PROVIDERS[name].available().ok);
  if (usable.length === 0) {
    const why = WEB_PROVIDERS[primary].available();
    return withStatus(await runInternal(), status(why.status, { reason: why.reason }));
  }

  // Each usable provider's own request for this search, or its reason for
  // declining it (page 2, a filter it has no parameter for, …).
  const built = usable.map(name => ({
    name,
    request: WEB_PROVIDERS[name].build(parsed, params)
  }));
  // A provider's answer is used only if it covers the query's meaningful
  // words, judged on the results as they would be shown.
  const accept = plan => raw =>
    coversQuery(
      WEB_PROVIDERS[plan.name].map(raw, parsed, { domain: params.domain }, plan.request),
      parsed
    );
  const plans = built
    .filter(plan => !plan.request.skip)
    .map(plan =>
      config.externalSearch.validateResults ? { ...plan, accept: accept(plan) } : plan
    );
  if (plans.length === 0) {
    return withStatus(
      await runInternal(),
      status('skipped', { reason: built[0].request.reason }, built[0].name)
    );
  }

  // Either in parallel with the index (SERPAPI_MIN_INTERNAL_RESULTS=0: every
  // eligible first page), or after it — and then only when the index needs
  // help: it found too little, or it has no page that is about the query,
  // however many pages matched (the relevance gate). A count says how much
  // was found, not whether any of it answers the question.
  const threshold = settings().minInternalResults;
  let internal;
  let outcome;
  if (threshold === 0) {
    const externalPromise = fetchFromProviders(plans); // rejects only for a bug
    externalPromise.catch(() => {}); // the index failing first must not leave it unhandled
    internal = await runInternal(); // an index failure still fails the search
    outcome = await externalPromise;
  } else {
    internal = await runInternal();
    const tooFew = (internal.totalResults || 0) < threshold;
    const site = options.navigational || null;
    const officialMissing =
      Boolean(site) &&
      !(internal.results || []).some(result => navigational.isOfficial(result.url, site.sites));
    const known = indexQuality(internal, parsed);
    if (!tooFew && (!known || known.level !== 'weak') && !officialMissing) {
      return withStatus(
        internal,
        status(
          'skipped',
          {
            reason: 'enough_index_results',
            ...(known ? { indexQuality: known.level, indexCovering: known.covering } : {})
          },
          plans[0].name
        )
      );
    }
    outcome = await fetchFromProviders(plans);
  }

  // Both sources' results are ranked together: neither block is placed
  // before the other.
  const measured = indexQuality(internal, parsed);
  const note = measured ? { indexQuality: measured.level, indexCovering: measured.covering } : {};

  if (outcome.status !== 'ok') {
    return withStatus(
      internal,
      status(outcome.status, { reason: outcome.reason, ...note }, outcome.provider)
    );
  }

  const provider = WEB_PROVIDERS[outcome.provider];
  const answered = plans.find(plan => plan.name === outcome.provider);
  const everything = provider.map(
    outcome.results,
    parsed,
    { domain: params.domain },
    answered && answered.request
  );
  // The answer as a whole covers the query (it was accepted above). What is
  // shown is the part of it that is on the subject: a result about something
  // else is left out rather than used to fill the page.
  const mapped = config.externalSearch.validateResults
    ? relevantResults(everything, parsed)
    : everything;
  const merged = await appendUnique(
    internal,
    mapped,
    params,
    options.indexedKeys,
    provider.maxResults()
  );

  return {
    ...internal,
    results: ranked(merged.results, parsed, intent, params.sort, params.language),
    continuation: {
      externalOffset: merged.added,
      externalMore: merged.available > merged.added,
      // Where the index did not answer, "Load more" keeps drawing on the
      // provider's answer first; otherwise both sources share each batch.
      placement: measured && measured.level === 'weak' ? 'external' : 'ranked'
    },
    external: status(
      'ok',
      {
        count: merged.added,
        cached: outcome.cached,
        ...(outcome.fallbackFrom
          ? { fallbackFrom: outcome.fallbackFrom, fallbackReason: outcome.fallbackReason }
          : {}),
        ...note,
        placement: 'ranked'
      },
      outcome.provider
    )
  };
}

/**
 * The next external web results for "Load more": the ones after `offset` in
 * the same answer the first page came from.
 *
 * The providers are asked exactly as for the first page (so the cached answer
 * is reused and nothing is sent again while it is fresh). Parallel has no
 * page or offset parameter, so its answer is all there is; when it runs out,
 * `more` is false and nothing is made up to continue it. The answer goes
 * through the same relevance filter, and a result for a page the index holds
 * is left out — it is shown, or will be, among the index's own results.
 *
 * @param {Object} params  the search's own parameters (query, filters)
 * @param {Object} options
 * @param {number} options.offset  external results already shown
 * @param {number} options.count   how many to return at most
 * @param {(keys: string[]) => Promise<Set<string>>} [options.indexedKeys]
 * @returns {Promise<{status: string, reason?: string, provider: string|null,
 *                    results: Array, more: boolean}>}
 */
async function moreExternal(params, { offset, count, indexedKeys }) {
  const none = (status, reason, provider = null) => ({
    status,
    ...(reason ? { reason } : {}),
    provider,
    results: [],
    more: false
  });
  const usable = webProviderOrder().filter(name => WEB_PROVIDERS[name].available().ok);
  if (usable.length === 0) return none('disabled', 'disabled');

  const parsed = parseQuery(params.query);
  // Built as the first page was: that is the request whose answer continues.
  const first = { ...params, page: 1, offset: undefined };
  const accept = plan => raw =>
    coversQuery(
      WEB_PROVIDERS[plan.name].map(raw, parsed, { domain: params.domain }, plan.request),
      parsed
    );
  const plans = usable
    .map(name => ({ name, request: WEB_PROVIDERS[name].build(parsed, first) }))
    .filter(plan => !plan.request.skip)
    .map(plan =>
      config.externalSearch.validateResults ? { ...plan, accept: accept(plan) } : plan
    );
  if (plans.length === 0) return none('skipped', 'not_applicable');

  const outcome = await fetchFromProviders(plans);
  if (outcome.status !== 'ok') return none(outcome.status, outcome.reason, outcome.provider);

  const provider = WEB_PROVIDERS[outcome.provider];
  const answered = plans.find(plan => plan.name === outcome.provider);
  const everything = provider.map(
    outcome.results,
    parsed,
    { domain: params.domain },
    answered && answered.request
  );
  const mapped = config.externalSearch.validateResults
    ? relevantResults(everything, parsed)
    : everything;
  const merged = await appendUnique({ results: [] }, mapped, first, indexedKeys, mapped.length);
  const fresh = merged.results;
  const results = fresh.slice(offset, offset + count);
  return {
    status: 'ok',
    provider: outcome.provider,
    cached: outcome.cached,
    results,
    more: offset + results.length < fresh.length
  };
}

/** For the admin dashboard: never a key, only whether there is one. */
function describe() {
  const s = settings();
  const used = provider => {
    const state = stateOf(provider);
    return state.day === today() ? state.sentToday : 0;
  };
  return {
    provider: PROVIDER,
    enabled: s.enabled,
    configured: Boolean(s.apiKey),
    usedToday: used('serpapi'),
    dailyLimit: s.dailyLimit,
    webProvider: webProviderOrder()[0],
    fallback: config.externalSearch.fallback,
    bing: {
      configured: Boolean(config.bing.apiKey),
      usedToday: used('bing'),
      dailyLimit: config.bing.dailyLimit
    },
    parallel: {
      enabled: config.parallel.enabled,
      configured: Boolean(config.parallel.apiKey),
      usedToday: used('parallel'),
      dailyLimit: config.parallel.dailyLimit
    }
  };
}

/** Tests: forget the cache, the counters and any pause. */
function reset() {
  cache.clear();
  inFlight.clear();
  states.clear();
  operationStates.clear();
}

module.exports = {
  ranked,
  MIN_COVERING_RESULTS,
  searchWithExternal,
  moreExternal,
  appendUnique,
  labelIndexResults,
  fetchOrganic,
  fetchCached,
  recordExtraRequests,
  availability,
  bingAvailability,
  parallelAvailability,
  webProviderOrder,
  indexQuality,
  describe,
  reset,
  PROVIDER
};
