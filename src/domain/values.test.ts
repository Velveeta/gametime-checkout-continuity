import { describe, expect, it } from 'vitest';
import { cents, instant, version } from './values';
import { DomainError } from './errors';

describe('money boundary', () => {
  it('accepts whole cents including zero', () => {
    expect(cents(0)).toBe(0);
    expect(cents(12345)).toBe(12345);
  });
  it.each([-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid cents %j',
    (value) => {
      expect(() => cents(value)).toThrow(RangeError);
    },
  );
});
describe('version boundary', () => {
  it('accepts monotonic version primitives', () => expect(version(1)).toBe(1));
  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid version %j',
    (value) => {
      expect(() => version(value)).toThrow(RangeError);
    },
  );
});
describe('authoritative timestamp format', () => {
  it('accepts canonical UTC', () =>
    expect(instant('2026-10-16T17:00:00.000Z')).toBe(
      '2026-10-16T17:00:00.000Z',
    ));
  it.each([
    '2026-10-16',
    '2026-10-16T17:00:00',
    '2026-02-30T00:00:00.000Z',
    'invalid',
  ])('rejects noncanonical timestamp %j', (value) => {
    expect(() => instant(value)).toThrow(RangeError);
  });
});
it('preserves typed business failure codes', () => {
  const error = new DomainError('VERSION_CONFLICT', 'Session changed');

  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe('VERSION_CONFLICT');
});
