const { config } = require('../config/env');
const logger = require('../utils/logger');
const { canonicalKey } = require('../utils/urlNormalizer');
const { parseQuery } = require('./opensearch/queryParser');
const { buildSerpApiRequest } = require('./external/serpApiQuery');
const { mapOrganicResults } = require('./external/serpApiMapper');
const serpApiClient = require('./external/serpApiClient');

/**
 * External results for web search.
 *
 * The index answers every search exactly as before. On the first page of a
 * web search, when SerpApi is enabled, Google's results are added AFTER the
 * index's results:
 *
 *   - the index's results keep their order, their scores and their pages;
 *   - a Google result for a page the index already has is dropped (the
 *     index's copy wins), as is one the query's own restrictions exclude;
 *   - nothing from SerpApi is stored anywhere — it is a query-time source.
 *
 * Google's order and the index's scores are different systems, so they are
 * never added or compared: the merge is by position (index first).
 *
 * This never throws because of SerpApi. Whatever happens — disabled, no key,
 * a rejected key, a timeout, an outage — the index's results are returned
 * with a short status saying what happened to the external ones.
 */

const PROVIDER = 'serpapi';

// --- Usage control ------------------------------------------------------
// Process-local by design, like the AI answer cache: SerpApi is an
// enhancement, and search must not come to depend on Redis for it.

const cache = new Map(); // request key -> { at, results }
const inFlight = new Map(); // request key -> Promise
const state = {
  active: 0,
  day: '',
  sentToday: 0,
  consecutiveFailures: 0,
  pausedUntil: 0,
  pausedFor: null
};

const FAILURES_BEFORE_PAUSE = 3;
const FAILURE_PAUSE_MS = 60 * 1000;
const AUTH_PAUSE_MS = 10 * 60 * 1000;
const RATE_LIMIT_PAUSE_MS = 5 * 60 * 1000;

function settings() {
  return config.serpapi;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The cache key: the vertical, then everything sent to SerpApi except the
 * API key — so "python" on Images never answers "python" on the web.
 */
function requestKey(vertical, request) {
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

function readCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > settings().cacheTtlMs) {
    cache.delete(key);
    return null;
  }
  return entry.results;
}

function writeCache(key, results) {
  if (settings().cacheTtlMs <= 0) return;
  if (cache.size >= settings().cacheMaxEntries) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), results });
}

/** Records a failure and decides how long to leave SerpApi alone. */
function recordFailure(error) {
  state.consecutiveFailures += 1;
  let pause = 0;
  if (error.code === 'auth') pause = AUTH_PAUSE_MS;
  else if (error.code === 'rate_limited') pause = error.retryAfterMs || RATE_LIMIT_PAUSE_MS;
  else if (state.consecutiveFailures >= FAILURES_BEFORE_PAUSE) pause = FAILURE_PAUSE_MS;

  if (pause > 0) {
    state.pausedUntil = Date.now() + pause;
    state.pausedFor = error.code;
  }
  // The code and the application's own message only: never the request.
  logger.warn('SerpApi request failed; showing index results only', {
    reason: error.code,
    status: error.status,
    pausedForMs: pause || undefined
  });
}

/**
 * Fetches one SerpApi result list through the cache, the in-flight table and
 * the usage limits — shared by web search and the image, video and map
 * verticals, so they share one daily limit and one pause after failures.
 *
 * @param {string} vertical  web | images | videos | maps (part of the cache key)
 * @param {{engine?: string, q: string, params: Object}} request
 * @param {() => Promise<{results: Array}>} send  makes the request
 * @returns {Promise<{status: 'ok', results: Array, cached: boolean}
 *                  | {status: 'skipped'|'unavailable', reason: string}>}
 */
async function fetchCached(vertical, request, send) {
  const key = requestKey(vertical, request);

  const cached = readCache(key);
  if (cached) return { status: 'ok', results: cached, cached: true };
  if (inFlight.has(key)) return inFlight.get(key);

  if (Date.now() < state.pausedUntil) {
    return { status: 'unavailable', reason: state.pausedFor || 'paused' };
  }
  if (state.active >= settings().maxConcurrent) return { status: 'skipped', reason: 'busy' };

  const day = today();
  if (state.day !== day) {
    state.day = day;
    state.sentToday = 0;
  }
  const { dailyLimit } = settings();
  if (dailyLimit > 0 && state.sentToday >= dailyLimit) {
    return { status: 'skipped', reason: 'daily_limit' };
  }

  // The slot is reserved before sending, so concurrent searches cannot pass
  // the limit together, and handed back on failure: SerpApi only charges a
  // search that worked, and a failing account must not use up the day.
  state.active += 1;
  state.sentToday += 1;
  const pending = Promise.resolve()
    .then(send)
    .then(({ results }) => {
      state.consecutiveFailures = 0;
      writeCache(key, results);
      return { status: 'ok', results, cached: false };
    })
    .catch(error => {
      if (state.day === day) state.sentToday = Math.max(0, state.sentToday - 1);
      const code = error && error.name === 'ExternalSearchError' ? error.code : 'unavailable';
      recordFailure(error && error.code ? error : { code });
      return { status: 'unavailable', reason: code };
    })
    .finally(() => {
      state.active -= 1;
      inFlight.delete(key);
    });

  inFlight.set(key, pending);
  return pending;
}

