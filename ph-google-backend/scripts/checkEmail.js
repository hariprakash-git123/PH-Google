/**
 * Checks outgoing email (the MAIL_* settings) — for deployment, not tests.
 *
 *   npm run mail:check                       connect and log in to the SMTP server; sends nothing
 *   npm run mail:check -- --to you@example   ...and send one plain test message to that address
 *
 * The test message contains no code and no secret. Only the outcome is
 * printed: never the password or other credentials.
 */
const { config } = require('../config/env');
const mailService = require('../services/mailService');

function argValue(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at > -1 ? process.argv[at + 1] : undefined;
}

async function main() {
  const missing = [];
  if (!config.mail.host) missing.push('MAIL_SMTP_HOST');
  if (!config.mail.fromAddress) missing.push('MAIL_FROM_ADDRESS');
  console.log('SMTP host:      ', config.mail.host || '(not set)');
  console.log(
    'SMTP port:      ',
    config.mail.port,
    config.mail.secure ? '(TLS)' : '(STARTTLS required)'
  );
  console.log('SMTP user:      ', config.mail.user ? '(set)' : '(not set)');
  console.log('SMTP password:  ', config.mail.pass ? '(set)' : '(not set)');
  console.log('Sender:         ', config.mail.fromAddress ? mailService.sender() : '(not set)');
  if (missing.length) {
    console.log(`\nEmail is NOT configured. Set: ${missing.join(', ')}`);
    process.exit(1);
  }

  const connection = await mailService.verifyConnection();
  if (!connection.ok) {
    console.log(
      `\nSMTP login FAILED (${connection.reason}${connection.responseCode ? `, ${connection.responseCode}` : ''}).`
    );
    process.exit(1);
  }
  console.log('\nSMTP connection and login: OK');

  const to = argValue('to');
  if (!to) {
    console.log('No message sent (add --to <address> to send a test message).');
    return;
  }
  const result = await mailService.send({
    to,
    subject: 'PH Spectrum email test',
    text: 'This is a test message from PH Spectrum. Outgoing email is working.'
  });
  console.log(
    `Test message accepted by the SMTP server (message id ${result.messageId || 'n/a'}).`
  );
  console.log('Check that it arrived in the inbox (and not in spam) to confirm delivery.');
}

main().catch(error => {
  console.log(
    `\nSending FAILED (${error.code || 'error'}${error.responseCode ? `, ${error.responseCode}` : ''}).`
  );
  process.exit(1);
});
