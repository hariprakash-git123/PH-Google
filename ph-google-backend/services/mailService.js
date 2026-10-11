const nodemailer = require('nodemailer');
const { config } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Outgoing email over SMTP (config.mail, from the MAIL_* variables).
 *
 * Any SMTP provider works: Amazon SES, SendGrid, Mailgun, Postmark,
 * Microsoft 365, Google Workspace (app password) and so on. Credentials come
 * only from the environment.
 *
 * Nothing about a message's content is ever logged — password-reset codes
 * travel in the body, so only the outcome (and the provider's error code) is.
 */

let transport = null;

/** Whether email can be sent at all: an SMTP host and a sender address are set. */
function isConfigured() {
  return Boolean(config.mail.host && config.mail.fromAddress);
}

function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      // Without implicit TLS, insist on STARTTLS: credentials and codes are
      // never sent over an unencrypted connection.
      requireTLS: !config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
      connectionTimeout: config.mail.timeoutMs,
      greetingTimeout: config.mail.timeoutMs,
      socketTimeout: config.mail.timeoutMs
    });
  }
  return transport;
}

/** "PH Spectrum" <noreply@example.com> */
function sender() {
  const name = config.mail.fromName.replace(/["\r\n]/g, '');
  return name ? `"${name}" <${config.mail.fromAddress}>` : config.mail.fromAddress;
}

/**
 * Sends one email.
 *
 * @param {{to: string, subject: string, text: string, html?: string}} message
 * @returns {Promise<{messageId: string|null}>}
 * @throws when email is not configured or the provider refuses the message
 */
async function send({ to, subject, text, html }) {
  if (!isConfigured()) {
    const error = new Error('Email is not configured (MAIL_SMTP_HOST, MAIL_FROM_ADDRESS).');
    error.code = 'MAIL_NOT_CONFIGURED';
    throw error;
  }
  try {
    const info = await getTransport().sendMail({ from: sender(), to, subject, text, html });
    return { messageId: info && info.messageId ? info.messageId : null };
  } catch (error) {
    // The provider's code and response class only — never the message itself.
    logger.error('Email could not be sent', {
      code: error.code || null,
      responseCode: error.responseCode || null
    });
    throw error;
  }
}

/**
 * Checks that the SMTP server accepts a connection and the credentials
 * (nodemailer's verify). Sends nothing. For the deployment check script.
 */
async function verifyConnection() {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  try {
    await getTransport().verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error.code || 'error', responseCode: error.responseCode || null };
  }
}

/** For tests: forget the transport so a changed config is picked up. */
function reset() {
  transport = null;
}

module.exports = { send, isConfigured, verifyConnection, sender, reset };
