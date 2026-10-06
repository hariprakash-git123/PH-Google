const request = require('supertest');
const jwt = require('jsonwebtoken');
const testDb = require('../helpers/testDb');
const { createUserWithToken, auth } = require('../helpers/factories');
const User = require('../../models/User');

let app;

beforeAll(async () => {
  await testDb.connect();
  app = require('../../app').createApp();
});
afterAll(async () => {
  await testDb.disconnect();
});
beforeEach(async () => {
  await testDb.clear();
});

describe('POST /api/auth/register', () => {
  it('creates an account and returns a token', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada Lovelace', email: 'ada@example.com', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeTruthy();
    expect(res.body.data.user).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com' });
  });

  it('never returns the password', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: 'password123' });

    expect(JSON.stringify(res.body)).not.toContain('password123');
    expect(res.body.data.user.password).toBeUndefined();
  });

  it('stores the password as a bcrypt hash, not plaintext', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: 'password123' });

    const user = await User.findOne({ email: 'ada@example.com' });
    expect(user.password).not.toBe('password123');
    expect(user.password).toMatch(/^\$2[aby]\$\d{2}\$/); // bcrypt format
    await expect(user.comparePassword('password123')).resolves.toBe(true);
    await expect(user.comparePassword('wrong')).resolves.toBe(false);
  });

  it('never grants admin through registration, not even to the first account', async () => {
    const first = await request(app)
      .post('/api/auth/register')
      .send({ name: 'First', email: 'first@example.com', password: 'password123' });
    const second = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Second',
        email: 'second@example.com',
        password: 'password123',
        role: 'admin'
      });

    expect(first.body.data.user.role).toBe('user');
    expect(second.body.data.user.role).toBe('user');
    expect((await User.findOne({ email: 'first@example.com' })).role).toBe('user');
    expect((await User.findOne({ email: 'second@example.com' })).role).toBe('user');
  });

  it('the first registered account cannot reach /api/admin/*', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'First', email: 'first@example.com', password: 'password123' });
    const admin = await request(app)
      .get('/api/admin/metrics')
      .set('Authorization', `Bearer ${res.body.data.token}`);
    expect(admin.status).toBe(403);
  });

  it('rejects a duplicate email', async () => {
    const body = { name: 'Ada', email: 'ada@example.com', password: 'password123' };
    await request(app).post('/api/auth/register').send(body);
    const res = await request(app).post('/api/auth/register').send(body);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/already exists/i);
  });

  it.each([
    ['missing name', { email: 'a@b.com', password: 'password123' }, /name/i],
    ['short name', { name: 'A', email: 'a@b.com', password: 'password123' }, /name/i],
    ['missing email', { name: 'Ada', password: 'password123' }, /email/i],
    ['invalid email', { name: 'Ada', email: 'not-an-email', password: 'password123' }, /email/i],
    ['missing password', { name: 'Ada', email: 'a@b.com' }, /password/i],
    ['short password', { name: 'Ada', email: 'a@b.com', password: '123' }, /6 characters/i]
  ])('rejects %s', async (_label, body, messagePattern) => {
    const res = await request(app).post('/api/auth/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(messagePattern);
  });

  it('rejects a malformed JSON body with 400, not 500', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send('{"name": broken}');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ name: 'Ada', email: 'ada@example.com', password: 'password123' });
  });

  it('returns a token for correct credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ada@example.com', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();

    const decoded = jwt.verify(res.body.data.token, process.env.JWT_SECRET);
    expect(decoded.id).toBe(res.body.data.user.id);
    expect(decoded.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('accepts a differently-cased email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ADA@Example.com', password: 'password123' });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong password with 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ada@example.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/invalid email or password/i);
  });

  it('gives an identical message for an unknown email, so accounts cannot be enumerated', async () => {
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'password123' });
    const wrongPass = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ada@example.com', password: 'wrongpassword' });

    expect(unknown.status).toBe(401);
    expect(unknown.body.message).toBe(wrongPass.body.message);
  });

  it('rejects missing credentials with 400', async () => {
    expect((await request(app).post('/api/auth/login').send({})).status).toBe(400);
    expect(
      (await request(app).post('/api/auth/login').send({ email: 'ada@example.com' })).status
    ).toBe(400);
  });
});

