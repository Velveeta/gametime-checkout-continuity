import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { request, RequestError, rememberAttempt, savedAttempt } from './http';
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());
it('persists the exact request key and price versions for safe retries', () => {
  const attempt = { key: 'request-123', expectedVersion: 4, quoteVersion: 2 };
  rememberAttempt('checkout', attempt);
  expect(savedAttempt('checkout')).toEqual(attempt);
  rememberAttempt('checkout', null);
  expect(savedAttempt('checkout')).toBeNull();
});
it('rejects malformed local retry data', () => {
  for (const input of [
    '{',
    'null',
    '{"key":"x","expectedVersion":-1,"quoteVersion":2}',
    '{"key":"bad key","expectedVersion":1,"quoteVersion":2}',
  ]) {
    values.set('gametime:payment:checkout', input);
    expect(savedAttempt('checkout')).toBeNull();
  }
});
it('tolerates unavailable storage without losing server-side protection', () => {
  vi.stubGlobal('sessionStorage', {
    getItem: () => {
      throw new Error();
    },
    setItem: () => {
      throw new Error();
    },
  });
  expect(savedAttempt('x')).toBeNull();
  expect(() =>
    rememberAttempt('x', { key: 'k', expectedVersion: 1, quoteVersion: 1 }),
  ).not.toThrow();
});
it('accepts retained expired snapshots only on the explicit checkout read path', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        {
          ok: false,
          error: { code: 'RESERVATION_EXPIRED', message: 'expired' },
          data: { session: { status: 'EXPIRED' } },
        },
        { status: 410 },
      ),
    ),
  );
  expect(await request('/checkout', {}, true)).toMatchObject({
    session: { status: 'EXPIRED' },
  });
  await expect(request('/checkout')).rejects.toBeInstanceOf(RequestError);
});
it('uses no-store and a bounded request signal', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ ok: true, data: { id: 'session' } }),
  );
  vi.stubGlobal('fetch', fetcher);
  await request('/checkout', { method: 'POST', body: '{}' });
  expect(fetcher).toHaveBeenCalledWith(
    '/checkout',
    expect.objectContaining({
      cache: 'no-store',
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
    }),
  );
});
