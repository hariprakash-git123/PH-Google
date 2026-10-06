/**
 * A failure from an external search provider, in the one vocabulary the rest
 * of the application understands — the same idea as ai/llm/llmError.js.
 *
 * The message is written by this application, never copied from the
 * provider or from fetch, so it can be logged and can never carry a
 * credential (SerpApi takes its key in the request URL).
 */

const CODES = [
  'not_configured', // no API key
  'auth', // the key was rejected (401/403)
  'rate_limited', // the provider is throttling this key, or the plan ran out (429)
  'timeout', // no answer in time
  'network', // DNS failure, refused connection, reset
  'bad_request', // the provider rejected the request as invalid (other 4xx)
  'invalid_response', // the reply could not be read
  'unavailable' // a provider outage (5xx) or anything else
];

class ExternalSearchError extends Error {
  /**
   * @param {string} code  one of CODES
   * @param {string} message  safe to log
   * @param {{status?: number, retryAfterMs?: number}} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ExternalSearchError';
    this.code = CODES.includes(code) ? code : 'unavailable';
    this.status = details.status || null;
    this.retryAfterMs = details.retryAfterMs || null;
  }
}

module.exports = { ExternalSearchError, CODES };
