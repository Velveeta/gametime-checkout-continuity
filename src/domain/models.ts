import type { Cents, Currency, Instant, Version } from "./values";

export type EventId = string;
export type ListingId = string;
export type SessionId = string;
export type OrderId = string;
export type AttemptId = string;
export type ReservationId = string;

export interface Event {
  readonly id: EventId;
  readonly title: string;
  readonly venue: string;
  readonly startsAt: Instant;
  readonly timeZone: string; // IANA zone for display; startsAt remains UTC.
}

export type SeatAllocation =
  | { readonly kind: "ASSIGNED"; readonly section: string; readonly row: string;
      /** Ascending, unique, contiguous seat numbers, validated at service boundary. */
      readonly seats: readonly [number, ...number[]] }
  | { readonly kind: "GENERAL_ADMISSION"; readonly section: string; readonly quantity: number };

export interface Listing {
  readonly id: ListingId;
  readonly eventId: EventId;
  readonly allocation: SeatAllocation;
  readonly unitPrice: Cents;
  readonly currency: Currency;
  readonly version: Version;
}

export interface PriceQuote {
  readonly ticketSubtotal: Cents;
  readonly fees: Cents;
  readonly total: Cents; // subtotal + fees, checked with safe integer arithmetic.
  readonly currency: Currency;
  readonly version: Version;
}

interface SessionBase {
  readonly id: SessionId;
  readonly eventId: EventId;
  readonly listingId: ListingId;
  readonly allocation: SeatAllocation;
  readonly reservationId: ReservationId;
  readonly quote: PriceQuote;
  readonly reservationExpiresAt: Instant;
  readonly recoveryRetainUntil: Instant;
  readonly version: Version;
  readonly acknowledgedQuoteVersion?: Version;
  readonly paymentAttemptCount: 0 | 1 | 2 | 3;
  readonly createdAt: Instant;
}

type IdleSession = SessionBase & {
  readonly status: "ACTIVE" | "PRICE_REVIEW";
  readonly paymentAttemptCount: 0 | 1 | 2;
  readonly processingDeadlineAt?: never;
  readonly orderId?: never;
};

type ProcessingSession = SessionBase & {
  readonly status: "PROCESSING";
  readonly attemptId: AttemptId;
  readonly paymentAttemptCount: 1 | 2 | 3;
  readonly processingDeadlineAt: Instant;
  readonly orderId?: never;
};

type RetryableSession = SessionBase & {
  readonly status: "PAYMENT_RETRYABLE";
  readonly paymentAttemptCount: 1 | 2;
  readonly failureCode: "TRANSIENT";
  readonly processingDeadlineAt?: never;
  readonly orderId?: never;
};

type FailedSession = SessionBase & {
  readonly status: "PAYMENT_FAILED";
  readonly paymentAttemptCount: 1 | 2 | 3;
  readonly failureCode: "DECLINED" | "ATTEMPTS_EXHAUSTED" | "PROCESSING_TIMEOUT";
  readonly processingDeadlineAt?: never;
  readonly orderId?: never;
};

type CompletedSession = SessionBase & {
  readonly status: "COMPLETED";
  readonly paymentAttemptCount: 1 | 2 | 3;
  readonly orderId: OrderId;
  readonly processingDeadlineAt?: never;
};

type ExpiredSession = SessionBase & {
  readonly status: "EXPIRED";
  readonly processingDeadlineAt?: never;
  readonly orderId?: never;
};

export type CheckoutSession = IdleSession | ProcessingSession | RetryableSession | FailedSession | CompletedSession | ExpiredSession;

export interface Order {
  readonly id: OrderId;
  readonly checkoutSessionId: SessionId;
  readonly eventId: EventId;
  readonly listingId: ListingId;
  readonly allocation: SeatAllocation;
  readonly quote: PriceQuote;
  readonly createdAt: Instant;
}

/** Opaque bearer token, never included in session snapshots, URLs, or analytics. */
export type CompletionCapability = string & { readonly __brand: "CompletionCapability" };
