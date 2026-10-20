import { DomainError } from './errors';
import {
  allocationQuantity,
  quoteSelection,
  validateSelection,
} from './inventory';
import type {
  CheckoutSession,
  Listing,
  Order,
  PriceQuote,
  SeatAllocation,
  SessionBase,
} from './models';
import { cents, instant, version, type Instant, type Version } from './values';

export interface CheckoutPolicy {
  readonly holdMs: number;
  readonly retentionAfterExpiryMs: number;
  readonly processingMs: number;
}
export const DEFAULT_CHECKOUT_POLICY: CheckoutPolicy = Object.freeze({
  holdMs: 10 * 60_000,
  retentionAfterExpiryMs: 30 * 60_000,
  processingMs: 60_000,
});
export function validateCheckoutPolicy(policy: CheckoutPolicy): CheckoutPolicy {
  if (
    ![policy.holdMs, policy.retentionAfterExpiryMs, policy.processingMs].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    policy.processingMs > policy.retentionAfterExpiryMs
  )
    throw new RangeError('Invalid checkout deadlines/retention policy');
  return Object.freeze({ ...policy });
}
export function after(now: Instant, milliseconds: number): Instant {
  return instant(new Date(Date.parse(now) + milliseconds).toISOString());
}
export type CheckoutEventName =
  | 'checkout_created'
  | 'quote_changed'
  | 'price_decreased'
  | 'quote_accepted'
  | 'payment_claimed'
  | 'payment_retryable'
  | 'payment_failed'
  | 'checkout_completed'
  | 'checkout_expired'
  | 'checkout_recovered';
export type InventoryEffect =
  | {
      readonly kind: 'RESERVE';
      readonly reservationId: string;
      readonly allocation: SeatAllocation;
      readonly until: Instant;
    }
  | {
      readonly kind: 'PROTECT';
      readonly reservationId: string;
      readonly attemptId: string;
      readonly until: Instant;
    }
  | {
      readonly kind: 'RESTORE_BUSINESS_HOLD';
      readonly reservationId: string;
      readonly until: Instant;
    }
  | { readonly kind: 'RELEASE'; readonly reservationId: string }
  | {
      readonly kind: 'SELL';
      readonly reservationId: string;
      readonly orderId: string;
    }
  | { readonly kind: 'FENCE_ATTEMPT'; readonly attemptId: string };
export interface CheckoutDecision {
  readonly session: CheckoutSession;
  readonly effects: readonly InventoryEffect[];
  readonly events: readonly CheckoutEventName[];
  readonly order?: Order;
}
export type ResolvedPayment =
  | { readonly kind: 'SUCCEEDED'; readonly reference: string }
  | { readonly kind: 'TRANSIENT_FAILURE' }
  | { readonly kind: 'DECLINED' }
  | { readonly kind: 'UNKNOWN' };

