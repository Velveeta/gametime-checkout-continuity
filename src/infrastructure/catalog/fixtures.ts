import type { Event, Listing, SeatAllocation } from '../../domain/models';
import { cents, instant, version } from '../../domain/values';

export const SIMULATION_NOTICE =
  'Fictional assessment fixtures. All dates, listings, fees, inventory and purchases are simulated; these are not scheduled events or real offers.';

function assigned(
  section: string,
  row: string,
  first: number,
  quantity: number,
): SeatAllocation {
  return {
    kind: 'ASSIGNED',
    section,
    row,
    seats: Array.from({ length: quantity }, (_, i) => first + i) as [
      number,
      ...number[],
    ],
  };
}
function ga(section: string, quantity: number): SeatAllocation {
  return { kind: 'GENERAL_ADMISSION', section, quantity };
}
function listing(
  id: string,
  eventId: string,
  allocation: SeatAllocation,
  dollars: number,
  feeDollars: number,
  min = 1,
  max = 4,
  increment = 1,
): Listing {
  return {
    id,
    eventId,
    allocation,
    unitPrice: cents(dollars * 100),
    feePerTicket: cents(feeDollars * 100),
    currency: 'USD',
    version: version(1),
    quantityRules: { min, max, increment },
  };
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const events: readonly Event[] = deepFreeze([
  {
    id: 'demo-cowboys-eagles',
    title: '[SIMULATED] Dallas Cowboys vs Philadelphia Eagles',
    venue: 'AT&T Stadium · Arlington, TX',
    startsAt: instant('2027-09-19T20:25:00.000Z'),
    timeZone: 'America/Chicago',
  },
  {
    id: 'demo-knicks-celtics',
    title: '[SIMULATED] New York Knicks vs Boston Celtics',
    venue: 'Madison Square Garden · New York, NY',
    startsAt: instant('2027-01-20T00:30:00.000Z'),
    timeZone: 'America/New_York',
  },
  {
    id: 'demo-midnight',
    title: '[SIMULATED] The Midnight',
    venue: 'Red Rocks Amphitheatre · Morrison, CO',
    startsAt: instant('2027-05-15T01:30:00.000Z'),
    timeZone: 'America/Denver',
  },
  {
    id: 'demo-cubs-cardinals',
    title: '[SIMULATED] Chicago Cubs vs St. Louis Cardinals',
    venue: 'Wrigley Field · Chicago, IL',
    startsAt: instant('2027-06-12T18:20:00.000Z'),
    timeZone: 'America/Chicago',
  },
]);

export const listings: readonly Listing[] = deepFreeze([
  listing(
    'nfl-upper-443',
    'demo-cowboys-eagles',
    assigned('443 · Upper Reserved', '18', 9, 8),
    95,
    19,
  ),
  listing(
    'nfl-upper-412',
    'demo-cowboys-eagles',
    assigned('412 · Upper Reserved', '5', 13, 6),
    145,
    29,
  ),
  listing(
    'nfl-lower-101',
    'demo-cowboys-eagles',
    assigned('101 · Lower Reserved', '12', 1, 4),
    295,
    59,
    2,
    4,
    2,
  ),
  listing(
    'nfl-club-c110',
    'demo-cowboys-eagles',
    assigned('C110 · Hall of Fame Club', '8', 5, 4),
    575,
    115,
    2,
    4,
    2,
  ),
  listing(
    'nba-upper-225',
    'demo-knicks-celtics',
    assigned('225 · Upper Bowl', '16', 7, 8),
    85,
    17,
  ),
  listing(
    'nba-upper-212',
    'demo-knicks-celtics',
    assigned('212 · Upper Bowl', '3', 1, 6),
    155,
    31,
  ),
  listing(
    'nba-lower-108',
    'demo-knicks-celtics',
    assigned('108 · Lower Bowl', '10', 9, 4),
    350,
    70,
    2,
    4,
    2,
  ),
  listing(
    'nba-courtside',
    'demo-knicks-celtics',
    assigned('Courtside · Synthetic Floor Block', 'AA', 1, 2),
    1250,
    250,
    2,
    2,
    2,
  ),
  // This fictional concert uses reserved rows 5–45, GA rows 46–69; not a real show configuration.
  listing('music-ga', 'demo-midnight', ga('GA · Rows 46–69', 12), 65, 13, 1, 6),
  listing(
    'music-row-40',
    'demo-midnight',
    assigned('Reserved', '40', 41, 8),
    115,
    23,
  ),
  listing(
    'music-row-25',
    'demo-midnight',
    assigned('Reserved', '25', 31, 6),
    175,
    35,
  ),
  listing(
    'music-row-10',
    'demo-midnight',
    assigned('Reserved', '10', 21, 4),
    245,
    49,
    2,
    4,
    2,
  ),
  listing(
    'mlb-upper-430',
    'demo-cubs-cardinals',
    assigned('430R · Upper Reserved Outfield', '7', 1, 8),
    40,
    8,
  ),
  listing(
    'mlb-bleachers',
    'demo-cubs-cardinals',
    ga('Budweiser Bleachers · Unassigned', 10),
    75,
    15,
    1,
    6,
  ),
  listing(
    'mlb-field-112',
    'demo-cubs-cardinals',
    assigned('112 · Field Box Infield', '12', 1, 6),
    145,
    29,
  ),
  listing(
    'mlb-field-110',
    'demo-cubs-cardinals',
    assigned('110 · Field Box Infield', '3', 7, 4),
    225,
    45,
    2,
    4,
    2,
  ),
]);
