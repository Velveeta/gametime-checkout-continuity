import type { CatalogRepository } from '../../application/ports';
import { allocationQuantity, validateAllocation } from '../../domain/inventory';
import type { Event, Listing } from '../../domain/models';
import { cents, instant, version } from '../../domain/values';
import { events, listings } from './fixtures';

/** Reject physical inventory aliases; a GA section is one explicit capacity pool.
 * Human-readable labels are fixture identifiers, not claims about official IDs.
 */
export function validateCatalog(
  eventData: readonly Event[],
  listingData: readonly Listing[],
): void {
  const eventIds = new Set<string>();
  const listingIds = new Set<string>();
  const physicalUnits = new Set<string>();
  for (const event of eventData) {
    if (!event.id || eventIds.has(event.id))
      throw new Error('Duplicate or empty event ID');
    instant(event.startsAt);
    new Intl.DateTimeFormat('en-US', { timeZone: event.timeZone }).format(
      new Date(0),
    );
    eventIds.add(event.id);
  }
  for (const listing of listingData) {
    if (
      !listing.id ||
      listingIds.has(listing.id) ||
      !eventIds.has(listing.eventId)
    )
      throw new Error('Invalid listing identity');
    listingIds.add(listing.id);
    validateAllocation(listing.allocation);
    cents(listing.unitPrice);
    cents(listing.feePerTicket);
    version(listing.version);
    const { min, max, increment } = listing.quantityRules;
    if (
      ![min, max, increment].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      min > max ||
      max > allocationQuantity(listing.allocation) ||
      (max - min) % increment !== 0
    )
      throw new Error('Invalid quantity rules');
    const allocation = listing.allocation;
    const units =
      allocation.kind === 'ASSIGNED'
        ? allocation.seats.map((seat) =>
            JSON.stringify([
              listing.eventId,
              allocation.section,
              allocation.row,
              seat,
            ]),
          )
        : [JSON.stringify([listing.eventId, allocation.section, 'GA'])];
    for (const unit of units) {
      if (physicalUnits.has(unit))
        throw new Error('Overlapping physical inventory in catalog');
      physicalUnits.add(unit);
    }
  }
}

export class FixtureCatalog implements CatalogRepository {
  constructor() {
    validateCatalog(events, listings);
  }
  async listEvents() {
    return events;
  }
  async listListings(eventId: string) {
    return listings.filter((listing) => listing.eventId === eventId);
  }
  async getEvent(id: string) {
    return events.find((event) => event.id === id) ?? null;
  }
  async getListing(id: string) {
    return listings.find((listing) => listing.id === id) ?? null;
  }
}