/** Google's organic web results for one translated request. */
function fetchOrganic(request) {
  return fetchCached('web', request, () =>
    serpApiClient.searchGoogle({ q: request.q, params: request.params })
  );
}

/** Whether external results may be requested at all, and if not, why. */
function availability() {
  const s = settings();
  if (!s.enabled) return { ok: false, status: 'disabled', reason: 'disabled' };
  if (!s.apiKey) return { ok: false, status: 'disabled', reason: 'not_configured' };
  if (s.engine !== 'google') return { ok: false, status: 'disabled', reason: 'unsupported_engine' };
  return { ok: true };
}

/** Index results, labelled with where they came from. Same order. */
function labelIndexResults(results, { page = 1, limit = 10 }) {
  const offset = (page - 1) * limit;
  return results.map((result, i) => ({ ...result, source: 'index', sourceRank: offset + i + 1 }));
}

/**
 * Appends the external results that add something new.
 *
 * @param {Object} internal  the index's outcome
 * @param {Array} external  mapped external results, Google's order
 * @param {(keys: string[]) => Promise<Set<string>>} [indexedKeys]
 *        which of these canonical keys the index already holds (beyond the
 *        results on this page)
 */
async function appendUnique(internal, external, params, indexedKeys) {
  const indexResults = labelIndexResults(internal.results || [], params);
  const onPage = new Set(indexResults.map(r => canonicalKey(r.url)).filter(Boolean));

  let fresh = external.filter(r => !onPage.has(canonicalKey(r.url)));
  if (fresh.length > 0 && indexedKeys) {
    try {
      const known = await indexedKeys(fresh.map(r => canonicalKey(r.url)));
      fresh = fresh.filter(r => !known.has(canonicalKey(r.url)));
    } catch (error) {
      // Only costs a possible repeat of an indexed page lower down.
      logger.warn('Could not check external results against the index', {
        message: error.message
      });
    }
  }

  const added = fresh.slice(0, settings().maxResults);
  return {
    results: [...indexResults, ...added],
    duplicatesDropped: external.length - fresh.length,
    added: added.length
  };
}

/**
 * Runs a web search with external results.
 *
 * @param {Object} params  webSearch's parameters
 * @param {() => Promise<Object>} runInternal  the index search
 * @param {Object} [options]
 * @param {(keys: string[]) => Promise<Set<string>>} [options.indexedKeys]
 * @returns {Promise<Object>} the index's outcome, with `results` extended and
 *          an `external` status; totalResults/reachableResults stay the
 *          index's own (pagination is the index's)
 */
async function searchWithExternal(params, runInternal, options = {}) {
  const status = (s, extra = {}) => ({ provider: PROVIDER, status: s, count: 0, ...extra });
  const withStatus = (internal, external) => ({
    ...internal,
    results: labelIndexResults(internal.results || [], params),
    external
  });

  const available = availability();
  if (!available.ok) {
    return withStatus(await runInternal(), status(available.status, { reason: available.reason }));
  }

  const parsed = parseQuery(params.query);
  const request = buildSerpApiRequest(parsed, params);
  if (request.skip) {
    return withStatus(await runInternal(), status('skipped', { reason: request.reason }));
  }

  // Either in parallel with the index (every eligible first page), or after
  // it and only when the index found too little.
  const threshold = settings().minInternalResults;
  let internal;
  let outcome;
  if (threshold === 0) {
    const externalPromise = fetchOrganic(request); // never rejects
    internal = await runInternal(); // an index failure still fails the search
    outcome = await externalPromise;
  } else {
    internal = await runInternal();
    if ((internal.totalResults || 0) >= threshold) {
      return withStatus(internal, status('skipped', { reason: 'enough_index_results' }));
    }
    outcome = await fetchOrganic(request);
  }

  if (outcome.status !== 'ok') {
    return withStatus(internal, status(outcome.status, { reason: outcome.reason }));
  }

  const mapped = mapOrganicResults(outcome.results, parsed, { domain: params.domain });
  const merged = await appendUnique(internal, mapped, params, options.indexedKeys);

  return {
    ...internal,
    results: merged.results,
    external: status('ok', { count: merged.added, cached: outcome.cached })
  };
}

/** For the admin dashboard: never the key, only whether there is one. */
function describe() {
  const s = settings();
  return {
    provider: PROVIDER,
    enabled: s.enabled,
    configured: Boolean(s.apiKey),
    usedToday: state.day === today() ? state.sentToday : 0,
    dailyLimit: s.dailyLimit
  };
}

/** Tests: forget the cache, the counters and any pause. */
function reset() {
  cache.clear();
  inFlight.clear();
  Object.assign(state, {
    active: 0,
    day: '',
    sentToday: 0,
    consecutiveFailures: 0,
    pausedUntil: 0,
    pausedFor: null
  });
}

module.exports = {
  searchWithExternal,
  appendUnique,
  labelIndexResults,
  fetchOrganic,
  fetchCached,
  availability,
  describe,
  reset,
  PROVIDER
};
