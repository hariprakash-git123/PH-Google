import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchApi } from './searchApi';
import { safeHttpUrl } from '../utils/safeUrl';

/**
 * The AI answer calls in the API layer, with `fetch` replaced: what is sent
 * to the backend, and how each kind of failure is turned into the one shape
 * the component renders.
 */

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchApi.getAiAnswer', () => {
  it('requests /ai-answer with the query and the filters in API vocabulary', async () => {
    fetch.mockResolvedValue(
      jsonResponse(200, { success: true, data: { status: 'ok', answer: 'A [1].' } })
    );

    const data = await searchApi.getAiAnswer('What is OpenSearch?', {
      domain: 'opensearch.org',
      date: 'Past week',
      language: 'English'
    });

    expect(data).toEqual({ status: 'ok', answer: 'A [1].' });
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/ai-answer');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'What is OpenSearch?',
      domain: 'opensearch.org',
      date: 'week',
      language: 'en'
    });
    expect(fetch.mock.calls[0][1].method).toBe('GET');
  });

  it('leaves out empty filters and only sends refresh when asked', async () => {
    fetch.mockResolvedValue(jsonResponse(200, { success: true, data: { status: 'ok' } }));

    await searchApi.getAiAnswer('opensearch', { date: 'Any time', language: 'Any language' });
    expect(Object.fromEntries(new URL(fetch.mock.calls[0][0]).searchParams)).toEqual({
      q: 'opensearch',
      date: 'any'
    });

    await searchApi.getAiAnswer('opensearch', {}, { refresh: true });
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get('refresh')).toBe('true');
  });

  it('passes the abort signal through', async () => {
    fetch.mockResolvedValue(jsonResponse(200, { success: true, data: { status: 'ok' } }));
    const controller = new AbortController();
    await searchApi.getAiAnswer('opensearch', {}, { signal: controller.signal });
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('never sends a credential for the AI provider', async () => {
    fetch.mockResolvedValue(jsonResponse(200, { success: true, data: { status: 'ok' } }));
    await searchApi.getAiAnswer('opensearch');
    const [url, init] = fetch.mock.calls[0];
    expect(url).not.toMatch(/key|token|secret/i);
    expect(Object.keys(init.headers)).not.toContain('x-api-key');
  });

  it('a server error becomes "unavailable", not an exception', async () => {
    fetch.mockResolvedValue(jsonResponse(500, { success: false, message: 'Internal error' }));
    const data = await searchApi.getAiAnswer('opensearch');
    expect(data).toMatchObject({
      status: 'unavailable',
      reason: 'request_failed',
      generated: false,
      answer: '',
      keyPoints: [],
      sources: [],
      message: 'AI answer is temporarily unavailable.'
    });
  });

  it('a rate limit is reported as such', async () => {
    fetch.mockResolvedValue(
      jsonResponse(429, { success: false, message: 'Too many AI answer requests.' })
    );
    const data = await searchApi.getAiAnswer('opensearch');
    expect(data).toMatchObject({ status: 'unavailable', reason: 'rate_limited' });
  });

  it('a network failure becomes "unavailable"', async () => {
    fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const data = await searchApi.getAiAnswer('opensearch');
    expect(data.status).toBe('unavailable');
  });

  it('a cancelled request is rethrown so the caller can ignore it', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError');
    fetch.mockRejectedValue(abort);
    await expect(searchApi.getAiAnswer('opensearch')).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('searchApi.sendAiFeedback', () => {
  it('posts the rating and reports success', async () => {
    fetch.mockResolvedValue(
      jsonResponse(201, { success: true, data: { answerId: 'abc12345', rating: 'up' } })
    );

    const stored = await searchApi.sendAiFeedback({
      answerId: 'abc12345',
      query: 'opensearch',
      rating: 'up',
      model: 'claude-opus-5-5',
      provider: 'anthropic'
    });

    expect(stored).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(url).pathname).toBe('/api/ai-answer/feedback');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      answerId: 'abc12345',
      query: 'opensearch',
      rating: 'up',
      model: 'claude-opus-5-5',
      provider: 'anthropic'
    });
  });

  it('reports failure without throwing', async () => {
    fetch.mockResolvedValue(
      jsonResponse(400, { success: false, message: '"rating" must be one of: up, down.' })
    );
    expect(
      await searchApi.sendAiFeedback({ answerId: 'abc12345', query: 'q', rating: 'meh' })
    ).toBe(false);
  });
});

describe('safeHttpUrl', () => {
  it('accepts http and https addresses', () => {
    expect(safeHttpUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(safeHttpUrl('  http://example.com  ')).toBe('http://example.com/');
  });

  it('refuses everything else', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://example.com/x',
      'mailto:a@b.c',
      '//example.com/no-scheme',
      '/relative/path',
      'example.com',
      '',
      null,
      undefined,
      42,
      {}
    ]) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
  });
});
