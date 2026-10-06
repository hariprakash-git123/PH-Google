/**
 * The Anthropic provider and the provider registry.
 *
 * The SDK is replaced with a double, so nothing here reaches the network:
 * what is checked is the request this application sends and how each kind
 * of SDK failure is translated into the application's own error codes.
 */

const mockCreate = jest.fn();
const mockBetaCreate = jest.fn();
const mockConstructed = [];

jest.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    constructor(status, message, headers) {
      super(message || 'api error');
      this.status = status;
      this.headers = headers || new Map();
    }
  }
  class APIConnectionError extends APIError {
    constructor(message) {
      super(undefined, message || 'connection error');
    }
  }
  class APIConnectionTimeoutError extends APIConnectionError {}
  class BadRequestError extends APIError {}
  class AuthenticationError extends APIError {}
  class PermissionDeniedError extends APIError {}
  class NotFoundError extends APIError {}
  class RateLimitError extends APIError {}

  class Anthropic {
    constructor(options) {
      mockConstructed.push(options);
      this.messages = { create: mockCreate };
      this.beta = { messages: { create: mockBetaCreate } };
    }
  }
  Object.assign(Anthropic, {
    APIError,
    APIConnectionError,
    APIConnectionTimeoutError,
    BadRequestError,
    AuthenticationError,
    PermissionDeniedError,
    NotFoundError,
    RateLimitError
  });
  return Anthropic;
});

const Anthropic = require('@anthropic-ai/sdk');
const { createAnthropicProvider } = require('../../services/ai/llm/anthropicProvider');
const { LlmError, CODES } = require('../../services/ai/llm/llmError');
const llm = require('../../services/ai/llm');
const { config } = require('../../config/env');

const SETTINGS = {
  apiKey: 'test-key-not-real',
  baseUrl: '',
  model: 'claude-opus-5-5',
  effort: 'low',
  maxOutputTokens: 8000,
  timeoutMs: 12345,
  refusalFallback: true
};

const REQUEST = {
  system: 'SYSTEM RULES',
  user: '<sources>…</sources><user_query>q</user_query>',
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false }
};

const message = (overrides = {}) => ({
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  content: [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: '{"answer":"ok"}' }
  ],
  usage: { input_tokens: 321, output_tokens: 45 },
  ...overrides
});

beforeEach(() => {
  mockCreate.mockReset();
  mockBetaCreate.mockReset();
  mockConstructed.length = 0;
});

describe('Anthropic provider: the request', () => {
  it('sends the system prompt, one user message and the reply schema', async () => {
    mockBetaCreate.mockResolvedValue(message());
    const provider = createAnthropicProvider(SETTINGS);

    const reply = await provider.generate(REQUEST);

    expect(mockBetaCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockBetaCreate.mock.calls[0][0]).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 8000,
      system: 'SYSTEM RULES',
      messages: [{ role: 'user', content: REQUEST.user }],
      output_config: { format: { type: 'json_schema', schema: REQUEST.schema }, effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default'
    });
    expect(reply).toEqual({
      text: '{"answer":"ok"}',
      model: 'claude-opus-5-5',
      stopReason: 'end_turn',
      usage: { inputTokens: 321, outputTokens: 45 }
    });
  });

  it('never sends sampling parameters, a thinking budget or a prefilled reply', async () => {
    mockBetaCreate.mockResolvedValue(message());
    await createAnthropicProvider(SETTINGS).generate(REQUEST);

    const params = mockBetaCreate.mock.calls[0][0];
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'tool_choice', 'tools']) {
      expect(params).not.toHaveProperty(key);
    }
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].role).toBe('user');
  });

  it('uses the plain endpoint, with no fallback fields, when refusal fallback is off', async () => {
    mockCreate.mockResolvedValue(message());
    await createAnthropicProvider({ ...SETTINGS, refusalFallback: false }).generate(REQUEST);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockBetaCreate).not.toHaveBeenCalled();
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('fallbacks');
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('betas');
  });

  it('leaves effort out when it is not a level the API accepts', async () => {
    mockBetaCreate.mockResolvedValue(message());
    for (const effort of ['', 'none', 'turbo']) {
      mockBetaCreate.mockClear();
      await createAnthropicProvider({ ...SETTINGS, effort }).generate(REQUEST);
      expect(mockBetaCreate.mock.calls[0][0].output_config).toEqual({
        format: { type: 'json_schema', schema: REQUEST.schema }
      });
    }
  });

  it('builds the client once, with the key, the deadline and no retries', async () => {
    mockBetaCreate.mockResolvedValue(message());
    const provider = createAnthropicProvider({
      ...SETTINGS,
      baseUrl: 'https://gateway.example/v1'
    });
    await provider.generate(REQUEST);
    await provider.generate(REQUEST);

    expect(mockConstructed).toEqual([
      {
        apiKey: 'test-key-not-real',
        baseURL: 'https://gateway.example/v1',
        maxRetries: 0,
        timeout: 12345
      }
    ]);
  });

  it('reports the model that actually answered', async () => {
    mockBetaCreate.mockResolvedValue(message({ model: 'claude-opus-4-8' }));
    const reply = await createAnthropicProvider(SETTINGS).generate(REQUEST);
    expect(reply.model).toBe('claude-opus-4-8');
  });

  it('joins text blocks and ignores every other kind of block', async () => {
    mockBetaCreate.mockResolvedValue(
      message({
        content: [
          { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
          { type: 'thinking', thinking: 'private reasoning' },
          { type: 'text', text: '{"answer":' },
          { type: 'text', text: '"joined"}' }
        ]
      })
    );
    const reply = await createAnthropicProvider(SETTINGS).generate(REQUEST);
    expect(reply.text).toBe('{"answer":"joined"}');
  });
});

