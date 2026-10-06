/**
 * A failure from a language-model provider, in the one vocabulary the rest
 * of the application understands. Every provider maps its own errors onto
 * these codes, so the answer pipeline never inspects a vendor's error types.
 */

const CODES = [
  'not_configured', // no API key, or an unknown provider name
  'timeout', // the provider did not answer in time
  'rate_limited', // the provider is throttling this key
  'auth', // the key was rejected
  'refused', // the model declined the request
  'bad_request', // the provider rejected the request as invalid
  'invalid_response', // the reply could not be read
  'unavailable' // anything else: network failure, provider outage
];

class LlmError extends Error {
  /**
   * @param {string} code  one of CODES
   * @param {string} message  safe to log; must never contain a credential
   * @param {Object} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = CODES.includes(code) ? code : 'unavailable';
    this.status = details.status || null;
    this.retryAfterMs = details.retryAfterMs || null;
  }
}

module.exports = { LlmError, CODES };
