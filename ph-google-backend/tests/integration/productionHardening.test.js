const request = require('supertest');
const testDb = require('../helpers/testDb');
const { config, parseTrustProxy } = require('../../config/env');
const openSearchClient = require('../../services/opensearch/client');
const redisConnection = require('../../services/queue/connection');

/**
 * What the API shows to anyone on the internet: a health answer with no
 * internal details, CORS refusals that are refusals (403), and a trust-proxy
 * setting that is configured rather than assumed.
 */

let app;
beforeAll(async () => {
  await testDb.connect();
  app = require('../../app').createApp();
});
afterAll(async () => {
  await testDb.disconnect();
});
afterEach(() => jest.restoreAllMocks());

describe('the public health check', () => {
  it.each(['/api/health', '/health', '/'])('%s says only whether each part is up', async path => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(Object.keys(data).sort()).toEqual(
      ['database', 'queue', 'search', 'service', 'status', 'timestamp', 'uptimeSeconds'].sort()
    );
    expect(Object.keys(data.database).sort()).toEqual(['connected', 'state']);
    expect(Object.keys(data.search)).toEqual(['connected']);
    expect(Object.keys(data.queue)).toEqual(['connected']);
    expect(['ok', 'degraded']).toContain(data.status);
  });

  it('never shows hosts, ports, database or index names, or error text', async () => {
    const body = JSON.stringify((await request(app).get('/api/health')).body);
    for (const leak of [
      config.opensearch.node,
      config.opensearch.index,
      'redis://',
      'mongodb',
      'localhost',
      '127.0.0.1',
      ':9200',
      ':6379',
      'ECONNREFUSED',
      'environment'
    ]) {
      expect(body).not.toContain(leak);
    }
  });

  it('checks the stores at most once every few seconds, however often it is asked', async () => {
    const search = jest
      .spyOn(openSearchClient, 'checkHealth')
      .mockResolvedValue({ ok: true, node: 'http://internal:9200' });
    const queue = jest
      .spyOn(redisConnection, 'checkHealth')
      .mockResolvedValue({ ok: true, url: 'redis://internal:6379' });
    const fresh = require('../../app').createApp();
    await Promise.all(Array.from({ length: 5 }, () => request(fresh).get('/api/health')));
    expect(search).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
  });
});

describe('CORS', () => {
  it('an allowed origin gets the CORS headers', async () => {
    const res = await request(app).get('/api/search/config').set('Origin', 'http://localhost:3000');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('any other origin is refused with 403 — a refusal, not a server error', async () => {
    const res = await request(app).get('/api/search/config').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a request with no Origin (same-origin through nginx, server to server) is served', async () => {
    expect((await request(app).get('/api/search/config')).status).toBe(200);
  });
});

describe('TRUST_PROXY', () => {
  it.each([
    [undefined, 1],
    ['', 1],
    ['1', 1],
    ['2', 2],
    ['0', false],
    ['false', false],
    ['loopback, 10.0.0.0/8', ['loopback', '10.0.0.0/8']]
  ])('%j → %j', (raw, expected) => {
    expect(parseTrustProxy(raw)).toEqual(expected);
  });

  it('the app uses the configured value', () => {
    expect(app.get('trust proxy')).toEqual(config.trustProxy);
  });
});
