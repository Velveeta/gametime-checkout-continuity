import type { Result } from "../domain/errors";
import type { CheckoutSession, CompletionCapability, ListingId, Order, OrderId,
  SeatAllocation, SessionId } from "../domain/models";
import type { Instant, Version } from "../domain/values";

export interface CheckoutSnapshot {
  readonly session: CheckoutSession;
  readonly serverNow: Instant;
}

export type CheckoutEntry =
  | { readonly kind: "RENDER"; readonly snapshot: CheckoutSnapshot }
  | { readonly kind: "REDIRECT_CHECKOUT"; readonly sessionId: SessionId }
  | { readonly kind: "REDIRECT_EVENT"; readonly eventId: string }
  | { readonly kind: "REDIRECT_HOME" };

export type CompletionResult =
  | { readonly kind: "COMPLETED"; readonly orderId: OrderId; readonly capability: CompletionCapability }
  | { readonly kind: "IN_PROGRESS"; readonly snapshot: CheckoutSnapshot }
  | { readonly kind: "UPDATED"; readonly snapshot: CheckoutSnapshot };

/** Contracts only in Wave 00; no exported pretend-success implementation. */
export interface CheckoutService {
  create(input: { readonly listingId: ListingId; readonly allocation: SeatAllocation;
    readonly expectedListingVersion: Version }): Promise<Result<CheckoutSnapshot>>;
  read(sessionId: SessionId): Promise<Result<CheckoutSnapshot>>;
  /** Fresh expired navigation may recover; mounted expiry must never recover. */
  enter(input: { readonly sessionId: SessionId; readonly intent: "FRESH_NAVIGATION" | "MOUNTED_REFRESH";
    readonly recoveryIdempotencyKey: string }): Promise<Result<CheckoutEntry>>;
  acceptQuote(input: { readonly sessionId: SessionId; readonly expectedVersion: Version;
    readonly quoteVersion: Version }): Promise<Result<CheckoutSnapshot>>;
  complete(input: { readonly sessionId: SessionId; readonly expectedVersion: Version;
    readonly quoteVersion: Version }): Promise<Result<CompletionResult>>;
  confirm(input: { readonly orderId: OrderId; readonly capability: CompletionCapability }): Promise<Result<Order>>;
}
