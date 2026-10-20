/** All money is non-negative, safe integer cents; no floating-point currency. */
export type Cents = number & { readonly __brand: 'Cents' };
/** UTC ISO-8601 with explicit Z. Domain timestamps are always timezone-aware. */
export type Instant = string & { readonly __brand: 'Instant' };
export type Currency = 'USD';
export type Version = number & { readonly __brand: 'Version' };

export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('Expected non-negative safe integer cents');
  return value as Cents;
}

export function version(value: number): Version {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError('Expected positive safe integer version');
  return value as Version;
}

export function instant(value: string): Instant {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new RangeError(
      'Expected canonical UTC ISO timestamp, e.g. 2026-10-16T17:00:00.000Z',
    );
  }
  return value as Instant;
}
