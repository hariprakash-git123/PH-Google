/**
 * Centralised, validated environment configuration.
 * Every module reads config from here instead of touching process.env directly,
 * so a missing/invalid variable fails loudly at startup instead of at request time.
 */

// Under test, the suite supplies its own variables. Loading the developer's
// real .env would put live database credentials in reach of a test run.
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ quiet: true });
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const isTest = NODE_ENV === 'test';

function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseOrigins(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
}

/**
 * Express's `trust proxy`, from TRUST_PROXY: how many proxies in front of the
 * API to believe about the client's address (X-Forwarded-For). It decides
 * what the rate limits count as one client, so it must match the real path a
 * request takes — never more hops than there are, or a client can forge its
 * address:
 *
 *   1 (default)  one proxy: the frontend's nginx, which sets the header itself
 *                — also behind a load balancer, where nginx's real_ip module
 *                recovers the visitor's address (DEPLOYMENT.md)
 *   0 / false    nothing in front: the API is reached directly
 *   a list       addresses or subnets of the trusted proxies, e.g.
 *                "loopback, 10.0.0.0/8" (passed to Express as given)
 */
function parseTrustProxy(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 1;
  const text = String(raw).trim().toLowerCase();
  if (text === 'false' || text === 'off' || text === 'no') return false;
  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    return hops === 0 ? false : hops;
  }
  return String(raw)
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

/**
 * Builds the crawler's User-Agent.
 *
 * Convention for a well-behaved bot is a name, a version and a URL a site
 * owner can visit to find out what hit them and how to block it. A bare
 * "PH-SearchBot" gives an administrator reading their access log no way to
 * reach anyone, which is how crawlers end up banned by default.
 *
 * The contact URL is only appended when it is actually set — inventing one
 * would be worse than omitting it.
 *
 * The name must not contain "Googlebot". Sites treat any user agent claiming
 * to be Googlebot from a non-Google address as an impersonation and refuse
 * it — Wikipedia answers "PH-GoogleBot/1.0" with a 403 — and robots.txt
 * rules written for Google's crawler would be applied to this one.
 */
const BOT_NAME = 'PH-SearchBot/1.0';

function buildUserAgent() {
  const explicit = (process.env.CRAWLER_USER_AGENT || '').trim();
  if (explicit) return explicit;

  const contact = (process.env.CRAWLER_CONTACT_URL || '').trim();
  return contact ? `${BOT_NAME} (+${contact})` : BOT_NAME;
}

