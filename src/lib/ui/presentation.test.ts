import { describe, it, expect } from 'vitest';
import { events, listings } from '../../infrastructure/catalog/fixtures';
import {
  eventTitle,
  eventDate,
  eventTime,
  money,
  quantities,
  selections,
  secondsLeft,
  terminal,
  seatLabel,
  selectionKey,
} from './presentation';
import type { SeatAllocation } from '../../domain/models';

const listing = listings[0]!;

describe('shopping presentation with authoritative domain constraints', () => {
  it('formats money without losing cents', () => {
    expect(money(11400)).toBe('$114');
    expect(money(11405)).toBe('$114.05');
  });
  it('uses the venue time zone and removes the fixture prefix for display', () => {
    expect(eventTitle(events[1]!)).toBe('New York Knicks vs Boston Celtics');
    expect(eventDate(events[1]!)).toBe('Jan 19');
    expect(eventTime(events[1]!)).toContain('7:30');
  });
  it('generates only contiguous available assigned choices', () => {
    if (listing.allocation.kind !== 'ASSIGNED') {
      throw new Error();
    }

    const available: SeatAllocation[] = [
      { ...listing.allocation, seats: [9, 10] },
      { ...listing.allocation, seats: [13, 14, 15] },
    ];

    expect(selections(listing, available, 2).map(seatLabel)).toEqual([
      'Row 18 · Seats 9, 10',
      'Row 18 · Seats 13, 14',
      'Row 18 · Seats 14, 15',
    ]);
    expect(quantities(listing, available)).toEqual([1, 2, 3]);
  });
  it('respects paired-ticket and min/max domain rules', () => {
    const pair = listings.find((row) => row.id === 'nfl-lower-101')!;

    expect(quantities(pair, [pair.allocation])).toEqual([2, 4]);
    expect(selections(pair, [pair.allocation], 3)).toEqual([]);
  });
  it('does not offer more GA tickets than are available', () => {
    const ga = listings.find((row) => row.id === 'music-ga')!;

    if (ga.allocation.kind !== 'GENERAL_ADMISSION') {
      throw new Error();
    }

    expect(quantities(ga, [{ ...ga.allocation, quantity: 2 }])).toEqual([1, 2]);
    expect(selections(ga, [{ ...ga.allocation, quantity: 2 }], 3)).toEqual([]);
  });
  it('offers no selections from missing inventory', () => {
    expect(quantities(listing, [])).toEqual([]);
    expect(selections(listing, [], 2)).toEqual([]);
  });
  it('computes countdown from server time plus monotonic elapsed, with exact expiry', () => {
    const deadline = '2027-01-01T00:00:10.000Z',
      server = Date.parse('2027-01-01T00:00:00.000Z');

    expect(secondsLeft(deadline, server, 0)).toBe(10);
    expect(secondsLeft(deadline, server, 1200)).toBe(9);
    expect(secondsLeft(deadline, server, 10_000)).toBe(0);
    expect(secondsLeft(deadline, server, 20_000)).toBe(0);
    expect(secondsLeft(deadline, server, -1000)).toBe(10);
  });
  it('stops polling terminal states but protects processing', () => {
    for (const state of ['EXPIRED', 'PAYMENT_FAILED', 'COMPLETED']) {
      expect(terminal(state)).toBe(true);
    }

    for (const state of [
      'ACTIVE',
      'PRICE_REVIEW',
      'PROCESSING',
      'PAYMENT_RETRYABLE',
    ]) {
      expect(terminal(state)).toBe(false);
    }
  });
  it('identifies the same seats independently of JSON property order', () => {
    const a: SeatAllocation = {
      kind: 'ASSIGNED',
      section: '443',
      row: '18',
      seats: [13, 14],
    };
    const b: SeatAllocation = {
      seats: [13, 14],
      row: '18',
      section: '443',
      kind: 'ASSIGNED',
    };

    expect(selectionKey(a)).toBe(selectionKey(b));
    expect(selectionKey(a)).not.toBe(selectionKey({ ...b, seats: [14, 15] }));
  });
});
