import type { Result } from '../domain/errors';
import type { InventorySelection } from '../domain/inventory';
import type {
  ListingId,
  OrderId,
  ReservationId,
  SeatAllocation,
  SessionId,
} from '../domain/models';
import type { Instant, Version } from '../domain/values';
import type { Inventory } from './ports';

export type InventoryReservation = {
  readonly id: ReservationId;
  readonly sessionId: SessionId;
  readonly listingId: ListingId;
  readonly allocation: SeatAllocation;
  readonly createdAt: Instant;
  readonly expiresAt: Instant;
} & (
  | { readonly status: 'HELD' }
  | { readonly status: 'EXPIRED' }
  | { readonly status: 'SOLD'; readonly orderId: OrderId }
);

export interface ListingAvailability {
  readonly available: readonly SeatAllocation[];
  /** Inventory revision, independent of the catalog/quote version. */
  readonly version: Version;
  readonly serverNow: Instant;
  readonly counts: {
    readonly total: number;
    readonly available: number;
    readonly held: number;
    readonly sold: number;
  };
  /** Only returned to a trusted application caller for this checkout owner. */
  readonly ownReservations: readonly InventoryReservation[];
}

export interface ReserveInventory {
  readonly listingId: ListingId;
  readonly sessionId: SessionId;
  readonly reservationId: ReservationId;
  readonly selection: InventorySelection;
  readonly expectedListingVersion: Version;
}

/** Internal persistence primitives, not checkout orchestration or HTTP APIs.
 * A future checkout repository MUST compose reserve + session creation and
 * sale + order creation within the same Lua execution, not call them in sequence.
 */
export interface ReservationRepository extends Inventory {
  getAvailability(
    listingId: ListingId,
    ownerSessionId?: SessionId,
  ): Promise<ListingAvailability>;
  reserve(input: ReserveInventory): Promise<Result<InventoryReservation>>;
  /** Inventory sale primitive only. No order is created here. */
  commitSale(input: {
    readonly listingId: ListingId;
    readonly reservationId: ReservationId;
    readonly sessionId: SessionId;
    readonly orderId: OrderId;
  }): Promise<Result<InventoryReservation>>;
  /** Non-destructive, SET-NX-equivalent fixture initialization. */
  initialize(): Promise<void>;
}

/** Wave 05 contract only; no reset implementation or route exists in Wave 01.
 * Verify DEMO_MODE and timing-safe secret authentication, then require explicit
 * confirmation before atomically resetting only the configured demo namespace.
 * Never expose this interface directly to a browser.
 */
export interface DemoInventoryReset {
  reset(input: {
    readonly demoSecret: string;
    readonly confirmation: 'RESET_SIMULATED_INVENTORY';
  }): Promise<Result<{ readonly resetAt: Instant }>>;
}