describe('GET /api/auth/me (protected endpoint)', () => {
  it('returns the caller profile with a valid token', async () => {
    const { token, user } = await createUserWithToken(app, { email: 'me@example.com' });

    const res = await request(app).get('/api/auth/me').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(user.email);
  });

  it('rejects a request with no token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/no token/i);
  });

  it('rejects a tampered token', async () => {
    const { token } = await createUserWithToken(app, { email: 'me@example.com' });
    const res = await request(app)
      .get('/api/auth/me')
      .set(auth(token.slice(0, -4) + 'aaaa'));
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/invalid token/i);
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = jwt.sign({ id: '6aabc623cb678866868d115e' }, 'not-the-real-secret');
    const res = await request(app).get('/api/auth/me').set(auth(forged));
    expect(res.status).toBe(401);
  });

  it('rejects an expired token with a distinguishable code', async () => {
    const { user } = await createUserWithToken(app, { email: 'me@example.com' });
    const expired = jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, {
      expiresIn: '-1s'
    });

    const res = await request(app).get('/api/auth/me').set(auth(expired));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  it('rejects a valid token whose user has been deleted', async () => {
    const { token, user } = await createUserWithToken(app, { email: 'me@example.com' });
    await User.deleteOne({ _id: user._id });

    const res = await request(app).get('/api/auth/me').set(auth(token));
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/not found/i);
  });

  it('rejects a malformed Authorization header', async () => {
    const { token } = await createUserWithToken(app, { email: 'me@example.com' });
    expect((await request(app).get('/api/auth/me').set({ Authorization: token })).status).toBe(401);
    expect(
      (await request(app).get('/api/auth/me').set({ Authorization: 'Basic abc' })).status
    ).toBe(401);
    expect((await request(app).get('/api/auth/me').set({ Authorization: 'Bearer' })).status).toBe(
      401
    );
  });
});

describe('POST /api/auth/change-password', () => {
  it('changes the password and issues a new token', async () => {
    const { token } = await createUserWithToken(app, {
      email: 'me@example.com',
      password: 'password123'
    });

    const res = await request(app)
      .post('/api/auth/change-password')
      .set(auth(token))
      .send({ currentPassword: 'password123', newPassword: 'newpassword456' });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeTruthy();

    // The new password works and the old one no longer does.
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email: 'me@example.com', password: 'newpassword456' })
      ).status
    ).toBe(200);
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email: 'me@example.com', password: 'password123' })
      ).status
    ).toBe(401);
  });

  it('rejects a wrong current password', async () => {
    const { token } = await createUserWithToken(app, { email: 'me@example.com' });
    const res = await request(app)
      .post('/api/auth/change-password')
      .set(auth(token))
      .send({ currentPassword: 'wrong', newPassword: 'newpassword456' });

    expect(res.status).toBe(401);
  });
});

describe('role authorization', () => {
  it('lets an admin reach /api/admin/*', async () => {
    const { token } = await createUserWithToken(app, { email: 'admin@example.com', role: 'admin' });
    const res = await request(app).get('/api/admin/metrics').set(auth(token));
    expect(res.status).toBe(200);
  });

  it('blocks a normal user from /api/admin/* with 403', async () => {
    const { token, user } = await createUserWithToken(app, {
      email: 'user@example.com',
      role: 'user'
    });
    expect(user.role).toBe('user');

    const res = await request(app).get('/api/admin/metrics').set(auth(token));
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/admin privileges/i);
  });

  it('blocks an anonymous request to /api/admin/* with 401', async () => {
    const res = await request(app).get('/api/admin/metrics');
    expect(res.status).toBe(401);
  });

  it.each([
    '/api/admin/dashboard',
    '/api/admin/metrics',
    '/api/admin/pages',
    '/api/admin/websites',
    '/api/admin/crawler/status',
    '/api/admin/crawler/jobs',
    '/api/analytics/overview',
    '/api/analytics/top-queries',
    '/api/analytics/zero-result-queries',
    '/api/analytics/searches'
  ])('protects %s against anonymous access', async path => {
    expect((await request(app).get(path)).status).toBe(401);
  });

  it('protects the crawler control endpoints', async () => {
    expect(
      (await request(app).post('/api/admin/crawler/start').send({ seedUrl: 'https://example.com' }))
        .status
    ).toBe(401);
    expect((await request(app).post('/api/admin/crawler/stop').send({})).status).toBe(401);
  });
});

describe('error envelope', () => {
  it('returns a consistent failure shape for an unknown route', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual(
      expect.objectContaining({ success: false, message: expect.any(String) })
    );
  });

  it('never exposes a stack trace on a client error', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.body.stack).toBeUndefined();
  });
});

describe('security headers', () => {
  it('sets helmet headers and hides the Express fingerprint', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
