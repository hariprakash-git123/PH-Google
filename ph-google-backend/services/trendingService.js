const { config } = require('../config/env');
const externalSearch = require('./externalSearch');
const serpApiClient = require('./external/serpApiClient');
const { text } = require('./external/fields');

/**
 * Trending searches for the homepage's "Trending now" card.
 *
 * The source is SerpApi's Google Trends "Trending Now" engine — the same
 * key, daily limit and failure pause as every other SerpApi request
 * (services/externalSearch.js). What this module adds:
 *
 *   - its own cache per country, with the time the trends were really
 *     fetched, so the card can say "Updated 5 min ago" truthfully;
 *   - the last good trends are kept and served, marked stale, whenever a
 *     refresh is not possible (SerpApi off, failing, or the day's limit
 *     reached) — the homepage never depends on SerpApi answering;
 *   - with nothing to serve it returns an empty list and says why. It never
 *     throws for a provider problem.
 */

const ENGINE = 'google_trends_trending_now';

/**
 * Countries the endpoint accepts (ISO 3166-1 alpha-2, as Google Trends uses).
 * Add a code here to support another country.
 */
const REGIONS = new Set([
  'IN',
  'US',
  'GB',
  'AU',
  'CA',
  'SG',
  'AE',
  'DE',
  'FR',
  'JP',
  'BR',
  'ZA',
  'NZ',
  'IE',
  'MY'
]);
/** What people type for a country that has another code. */
const ALIASES = { UK: 'GB' };

/** region -> { trends, fetchedAt } — the last trends fetched successfully. */
const latest = new Map();
/** region -> Promise — one refresh at a time per country. */
const refreshing = new Map();

/**
 * @param {string} [value]  a country code, any case; empty means the default
 * @returns {string|null} the code to use, or null when it is not supported
 */
function resolveRegion(value) {
  const raw = String(value || '')
    .trim()
    .toUpperCase();
  if (!raw) return REGIONS.has(config.trending.region) ? config.trending.region : 'IN';
  const code = ALIASES[raw] || raw;
  return REGIONS.has(code) ? code : null;
}

/** SerpApi's `trending_searches` → [{ title, query }], cleaned and de-duplicated. */
function mapTrends(raw, maxItems = config.trending.maxItems) {
  const seen = new Set();
  const trends = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const query = text(entry && typeof entry === 'object' ? entry.query : entry, 80);
    const key = query.toLowerCase();
    if (!query || seen.has(key)) continue;
    seen.add(key);
    trends.push({ title: query, query });
    if (trends.length >= maxItems) break;
  }
  return trends;
}

function respond(region, entry, extra = {}) {
  return {
    region,
    updatedAt: entry ? new Date(entry.fetchedAt).toISOString() : null,
    trends: entry ? entry.trends : [],
    source: entry ? 'serpapi' : 'none',
    stale: false,
    ...extra
  };
}

async function refresh(region) {
  const request = { engine: ENGINE, params: { geo: region } };
  const outcome = await externalSearch.fetchCached('trending', request, () =>
    serpApiClient.searchEngine(request, {
      settings: { timeoutMs: config.trending.timeoutMs }
    })
  );
  if (outcome.status !== 'ok') return outcome;

  const trends = mapTrends(outcome.results);
  // An answer with no usable trend is not worth replacing good ones with.
  if (trends.length === 0) return { status: 'unavailable', reason: 'empty' };

  const previous = latest.get(region);
  // A reply served from the SerpApi cache is as old as the copy we hold.
  const fetchedAt = outcome.cached && previous ? previous.fetchedAt : Date.now();
  latest.set(region, { trends, fetchedAt });
  return { status: 'ok' };
}

/**
 * @param {string} region  a code from resolveRegion
 * @returns {Promise<{region: string, updatedAt: string|null,
 *   trends: Array<{title: string, query: string}>, source: 'serpapi'|'none',
 *   stale: boolean, reason?: string}>}
 */
async function getTrending(region) {
  const held = latest.get(region);
  if (held && Date.now() - held.fetchedAt < config.trending.cacheTtlMs)
    return respond(region, held);

  const available = externalSearch.availability();
  if (!available.ok) {
    return respond(region, held || null, { stale: Boolean(held), reason: available.reason });
  }

  if (!refreshing.has(region)) {
    refreshing.set(
      region,
      refresh(region)
        .catch(() => ({ status: 'unavailable', reason: 'unavailable' }))
        .finally(() => refreshing.delete(region))
    );
  }
  const outcome = await refreshing.get(region);

  const now = latest.get(region);
  if (outcome.status === 'ok') return respond(region, now);
  // Could not refresh: the last good trends, marked stale — or nothing.
  return respond(region, now || null, { stale: Boolean(now), reason: outcome.reason });
}

/** Tests: forget everything held. */
function reset() {
  latest.clear();
  refreshing.clear();
}

module.exports = { getTrending, resolveRegion, mapTrends, reset, REGIONS, ENGINE };
