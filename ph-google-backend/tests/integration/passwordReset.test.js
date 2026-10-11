const request = require('supertest');
const jwt = require('jsonwebtoken');
const testDb = require('../helpers/testDb');
const { createUserWithToken, auth } = require('../helpers/factories');
const User = require('../../models/User');
const PasswordReset = require('../../models/PasswordReset');
const mailService = require('../../services/mailService');
const passwordReset = require('../../services/passwordResetService');
const logger = require('../../utils/logger');
const { config } = require('../../config/env');

/**
 * Password reset by emailed code: forgot-password → verify-reset-code →
 * reset-password.
 *
 * The email provider is replaced by a stand-in: no message leaves this
 * process. Codes are read from the stand-in's captured messages and never
 * printed.
 */

let app;
let sent; // messages the stand-in "sent"
let logged; // everything logged, to prove no code or token is ever written

beforeAll(async () => {
  await testDb.connect();
  app = require('../../app').createApp();
});
afterAll(async () => {
  await testDb.disconnect();
});
beforeEach(async () => {
  await testDb.clear();
  sent = [];
  logged = [];
  jest.spyOn(mailService, 'isConfigured').mockReturnValue(true);
  jest.spyOn(mailService, 'send').mockImplementation(async message => {
    sent.push(message);
    return { messageId: `test-${sent.length}` };
  });
  for (const level of ['debug', 'info', 'warn', 'error']) {
    jest.spyOn(logger, level).mockImplementation((...args) => {
      logged.push(JSON.stringify(args));
    });
  }
});
afterEach(() => jest.restoreAllMocks());

const EMAIL = 'reader@example.com';
const GENERIC_SENT = /If an account exists for that email address, we have sent it a 6-digit code/;
const GENERIC_BAD_CODE = 'The code is incorrect or has expired. Request a new code and try again.';

const forgot = async email => {
  const res = await request(app).post('/api/auth/forgot-password').send({ email });
  await passwordReset.flushDeliveries();
  return res;
};
const verify = (email, code) =>
  request(app).post('/api/auth/verify-reset-code').send({ email, code });
const reset = (resetToken, password, confirmPassword = password) =>
  request(app).post('/api/auth/reset-password').send({ resetToken, password, confirmPassword });

/** The code in the most recent captured email. */
const lastCode = () => {
  const match = /\b(\d{6})\b/.exec(sent[sent.length - 1].text);
  return match[1];
};
const wrongCodeFor = code => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
const record = async () => {
  const user = await User.findOne({ email: EMAIL });
  return PasswordReset.findOne({ userId: user._id });
};
const makeUser = () =>
  createUserWithToken(app, { email: EMAIL, password: 'original-pass-1', name: 'Reader' });

describe('the code', () => {
  it('is six random digits from a secure source', () => {
    const codes = Array.from({ length: 200 }, () => passwordReset.generateCode());
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
    expect(new Set(codes).size).toBeGreaterThan(190);
  });

  it('is stored only as a hash, bound to the account', async () => {
    await makeUser();
    await forgot(EMAIL);
    const code = lastCode();
    const stored = await record();
    expect(stored.otpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.otpHash).not.toContain(code);
    expect(JSON.stringify(stored.toObject())).not.toContain(code);
    expect(passwordReset.hashCode('another-user', code)).not.toBe(stored.otpHash);
  });

  it('expires after 10 minutes', async () => {
    await makeUser();
    await forgot(EMAIL);
    const stored = await record();
    const ttl = stored.otpExpiresAt.getTime() - stored.lastSentAt.getTime();
    expect(ttl).toBe(10 * 60 * 1000);
  });
});