/** Explicit projection prevents processing-only fields leaking into other states. */
function base(session: CheckoutSession): SessionBase {
  return {
    id: session.id,
    eventId: session.eventId,
    listingId: session.listingId,
    allocation: session.allocation,
    reservationId: session.reservationId,
    quote: session.quote,
    acceptedTotal: session.acceptedTotal,
    ...(session.acknowledgedQuoteVersion === undefined
      ? {}
      : { acknowledgedQuoteVersion: session.acknowledgedQuoteVersion }),
    reservationExpiresAt: session.reservationExpiresAt,
    recoveryRetainUntil: session.recoveryRetainUntil,
    version: version(session.version + 1),
    paymentAttemptCount: session.paymentAttemptCount,
    createdAt: session.createdAt,
  };
}
function unchanged(session: CheckoutSession): CheckoutDecision {
  return { session, effects: [], events: [] };
}
function fail(
  code: ConstructorParameters<typeof DomainError>[0],
  message: string,
): never {
  throw new DomainError(code, message);
}
function cas(session: CheckoutSession, expected: Version) {
  if (session.version !== expected)
    fail('VERSION_CONFLICT', 'Checkout changed; refresh before retrying');
}
function editable(session: CheckoutSession, now: Instant) {
  if (session.status === 'PROCESSING')
    fail('PROCESSING_IN_PROGRESS', 'Payment is already processing');
  if (session.status === 'COMPLETED' || session.status === 'PAYMENT_FAILED')
    fail('TERMINAL_SESSION', 'Checkout is terminal');
  if (
    session.status === 'EXPIRED' ||
    Date.parse(now) >= Date.parse(session.reservationExpiresAt)
  )
    fail('RESERVATION_EXPIRED', 'Reservation expired');
  return session;
}
export function validateQuote(quote: PriceQuote): void {
  cents(quote.ticketSubtotal);
  cents(quote.fees);
  cents(quote.total);
  version(quote.version);
  if (
    quote.currency !== 'USD' ||
    quote.total !== cents(quote.ticketSubtotal + quote.fees)
  )
    fail('INVALID_QUOTE', 'Invalid quote total or currency');
}
export function sameQuote(a: PriceQuote, b: PriceQuote): boolean {
  return (
    a.version === b.version &&
    a.total === b.total &&
    a.fees === b.fees &&
    a.ticketSubtotal === b.ticketSubtotal &&
    a.currency === b.currency
  );
}
export function createCheckout(
  input: {
    id: string;
    reservationId: string;
    listing: Listing;
    allocation: SeatAllocation;
  },
  now: Instant,
  policy: CheckoutPolicy,
): CheckoutDecision {
  validateCheckoutPolicy(policy);
  validateSelection(input.listing, {
    kind: 'EXACT',
    allocation: input.allocation,
  });
  const quote = quoteSelection(
    input.listing,
    allocationQuantity(input.allocation),
  );
  const expires = after(now, policy.holdMs);
  const session: CheckoutSession = {
    id: input.id,
    reservationId: input.reservationId,
    listingId: input.listing.id,
    eventId: input.listing.eventId,
    allocation: input.allocation,
    quote,
    acceptedTotal: quote.total,
    acknowledgedQuoteVersion: quote.version,
    status: 'ACTIVE',
    paymentAttemptCount: 0,
    version: version(1),
    createdAt: now,
    reservationExpiresAt: expires,
    recoveryRetainUntil: after(expires, policy.retentionAfterExpiryMs),
  };
  return {
    session,
    effects: [
      {
        kind: 'RESERVE',
        reservationId: input.reservationId,
        allocation: input.allocation,
        until: expires,
      },
    ],
    events: ['checkout_created'],
  };
}

/** Pure projection. Persist these effects atomically with attempt fencing before
 * releasing protected inventory. This simulator never captures outside settlement.
 */
export function reconcileCheckout(
  session: CheckoutSession,
  now: Instant,
): CheckoutDecision {
  if (
    session.status === 'COMPLETED' ||
    session.status === 'EXPIRED' ||
    session.status === 'PAYMENT_FAILED'
  )
    return unchanged(session);
  if (session.status === 'PROCESSING') {
    if (Date.parse(now) < Date.parse(session.processingDeadlineAt))
      return unchanged(session);
    return {
      session: {
        ...base(session),
        status: 'PAYMENT_FAILED',
        paymentAttemptCount: session.paymentAttemptCount,
        failureCode: 'PROCESSING_TIMEOUT',
      },
      effects: [
        { kind: 'FENCE_ATTEMPT', attemptId: session.attemptId },
        { kind: 'RELEASE', reservationId: session.reservationId },
      ],
      events: ['payment_failed'],
    };
  }
  if (Date.parse(now) < Date.parse(session.reservationExpiresAt))
    return unchanged(session);
  return {
    session: { ...base(session), status: 'EXPIRED' },
    effects: [{ kind: 'RELEASE', reservationId: session.reservationId }],
    events: ['checkout_expired'],
  };
}

