const AnthropicModule = require('@anthropic-ai/sdk');
const { LlmError } = require('./llmError');

const Anthropic = AnthropicModule.default || AnthropicModule;

/**
 * Claude, through the official Anthropic SDK.
 *
 * One request per answer: the system prompt, one user message carrying the
 * query and the numbered sources, and a JSON schema the reply must match.
 *
 * Notes on the request:
 *  - `output_config.format` makes the reply schema-valid JSON, so the answer
 *    is parsed rather than scraped out of prose.
 *  - `output_config.effort` is how depth is controlled on current models;
 *    there is no temperature or thinking budget to set. Leave AI_EFFORT
 *    empty for a model that does not accept it.
 *  - With AI_REFUSAL_FALLBACK on, a request the model's safety system
 *    declines is re-run on Anthropic's recommended fallback model inside the
 *    same call (`fallbacks: "default"`), instead of coming back as a refusal.
 *  - Retries are off: the caller's deadline is the whole budget, and a
 *    retried timeout would double it.
 */

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

function createAnthropicProvider(settings) {
  const { apiKey, baseUrl, model, effort, maxOutputTokens, timeoutMs, refusalFallback } = settings;
  let client = null;

  function getClient() {
    if (!client) {
      client = new Anthropic({
        apiKey,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        maxRetries: 0,
        timeout: timeoutMs
      });
    }
    return client;
  }

  /** Maps an SDK error onto the application's vocabulary. Most specific first. */
  function toLlmError(error) {
    if (error instanceof LlmError) return error;
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return new LlmError('timeout', 'The AI provider did not respond in time.');
    }
    if (
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError
    ) {
      return new LlmError('auth', 'The AI provider rejected the configured API key.', {
        status: error.status
      });
    }
    if (error instanceof Anthropic.RateLimitError) {
      const retryAfter = Number(
        error.headers && error.headers.get && error.headers.get('retry-after')
      );
      return new LlmError('rate_limited', 'The AI provider is rate limiting requests.', {
        status: 429,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null
      });
    }
    if (error instanceof Anthropic.NotFoundError) {
      return new LlmError('bad_request', `The AI model "${model}" was not found.`, { status: 404 });
    }
    if (error instanceof Anthropic.BadRequestError) {
      return new LlmError('bad_request', 'The AI provider rejected the request as invalid.', {
        status: 400
      });
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return new LlmError('unavailable', 'Could not reach the AI provider.');
    }
    if (error instanceof Anthropic.APIError) {
      return new LlmError('unavailable', `The AI provider returned an error (${error.status}).`, {
        status: error.status
      });
    }
    if (error && (error.name === 'AbortError' || error.name === 'APIUserAbortError')) {
      return new LlmError('timeout', 'The AI request was cancelled before it finished.');
    }
    return new LlmError('unavailable', 'The AI request failed.');
  }

  return {
    name: 'anthropic',
    model,
    isConfigured: () => Boolean(apiKey),

    /**
     * @param {Object} request
     * @param {string} request.system
     * @param {string} request.user
     * @param {Object} request.schema  JSON schema of the reply
     * @returns {Promise<{text: string, model: string, stopReason: string, usage: Object}>}
     */
    async generate({ system, user, schema }) {
      if (!apiKey) throw new LlmError('not_configured', 'AI_API_KEY is not set.');

      const outputConfig = { format: { type: 'json_schema', schema } };
      if (EFFORT_LEVELS.includes(effort)) outputConfig.effort = effort;

      const params = {
        model,
        max_tokens: maxOutputTokens,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: outputConfig
      };

      let response;
      try {
        response = refusalFallback
          ? await getClient().beta.messages.create({
              ...params,
              betas: [FALLBACK_BETA],
              fallbacks: 'default'
            })
          : await getClient().messages.create(params);
      } catch (error) {
        throw toLlmError(error);
      }

      // Checked before the content is read: a refusal carries no answer.
      if (response.stop_reason === 'refusal') {
        throw new LlmError('refused', 'The AI model declined to answer this query.');
      }

      const text = (response.content || [])
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim();
      if (!text) throw new LlmError('invalid_response', 'The AI model returned no text.');

      const usage = response.usage || {};
      return {
        text,
        // The model that actually answered, which differs from the one
        // requested when a fallback ran.
        model: response.model || model,
        stopReason: response.stop_reason || '',
        usage: {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0
        }
      };
    }
  };
}

module.exports = { createAnthropicProvider };
