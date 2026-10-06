const request = require('supertest');
const testDb = require('../helpers/testDb');
const { seedPage, createUserWithToken, auth } = require('../helpers/factories');
const History = require('../../models/History');
const SearchLog = require('../../models/SearchLog');

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

/** Registers two users: the first becomes admin, the second stays a normal user. */
async function twoUsers() {
  const admin = await createUserWithToken(app, {
    email: 'admin@example.com',
    name: 'Admin',
    role: 'admin'
  });
  const user = await createUserWithToken(app, {
    email: 'user@example.com',
    name: 'User',
    role: 'user'
  });
  return { admin, user };
}

describe('GET /api/history', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/history');
    expect(res.status).toBe(401);
  });

  it('returns the caller own history', async () => {
    const { token } = await createUserWithToken(app, { email: 'me@example.com' });
    await request(app).post('/api/history').set(auth(token)).send({ query: 'first query' });
    await request(app).post('/api/history').set(auth(token)).send({ query: 'second query' });

    const res = await request(app).get('/api/history').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.data.history).toHaveLength(2);
    // Newest first.
    expect(res.body.data.history[0].query).toBe('second query');
  });

  it('exposes an id field the frontend can key on', async () => {
    const { token } = await createUserWithToken(app, { email: 'me@example.com' });
    await request(app).post('/api/history').set(auth(token)).send({ query: 'keyed' });

    const res = await request(app).get('/api/history').set(auth(token));
    expect(res.body.data.history[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        query: 'keyed',
        timestamp: expect.any(String)
      })
    );
    expect(res.body.data.history[0]._id).toBeUndefined();
  });

  it('never leaks another user history', async () => {
    const { admin, user } = await twoUsers();
    await request(app)
      .post('/api/history')
      .set(auth(admin.token))
      .send({ query: 'admin secret search' });

    const res = await request(app).get('/api/history').set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.history).toHaveLength(0);
  });

  it('refuses a normal user asking for another user history by id', async () => {
    const { admin, user } = await twoUsers();
    const res = await request(app)
      .get('/api/history')
      .query({ userId: admin.user._id.toString() })
      .set(auth(user.token));

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/only access your own/i);
  });

  it('lets an admin read a specific user history', async () => {
    const { admin, user } = await twoUsers();
    await request(app).post('/api/history').set(auth(user.token)).send({ query: 'user query' });

    const res = await request(app)
      .get('/api/history')
      .query({ userId: user.user._id.toString() })
      .set(auth(admin.token));

    expect(res.status).toBe(200);
    expect(res.body.data.history[0].query).toBe('user query');
  });

  it('excludes legacy rows that belong to no user', async () => {
    const { token } = await createUserWithToken(app, { email: 'me@example.com' });
    // A row written before history became per-user.
    await History.create({ query: 'legacy global search', userId: null });

    const res = await request(app).get('/api/history').set(auth(token));
    expect(res.body.data.history).toHaveLength(0);
  });

  it('paginates and filters', async () => {
    const { token } = await createUserWithToken(app, { email: 'me@example.com' });
    for (const q of ['alpha one', 'alpha two', 'beta three']) {
      await request(app).post('/api/history').set(auth(token)).send({ query: q });
    }

    const paged = await request(app).get('/api/history').query({ limit: 2 }).set(auth(token));
    expect(paged.body.data.history).toHaveLength(2);
    expect(paged.body.data.pagination.totalResults).toBe(3);

    const filtered = await request(app).get('/api/history').query({ q: 'alpha' }).set(auth(token));
    expect(filtered.body.data.history).toHaveLength(2);
  });
});

describe('POST /api/history', () => {
  it('records a query and de-duplicates repeats', async () => {
    const { token } = await createUserWithToken(app, { email: 'me@example.com' });

    await request(app).post('/api/history').set(auth(token)).send({ query: 'repeated' });
    await request(app).post('/api/history').set(auth(token)).send({ query: 'repeated' });

    expect(await History.countDocuments()).toBe(1);
  });

  it('rejects an empty query', async () => {
    const { token } = await createUserWithToken(app, { email: 'me@example.com' });
    const res = await request(app).post('/api/history').set(auth(token)).send({ query: '   ' });
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    expect((await request(app).post('/api/history').send({ query: 'x' })).status).toBe(401);
  });
});

describe('DELETE /api/history/:id', () => {
  it('deletes the caller own entry', async () => {
    const { token } = await createUserWithToken(app, { email: 'me@example.com' });
    await request(app).post('/api/history').set(auth(token)).send({ query: 'to delete' });
    const list = await request(app).get('/api/history').set(auth(token));
    const id = list.body.data.history[0].id;

    const res = await request(app).delete(`/api/history/${id}`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.data.history).toHaveLength(0);
    expect(await History.countDocuments()).toBe(0);
  });

  it('will not delete another user entry', async () => {
    const { admin, user } = await twoUsers();
    await request(app).post('/api/history').set(auth(admin.token)).send({ query: 'admin entry' });
    const adminEntry = await History.findOne({ userId: admin.user._id });

    const res = await request(app).delete(`/api/history/${adminEntry._id}`).set(auth(user.token));
    expect(res.status).toBe(404);
    // The entry survives.
    expect(await History.countDocuments({ _id: adminEntry._id })).toBe(1);
  });

  it('rejects a malformed id with 400 rather than a cast error', async () => {
    const { token } = await createUserWithToken(app, { email: 'me@example.com' });
    const res = await request(app).delete('/api/history/not-an-id').set(auth(token));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/invalid/i);
  });

  it('returns 404 for an id that does not exist', async () => {
    const { token } = await createUserWithToken(app, { email: 'me@example.com' });
    const res = await request(app).delete('/api/history/6aabc623cb678866868d115e').set(auth(token));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/history', () => {
  it('clears only the caller history', async () => {
    const { admin, user } = await twoUsers();
    await request(app)
      .post('/api/history')
      .set(auth(admin.token))
      .send({ query: 'admin keeps this' });
    await request(app)
      .post('/api/history')
      .set(auth(user.token))
      .send({ query: 'user clears this' });

    const res = await request(app).delete('/api/history').set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data.history).toEqual([]);
    expect(res.body.data.deletedCount).toBe(1);

    // The admin's history is untouched.
    expect(await History.countDocuments({ userId: admin.user._id })).toBe(1);
  });

  it('requires authentication', async () => {
    expect((await request(app).delete('/api/history')).status).toBe(401);
  });
});

