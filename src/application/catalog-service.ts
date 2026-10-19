import { DomainError, type Result } from "../domain/errors";
import { validateSelection } from "../domain/inventory";
import type { CatalogRepository } from "./ports";
import type { ReservationRepository, ReserveInventory, ListingAvailability } from "./inventory-contracts";
import type { Listing } from "../domain/models";

/** Read/service contract for future UI; no HTTP route or UI is added in Wave 01. */
export class CatalogService {
  constructor(private readonly catalog: CatalogRepository, private readonly inventory: ReservationRepository) {}
  listEvents() { return this.catalog.listEvents(); }
  async listListings(eventId: string): Promise<Result<readonly Listing[]>> {
    if (!await this.catalog.getEvent(eventId)) return { ok: false, error: new DomainError("NOT_FOUND", "Event not found") };
    return { ok: true, value: await this.catalog.listListings(eventId) };
  }
  async availability(listingId: string, trustedOwnerSessionId?: string): Promise<Result<ListingAvailability>> {
    if (!await this.catalog.getListing(listingId)) return { ok: false, error: new DomainError("NOT_FOUND", "Listing not found") };
    try {
      return { ok: true, value: await this.inventory.getAvailability(listingId, trustedOwnerSessionId) };
    } catch (error) {
      if (error instanceof DomainError) return { ok: false, error };
      throw error;
    }
  }
  async reserve(input: ReserveInventory) {
    const listing = await this.catalog.getListing(input.listingId);
    if (!listing) return { ok: false, error: new DomainError("NOT_FOUND", "Listing not found") } as const;
    try { validateSelection(listing, input.selection); } catch (error) {
      if (error instanceof DomainError) return { ok: false, error } as const;
      throw error;
    }
    // Adapter repeats validation against persisted definitions inside Lua, closing TOCTOU gaps.
    return this.inventory.reserve(input);
  }
}
