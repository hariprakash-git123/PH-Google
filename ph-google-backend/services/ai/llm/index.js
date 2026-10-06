const { config } = require('../../../config/env');
const { LlmError } = require('./llmError');
const { createAnthropicProvider } = require('./anthropicProvider');

/**
 * The language-model provider behind AI answers.
 *
 * The answer pipeline depends on one small contract and nothing else:
 *
 *   provider.name                         'anthropic'
 *   provider.model                        the configured model id
 *   provider.isConfigured()               has what it needs to make a call
 *   provider.generate({system, user, schema})
 *       -> { text, model, stopReason, usage: { inputTokens, outputTokens } }
 *       throws LlmError (see llmError.js) for every failure
 *
 * To add a provider: write a factory with that contract, add it to FACTORIES
 * and set AI_PROVIDER to its name. Retrieval, context building, the prompt
 * and citation mapping do not change.
 */

const FACTORIES = {
  anthropic: createAnthropicProvider
};

let cached = null;

function settings() {
  const ai = config.ai;
  return {
    apiKey: ai.apiKey,
    baseUrl: ai.baseUrl,
    model: ai.model,
    effort: ai.effort,
    maxOutputTokens: ai.maxOutputTokens,
    timeoutMs: ai.timeoutMs,
    refusalFallback: ai.refusalFallback
  };
}

/**
 * The configured provider.
 * @throws {LlmError} `not_configured` when AI_PROVIDER names nothing known
 */
function getProvider() {
  if (cached) return cached;
  const factory = FACTORIES[config.ai.provider];
  if (!factory) {
    throw new LlmError(
      'not_configured',
      `Unknown AI_PROVIDER "${config.ai.provider}". Known providers: ${Object.keys(FACTORIES).join(', ')}.`
    );
  }
  cached = factory(settings());
  return cached;
}

/** Whether an answer can be generated at all, without throwing. */
function isConfigured() {
  try {
    return getProvider().isConfigured();
  } catch {
    return false;
  }
}

/** Replaces the provider. Used by the tests to supply a controllable one. */
function setProvider(provider) {
  cached = provider;
}

/** Forgets the built provider so the next call rebuilds it from config. */
function resetProvider() {
  cached = null;
}

module.exports = { getProvider, isConfigured, setProvider, resetProvider, LlmError };
