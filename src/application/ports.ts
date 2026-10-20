import type { CheckoutEventName, CheckoutPolicy, ResolvedPayment } from "../domain/checkout";
import type { Result } from "../domain/errors";
import type { AttemptId, CheckoutSession, CompletionCapability, Event, EventId, Listing,
  ListingId, Order, OrderId, PriceQuote, SeatAllocation, SessionId } from "../domain/models";
import type { Instant, Version } from "../domain/values";

export interface Clock { now(): Instant }

export interface CatalogRepository {
  listEvents(): Promise<readonly Event[]>;
  listListings(eventId: EventId): Promise<readonly Listing[]>;
  getEvent(id: EventId): Promise<Event | null>;
  getListing(id: ListingId): Promise<Listing | null>;
}

export interface Inventory {
  /** Authoritative availability at serverNow; excludes live holds and sold units. */
  getAvailability(listingId: ListingId): Promise<{
    readonly available: readonly SeatAllocation[];
    readonly version: Version;
    readonly serverNow: Instant;
  }>;
}

export type PaymentOutcome = ResolvedPayment;

export interface Payment {
  /** Simulator only: stable ordinal + attemptId, never a process-local counter.
   * TRANSIENT_FAILURE conclusively means non-capture. UNKNOWN never permits retry.
   * A success is only a proposal; only fenced atomic settlement can capture/sell.
   */
  attempt(input: { readonly sessionId: SessionId; readonly attemptId: AttemptId;
    readonly attemptNumber: 1 | 2 | 3; readonly quote: PriceQuote }): Promise<PaymentOutcome>;
}

export type AnalyticsEvent = {
  readonly name: CheckoutEventName;
  readonly sessionId: SessionId;
  readonly at: Instant; // authoritative transaction timestamp
  readonly observedAt?: Instant; // injected application clock, telemetry only
  readonly version: Version;
};
export interface Analytics { record(event: AnalyticsEvent): Promise<void> }

export interface CompletionIdentity {
  /** Trusted server-established caller binding, never an arbitrary body field. */
  readonly callerId: string;
  readonly idempotencyKey: string;
}
export interface Identifiers { next(kind: "session" | "reservation" | "attempt" | "order"): string }
export interface CompletionAuthority {
  /** Deterministic secret-derived token for stable SAME-caller/key replay only. */
  issue(input: CompletionIdentity & { readonly sessionId: SessionId }): { readonly capability: CompletionCapability; readonly digest: string };
}
export type DemoAuthorization = string & { readonly __brand: "DemoAuthorization" };

/** All commands are server-internal. Atomic executor samples authoritative time,
 * reads current quotes/ownership/order/idempotency facts and applies domain rules
 * inside ONE consistency boundary. Never implement using read + separate writes.
 */
export type CheckoutCommand =
  | { readonly kind: "RESERVE"; readonly sessionId: SessionId; readonly reservationId: string;
      readonly listingId: ListingId; readonly allocation: SeatAllocation; readonly expectedListingVersion: Version }
  | { readonly kind: "ACCEPT_QUOTE"; readonly sessionId: SessionId;
      readonly expectedVersion: Version; readonly quoteVersion: Version }
  | { readonly kind: "REFRESH_QUOTE"; readonly sessionId: SessionId; readonly expectedVersion: Version }
  | ({ readonly kind: "CLAIM_COMPLETION"; readonly sessionId: SessionId; readonly attemptId: AttemptId;
      readonly expectedVersion: Version; readonly quoteVersion: Version } & CompletionIdentity)
  | ({ readonly kind: "SETTLE_PAYMENT"; readonly sessionId: SessionId; readonly attemptId: AttemptId;
      readonly outcome: PaymentOutcome; readonly orderId: OrderId; readonly capabilityDigest: string } & CompletionIdentity)
  | { readonly kind: "EXPIRE_IF_DUE"; readonly sessionId: SessionId }
  | { readonly kind: "RECOVER"; readonly expiredSessionId: SessionId; readonly successorId: SessionId;
      readonly reservationId: string; readonly idempotencyKey: string }
  | { readonly kind: "CHANGE_DEADLINE"; readonly sessionId: SessionId; readonly expectedVersion: Version;
      readonly expiresAt: Instant; readonly authorization: DemoAuthorization };

interface MutationSnapshot {
  readonly session: CheckoutSession;
  readonly serverNow: Instant;
  /** Newly committed events only; replays return no events. */
  readonly events: readonly CheckoutEventName[];
}
export type CheckoutMutation =
  | (MutationSnapshot & { readonly kind: "UPDATED" | "IN_PROGRESS" | "REPLAY" })
  | (MutationSnapshot & { readonly kind: "CLAIMED"; readonly session: Extract<CheckoutSession, { status: "PROCESSING" }> })
  | (MutationSnapshot & { readonly kind: "COMPLETED" | "REPLAY_COMPLETED";
      readonly session: Extract<CheckoutSession, { status: "COMPLETED" }>;
      /** Only authorized initiating caller/key; capability itself is never stored. */
      readonly completion: { readonly orderId: OrderId } });

export interface CheckoutRepository {
  /** Read-only effective quote snapshot + serverNow; no writes/recovery/hold extension.
   * Service projects due expiry for display. Mutations reconcile + persist it.
   */
  read(id: SessionId): Promise<{ readonly session: CheckoutSession; readonly serverNow: Instant } | null>;
  /** Policy is validated server configuration, never an HTTP request field.
   * Persist session + inventory effects + order + capability digest + replay ledger
   * atomically. Reconciliation/fencing must commit even if a later guard rejects.
   * Claim checks live quote, CAS, hold ownership and unique checkout-order index.
   * Within retained replay metadata, same session/key/caller + same request
   * returns a stable result; successful completion receipts remain durable.
   * Collected unsuccessful requests must fail without restarting payment. Changed request
   * or caller conflicts. Different keys cannot claim a processing/completed session.
   * Store only token digests. Replay grants return solely to the original binding.
   * Recovery links ONE successor per original, regardless of request keys/devices.
   * At processing timeout fence attempt/settlement BEFORE releasing its inventory.
   */
  execute(command: CheckoutCommand, policy: CheckoutPolicy): Promise<Result<CheckoutMutation>>;
}

export interface OrderRepository {
  /** Validate a hashed, unguessable capability bound to this order before reading. */
  getConfirmation(orderId: OrderId, capability: CompletionCapability): Promise<Result<Order>>;
}
