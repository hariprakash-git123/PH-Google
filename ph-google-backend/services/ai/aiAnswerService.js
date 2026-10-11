const crypto = require('crypto');
const { config } = require('../../config/env');
const logger = require('../../utils/logger');
const { detectIntent } = require('./intentService');
const retrievalService = require('./retrievalService');
const { buildContext } = require('./contextService');
const { buildPrompt, parseModelReply } = require('./promptBuilder');
const { mapCitations } = require('./citationService');
const llm = require('./llm');
const { LlmError } = require('./llm/llmError');

/**
 * AI answers: retrieval-augmented generation over the search index.
 *
 *   query -> intent -> retrieval (the existing search) -> context builder
 *         -> prompt -> language model -> citation mapper -> response
 *
 * The model is only called when there is real evidence to give it, and its
 * reply only becomes an answer if it cites that evidence. Every other
 * outcome is a status, not an error: an answer box that has nothing to say
 * must never take the search page down with it.
 *
 *   ok                     a grounded answer with its sources
 *   no_results             the search found nothing; the model was not called
 *   insufficient_evidence  nothing usable to answer from, or the model said so
 *   not_configured         no provider credentials
 *   disabled               AI_ANSWERS_ENABLED=false
 *   unavailable            the provider failed (timeout, rate limit, outage, …)
 */

const MESSAGES = {
  no_results: 'No reliable sources were found for an AI answer.',
  insufficient_evidence:
    "I couldn't find enough reliable information in the available search results to give a confident answer.",
  not_configured: 'AI answers are not configured on this server.',
  disabled: 'AI answers are turned off.',
  unavailable: 'AI answer is temporarily unavailable.'
};

// ---------------------------------------------------------------- cache
// A short-lived, bounded, in-process cache. The same question asked again
// within a few minutes gets the same answer without a second model call.
// Per process on purpose: answers are cheap to regenerate and this feature
// should not make Redis (which carries the crawl queue) a dependency of search.
const cache = new Map();
const inFlight = new Map();

function cacheKey({ query, domain, language, dateWindow, maxSources }) {
  const normalised = String(query).toLowerCase().replace(/\s+/g, ' ').trim();
  return JSON.stringify([
    normalised,
    domain || '',
    language || '',
    dateWindow || 'any',
    maxSources || 0,
    config.ai.provider,
    config.ai.model
  ]);
}

function readCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key, value) {
  if (config.ai.cacheTtlMs <= 0) return;
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + config.ai.cacheTtlMs });
  // Map iterates in insertion order, so the first key is the oldest.
  while (cache.size > config.ai.cacheMaxEntries) cache.delete(cache.keys().next().value);
}

function clearCache() {
  cache.clear();
  inFlight.clear();
}

// ------------------------------------------------------------- response
function baseResponse(query, intent) {
  return {
    answerId: crypto.randomUUID(),
    query,
    intent,
    status: 'ok',
    generated: false,
    answer: '',
    summary: '',
    keyPoints: [],
    sources: [],
    message: null,
    reason: null,
    provider: null,
    model: null,
    cached: false,
    retrieval: { totalResults: 0, retrieved: 0, offTopic: 0, used: 0 },
    timings: { retrievalMs: 0, generationMs: 0 },
    processingTimeMs: 0
  };
}

function withStatus(response, status, reason = null) {
  return { ...response, status, reason, generated: false, message: MESSAGES[status] || null };
}

