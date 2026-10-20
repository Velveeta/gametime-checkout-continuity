import { describe, expect, it } from 'vitest';
import { parseServerEnv, requireRedisEnv, requireCheckoutEnv } from './env';

describe('server configuration', () => {
  it('builds the scaffold without credentials and defaults demo off', () => {
    expect(parseServerEnv({}).DEMO_MODE).toBe(false);
    expect(
      parseServerEnv({
        UPSTASH_REDIS_REST_URL: '',
        UPSTASH_REDIS_REST_TOKEN: '',
        DEMO_SECRET: '',
      }).DEMO_MODE,
    ).toBe(false);
  });
  it('does not coerce false to true', () => {
    expect(parseServerEnv({ DEMO_MODE: 'false' }).DEMO_MODE).toBe(false);
  });
  it.each(['yes', '1', 'TRUE', ''])(
    'rejects ambiguous demo setting %j',
    (value) => {
      expect(() => parseServerEnv({ DEMO_MODE: value })).toThrow(
        'Invalid server environment',
      );
    },
  );
  it('requires a strong demo secret only after opt-in', () => {
    expect(() => parseServerEnv({ DEMO_MODE: 'true' })).toThrow(
      'Demo mode requires',
    );
    expect(() =>
      parseServerEnv({ DEMO_MODE: 'true', DEMO_SECRET: 'short' }),
    ).toThrow();
    expect(
      parseServerEnv({ DEMO_MODE: 'true', DEMO_SECRET: 'x'.repeat(32) })
        .DEMO_MODE,
    ).toBe(true);
  });
  it.each([
    { UPSTASH_REDIS_REST_URL: 'https://example.upstash.io' },
    { UPSTASH_REDIS_REST_TOKEN: 'example-token' },
  ])('rejects incomplete Redis config', (input) => {
    expect(() => parseServerEnv(input)).toThrow(
      'Provide both Redis REST credentials',
    );
  });
  it.each(['http://example.upstash.io', 'not-a-url'])(
    'rejects invalid or insecure URL %j',
    (url) => {
      expect(() =>
        parseServerEnv({
          UPSTASH_REDIS_REST_URL: url,
          UPSTASH_REDIS_REST_TOKEN: 'example',
        }),
      ).toThrow();
    },
  );
  it('requires Redis at the adapter boundary', () => {
    expect(() => requireRedisEnv({})).toThrow(
      'Redis REST credentials are required',
    );
    expect(
      requireRedisEnv({
        UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'example',
      }),
    ).toEqual({ url: 'https://example.upstash.io', token: 'example' });
  });
  it('does not echo secrets in validation errors', () => {
    expect(() =>
      parseServerEnv({
        DEMO_SECRET: 'sensitive-input',
        UPSTASH_REDIS_REST_TOKEN: 'private-token',
      }),
    ).toThrow(/^Invalid server environment:/);

    try {
      parseServerEnv({ DEMO_SECRET: 'sensitive-input' });
    } catch (error) {
      expect(String(error)).not.toContain('sensitive-input');
    }
  });
});

describe('Wave 03 runtime configuration', () => {
  const credentials = {
    UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'example',
  };

  it('requires distinct caller/completion secrets at runtime but not build', () => {
    expect(() => requireCheckoutEnv(credentials)).toThrow(
      'secrets are required',
    );
    expect(() =>
      requireCheckoutEnv({
        ...credentials,
        CHECKOUT_CALLER_SECRET: 'x'.repeat(32),
        CHECKOUT_COMPLETION_SECRET: 'x'.repeat(32),
      }),
    ).toThrow('distinct');
    expect(
      requireCheckoutEnv({
        ...credentials,
        CHECKOUT_CALLER_SECRET: 'x'.repeat(32),
        CHECKOUT_COMPLETION_SECRET: 'y'.repeat(32),
      }).CHECKOUT_NAMESPACE,
    ).toBe('gametime-demo');
  });
  it('rejects namespace injection and non-demo scenario changes', () => {
    expect(() =>
      parseServerEnv({ CHECKOUT_NAMESPACE: 'bad}:other' }),
    ).toThrow();
    expect(() => parseServerEnv({ PAYMENT_SCENARIO: 'DECLINE' })).toThrow(
      'require DEMO_MODE',
    );
    expect(
      parseServerEnv({
        PAYMENT_SCENARIO: 'DECLINE',
        DEMO_MODE: 'true',
        DEMO_SECRET: 'x'.repeat(32),
      }).PAYMENT_SCENARIO,
    ).toBe('DECLINE');
  });
});
