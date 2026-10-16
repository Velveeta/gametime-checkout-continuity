import type { Result } from "../domain/errors";
import type { AttemptId, CheckoutSession, CompletionCapability, Event, EventId, Listing,
  ListingId, Order, OrderId, PriceQuote, SeatAllocation, SessionId } from "../domain/models";
import type { Instant, Version } from "../domain/values";

export interface Clock { now(): Instant }

export interface CatalogRepository {
  getEvent(id: EventId): Promise<Event | null>;
  getListing(id: ListingId): Promise<Listing | null>;
}

export interface Inventory {
  /** Authoritative availability at serverNow; never counts expired holds. */
  getAvailability(listingId: ListingId): Promise<{
    readonly available: readonly SeatAllocation[];
    readonly version: Version;
    readonly serverNow: Instant;
  }>;
}

export type PaymentOutcome =
  | { readonly kind: "SUCCEEDED"; readonly reference: string }
  | { readonly kind: "TRANSIENT_FAILURE" }
  | { readonly kind: "DECLINED" }
  | { readonly kind: "UNKNOWN" }; // Never automatically retry an ambiguous outcome.

export interface Payment {
  /** Simulator only. Stable attemptId is the idempotency key, not a new charge. */
  attempt(input: { readonly sessionId: SessionId; readonly attemptId: AttemptId;
    readonly quote: PriceQuote }): Promise<PaymentOutcome>;
}

export type AnalyticsEvent = {
  readonly name: "checkout_created" | "quote_changed" | "quote_accepted" | "payment_claimed"
    | "payment_retryable" | "payment_failed" | "checkout_completed" | "checkout_expired" | "checkout_recovered";
  readonly sessionId: SessionId;
  readonly at: Instant;
  readonly version: Version;
};
export interface Analytics { record(event: AnalyticsEvent): Promise<void> }

/** Each command is ONE atomic consistency boundary across affected keys.
 * Adapter obtains authoritative time inside that boundary; caller timestamps
 * cannot authorize a claim. No general save/update method is intentionally exposed.
 */
export type CheckoutCommand =
  | { readonly kind: "RESERVE"; readonly sessionId: SessionId; readonly listingId: ListingId;
      readonly allocation: SeatAllocation; readonly expectedListingVersion: Version }
  | { readonly kind: "ACCEPT_QUOTE"; readonly sessionId: SessionId;
      readonly expectedVersion: Version; readonly quoteVersion: Version }
  | { readonly kind: "REFRESH_QUOTE"; readonly sessionId: SessionId;
      readonly expectedVersion: Version; readonly expectedListingVersion: Version }
  | { readonly kind: "CLAIM_COMPLETION"; readonly sessionId: SessionId;
      readonly expectedVersion: Version; readonly quoteVersion: Version }
  | { readonly kind: "SETTLE_PAYMENT"; readonly sessionId: SessionId; readonly attemptId: AttemptId;
      readonly outcome: Exclude<PaymentOutcome, { kind: "UNKNOWN" }> }
  | { readonly kind: "EXPIRE_IF_DUE"; readonly sessionId: SessionId }
  | { readonly kind: "RECOVER"; readonly expiredSessionId: SessionId;
      readonly idempotencyKey: string };

export type CheckoutMutation =
  | { readonly kind: "UPDATED"; readonly session: CheckoutSession; readonly serverNow: Instant }
  | { readonly kind: "CLAIMED";
      readonly session: Extract<CheckoutSession, { status: "PROCESSING" }>;
      readonly serverNow: Instant }
  | { readonly kind: "COMPLETED";
      readonly session: Extract<CheckoutSession, { status: "COMPLETED" }>;
      readonly serverNow: Instant;
      readonly completion: { readonly orderId: OrderId; readonly capability: CompletionCapability } };

export interface CheckoutRepository {
  /** Reads reconcile effective expiry without extending any deadline. */
  read(id: SessionId): Promise<{ readonly session: CheckoutSession; readonly serverNow: Instant } | null>;
  /** RESERVE/RECOVER reserve and create together; SETTLE_PAYMENT succeeds with
   * order creation + inventory sale together. CAS, reservation ownership, quote
   * version, deadlines and attempt identity are checked inside atomic execution.
   * Only a newly won claim returns CLAIMED (and may invoke payment); reads or
   * competing claims never do. Only first successful settlement returns COMPLETED
   * with a capability; duplicate settlement never reissues it.
   * Policies (hold/recovery/processing durations) are server-owned configuration.
   */
  execute(command: CheckoutCommand): Promise<Result<CheckoutMutation>>;
}

export interface OrderRepository {
  /** Validate a hashed, unguessable capability bound to this order before reading. */
  getConfirmation(orderId: OrderId, capability: CompletionCapability): Promise<Result<Order>>;
}
