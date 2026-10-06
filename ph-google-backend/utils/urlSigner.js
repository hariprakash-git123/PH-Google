const crypto = require('crypto');
const { config } = require('../config/env');

/**
 * Signs a URL so the server can later tell "an address I handed out" from
 * "an address someone typed in".
 *
 * Used by the image download endpoint: only image addresses this backend
 * returned in search results carry a valid signature, so the endpoint cannot
 * be used to fetch arbitrary URLs. The key is derived from the server's JWT
 * secret and the purpose, so a signature for one purpose is useless for
 * another and nothing new has to be configured.
 */

function sign(purpose, url) {
  return crypto
    .createHmac('sha256', String(config.jwt.secret || ''))
    .update(`${purpose}\n${url}`)
    .digest('base64url');
}

/** @returns {string} the signature for `url` under `purpose` */
function signUrl(purpose, url) {
  return sign(purpose, String(url));
}

/** Whether `signature` is this server's signature for `url` under `purpose`. */
function verifyUrl(purpose, url, signature) {
  if (typeof url !== 'string' || typeof signature !== 'string' || !config.jwt.secret) return false;
  const expected = Buffer.from(sign(purpose, url));
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { signUrl, verifyUrl };