function idle(
  session: CheckoutSession,
  data: SessionBase,
  review: boolean,
): CheckoutSession {
  if (session.paymentAttemptCount === 3)
    fail('ATTEMPTS_EXHAUSTED', 'No payment attempts remain');
  if (review)
    return {
      ...data,
      status: 'PRICE_REVIEW',
      paymentAttemptCount: session.paymentAttemptCount,
    };
  return session.paymentAttemptCount === 0
    ? { ...data, status: 'ACTIVE', paymentAttemptCount: 0 }
    : {
        ...data,
        status: 'PAYMENT_RETRYABLE',
        paymentAttemptCount: session.paymentAttemptCount,
        failureCode: 'TRANSIENT',
      };
}
export function refreshCheckoutQuote(
  session: CheckoutSession,
  quote: PriceQuote,
  expected: Version,
  now: Instant,
): CheckoutDecision {
  editable(session, now);
  cas(session, expected);
  validateQuote(quote);
  if (sameQuote(session.quote, quote)) return unchanged(session);
  if (quote.version <= session.quote.version)
    fail('VERSION_CONFLICT', 'Quote version must advance for any change');
  const increased = quote.total > session.quote.total;
  const decreased = quote.total < session.quote.total;
  const review =
    increased ||
    quote.total > session.acceptedTotal ||
    (!decreased && session.status === 'PRICE_REVIEW');
  const { acknowledgedQuoteVersion: _obsolete, ...data } = base(session);
  void _obsolete;
  return {
    session: idle(
      session,
      {
        ...data,
        quote,
        acceptedTotal: review ? session.acceptedTotal : quote.total,
        ...(review ? {} : { acknowledgedQuoteVersion: quote.version }),
      },
      review,
    ),
    effects: [],
    events: decreased
      ? ['quote_changed', 'price_decreased']
      : ['quote_changed'],
  };
}
export function acceptCheckoutQuote(
  session: CheckoutSession,
  input: { expectedVersion: Version; quoteVersion: Version },
  facts: { now: Instant; currentQuote: PriceQuote },
): CheckoutDecision {
  editable(session, facts.now);
  cas(session, input.expectedVersion);
  if (!sameQuote(session.quote, facts.currentQuote))
    fail('VERSION_CONFLICT', 'Live quote changed; refresh before acceptance');
  if (input.quoteVersion !== session.quote.version)
    fail('QUOTE_ACCEPTANCE_REQUIRED', 'Accept the exact current quote');
  if (session.status !== 'PRICE_REVIEW') return unchanged(session);
  return {
    session: idle(
      session,
      {
        ...base(session),
        acceptedTotal: session.quote.total,
        acknowledgedQuoteVersion: input.quoteVersion,
      },
      false,
    ),
    effects: [],
    events: ['quote_accepted'],
  };
}
export function claimCheckout(
  session: CheckoutSession,
  input: { expectedVersion: Version; quoteVersion: Version; attemptId: string },
  facts: {
    now: Instant;
    currentQuote: PriceQuote;
    ownsReservation: boolean;
    orderExists: boolean;
  },
  policy: CheckoutPolicy,
): CheckoutDecision {
  validateCheckoutPolicy(policy);
  editable(session, facts.now);
  cas(session, input.expectedVersion);
  validateQuote(facts.currentQuote);
  if (!facts.ownsReservation)
    fail('RESERVATION_CONFLICT', 'No current owned reservation');
  if (facts.orderExists)
    fail('TERMINAL_SESSION', 'An order already exists for this checkout');
  if (!sameQuote(session.quote, facts.currentQuote))
    fail('VERSION_CONFLICT', 'Live quote changed; refresh and review');
  if (
    session.status === 'PRICE_REVIEW' ||
    session.acknowledgedQuoteVersion !== input.quoteVersion ||
    input.quoteVersion !== session.quote.version ||
    session.quote.total > session.acceptedTotal
  )
    fail('QUOTE_ACCEPTANCE_REQUIRED', 'Accept the exact current quote');
  if (session.paymentAttemptCount >= 3)
    fail('ATTEMPTS_EXHAUSTED', 'No payment attempts remain');
  const deadline = after(facts.now, policy.processingMs);
  return {
    session: {
      ...base(session),
      status: 'PROCESSING',
      attemptId: input.attemptId,
      paymentAttemptCount: (session.paymentAttemptCount + 1) as 1 | 2 | 3,
      processingDeadlineAt: deadline,
    },
    effects: [
      {
        kind: 'PROTECT',
        reservationId: session.reservationId,
        attemptId: input.attemptId,
        until: deadline,
      },
    ],
    events: ['payment_claimed'],
  };
}
export function settleCheckout(
  session: CheckoutSession,
  input: { attemptId: string; outcome: ResolvedPayment; orderId: string },
  now: Instant,
): CheckoutDecision {
  if (session.status !== 'PROCESSING')
    fail('TERMINAL_SESSION', 'No processing attempt to settle');
  if (session.attemptId !== input.attemptId)
    fail('VERSION_CONFLICT', 'Stale payment attempt');
  const reconciled = reconcileCheckout(session, now);
  if (reconciled.session.status !== 'PROCESSING') return reconciled;
  if (input.outcome.kind === 'UNKNOWN') return unchanged(session);
  if (input.outcome.kind === 'SUCCEEDED') {
    const order: Order = {
      id: input.orderId,
      checkoutSessionId: session.id,
      eventId: session.eventId,
      listingId: session.listingId,
      allocation: session.allocation,
      quote: session.quote,
      createdAt: now,
    };
    return {
      session: {
        ...base(session),
        status: 'COMPLETED',
        orderId: order.id,
        paymentAttemptCount: session.paymentAttemptCount,
      },
      order,
      effects: [
        {
          kind: 'SELL',
          reservationId: session.reservationId,
          orderId: order.id,
        },
      ],
      events: ['checkout_completed'],
    };
  }
  const fenced: InventoryEffect = {
    kind: 'FENCE_ATTEMPT',
    attemptId: session.attemptId,
  };
  if (input.outcome.kind === 'DECLINED' || session.paymentAttemptCount === 3) {
    return {
      session: {
        ...base(session),
        status: 'PAYMENT_FAILED',
        paymentAttemptCount: session.paymentAttemptCount,
        failureCode:
          input.outcome.kind === 'DECLINED' ? 'DECLINED' : 'ATTEMPTS_EXHAUSTED',
      },
      effects: [
        fenced,
        { kind: 'RELEASE', reservationId: session.reservationId },
      ],
      events: ['payment_failed'],
    };
  }
  if (Date.parse(now) >= Date.parse(session.reservationExpiresAt)) {
    return {
      session: { ...base(session), status: 'EXPIRED' },
      effects: [
        fenced,
        { kind: 'RELEASE', reservationId: session.reservationId },
      ],
      events: ['checkout_expired'],
    };
  }
  return {
    session: {
      ...base(session),
      status: 'PAYMENT_RETRYABLE',
      paymentAttemptCount: session.paymentAttemptCount,
      failureCode: 'TRANSIENT',
    },
    effects: [
      fenced,
      {
        kind: 'RESTORE_BUSINESS_HOLD',
        reservationId: session.reservationId,
        until: session.reservationExpiresAt,
      },
    ],
    events: ['payment_retryable'],
  };
}
function allocationKey(allocation: SeatAllocation) {
  return JSON.stringify(
    allocation.kind === 'ASSIGNED'
      ? [allocation.kind, allocation.section, allocation.row, allocation.seats]
      : [allocation.kind, allocation.section, allocation.quantity],
  );
}
export function recoverCheckout(
  expired: CheckoutSession,
  input: Parameters<typeof createCheckout>[0],
  now: Instant,
  policy: CheckoutPolicy,
): CheckoutDecision {
  if (Date.parse(now) >= Date.parse(expired.recoveryRetainUntil))
    fail('NOT_FOUND', 'Recovery metadata expired');
  if (reconcileCheckout(expired, now).session.status !== 'EXPIRED')
    fail('TERMINAL_SESSION', 'Only expired checkout may recover');
  if (expired.status === 'EXPIRED' && expired.successorSessionId)
    fail('VERSION_CONFLICT', 'Return the existing successor instead');
  if (
    input.id === expired.id ||
    input.reservationId === expired.reservationId ||
    input.listing.id !== expired.listingId ||
    input.listing.eventId !== expired.eventId ||
    allocationKey(input.allocation) !== allocationKey(expired.allocation)
  ) {
    fail(
      'INVALID_SELECTION',
      'Recovery must use a new identity and the original selection',
    );
  }
  const fresh = createCheckout(input, now, policy);
  return { ...fresh, events: ['checkout_recovered'] };
}
/** Pure rule + future atomic command only; no developer control is wired here. */
export function changeCheckoutDeadline(
  session: CheckoutSession,
  input: { expectedVersion: Version; expiresAt: Instant; authorized: boolean },
  now: Instant,
  policy: CheckoutPolicy,
): CheckoutDecision {
  if (!input.authorized)
    fail('UNAUTHORIZED', 'Explicit demo authorization required');
  validateCheckoutPolicy(policy);
  instant(input.expiresAt);
  editable(session, now);
  cas(session, input.expectedVersion);
  const updated: CheckoutSession = {
    ...session,
    version: version(session.version + 1),
    reservationExpiresAt: input.expiresAt,
    recoveryRetainUntil: after(input.expiresAt, policy.retentionAfterExpiryMs),
  };
  const projected = reconcileCheckout(updated, now);
  return projected.session.status === 'EXPIRED'
    ? projected
    : {
        session: updated,
        effects: [
          {
            kind: 'RESTORE_BUSINESS_HOLD',
            reservationId: session.reservationId,
            until: input.expiresAt,
          },
        ],
        events: [],
      };
}