const config = {
  nodeEnv: NODE_ENV,
  isProduction,
  isTest,
  port: toInt(process.env.PORT, 5000),

  mongoUri: process.env.MONGO_URI || '',

  jwt: {
    secret: process.env.JWT_SECRET || '',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },

  // --- Outgoing email (password-reset codes) -------------------------------
  // Plain SMTP, so any provider works (Amazon SES, SendGrid, Mailgun, Postmark,
  // Microsoft 365, Gmail/Workspace with an app password...). Email is "configured"
  // only when a host and a sender address are both set; without them the
  // forgot-password endpoint answers 503 instead of pretending to send.
  mail: {
    host: (process.env.MAIL_SMTP_HOST || '').trim(),
    port: toInt(process.env.MAIL_SMTP_PORT, 587),
    // true = TLS from the first byte (usually port 465); false = STARTTLS,
    // which is then required (requireTLS) so credentials never go in clear.
    secure: process.env.MAIL_SMTP_SECURE === 'true',
    user: (process.env.MAIL_SMTP_USER || '').trim(),
    pass: process.env.MAIL_SMTP_PASS || '',
    fromAddress: (process.env.MAIL_FROM_ADDRESS || '').trim(),
    fromName: (process.env.MAIL_FROM_NAME || 'PH Spectrum').trim(),
    timeoutMs: Math.max(1000, toInt(process.env.MAIL_SMTP_TIMEOUT_MS, 15000))
  },

  // --- Password reset by emailed code ------------------------------------
  passwordReset: {
    // How long an emailed code works, and how many wrong guesses it takes.
    otpTtlMs: 10 * 60 * 1000,
    maxAttempts: 5,
    // A new code at most once a minute, and at most this many per hour.
    resendCooldownMs: toInt(process.env.PASSWORD_RESET_RESEND_COOLDOWN_MS, 60 * 1000),
    maxSendsPerHour: Math.max(1, toInt(process.env.PASSWORD_RESET_MAX_SENDS_PER_HOUR, 5)),
    // After the code is accepted: how long the user has to choose a password.
    resetTokenTtlMs: 15 * 60 * 1000
  },

  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

  // CORS: explicit allow-list in production, localhost dev servers otherwise.
  cors: {
    origins: parseOrigins(process.env.FRONTEND_URL || process.env.FRONTEND_URLS),
    devOrigins: [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:5173',
      'http://127.0.0.1:5173'
    ]
  },

  search: {
    defaultLimit: toInt(process.env.SEARCH_DEFAULT_LIMIT, 10),
    maxLimit: toInt(process.env.SEARCH_MAX_LIMIT, 50),
    maxPage: toInt(process.env.SEARCH_MAX_PAGE, 500),
    maxQueryLength: toInt(process.env.SEARCH_MAX_QUERY_LENGTH, 200),
    // How many results of one search can be paged through. This is
    // OpenSearch's index.max_result_window, which the index leaves at its
    // default; it is a property of the index, not a tunable, so it is not
    // read from the environment.
    maxResultWindow: 10000
  },

  crawler: {
    // A crawler that does not say who it is, and how to ask it to stop, is a
    // nuisance to every site it visits. buildUserAgent appends the contact
    // URL when one is configured.
    userAgent: buildUserAgent(),
    contactUrl: (process.env.CRAWLER_CONTACT_URL || '').trim(),

    maxPagesHardLimit: toInt(process.env.CRAWLER_MAX_PAGES_LIMIT, 10000),
    defaultMaxPages: toInt(process.env.CRAWLER_DEFAULT_MAX_PAGES, 100),
    defaultMaxDepth: toInt(process.env.CRAWLER_DEFAULT_MAX_DEPTH, 3),
    maxDepthLimit: toInt(process.env.CRAWLER_MAX_DEPTH_LIMIT, 10),
    defaultDelayMs: toInt(process.env.CRAWLER_DELAY_MS, 1000),
    maxDelayMs: toInt(process.env.CRAWLER_MAX_DELAY_MS, 30000),
    requestTimeoutMs: toInt(process.env.CRAWLER_TIMEOUT_MS, 8000),
    maxTermsPerPage: toInt(process.env.CRAWLER_MAX_TERMS_PER_PAGE, 5000),
    maxConcurrentJobs: toInt(process.env.CRAWLER_MAX_CONCURRENT_JOBS, 2),

    // Largest response body the fetcher will buffer. Anything bigger is
    // recorded as `too_large` rather than held in memory.
    maxPageBytes: toInt(process.env.CRAWLER_MAX_PAGE_BYTES, 5 * 1024 * 1024),

    // Links from one page that may enter the frontier. An encyclopedia
    // article links to a thousand pages; a crawl budgeted at ten pages has
    // no use for the other 990 and storing them only grows the queue.
    maxLinksPerPage: toInt(process.env.CRAWLER_MAX_LINKS_PER_PAGE, 100),

    // --- Topic (seed catalog) crawls ------------------------------------
    // The catalog of topics and seed URLs. Empty means the bundled
    // config/crawlSeeds.json.
    seedsFile: (process.env.CRAWLER_SEEDS_FILE || '').trim(),
    // Pages each seed may crawl, unless a request asks for fewer.
    seedPagesPerSeed: toInt(process.env.CRAWLER_SEED_PAGES_PER_SEED, 5),
    // Link depth for seed crawls. Shallow keeps a crawl on its topic.
    seedMaxDepth: toInt(process.env.CRAWLER_SEED_MAX_DEPTH, 2),
    // Ceiling on the whole topic crawl: seeds x pages per seed must fit.
    maxPagesPerCrawl: toInt(process.env.CRAWLER_MAX_PAGES_PER_CRAWL, 300),

    // --- Continuous crawl ---------------------------------------------
    // Off: a job that spends its page budget skips every URL it had not
    // reached yet. On: those URLs stay pending and the maintenance sweep
    // hands them to a continuation job with the same scope and the same
    // budget, so the frontier keeps being worked through one bounded job at
    // a time. Only an explicit "true" turns it on.
    continuous: process.env.CRAWLER_CONTINUOUS === 'true',
    // Continuations one crawl may chain before its remaining URLs are
    // skipped as they are today. Keeps "continuous" from meaning "forever".
    continuousMaxContinuations: Math.max(
      0,
      toInt(process.env.CRAWLER_CONTINUOUS_MAX_CONTINUATIONS, 10)
    ),

    // --- Sitemap discovery --------------------------------------------
    // Off unless explicitly "true". When on, the worker reads a crawl host's
    // sitemaps once per crawl chain, after the chain's first page there.
    sitemaps: process.env.CRAWLER_SITEMAPS === 'true',
    // Sitemap files fetched per host in one discovery run, failures included.
    sitemapMaxFiles: Math.max(1, toInt(process.env.CRAWLER_SITEMAP_MAX_FILES, 5)),
    // How deep sitemap indexes may nest below the files robots.txt names.
    sitemapMaxDepth: Math.max(0, toInt(process.env.CRAWLER_SITEMAP_MAX_DEPTH, 2)),
    // Most URLs one discovery run may add to the frontier.
    sitemapMaxUrls: Math.max(0, toInt(process.env.CRAWLER_SITEMAP_MAX_URLS, 200)),
    // The parser stops reading a file after this many <loc> entries.
    sitemapMaxUrlsPerFile: Math.max(1, toInt(process.env.CRAWLER_SITEMAP_MAX_URLS_PER_FILE, 5000)),
    // Largest sitemap file, both as downloaded and after decompression. The
    // protocol allows 50 MB; this is deliberately lower.
    sitemapMaxBytes: Math.max(1024, toInt(process.env.CRAWLER_SITEMAP_MAX_BYTES, 10 * 1024 * 1024)),
    // Try /sitemap.xml when robots.txt names no sitemap. On unless "false".
    sitemapFallback: process.env.CRAWLER_SITEMAP_FALLBACK !== 'false',
    // A discovery still "running" after this long is taken to have died with
    // its worker, and may be claimed again.
    sitemapDiscoveryLeaseMs: Math.max(
      60 * 1000,
      toInt(process.env.CRAWLER_SITEMAP_DISCOVERY_LEASE_MS, 15 * 60 * 1000)
    ),
    // Attempts per crawl chain and host, the first included. A run that
    // failed for a temporary reason is retried until this many have been made.
    sitemapDiscoveryMaxAttempts: Math.max(
      1,
      toInt(process.env.CRAWLER_SITEMAP_DISCOVERY_MAX_ATTEMPTS, 2)
    ),

    // --- Worker -------------------------------------------------------
    // How many *hosts* the worker crawls at once. Politeness is per host, so
    // this is the cross-domain parallelism and not a per-site request rate.
    workerConcurrency: toInt(process.env.CRAWLER_WORKER_CONCURRENCY, 4),

    // Pages one host lease handles before yielding its worker slot. Without
    // a slice, a site with 50,000 pages would hold a slot until it finished
    // and every other host would wait behind it.
    hostSlicePages: toInt(process.env.CRAWLER_HOST_SLICE_PAGES, 10),

    // A URL claimed but never released — the worker was killed mid-fetch —
    // returns to the frontier after this long.
    leaseTimeoutMs: toInt(process.env.CRAWLER_LEASE_TIMEOUT_MS, 120000),

    // How often the maintenance job reclaims stale leases, re-queues pages
    // due for a re-crawl, and closes out finished jobs.
    maintenanceIntervalMs: toInt(process.env.CRAWLER_MAINTENANCE_INTERVAL_MS, 60000),

    // How long a running crawl may go without any sign of progress — while
    // the crawler is demonstrably running — before it is failed as
    // abandoned. Deliberately long: the later seeds of a topic crawl share
    // one host and wait their turn, and on a site like Wikipedia (~3.5s per
    // page at a 1s politeness delay) a 38-seed crawl keeps some of its jobs
    // waiting for well over a quarter of an hour. Floored in the sweep at
    // several lease timeouts so a short value cannot race a slow fetch.
    orphanTimeoutMs: toInt(process.env.CRAWLER_ORPHAN_TIMEOUT_MS, 30 * 60 * 1000),

    // A crawled page becomes eligible for re-crawling after this many days.
    recrawlAfterDays: toInt(process.env.CRAWLER_RECRAWL_AFTER_DAYS, 7),

    // Attempts before a frontier URL is abandoned.
    maxAttemptsPerUrl: toInt(process.env.CRAWLER_MAX_ATTEMPTS_PER_URL, 3)
  },

  // --- Redis ------------------------------------------------------------
  // Carries the crawl queue only. Nothing durable lives here: the frontier
  // and every job record are in MongoDB, so losing Redis loses scheduling,
  // not crawl state.
  redis: {
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    queuePrefix: process.env.CRAWLER_QUEUE_PREFIX || 'ph-google',
    // Keep a bounded history so the admin view has something to show without
    // Redis growing without limit.
    keepCompletedJobs: toInt(process.env.CRAWLER_QUEUE_KEEP_COMPLETED, 200),
    keepFailedJobs: toInt(process.env.CRAWLER_QUEUE_KEEP_FAILED, 500)
  },

  // --- OpenSearch -----------------------------------------------------
  // OpenSearch is the primary engine for web search. MongoDB keeps every
  // other kind of data (users, history, analytics, crawl jobs, verticals).
  opensearch: {
    node: process.env.OPENSEARCH_NODE || 'http://localhost:9200',
    username: process.env.OPENSEARCH_USERNAME || '',
    password: process.env.OPENSEARCH_PASSWORD || '',
    index: process.env.OPENSEARCH_INDEX || 'ph-google-pages',
    requestTimeoutMs: toInt(process.env.OPENSEARCH_REQUEST_TIMEOUT_MS, 10000),
    pingTimeoutMs: toInt(process.env.OPENSEARCH_PING_TIMEOUT_MS, 3000),
    maxRetries: toInt(process.env.OPENSEARCH_MAX_RETRIES, 2),
    bulkBatchSize: toInt(process.env.OPENSEARCH_BULK_BATCH_SIZE, 250),
    // Self-signed certificates are normal for a local secured cluster.
    rejectUnauthorized: process.env.OPENSEARCH_TLS_REJECT_UNAUTHORIZED !== 'false',
    numberOfShards: toInt(process.env.OPENSEARCH_SHARDS, 1),
    numberOfReplicas: toInt(process.env.OPENSEARCH_REPLICAS, 0)
  },

  // Which engine answers web search. 'opensearch' is the architecture;
  // 'mongo' selects the superseded inverted index and exists only as an
  // explicit, documented rollback switch. There is never a silent fallback.
  searchEngine: (process.env.SEARCH_ENGINE || 'opensearch').toLowerCase(),

  rateLimit: {
    // Generous by default so local development and test runs are never blocked.
    authWindowMs: toInt(process.env.RATE_LIMIT_AUTH_WINDOW_MS, 15 * 60 * 1000),
    authMax: toInt(process.env.RATE_LIMIT_AUTH_MAX, 30),
    searchWindowMs: toInt(process.env.RATE_LIMIT_SEARCH_WINDOW_MS, 60 * 1000),
    searchMax: toInt(process.env.RATE_LIMIT_SEARCH_MAX, 120),
    crawlerWindowMs: toInt(process.env.RATE_LIMIT_CRAWLER_WINDOW_MS, 60 * 1000),
    crawlerMax: toInt(process.env.RATE_LIMIT_CRAWLER_MAX, 20),
    // AI answers call a paid model, so they get a much tighter budget than search.
    aiWindowMs: toInt(process.env.RATE_LIMIT_AI_WINDOW_MS, 60 * 1000),
    aiMax: toInt(process.env.RATE_LIMIT_AI_MAX, 20),
    // Image downloads make this server fetch a remote file, so they are
    // limited more tightly than search.
    imageWindowMs: toInt(process.env.RATE_LIMIT_IMAGE_WINDOW_MS, 60 * 1000),
    imageMax: toInt(process.env.RATE_LIMIT_IMAGE_MAX, 30),
    embedWindowMs: toInt(process.env.RATE_LIMIT_EMBED_WINDOW_MS, 60 * 1000),
    embedMax: toInt(process.env.RATE_LIMIT_EMBED_MAX, 60),
    // Password recovery, per client IP (on top of the per-account limits in
    // passwordReset): requesting codes, and entering codes / new passwords.
    recoveryWindowMs: toInt(process.env.RATE_LIMIT_RECOVERY_WINDOW_MS, 15 * 60 * 1000),
    recoveryRequestMax: toInt(process.env.RATE_LIMIT_RECOVERY_REQUEST_MAX, 5),
    recoveryVerifyMax: toInt(process.env.RATE_LIMIT_RECOVERY_VERIFY_MAX, 20),
    disabled: process.env.DISABLE_RATE_LIMIT === 'true' || isTest
  },

  // --- AI answers (retrieval-augmented generation) ------------------------
  // The answer shown above the web results. It is written by a language
  // model from the documents the search engine retrieved, never from the
  // model's own knowledge. Nothing here is required: without an API key the
  // endpoint reports "not configured" and search works exactly as before.
  ai: {
    // Off switch for the whole feature. On unless explicitly "false".
    enabled: process.env.AI_ANSWERS_ENABLED !== 'false',
    // Which entry of services/ai/llm/ generates the answer.
    provider: (process.env.AI_PROVIDER || 'anthropic').trim().toLowerCase(),
    model: (process.env.AI_MODEL || 'claude-opus-5-5').trim(),
    // Server-side only. Never sent to the browser and never logged.
    apiKey: (process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim(),
    // Only for a proxy or gateway in front of the provider.
    baseUrl: (process.env.AI_BASE_URL || '').trim(),
    // low | medium | high | xhigh | max. An answer box is latency-sensitive
    // and the task is a short grounded summary, so the default is low.
    effort: (process.env.AI_EFFORT || 'low').trim().toLowerCase(),
    // Ceiling on one response, the model's reasoning included.
    maxOutputTokens: Math.max(256, toInt(process.env.AI_MAX_OUTPUT_TOKENS, 8000)),
    // Give up on the model after this long; search results are unaffected.
    timeoutMs: Math.max(1000, toInt(process.env.AI_TIMEOUT_MS, 30000)),
    // Re-run a request the model's safety system declined on the provider's
    // recommended fallback model. On unless "false".
    refusalFallback: process.env.AI_REFUSAL_FALLBACK !== 'false',

    // --- Retrieval -------------------------------------------------------
    // Search results fetched as candidate evidence.
    retrievalCount: Math.min(20, Math.max(1, toInt(process.env.AI_RETRIEVAL_COUNT, 8))),
    // Sources actually given to the model, best first.
    maxSources: Math.min(10, Math.max(1, toInt(process.env.AI_MAX_SOURCES, 5))),
    // A candidate scoring below this share of the best hit is dropped: a
    // weak match is noise, not evidence.
    minRelativeScore: Math.min(1, Math.max(0, Number(process.env.AI_MIN_RELATIVE_SCORE) || 0.3)),

    // --- Context ---------------------------------------------------------
    // Characters of evidence per source, and in total.
    maxCharsPerSource: Math.max(200, toInt(process.env.AI_MAX_CHARS_PER_SOURCE, 1800)),
    maxContextChars: Math.max(500, toInt(process.env.AI_MAX_CONTEXT_CHARS, 8000)),
    // Less usable evidence than this in total and the model is not called.
    minEvidenceChars: Math.max(0, toInt(process.env.AI_MIN_EVIDENCE_CHARS, 200)),

    // --- Cache -----------------------------------------------------------
    // Identical questions within this window reuse the answer. 0 disables.
    cacheTtlMs: Math.max(0, toInt(process.env.AI_CACHE_TTL_MS, 10 * 60 * 1000)),
    cacheMaxEntries: Math.max(1, toInt(process.env.AI_CACHE_MAX_ENTRIES, 200))
  },

  // --- External web search (SerpApi: Google web results) ------------------
  // Google results added after the index's own results on the first page of
  // a web search. Off unless SERPAPI_ENABLED=true and a key is set; while
  // off, no request is ever made. Never used by AI answers, never stored.
  serpapi: {
    enabled: process.env.SERPAPI_ENABLED === 'true',
    // Server-side only. Never sent to the browser, never logged.
    apiKey: (process.env.SERPAPI_API_KEY || '').trim(),
    // Only Google web search is implemented.
    engine: (process.env.SERPAPI_ENGINE || 'google').trim().toLowerCase(),
    // Only for tests (a local stand-in) or a proxy.
    baseUrl: (process.env.SERPAPI_BASE_URL || 'https://serpapi.com').trim().replace(/\/+$/, ''),
    // Give up on a SerpApi web search after this long; the index's results
    // are unaffected. SERPAPI_WEB_TIMEOUT_MS, or its older name
    // SERPAPI_TIMEOUT_MS.
    timeoutMs: Math.min(
      15000,
      Math.max(
        500,
        toInt(process.env.SERPAPI_WEB_TIMEOUT_MS, toInt(process.env.SERPAPI_TIMEOUT_MS, 3000))
      )
    ),
    // The same for the Images, Videos and Maps tabs. Longer, because there
    // SerpApi is the whole result rather than an addition to it: waiting a
    // few seconds beats showing nothing.
    verticalTimeoutMs: Math.min(
      20000,
      Math.max(1000, toInt(process.env.SERPAPI_VERTICAL_TIMEOUT_MS, 8000))
    ),
    // Google results shown under the index's results (Google returns ~10).
    maxResults: Math.min(10, Math.max(1, toInt(process.env.SERPAPI_MAX_RESULTS, 10))),
    // Optional localisation: a SerpApi location name, a country code (gl) and
    // the interface language (hl).
    location: (process.env.SERPAPI_LOCATION || '').trim(),
    gl: (process.env.SERPAPI_GL || '').trim().toLowerCase(),
    hl: (process.env.SERPAPI_HL || 'en').trim().toLowerCase(),
    // Identical requests within this window reuse the stored response. 0 disables.
    cacheTtlMs: Math.max(0, toInt(process.env.SERPAPI_CACHE_TTL_MS, 10 * 60 * 1000)),
    cacheMaxEntries: Math.max(1, toInt(process.env.SERPAPI_CACHE_MAX_ENTRIES, 200)),
    // Successful requests per UTC day by this process (failures are handed
    // back: SerpApi does not charge them); past it SerpApi is skipped
    // until midnight. The free plan has 250 searches a month (~8 a day).
    // 0 means no daily cap.
    dailyLimit: Math.max(0, toInt(process.env.SERPAPI_DAILY_LIMIT, 8)),
    // 0: ask SerpApi on every eligible first page, in parallel with the index.
    // N: ask only when the index found fewer than N results.
    minInternalResults: Math.max(0, toInt(process.env.SERPAPI_MIN_INTERNAL_RESULTS, 0)),
    // Requests in flight at once; a search beyond this skips SerpApi.
    maxConcurrent: Math.max(1, toInt(process.env.SERPAPI_MAX_CONCURRENT, 2))
  },

  // --- Which provider adds external web results ---------------------------
  // The index always answers first; this chooses who supplies the extra web
  // results appended on page 1. (Not SEARCH_ENGINE, which chooses the index.)
  externalSearch: {
    // serpapi (Google results, the default) | bing | parallel.
    // EXTERNAL_SEARCH_PROVIDER is the same setting under a clearer name and
    // wins when both are set; SEARCH_PROVIDER keeps working on its own.
    provider: (process.env.EXTERNAL_SEARCH_PROVIDER || process.env.SEARCH_PROVIDER || 'serpapi')
      .trim()
      .toLowerCase(),
    // When the chosen provider cannot answer (timeout, outage, rate limit,
    // rejected key), ask the others that are configured. On unless "false".
    // Set it to "false" to use the chosen provider exclusively.
    fallback: process.env.SEARCH_PROVIDER_FALLBACK !== 'false',
    // Decide by what the index found, not by how much. When no indexed page
    // is about the query (every query word in its title, headings,
    // description or address), the external provider is asked and its
    // results are placed first. "false" restores the count-only rule
    // (SERPAPI_MIN_INTERNAL_RESULTS), with index results always first.
    relevanceGate: process.env.EXTERNAL_RELEVANCE_GATE !== 'false',
    // Check that a provider's web results cover the query's meaningful words
    // before showing or caching them (services/external/resultRelevance.js).
    // A list that does not is rejected; SerpApi is asked once more for a
    // fresh copy, then the other provider. "false" accepts whatever arrives.
    validateResults: process.env.EXTERNAL_RESULT_VALIDATION !== 'false'
  },

  // --- Bing web search (RapidAPI: bing-search-apis) ------------------------
  // Used for the external web results when SEARCH_PROVIDER=bing. Web search
  // only: images, videos, maps and trends stay with SerpApi.
  bing: {
    // Server-side only. Sent as a request header; never logged or returned.
    apiKey: (process.env.BING_SEARCH_API_KEY || '').trim(),
    // The RapidAPI host this key is subscribed to.
    host: (process.env.BING_SEARCH_HOST || 'bing-search-apis.p.rapidapi.com').trim(),
    // Only for tests (a local stand-in) or a proxy. Defaults to https://<host>.
    baseUrl: (process.env.BING_SEARCH_BASE_URL || '').trim().replace(/\/+$/, ''),
    // Give up on Bing after this long; the fallback or the index answers.
    timeoutMs: Math.min(15000, Math.max(500, toInt(process.env.BING_SEARCH_TIMEOUT_MS, 3000))),
    // Results asked for and shown under the index's results.
    maxResults: Math.min(20, Math.max(1, toInt(process.env.BING_SEARCH_MAX_RESULTS, 10))),
    // Country code sent as `cc`.
    cc: (process.env.BING_SEARCH_CC || 'IN').trim().toUpperCase(),
    // Identical requests within this window reuse the stored response. 0 disables.
    cacheTtlMs: Math.max(0, toInt(process.env.BING_SEARCH_CACHE_TTL_MS, 10 * 60 * 1000)),
    cacheMaxEntries: Math.max(1, toInt(process.env.BING_SEARCH_CACHE_MAX_ENTRIES, 200)),
    // Successful requests per UTC day from this process. 0 means no daily cap.
    dailyLimit: Math.max(0, toInt(process.env.BING_SEARCH_DAILY_LIMIT, 50)),
    // Requests in flight at once; a search beyond this skips Bing.
    maxConcurrent: Math.max(1, toInt(process.env.BING_SEARCH_MAX_CONCURRENT, 2))
  },

  // --- Parallel web search (Parallel Search API) ---------------------------
  // POST {baseUrl}/v1/search: ranked URLs with excerpts. Used for the external
  // web results when the provider above is `parallel`. Web search only:
  // images, videos, maps and trends stay with SerpApi. Never used by AI
  // answers, never stored.
  parallel: {
    // Asked only when this is "true" and a key is set. While off, no request
    // is ever made — also not as a fallback for another provider.
    enabled: process.env.PARALLEL_ENABLED === 'true',
    // Server-side only. Sent in the x-api-key header; never logged or returned.
    apiKey: (process.env.PARALLEL_API_KEY || '').trim(),
    // Only for tests (a local stand-in) or a proxy.
    baseUrl: (process.env.PARALLEL_BASE_URL || 'https://api.parallel.ai')
      .trim()
      .replace(/\/+$/, ''),
    // turbo | fast | basic | advanced. The API's own default is `advanced`
    // (~3s); `fast` answers in about a second, which a results page can wait for.
    mode: (process.env.PARALLEL_MODE || 'fast').trim().toLowerCase(),
    // Give up on Parallel after this long; the fallback or the index answers.
    timeoutMs: Math.min(15000, Math.max(500, toInt(process.env.PARALLEL_TIMEOUT_MS, 4000))),
    // Results asked for and shown with the index's results.
    maxResults: Math.min(10, Math.max(1, toInt(process.env.PARALLEL_MAX_RESULTS, 10))),
    // Identical requests within this window reuse the stored response. 0 disables.
    cacheTtlMs: Math.max(0, toInt(process.env.PARALLEL_CACHE_TTL_MS, 10 * 60 * 1000)),
    cacheMaxEntries: Math.max(1, toInt(process.env.PARALLEL_CACHE_MAX_ENTRIES, 200)),
    // Requests sent per UTC day from this process. Every request sent counts,
    // failed or not: how Parallel bills a failed request is not documented, so
    // none is assumed free. A safety cap, not a plan figure. 0 means no cap.
    dailyLimit: Math.max(0, toInt(process.env.PARALLEL_DAILY_LIMIT, 100)),
    // Requests in flight at once; a search beyond this skips Parallel.
    maxConcurrent: Math.max(1, toInt(process.env.PARALLEL_MAX_CONCURRENT, 2)),
    // Let the Images and Videos tabs use Parallel for discovery while SerpApi
    // cannot serve them (services/parallelVerticals.js). Off unless "true":
    // it makes this server read the pages Parallel finds, at search time.
    verticals: process.env.PARALLEL_VERTICALS_ENABLED === 'true'
  },

  // --- Maps: OpenStreetMap (Nominatim) -----------------------------------
  // Used by the Maps tab to check a pin against where OpenStreetMap places
  // the town its address names, and to add places OpenStreetMap itself knows
  // (services/external/nominatimClient.js). No key. Off unless "true": it
  // sends the search text and town names to the service below.
  maps: {
    osm: {
      enabled: process.env.MAPS_OSM_ENABLED === 'true',
      // The public service by default. Its usage policy requires that this
      // can be changed without a new build — point it at your own Nominatim
      // if the deployment outgrows the public one.
      baseUrl: (process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org')
        .trim()
        .replace(/\/+$/, ''),
      // The policy requires the application to identify itself; a library's
      // default User-Agent is refused. Include a contact address or URL.
      userAgent: (
        process.env.NOMINATIM_USER_AGENT ||
        `PH-Search-Maps/1.0${(process.env.CRAWLER_CONTACT_URL || '').trim() ? ` (+${process.env.CRAWLER_CONTACT_URL.trim()})` : ''}`
      ).trim(),
      timeoutMs: Math.min(15000, Math.max(1000, toInt(process.env.NOMINATIM_TIMEOUT_MS, 5000))),
      // Never two requests within this long of each other. The policy's
      // absolute limit is one a second; this cannot be set below it.
      minIntervalMs: Math.max(1000, toInt(process.env.NOMINATIM_MIN_INTERVAL_MS, 1100)),
      // A search does not wait behind a queue longer than this; it goes without.
      maxWaitMs: Math.max(0, toInt(process.env.NOMINATIM_MAX_WAIT_MS, 6000)),
      // Requests per UTC day from this process. 0 means no cap.
      dailyLimit: Math.max(0, toInt(process.env.NOMINATIM_DAILY_LIMIT, 500)),
      // Answers are kept this long (the policy requires caching). Towns do not move.
      cacheTtlMs: Math.max(0, toInt(process.env.NOMINATIM_CACHE_TTL_MS, 7 * 24 * 60 * 60 * 1000)),
      cacheMaxEntries: Math.max(1, toInt(process.env.NOMINATIM_CACHE_MAX_ENTRIES, 1000))
    }
  },

  // --- Trending now (the homepage card) ----------------------------------
  // GET /api/trending: current trending searches for a country, from
  // SerpApi's Google Trends "Trending Now" engine. Uses the SerpApi settings
  // above (key, on/off switch, daily limit); nothing else is required.
  trending: {
    // Country used when a request names none. ISO code: IN, US, GB, …
    region: (process.env.TRENDING_REGION || 'IN').trim().toUpperCase(),
    // How long fetched trends are served before asking again. Every refresh
    // is one SerpApi search, counted in SERPAPI_DAILY_LIMIT.
    cacheTtlMs: Math.max(60 * 1000, toInt(process.env.TRENDING_CACHE_TTL_MS, 10 * 60 * 1000)),
    // Give up on a refresh after this long; the card keeps what it had.
    timeoutMs: Math.min(20000, Math.max(1000, toInt(process.env.TRENDING_TIMEOUT_MS, 8000))),
    // Trends returned to the homepage.
    maxItems: Math.min(20, Math.max(1, toInt(process.env.TRENDING_MAX_ITEMS, 8)))
  },

  // --- Image download (the Download button in image search) --------------
  // GET /api/images/download fetches one image the search results pointed at
  // and returns it as an attachment. Only addresses this server signed are
  // accepted, only public hosts are fetched, and only real images returned.
  imageDownload: {
    // One deadline for the whole fetch, redirects and body included.
    timeoutMs: Math.min(30000, Math.max(1000, toInt(process.env.IMAGE_DOWNLOAD_TIMEOUT_MS, 8000))),
    // Largest image handed on; anything bigger is refused.
    maxBytes: Math.min(
      50 * 1024 * 1024,
      Math.max(64 * 1024, toInt(process.env.IMAGE_DOWNLOAD_MAX_BYTES, 15 * 1024 * 1024))
    ),
    // Redirects followed; every hop is checked like the first address.
    maxRedirects: Math.min(5, Math.max(0, toInt(process.env.IMAGE_DOWNLOAD_MAX_REDIRECTS, 3)))
  },

  logLevel: process.env.LOG_LEVEL || (isTest ? 'error' : 'info')
};

/**
 * Validates configuration required to actually serve traffic.
 * Called from server.js (not from app.js) so tests can build the app
 * with their own injected settings.
 */
function assertValidConfig() {
  const errors = [];

  if (!config.mongoUri) {
    errors.push('MONGO_URI is not set. Copy .env.example to .env and fill it in.');
  }
  if (!config.jwt.secret) {
    errors.push(
      "JWT_SECRET is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
    );
  } else if (config.jwt.secret.length < 32 && isProduction) {
    errors.push('JWT_SECRET must be at least 32 characters in production.');
  }
  if (isProduction && config.cors.origins.length === 0) {
    errors.push('FRONTEND_URL must list the allowed frontend origin(s) in production.');
  }

  if (errors.length) {
    const err = new Error('Invalid environment configuration:\n  - ' + errors.join('\n  - '));
    err.isConfigError = true;
    throw err;
  }
}

/**
 * Configuration that is legal but worth saying out loud at startup.
 *
 * Separate from assertValidConfig because none of these should stop the
 * process — refusing to boot over a missing contact URL would be worse than
 * the problem it describes.
 *
 * @returns {string[]}
 */
function configWarnings() {
  const warnings = [];

  if (!config.crawler.contactUrl && !process.env.CRAWLER_USER_AGENT) {
    warnings.push(
      'CRAWLER_CONTACT_URL is not set, so the crawler identifies itself as ' +
        `"${config.crawler.userAgent}" with no way for a site owner to reach you. ` +
        'Set it to a page describing the bot.'
    );
  }

  if (isProduction && config.redis.url.includes('127.0.0.1')) {
    warnings.push('REDIS_URL still points at localhost in production.');
  }

  return warnings;
}

module.exports = { config, assertValidConfig, configWarnings, parseTrustProxy };
