import type { ListingAvailability, InventoryReservation, ReservationRepository, ReserveInventory } from "../../application/inventory-contracts";
import type { CatalogRepository } from "../../application/ports";
import { DomainError, type DomainErrorCode, type Result } from "../../domain/errors";
import { validateSelection } from "../../domain/inventory";
import type { Listing, SeatAllocation } from "../../domain/models";
import { instant, version } from "../../domain/values";
import { INVENTORY_LUA } from "./inventory-lua";
import { validateCatalog } from "../catalog/catalog";

/** Implemented by @upstash/redis; integration tests execute the same Lua on Redis. */
export interface RedisScriptExecutor {
  eval<T>(script: string, keys: string[], args: (string | number)[]): Promise<T>;
}
interface StoredReservation {
  id: string; listingId: string; sessionId: string; allocation: SeatAllocation;
  createdAtMs: number; expiresAtMs: number; status: "HELD" | "EXPIRED" | "SOLD"; orderId?: string;
}
interface StoredAvailability {
  available: SeatAllocation[] | Record<string, never>;
  ownReservations: StoredReservation[] | Record<string, never>;
  counts: ListingAvailability["counts"]; version: number; serverNowMs: number;
}
type Reply<T> = { ok: true; value: T } | { ok: false; code: DomainErrorCode };
function reservation(raw: StoredReservation): InventoryReservation {
  const base = { id: raw.id, listingId: raw.listingId, sessionId: raw.sessionId, allocation: raw.allocation,
    createdAt: instant(new Date(raw.createdAtMs).toISOString()), expiresAt: instant(new Date(raw.expiresAtMs).toISOString()) };
  if (raw.status === "SOLD") {
    if (!raw.orderId) throw new Error("Corrupt sold reservation");
    return { ...base, status: "SOLD", orderId: raw.orderId };
  }
  return { ...base, status: raw.status };
}
function identifier(value: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new DomainError("INVALID_SELECTION", "Invalid inventory identifier");
}

export class RedisInventory implements ReservationRepository {
  private readonly prefix: string;
  private readonly holdDurationMs: number;
  constructor(private readonly redis: RedisScriptExecutor, private readonly catalog: CatalogRepository,
    options: { namespace: string; holdDurationMs?: number }) {
    identifier(options.namespace);
    this.prefix = `checkout:{${options.namespace}}:inventory:`;
    this.holdDurationMs = options.holdDurationMs ?? 10 * 60_000;
    if (!Number.isSafeInteger(this.holdDurationMs) || this.holdDurationMs < 100 || this.holdDurationMs > 30 * 60_000) {
      throw new RangeError("Hold policy must be 100ms–30min (server configuration only)");
    }
  }
  private async command<T>(eventId: string, request: object): Promise<Reply<T>> {
    identifier(eventId);
    const raw = await this.redis.eval<Reply<T> | string>(INVENTORY_LUA, [this.prefix + eventId], [JSON.stringify({ ...request, eventId })]);
    return typeof raw === "string" ? JSON.parse(raw) as Reply<T> : raw;
  }
  async initialize(): Promise<void> {
    const events = await this.catalog.listEvents();
    const groups = await Promise.all(events.map((event) => this.catalog.listListings(event.id)));
    validateCatalog(events, groups.flat());
    for (const [index, event] of events.entries()) {
      const listings = Object.fromEntries(groups[index]!.map((listing) => [listing.id, listing]));
      const result = await this.command<boolean>(event.id, { kind: "INITIALIZE", listings });
      if (!result.ok) throw new DomainError(result.code, result.code);
    }
  }
  private async listing(id: string): Promise<Listing> {
    identifier(id);
    const listing = await this.catalog.getListing(id);
    if (!listing) throw new DomainError("NOT_FOUND", "Listing not found");
    return listing;
  }
  async getAvailability(listingId: string, ownerSessionId?: string): Promise<ListingAvailability> {
    const listing = await this.listing(listingId);
    if (ownerSessionId !== undefined) identifier(ownerSessionId);
    const result = await this.command<StoredAvailability>(listing.eventId, { kind: "AVAILABILITY", listingId, ownerSessionId });
    if (!result.ok) throw new DomainError(result.code, result.code);
    const value = result.value;
    return { available: Array.isArray(value.available) ? value.available : [],
      ownReservations: Array.isArray(value.ownReservations) ? value.ownReservations.map(reservation) : [],
      counts: value.counts, version: version(value.version), serverNow: instant(new Date(value.serverNowMs).toISOString()) };
  }
  async reserve(input: ReserveInventory): Promise<Result<InventoryReservation>> {
    try {
      identifier(input.sessionId); identifier(input.reservationId);
      const listing = await this.listing(input.listingId);
      validateSelection(listing, input.selection);
      const result = await this.command<StoredReservation>(listing.eventId, { kind: "RESERVE", input, holdDurationMs: this.holdDurationMs });
      return result.ok ? { ok: true, value: reservation(result.value) } : { ok: false, error: new DomainError(result.code, result.code) };
    } catch (error) {
      if (error instanceof DomainError) return { ok: false, error };
      throw error;
    }
  }
  async commitSale(input: { listingId: string; reservationId: string; sessionId: string; orderId: string }): Promise<Result<InventoryReservation>> {
    try {
      identifier(input.sessionId); identifier(input.reservationId); identifier(input.orderId);
      const listing = await this.listing(input.listingId);
      const result = await this.command<StoredReservation>(listing.eventId, { kind: "SELL", input });
      return result.ok ? { ok: true, value: reservation(result.value) } : { ok: false, error: new DomainError(result.code, result.code) };
    } catch (error) {
      if (error instanceof DomainError) return { ok: false, error };
      throw error;
    }
  }
}
