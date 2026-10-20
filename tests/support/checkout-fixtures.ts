import type { Event, Listing, SeatAllocation } from '../../src/domain/models';
import { cents, instant, version } from '../../src/domain/values';

export const NOW = instant('2026-10-20T13:00:00.000Z');
export const event: Event = {
  id: 'event',
  title: '[SIMULATED] Test event',
  venue: 'Synthetic venue',
  startsAt: instant('2027-01-01T00:00:00.000Z'),
  timeZone: 'America/Chicago',
};
export const allocation: SeatAllocation = {
  kind: 'ASSIGNED',
  section: 'Upper',
  row: '1',
  seats: [1, 2],
};
export const listing: Listing = {
  id: 'listing',
  eventId: event.id,
  allocation: {
    kind: 'ASSIGNED',
    section: 'Upper',
    row: '1',
    seats: [1, 2, 3, 4],
  },
  unitPrice: cents(9500),
  feePerTicket: cents(1900),
  currency: 'USD',
  version: version(1),
  quantityRules: { min: 1, max: 4, increment: 1 },
};
