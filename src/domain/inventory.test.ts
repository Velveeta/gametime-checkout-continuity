import { describe, expect, it } from 'vitest';
import {
  allocationQuantity,
  quoteSelection,
  validateAllocation,
  validateSelection,
} from './inventory';
import { cents, version } from './values';
import type { Listing } from './models';
import type { SeatAllocation } from './models';

const listing: Listing = {
  id: 'test',
  eventId: 'event',
  allocation: {
    kind: 'ASSIGNED',
    section: 'Upper',
    row: '18',
    seats: [9, 10, 11, 12, 13, 14, 15, 16],
  },
  unitPrice: cents(9500),
  feePerTicket: cents(1900),
  currency: 'USD',
  version: version(1),
  quantityRules: { min: 1, max: 4, increment: 1 },
};

describe('selection rules', () => {
  it('validates exact contiguous membership and quantities', () => {
    expect(() =>
      validateSelection(listing, {
        kind: 'EXACT',
        allocation: {
          kind: 'ASSIGNED',
          section: listing.allocation.section,
          row: '18',
          seats: [9, 10],
        },
      }),
    ).not.toThrow();
    expect(() =>
      validateSelection(listing, { kind: 'QUANTITY', quantity: 4 }),
    ).not.toThrow();
  });
  it.each([
    { kind: 'ASSIGNED', section: 'x', row: '1', seats: [] },
    { kind: 'ASSIGNED', section: 'x', row: '1', seats: [1, 3] },
    { kind: 'ASSIGNED', section: 'x', row: '1', seats: [1, 1] },
    { kind: 'ASSIGNED', section: 'x', row: '', seats: [1] },
    { kind: 'GENERAL_ADMISSION', section: 'x', quantity: 1.5 },
    { kind: 'GENERAL_ADMISSION', section: 'x', quantity: 0 },
  ])('rejects invalid allocation %#', (allocation) => {
    expect(() => validateAllocation(allocation as SeatAllocation)).toThrow();
  });
  it.each([0, 5, -1, NaN, Infinity, 1.1])(
    'rejects invalid quantity %j',
    (quantity) => {
      expect(() =>
        validateSelection(listing, { kind: 'QUANTITY', quantity }),
      ).toThrow();
    },
  );
  it('honors pair-only constraints', () => {
    const pairs: Listing = {
      ...listing,
      quantityRules: { min: 2, max: 4, increment: 2 },
    };

    expect(() =>
      validateSelection(pairs, { kind: 'QUANTITY', quantity: 3 }),
    ).toThrow();
    expect(() =>
      validateSelection(pairs, { kind: 'QUANTITY', quantity: 2 }),
    ).not.toThrow();
  });
  it('rejects another row, section, out-of-pool seat or allocation kind', () => {
    for (const allocation of [
      {
        kind: 'ASSIGNED',
        section: listing.allocation.section,
        row: '19',
        seats: [9],
      },
      {
        kind: 'ASSIGNED',
        section: listing.allocation.section,
        row: '18',
        seats: [100],
      },
      { kind: 'ASSIGNED', section: 'Other', row: '18', seats: [9] },
      {
        kind: 'GENERAL_ADMISSION',
        section: listing.allocation.section,
        quantity: 2,
      },
    ] as SeatAllocation[]) {
      expect(() =>
        validateSelection(listing, { kind: 'EXACT', allocation }),
      ).toThrow();
    }
  });
  it('quotes explicit synthetic fees in safe integer cents', () => {
    const quote = quoteSelection(listing, 2);

    expect(quote).toMatchObject({
      ticketSubtotal: 19000,
      fees: 3800,
      total: 22800,
      currency: 'USD',
      version: 1,
    });
    expect(allocationQuantity(listing.allocation)).toBe(8);
    expect(() =>
      quoteSelection(
        {
          ...listing,
          unitPrice: Number.MAX_SAFE_INTEGER as typeof listing.unitPrice,
        },
        2,
      ),
    ).toThrow(RangeError);
  });
});