describe('POST /api/auth/forgot-password', () => {
  it('emails a code to an existing account, from PH Spectrum', async () => {
    await makeUser();
    const res = await forgot(EMAIL);
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(GENERIC_SENT);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(EMAIL);
    expect(sent[0].subject).toBe('Your PH Spectrum password reset code');
    expect(sent[0].text).toMatch(/expires in 10 minutes/);
    expect(sent[0].html).toContain(lastCode());
  });

  it('gives exactly the same answer for an address with no account, and sends nothing', async () => {
    await makeUser();
    const known = await forgot(EMAIL);
    const unknown = await forgot('nobody@example.com');
    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
    expect(sent).toHaveLength(1);
  });

  it('accepts the address in any case', async () => {
    await makeUser();
    await forgot('Reader@Example.COM');
    expect(sent).toHaveLength(1);
  });

  it('never returns the code', async () => {
    await makeUser();
    const res = await forgot(EMAIL);
    expect(JSON.stringify(res.body)).not.toContain(lastCode());
  });

  it('rejects a malformed address with 400', async () => {
    expect((await forgot('not-an-email')).status).toBe(400);
  });

  it('when email is not configured: 503 for every address alike, and nothing is stored', async () => {
    mailService.isConfigured.mockReturnValue(false);
    await makeUser();
    const known = await forgot(EMAIL);
    const unknown = await forgot('nobody@example.com');
    expect(known.status).toBe(503);
    expect(unknown.body).toEqual(known.body);
    expect(await PasswordReset.countDocuments()).toBe(0);
  });

  it('when delivery fails: the same answer, and the undelivered code does not work', async () => {
    await makeUser();
    mailService.send.mockImplementationOnce(async message => {
      sent.push(message);
      const error = new Error('Mailbox unavailable');
      error.code = 'EENVELOPE';
      error.responseCode = 550;
      throw error;
    });
    const res = await forgot(EMAIL);
    expect(res.status).toBe(200);
    expect(res.body.data.message).toMatch(GENERIC_SENT);
    const code = lastCode();
    expect((await verify(EMAIL, code)).status).toBe(400);
    expect((await record()).otpHash).toBeNull();
  });

  it('a new code within a minute is not sent; the earlier code keeps working', async () => {
    await makeUser();
    await forgot(EMAIL);
    const first = lastCode();
    const again = await forgot(EMAIL);
    expect(again.body.data.message).toMatch(GENERIC_SENT);
    expect(sent).toHaveLength(1);
    expect((await verify(EMAIL, first)).status).toBe(200);
  });

  it('after the cooldown a new code is sent, and it replaces the old one', async () => {
    await makeUser();
    await forgot(EMAIL);
    const first = lastCode();
    await PasswordReset.updateOne({}, { $set: { lastSentAt: new Date(Date.now() - 61 * 1000) } });
    await forgot(EMAIL);
    expect(sent).toHaveLength(2);
    const second = lastCode();
    if (second !== first) {
      expect((await verify(EMAIL, first)).body.message).toBe(GENERIC_BAD_CODE);
    }
    expect((await verify(EMAIL, second)).status).toBe(200);
  });

  it('at most five codes an hour per account', async () => {
    await makeUser();
    for (let i = 0; i < 7; i += 1) {
      await forgot(EMAIL);
      await PasswordReset.updateOne({}, { $set: { lastSentAt: new Date(Date.now() - 61 * 1000) } });
    }
    expect(sent).toHaveLength(config.passwordReset.maxSendsPerHour);
  });
});