/** The first sentence of the answer, without citation markers. */
function summarise(answer) {
  const plain = String(answer || '')
    .replace(/\[\d+\]/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const firstSentence = plain.match(/^.*?[.!?](?=\s|$)/);
  const summary = firstSentence ? firstSentence[0] : plain;
  return summary.length > 280 ? `${summary.slice(0, 277).trim()}…` : summary;
}

// ------------------------------------------------------------- pipeline
async function generate({ query, domain, language, dateWindow, maxSources }) {
  const startedAt = Date.now();
  const intent = detectIntent(query);
  let response = baseResponse(query, intent);
  const finish = result => ({ ...result, processingTimeMs: Date.now() - startedAt });

  // 1. Retrieval — the existing search, then the text of what it found.
  const retrieval = await retrievalService.retrieve({ query, domain, language, dateWindow });
  response.timings.retrievalMs = retrieval.responseTimeMs;
  response.retrieval = {
    totalResults: retrieval.totalResults,
    retrieved: retrieval.retrieved,
    offTopic: retrieval.offTopic || 0,
    used: 0
  };
  if (retrieval.documents.length === 0) {
    // Pages were found, but none whose text covers the question: not "no
    // results", and nothing for a model to answer from.
    if (retrieval.offTopic > 0) {
      return finish(withStatus(response, 'insufficient_evidence', 'no_relevant_evidence'));
    }
    return finish(withStatus(response, 'no_results'));
  }

  // 2. Context — cleaned, de-duplicated, numbered, within budget.
  const context = buildContext({
    query,
    documents: retrieval.documents,
    limits: maxSources ? { maxSources } : {}
  });
  response.retrieval.used = context.sources.length;

  const bestMatch = context.sources.reduce((max, s) => Math.max(max, s.matchScore), 0);
  const nothingRelevant = context.terms.length > 0 && bestMatch === 0;
  if (
    context.sources.length === 0 ||
    context.totalChars < config.ai.minEvidenceChars ||
    nothingRelevant
  ) {
    // Not worth a model call: there is nothing to ground an answer in.
    return finish(withStatus(response, 'insufficient_evidence', 'no_usable_evidence'));
  }

  // 3. Generation.
  const provider = llm.getProvider();
  response.provider = provider.name;
  response.model = provider.model;
  const prompt = buildPrompt({ query, intent, sources: context.sources });

  const generationStartedAt = Date.now();
  let reply;
  try {
    reply = await provider.generate(prompt);
  } catch (error) {
    // A provider is meant to throw LlmError; one that throws anything else
    // has still only failed to produce an answer.
    if (error instanceof LlmError) throw error;
    logger.error('AI provider threw an unexpected error', { provider: provider.name });
    throw new LlmError('unavailable', 'The AI provider failed unexpectedly.');
  } finally {
    response.timings.generationMs = Date.now() - generationStartedAt;
  }
  response.model = (reply && reply.model) || provider.model;

  const parsed = parseModelReply(reply && reply.text);
  if (!parsed) throw new LlmError('invalid_response', 'The AI reply could not be read.');
  if (!parsed.sufficientEvidence) {
    return finish(withStatus(response, 'insufficient_evidence', 'model_declined'));
  }

  // 4. Citations — numbers back to the documents retrieval returned.
  const mapped = mapCitations({
    answer: parsed.answer,
    keyPoints: parsed.keyPoints,
    citedSources: parsed.citedSources,
    sources: context.sources
  });
  if (mapped.citationCount === 0 || !mapped.answer) {
    // An answer that cites nothing cannot be checked against anything.
    return finish(withStatus(response, 'insufficient_evidence', 'uncited_answer'));
  }

  response = {
    ...response,
    status: 'ok',
    generated: true,
    answer: mapped.answer,
    summary: summarise(mapped.answer),
    keyPoints: mapped.keyPoints,
    sources: mapped.sources,
    usage: reply.usage || null,
    invalidCitations: mapped.invalidCitations.length
  };
  return finish(response);
}

function logOutcome(response, extra = {}) {
  const level = response.status === 'unavailable' ? 'warn' : 'info';
  logger[level]('AI answer', {
    query: String(response.query).slice(0, 200),
    intent: response.intent,
    status: response.status,
    reason: response.reason || undefined,
    retrieved: response.retrieval.retrieved,
    sourcesUsed: response.retrieval.used,
    sourcesCited: response.sources.length,
    retrievalMs: response.timings.retrievalMs,
    generationMs: response.timings.generationMs,
    totalMs: response.processingTimeMs,
    provider: response.provider || undefined,
    model: response.model || undefined,
    cached: response.cached,
    inputTokens: response.usage ? response.usage.inputTokens : undefined,
    outputTokens: response.usage ? response.usage.outputTokens : undefined,
    ...extra
  });
}

/** What the browser is sent: the answer, never token counts or internals. */
function toPublic(response) {
  const { usage: _usage, invalidCitations: _invalid, ...rest } = response;
  return rest;
}

/**
 * Answers a query from the search index.
 *
 * Never throws for anything the model or its provider does; those become
 * `status: "unavailable"`. A failure of the search engine itself is thrown,
 * exactly as it is from /api/search.
 *
 * @param {Object} params
 * @param {string} params.query        already validated, non-empty
 * @param {string} [params.domain]
 * @param {string} [params.language]
 * @param {string} [params.dateWindow]
 * @param {number} [params.maxSources]
 * @param {boolean} [params.refresh]   bypass the cache ("regenerate")
 * @returns {Promise<Object>}
 */
async function answerQuery({
  query,
  domain = '',
  language = '',
  dateWindow = 'any',
  maxSources,
  refresh = false
}) {
  const intent = detectIntent(query);

  if (!config.ai.enabled) return toPublic(withStatus(baseResponse(query, intent), 'disabled'));
  if (!llm.isConfigured()) {
    return toPublic(withStatus(baseResponse(query, intent), 'not_configured'));
  }

  const params = { query, domain, language, dateWindow, maxSources };
  const key = cacheKey(params);

  if (!refresh) {
    const hit = readCache(key);
    if (hit) {
      const response = { ...hit, cached: true };
      logOutcome(response);
      return toPublic(response);
    }
    // Two people asking the same thing at once share one model call.
    if (inFlight.has(key)) return toPublic(await inFlight.get(key));
  }

  const task = (async () => {
    const startedAt = Date.now();
    try {
      const response = await generate(params);
      // "No results" is not cached: the index grows, and the next crawl may
      // well have the answer.
      if (response.status === 'ok' || response.status === 'insufficient_evidence') {
        writeCache(key, response);
      }
      logOutcome(response);
      return response;
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      const response = {
        ...withStatus(baseResponse(query, intent), 'unavailable', error.code),
        provider: config.ai.provider,
        model: config.ai.model,
        processingTimeMs: Date.now() - startedAt
      };
      // The message is the provider wrapper's own wording; it never holds a key.
      logOutcome(response, { error: error.message });
      return response;
    }
  })();

  inFlight.set(key, task);
  try {
    return toPublic(await task);
  } finally {
    inFlight.delete(key);
  }
}

/** Whether the feature can produce answers, for /api/search/config. */
function describe() {
  return {
    enabled: config.ai.enabled,
    configured: config.ai.enabled && llm.isConfigured(),
    provider: config.ai.provider,
    model: config.ai.model
  };
}

module.exports = { answerQuery, describe, clearCache, summarise, MESSAGES };
