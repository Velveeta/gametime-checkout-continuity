import type { Event, Listing, SeatAllocation } from '../../domain/models';
import { validateSelection } from '../../domain/inventory';

export const eventArt: Record<
  string,
  { image: string; category: string; eyebrow: string }
> = {
  'demo-cowboys-eagles': {
    image: 'football',
    category: 'Football',
    eyebrow: 'A rivalry worth showing up for',
  },
  'demo-knicks-celtics': {
    image: 'basketball',
    category: 'Basketball',
    eyebrow: 'Big city. Bigger game.',
  },
  'demo-midnight': {
    image: 'concert',
    category: 'Concerts',
    eyebrow: 'Under the stars, in the moment',
  },
  'demo-cubs-cardinals': {
    image: 'baseball',
    category: 'Baseball',
    eyebrow: 'An afternoon at the ballpark',
  },
};
export const eventTitle = (event: Event) =>
  event.title.replace(/^\[SIMULATED\]\s*/, '');
export const money = (cents: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);

export function eventDate(event: Event, long = false) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: event.timeZone,
    month: long ? 'long' : 'short',
    day: 'numeric',
    ...(long ? ({ weekday: 'long', year: 'numeric' } as const) : {}),
  }).format(new Date(event.startsAt));
}

export const eventTime = (event: Event) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: event.timeZone,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(event.startsAt));

export function seatLabel(allocation: SeatAllocation) {
  if (allocation.kind === 'GENERAL_ADMISSION') {
    return `${allocation.quantity} general admission ${allocation.quantity === 1 ? 'ticket' : 'tickets'}`;
  }

  return `Row ${allocation.row} · ${allocation.seats.length === 1 ? 'Seat' : 'Seats'} ${allocation.seats.join(', ')}`;
}

export function selectionKey(allocation: SeatAllocation) {
  return JSON.stringify(
    allocation.kind === 'ASSIGNED'
      ? [allocation.kind, allocation.section, allocation.row, allocation.seats]
      : [allocation.kind, allocation.section, allocation.quantity],
  );
}

/** Presentation candidates only. The domain validates each option; the server
 * revalidates stock/version atomically when the shopper actually reserves.
 */
export function selections(
  listing: Listing,
  available: readonly SeatAllocation[],
  quantity: number,
): SeatAllocation[] {
  const candidates: SeatAllocation[] = [];

  for (const pool of available) {
    if (pool.kind === 'GENERAL_ADMISSION') {
      if (pool.quantity >= quantity) {
        candidates.push({ ...pool, quantity });
      }
    } else {
      for (let i = 0; i <= pool.seats.length - quantity; i++) {
        candidates.push({
          ...pool,
          seats: pool.seats.slice(i, i + quantity) as [number, ...number[]],
        });
      }
    }
  }

  return candidates.filter((allocation) => {
    try {
      validateSelection(listing, { kind: 'EXACT', allocation });

      return true;
    } catch {
      return false;
    }
  });
}

export function quantities(
  listing: Listing,
  available: readonly SeatAllocation[],
) {
  const { min, max, increment } = listing.quantityRules;
  const options: number[] = [];

  for (let n = min; n <= max; n += increment) {
    if (selections(listing, available, n).length) {
      options.push(n);
    }
  }

  return options;
}

export function secondsLeft(
  deadline: string,
  serverMs: number,
  elapsedMs: number,
) {
  return Math.max(
    0,
    Math.ceil(
      (Date.parse(deadline) - serverMs - Math.max(0, elapsedMs)) / 1000,
    ),
  );
}

export const terminal = (status: string) =>
  ['EXPIRED', 'COMPLETED', 'PAYMENT_FAILED'].includes(status);