describe('POST /api/auth/verify-reset-code', () => {
  it('a correct code is exchanged for a reset token, which is stored only as a hash', async () => {
    await makeUser();
    await forgot(EMAIL);
    const res = await verify(EMAIL, lastCode());
    expect(res.status).toBe(200);
    expect(res.body.data.resetToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(res.body.data.expiresInSeconds).toBe(15 * 60);
    const stored = await record();
    expect(stored.resetTokenHash).toBe(passwordReset.hashToken(res.body.data.resetToken));
    expect(stored.resetTokenHash).not.toBe(res.body.data.resetToken);
  });

  it('a wrong code: the generic message, and the guess is counted', async () => {
    await makeUser();
    await forgot(EMAIL);
    const res = await verify(EMAIL, wrongCodeFor(lastCode()));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(GENERIC_BAD_CODE);
    expect((await record()).attempts).toBe(1);
  });

  it('after five wrong guesses the code is dead — even the right one fails', async () => {
    await makeUser();
    await forgot(EMAIL);
    const code = lastCode();
    for (let i = 0; i < 5; i += 1) {
      expect((await verify(EMAIL, wrongCodeFor(code))).status).toBe(400);
    }
    const res = await verify(EMAIL, code);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(GENERIC_BAD_CODE);
  });

  it('guesses sent all at once cannot get past the limit', async () => {
    await makeUser();
    await forgot(EMAIL);
    const code = lastCode();
    const wrong = Array.from({ length: 20 }, (_, i) =>
      String((Number(code) + i + 1) % 1_000_000).padStart(6, '0')
    );
    const results = await Promise.all(wrong.map(guess => verify(EMAIL, guess)));
    expect(results.every(r => r.status === 400)).toBe(true);
    const stored = await record();
    expect(stored.attempts).toBeLessThanOrEqual(config.passwordReset.maxAttempts);
    expect(stored.otpHash).toBeNull(); // the code is dead
    expect((await verify(EMAIL, code)).status).toBe(400);
  });

  it('an expired code fails with the same message', async () => {
    await makeUser();
    await forgot(EMAIL);
    await PasswordReset.updateOne({}, { $set: { otpExpiresAt: new Date(Date.now() - 1000) } });
    const res = await verify(EMAIL, lastCode());
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(GENERIC_BAD_CODE);
  });

  it('a code works once: replaying it fails', async () => {
    await makeUser();
    await forgot(EMAIL);
    const code = lastCode();
    expect((await verify(EMAIL, code)).status).toBe(200);
    const replay = await verify(EMAIL, code);
    expect(replay.status).toBe(400);
    expect(replay.body.message).toBe(GENERIC_BAD_CODE);
  });

  it('two simultaneous uses of one code: only one succeeds', async () => {
    await makeUser();
    await forgot(EMAIL);
    const code = lastCode();
    const results = await Promise.all([verify(EMAIL, code), verify(EMAIL, code)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
  });

  it('an address with no account, or no code requested: the same message', async () => {
    await makeUser();
    const none = await verify(EMAIL, '123456');
    const unknown = await verify('nobody@example.com', '123456');
    expect(none.body.message).toBe(GENERIC_BAD_CODE);
    expect(unknown.body.message).toBe(GENERIC_BAD_CODE);
    expect(unknown.status).toBe(none.status);
  });

  it.each(['12345', '1234567', 'abcdef', '', '12 456'])(
    'a malformed code (%j) is refused',
    async code => {
      await makeUser();
      await forgot(EMAIL);
      const res = await verify(EMAIL, code);
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(GENERIC_BAD_CODE);
    }
  );
});

describe('POST /api/auth/reset-password', () => {
  async function tokenFor() {
    await forgot(EMAIL);
    return (await verify(EMAIL, lastCode())).body.data.resetToken;
  }
  const login = password => request(app).post('/api/auth/login').send({ email: EMAIL, password });

  it('sets the new password: the new one signs in, the old one no longer does', async () => {
    await makeUser();
    const res = await reset(await tokenFor(), 'brand-new-pass-2');
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe(
      'Your password has been reset. Sign in with your new password.'
    );
    expect(res.body.data.token).toBeUndefined();
    expect((await login('brand-new-pass-2')).status).toBe(200);
    expect((await login('original-pass-1')).status).toBe(401);
    const user = await User.findOne({ email: EMAIL });
    expect(user.password).toMatch(/^\$2[aby]\$/); // bcrypt, never plaintext
  });

  it('ends every existing session', async () => {
    const { token } = await makeUser();
    expect((await request(app).get('/api/auth/me').set(auth(token))).status).toBe(200);
    // A session from an earlier second than the reset.
    const user = await User.findOne({ email: EMAIL });
    const earlier = jwt.sign(
      { id: user._id, iat: Math.floor(Date.now() / 1000) - 5 },
      config.jwt.secret,
      { expiresIn: '1h' }
    );
    await reset(await tokenFor(), 'brand-new-pass-2');
    const res = await request(app).get('/api/auth/me').set(auth(earlier));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  it('the reset token works once; the reset request is gone afterwards', async () => {
    await makeUser();
    const token = await tokenFor();
    expect((await reset(token, 'brand-new-pass-2')).status).toBe(200);
    const again = await reset(token, 'another-pass-3');
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/expired or was already used/);
    expect(await PasswordReset.countDocuments()).toBe(0);
    expect((await login('brand-new-pass-2')).status).toBe(200);
  });

  it('an expired reset token is refused', async () => {
    await makeUser();
    const token = await tokenFor();
    await PasswordReset.updateOne(
      {},
      { $set: { resetTokenExpiresAt: new Date(Date.now() - 1000) } }
    );
    expect((await reset(token, 'brand-new-pass-2')).status).toBe(400);
    expect((await login('original-pass-1')).status).toBe(200);
  });

  it('a made-up token is refused', async () => {
    await makeUser();
    expect((await reset('x'.repeat(43), 'brand-new-pass-2')).status).toBe(400);
    expect((await reset('', 'brand-new-pass-2')).status).toBe(400);
  });

  it('the password policy applies, and a failed attempt does not use the token up', async () => {
    await makeUser();
    const token = await tokenFor();
    const short = await reset(token, '12345');
    expect(short.status).toBe(400);
    expect(short.body.message).toMatch(/at least 6 characters/);
    const mismatch = await reset(token, 'brand-new-pass-2', 'brand-new-pass-X');
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.message).toBe('The passwords do not match.');
    expect((await reset(token, 'brand-new-pass-2')).status).toBe(200);
  });

  it('a reset token cannot be had without the emailed code', async () => {
    await makeUser();
    await forgot(EMAIL);
    expect((await record()).resetTokenHash).toBeNull();
  });
});

describe('secrecy', () => {
  it('no code or reset token is ever logged', async () => {
    await makeUser();
    await forgot(EMAIL);
    const code = lastCode();
    await verify(EMAIL, wrongCodeFor(code));
    const token = (await verify(EMAIL, code)).body.data.resetToken;
    await reset(token, 'brand-new-pass-2');
    const everything = logged.join('\n');
    expect(everything).not.toContain(code);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain('brand-new-pass-2');
  });

  it('existing sign-in, sign-up and change-password are unaffected', async () => {
    const { token } = await makeUser();
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email: EMAIL, password: 'original-pass-1' })
      ).status
    ).toBe(200);
    const changed = await request(app)
      .post('/api/auth/change-password')
      .set(auth(token))
      .send({ currentPassword: 'original-pass-1', newPassword: 'changed-pass-4' });
    expect(changed.status).toBe(200);
    // The token returned with the change is a working session.
    expect((await request(app).get('/api/auth/me').set(auth(changed.body.data.token))).status).toBe(
      200
    );
  });
});

describe('the mail service', () => {
  it('sends as "PH Spectrum" from the configured address', () => {
    jest.restoreAllMocks();
    const before = { ...config.mail };
    Object.assign(config.mail, { fromAddress: 'noreply@example.com', fromName: 'PH Spectrum' });
    expect(mailService.sender()).toBe('"PH Spectrum" <noreply@example.com>');
    Object.assign(config.mail, before);
  });

  it('refuses to send when not configured, saying which settings are missing', async () => {
    jest.restoreAllMocks();
    const before = { ...config.mail };
    Object.assign(config.mail, { host: '', fromAddress: '' });
    mailService.reset();
    await expect(
      mailService.send({ to: 'a@example.com', subject: 's', text: 't' })
    ).rejects.toMatchObject({ code: 'MAIL_NOT_CONFIGURED' });
    expect(await mailService.verifyConnection()).toEqual({ ok: false, reason: 'not_configured' });
    Object.assign(config.mail, before);
  });
});
