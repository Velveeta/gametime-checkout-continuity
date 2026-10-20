import type { Result } from "../domain/errors";
import type { CheckoutSession, CompletionCapability, ListingId, Order, OrderId, SeatAllocation, SessionId } from "../domain/models";
import type { Instant, Version } from "../domain/values";
import type { CompletionIdentity } from "./ports";

export interface CheckoutSnapshot { readonly session: CheckoutSession; readonly serverNow: Instant }
export type CheckoutEntry =
  | { readonly kind: "RENDER"; readonly snapshot: CheckoutSnapshot }
  | { readonly kind: "REDIRECT_CHECKOUT"; readonly sessionId: SessionId }
  | { readonly kind: "REDIRECT_EVENT"; readonly eventId: string }
  | { readonly kind: "REDIRECT_HOME" };
export type CompletionResult =
  | { readonly kind: "COMPLETED"; readonly orderId: OrderId; readonly capability: CompletionCapability }
  | { readonly kind: "IN_PROGRESS"; readonly snapshot: CheckoutSnapshot }
  | { readonly kind: "UPDATED"; readonly snapshot: CheckoutSnapshot };
export type CompleteCheckoutInput = CompletionIdentity & {
  readonly sessionId: SessionId; readonly expectedVersion: Version; readonly quoteVersion: Version;
};
export interface CheckoutService {
  create(input: { readonly listingId: ListingId; readonly allocation: SeatAllocation; readonly expectedListingVersion: Version }): Promise<Result<CheckoutSnapshot>>;
  /** Read-only: does not reserve, recover, refresh quote, or mutate inventory. */
  getSession(sessionId: SessionId): Promise<Result<CheckoutSnapshot>>;
  read(sessionId: SessionId): Promise<Result<CheckoutSnapshot>>;
  /** Explicit atomic expiry/processing reconciliation; never creates a session. */
  reconcile(sessionId: SessionId): Promise<Result<CheckoutSnapshot>>;
  enter(input: { readonly sessionId: SessionId; readonly intent: "FRESH_NAVIGATION" | "MOUNTED_REFRESH";
    readonly recoveryIdempotencyKey: string }): Promise<Result<CheckoutEntry>>;
  recoverExpiredSession(input: { readonly sessionId: SessionId; readonly intent: "FRESH_NAVIGATION";
    readonly idempotencyKey: string }): Promise<Result<CheckoutEntry>>;
  refreshQuote(input: { readonly sessionId: SessionId; readonly expectedVersion: Version }): Promise<Result<CheckoutSnapshot>>;
  acceptQuote(input: { readonly sessionId: SessionId; readonly expectedVersion: Version; readonly quoteVersion: Version }): Promise<Result<CheckoutSnapshot>>;
  complete(input: CompleteCheckoutInput): Promise<Result<CompletionResult>>;
  confirm(input: { readonly orderId: OrderId; readonly capability: CompletionCapability }): Promise<Result<Order>>;
}