describe('Anthropic provider: failures become application errors', () => {
  const failWith = async error => {
    mockBetaCreate.mockRejectedValue(error);
    const failure = await createAnthropicProvider(SETTINGS)
      .generate(REQUEST)
      .catch(e => e);
    expect(failure).toBeInstanceOf(LlmError);
    return failure;
  };

  it('no API key: not_configured, and the SDK is never called', async () => {
    const provider = createAnthropicProvider({ ...SETTINGS, apiKey: '' });
    expect(provider.isConfigured()).toBe(false);
    const failure = await provider.generate(REQUEST).catch(e => e);
    expect(failure).toBeInstanceOf(LlmError);
    expect(failure.code).toBe('not_configured');
    expect(mockBetaCreate).not.toHaveBeenCalled();
    expect(mockConstructed).toHaveLength(0);
  });

  it('timeout', async () => {
    expect((await failWith(new Anthropic.APIConnectionTimeoutError())).code).toBe('timeout');
  });

  it('rejected key', async () => {
    expect((await failWith(new Anthropic.AuthenticationError(401, 'invalid x-api-key'))).code).toBe(
      'auth'
    );
    expect((await failWith(new Anthropic.PermissionDeniedError(403, 'forbidden'))).code).toBe(
      'auth'
    );
  });

  it('rate limit, with the wait the provider asked for', async () => {
    const failure = await failWith(
      new Anthropic.RateLimitError(429, 'slow down', new Map([['retry-after', '7']]))
    );
    expect(failure.code).toBe('rate_limited');
    expect(failure.retryAfterMs).toBe(7000);
  });

  it('unknown model and invalid request', async () => {
    expect((await failWith(new Anthropic.NotFoundError(404, 'model not found'))).code).toBe(
      'bad_request'
    );
    expect((await failWith(new Anthropic.BadRequestError(400, 'bad'))).code).toBe('bad_request');
  });

  it('network failure and provider outage', async () => {
    expect((await failWith(new Anthropic.APIConnectionError('ECONNRESET'))).code).toBe(
      'unavailable'
    );
    const outage = await failWith(new Anthropic.APIError(529, 'overloaded'));
    expect(outage.code).toBe('unavailable');
    expect(outage.status).toBe(529);
  });

  it('anything unexpected', async () => {
    expect((await failWith(new Error('boom'))).code).toBe('unavailable');
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    expect((await failWith(aborted)).code).toBe('timeout');
  });

  it('a refusal is reported, and its content is never read as an answer', async () => {
    mockBetaCreate.mockResolvedValue(
      message({ stop_reason: 'refusal', content: [{ type: 'text', text: 'partial text' }] })
    );
    const failure = await createAnthropicProvider(SETTINGS)
      .generate(REQUEST)
      .catch(e => e);
    expect(failure).toBeInstanceOf(LlmError);
    expect(failure.code).toBe('refused');
  });

  it('an empty reply', async () => {
    mockBetaCreate.mockResolvedValue(message({ content: [{ type: 'thinking', thinking: '' }] }));
    const failure = await createAnthropicProvider(SETTINGS)
      .generate(REQUEST)
      .catch(e => e);
    expect(failure.code).toBe('invalid_response');
  });

  it('no error message ever contains the API key', async () => {
    const errors = [
      new Anthropic.APIConnectionTimeoutError(),
      new Anthropic.AuthenticationError(401, `bad key ${SETTINGS.apiKey}`),
      new Anthropic.RateLimitError(429, `limit for ${SETTINGS.apiKey}`),
      new Anthropic.BadRequestError(400, `request with ${SETTINGS.apiKey}`),
      new Anthropic.APIError(500, `server saw ${SETTINGS.apiKey}`),
      new Error(`boom ${SETTINGS.apiKey}`)
    ];
    for (const error of errors) {
      const failure = await failWith(error);
      expect(failure.message).not.toContain(SETTINGS.apiKey);
    }
  });
});

describe('LlmError', () => {
  it('falls back to "unavailable" for a code it does not know', () => {
    expect(new LlmError('made_up', 'x').code).toBe('unavailable');
    for (const code of CODES) expect(new LlmError(code, 'x').code).toBe(code);
  });
});

describe('provider registry', () => {
  const saved = { ...config.ai };
  afterEach(() => {
    Object.assign(config.ai, saved);
    llm.resetProvider();
  });

  it('builds the configured provider from config, once', () => {
    Object.assign(config.ai, { provider: 'anthropic', apiKey: 'k', model: 'claude-opus-5-5' });
    llm.resetProvider();
    const provider = llm.getProvider();
    expect(provider.name).toBe('anthropic');
    expect(provider.model).toBe('claude-opus-5-5');
    expect(llm.getProvider()).toBe(provider);
    expect(llm.isConfigured()).toBe(true);
  });

  it('is not configured without a key', () => {
    Object.assign(config.ai, { provider: 'anthropic', apiKey: '' });
    llm.resetProvider();
    expect(llm.isConfigured()).toBe(false);
  });

  it('rejects a provider name it does not know, without throwing from isConfigured', () => {
    Object.assign(config.ai, { provider: 'nonesuch', apiKey: 'k' });
    llm.resetProvider();
    expect(llm.isConfigured()).toBe(false);
    expect(() => llm.getProvider()).toThrow(LlmError);
    expect(() => llm.getProvider()).toThrow(/Unknown AI_PROVIDER "nonesuch"/);
  });

  it('lets a different provider be supplied behind the same contract', () => {
    const custom = { name: 'custom', model: 'm', isConfigured: () => true, generate: jest.fn() };
    llm.setProvider(custom);
    expect(llm.getProvider()).toBe(custom);
    expect(llm.isConfigured()).toBe(true);
  });
});