describe('analytics endpoints', () => {
  let admin;
  let user;

  beforeEach(async () => {
    ({ admin, user } = await twoUsers());

    await seedPage({
      url: 'https://example.com/react',
      title: 'React guide',
      text: 'react hooks components'
    });

    // Real searches produce the analytics data.
    // "react" is searched 3 times so it is unambiguously the top query.
    await request(app).get('/api/search').query({ q: 'react' }).set(auth(user.token));
    await request(app).get('/api/search').query({ q: 'react' });
    await request(app).get('/api/search').query({ q: 'react' });
    await request(app).get('/api/search').query({ q: 'react hooks' });
    await request(app).get('/api/search').query({ q: 'kubernetes' }); // zero results
    await request(app).get('/api/search').query({ q: 'kubernetes' });
  });

  describe('GET /api/analytics/overview', () => {
    it('is admin-only', async () => {
      expect((await request(app).get('/api/analytics/overview')).status).toBe(401);
      expect((await request(app).get('/api/analytics/overview').set(auth(user.token))).status).toBe(
        403
      );
    });

    it('reports counts computed from the search log', async () => {
      const res = await request(app).get('/api/analytics/overview').set(auth(admin.token));

      expect(res.status).toBe(200);
      expect(res.body.data.totalSearches).toBe(6);
      expect(res.body.data.searchesToday).toBe(6);
      expect(res.body.data.searchesThisWeek).toBe(6);
      expect(res.body.data.uniqueQueries).toBe(3); // react, react hooks, kubernetes
      expect(res.body.data.zeroResultSearches).toBe(2);
      expect(res.body.data.avgResponseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('includes the top queries and zero-result queries', async () => {
      const res = await request(app).get('/api/analytics/overview').set(auth(admin.token));
      expect(res.body.data.topQueries[0]).toMatchObject({ query: 'react', count: 3 });
      expect(res.body.data.zeroResultQueries[0]).toMatchObject({ query: 'kubernetes', count: 2 });
    });

    it('includes per-day and per-hour series', async () => {
      const res = await request(app).get('/api/analytics/overview').set(auth(admin.token));
      expect(Array.isArray(res.body.data.searchesPerDay)).toBe(true);
      expect(res.body.data.searchesPerDay.at(-1)).toMatchObject({ count: 6 });
      expect(Array.isArray(res.body.data.searchesPerHour)).toBe(true);
    });
  });

  describe('GET /api/analytics/top-queries', () => {
    it('ranks queries by frequency', async () => {
      const res = await request(app).get('/api/analytics/top-queries').set(auth(admin.token));
      expect(res.status).toBe(200);
      const counts = res.body.data.topQueries.map(q => q.count);
      expect(counts).toEqual([...counts].sort((a, b) => b - a));
    });

    it('honours the limit', async () => {
      const res = await request(app)
        .get('/api/analytics/top-queries')
        .query({ limit: 1 })
        .set(auth(admin.token));
      expect(res.body.data.topQueries).toHaveLength(1);
    });

    it('is blocked for a normal user', async () => {
      expect(
        (await request(app).get('/api/analytics/top-queries').set(auth(user.token))).status
      ).toBe(403);
    });
  });

  describe('GET /api/analytics/zero-result-queries', () => {
    it('lists only queries that returned nothing', async () => {
      const res = await request(app)
        .get('/api/analytics/zero-result-queries')
        .set(auth(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.zeroResultQueries.map(q => q.query)).toEqual(['kubernetes']);
    });
  });

  describe('GET /api/analytics/searches', () => {
    it('returns a paginated raw log', async () => {
      const res = await request(app)
        .get('/api/analytics/searches')
        .query({ limit: 2 })
        .set(auth(admin.token));
      expect(res.status).toBe(200);
      expect(res.body.data.searches).toHaveLength(2);
      expect(res.body.data.pagination.totalResults).toBe(6);
    });

    it('does not store or return an IP address or user agent', async () => {
      const res = await request(app).get('/api/analytics/searches').set(auth(admin.token));
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/ipAddress|userAgent|"ip"/);

      const raw = await SearchLog.findOne().lean();
      expect(Object.keys(raw)).not.toContain('ip');
      expect(Object.keys(raw)).not.toContain('userAgent');
    });
  });

  describe('GET /api/analytics/me', () => {
    it('reports the caller own activity without admin rights', async () => {
      const res = await request(app).get('/api/analytics/me').set(auth(user.token));
      expect(res.status).toBe(200);
      // Only the one search made while signed in as this user.
      expect(res.body.data.totalSearches).toBe(1);
      expect(res.body.data.topQueries[0].query).toBe('react');
    });

    it('requires authentication', async () => {
      expect((await request(app).get('/api/analytics/me')).status).toBe(401);
    });
  });
});
