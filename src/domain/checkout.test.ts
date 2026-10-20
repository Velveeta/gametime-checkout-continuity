import { describe, expect, it } from "vitest";
import { acceptCheckoutQuote, after, changeCheckoutDeadline, claimCheckout, createCheckout, DEFAULT_CHECKOUT_POLICY as policy,
  reconcileCheckout, recoverCheckout, refreshCheckoutQuote, settleCheckout, validateCheckoutPolicy, validateQuote } from "./checkout";
import { DomainError } from "./errors";
import type { CheckoutSession, PriceQuote } from "./models";
import { cents, version } from "./values";
import { allocation, listing, NOW } from "../../tests/support/checkout-fixtures";

const fresh = () => createCheckout({ id: "checkout", reservationId: "hold", listing, allocation }, NOW, policy).session;
const facts = (session: CheckoutSession, now = NOW) => ({ now, currentQuote: session.quote, ownsReservation: true, orderExists: false });
const claim = (session: CheckoutSession, now = NOW) => claimCheckout(session, { expectedVersion: session.version, quoteVersion: session.quote.version, attemptId: `attempt-${session.paymentAttemptCount + 1}` }, facts(session, now), policy).session;
const quote = (session: CheckoutSession, subtotal: number, fees: number): PriceQuote => ({ ...session.quote, ticketSubtotal: cents(subtotal), fees: cents(fees), total: cents(subtotal + fees), version: version(session.quote.version + 1) });
function code(action: () => unknown, expected: string) {
  try { action(); throw new Error("Expected rejection"); } catch (error) { expect(error).toBeInstanceOf(DomainError); expect((error as DomainError).code).toBe(expected); }
}

describe("checkout state/deadline rules", () => {
  it("starts a 10-minute hold at reservation, retaining metadata 30 minutes after expiry", () => {
    const session = fresh();
    expect(session.reservationExpiresAt).toBe(after(NOW, 600_000));
    expect(session.recoveryRetainUntil).toBe(after(NOW, 2_400_000));
    expect(session.quote.total).toBe(22800);
  });
  it.each([-1, 0, 1.5, Infinity])("rejects invalid policy value %j", (holdMs) => {
    expect(() => validateCheckoutPolicy({ ...policy, holdMs })).toThrow();
  });
  it("retains metadata beyond any permitted processing claim", () => {
    expect(() => validateCheckoutPolicy({ ...policy, processingMs: policy.retentionAfterExpiryMs + 1 })).toThrow();
  });
  it("expires exactly at the business deadline, not one millisecond before", () => {
    const session = fresh();
    expect(reconcileCheckout(session, after(NOW, 599_999)).session.status).toBe("ACTIVE");
    expect(reconcileCheckout(session, session.reservationExpiresAt).session.status).toBe("EXPIRED");
    code(() => claim(session, session.reservationExpiresAt), "RESERVATION_EXPIRED");
    expect(claim(session, after(NOW, 599_999)).status).toBe("PROCESSING");
  });
  it("protects processing beyond business expiry and fences exactly at processing timeout", () => {
    const session = fresh();
    const processing = claim(session, after(NOW, 599_999));
    expect(processing.reservationExpiresAt).toBe(session.reservationExpiresAt);
    expect(reconcileCheckout(processing, session.reservationExpiresAt).session.status).toBe("PROCESSING");
    if (processing.status !== "PROCESSING") throw new Error();
    const timeout = reconcileCheckout(processing, processing.processingDeadlineAt);
    expect(timeout.session).toMatchObject({ status: "PAYMENT_FAILED", failureCode: "PROCESSING_TIMEOUT" });
    expect(timeout.effects.map((effect) => effect.kind)).toEqual(["FENCE_ATTEMPT", "RELEASE"]);
    const late = settleCheckout(processing, { attemptId: processing.attemptId, outcome: { kind: "SUCCEEDED", reference: "late" }, orderId: "order" }, processing.processingDeadlineAt);
    expect(late.order).toBeUndefined();
  });
  it.each(["COMPLETED", "PAYMENT_FAILED", "EXPIRED"] as const)("never reopens terminal %s", (status) => {
    let terminal: CheckoutSession;
    if (status === "EXPIRED") terminal = reconcileCheckout(fresh(), fresh().reservationExpiresAt).session;
    else {
      const processing = claim(fresh());
      if (processing.status !== "PROCESSING") throw new Error();
      terminal = settleCheckout(processing, { attemptId: processing.attemptId, outcome: status === "COMPLETED" ? { kind: "SUCCEEDED", reference: "ok" } : { kind: "DECLINED" }, orderId: "order" }, NOW).session;
    }
    expect(reconcileCheckout(terminal, after(NOW, 900_000)).session).toEqual(terminal);
    code(() => claim(terminal), status === "EXPIRED" ? "RESERVATION_EXPIRED" : "TERMINAL_SESSION");
  });
  it("checks ownership, unique order, live quote and CAS independently", () => {
    const session = fresh(); const input = { expectedVersion: session.version, quoteVersion: session.quote.version, attemptId: "attempt" };
    code(() => claimCheckout(session, input, { ...facts(session), ownsReservation: false }, policy), "RESERVATION_CONFLICT");
    code(() => claimCheckout(session, input, { ...facts(session), orderExists: true }, policy), "TERMINAL_SESSION");
    code(() => claimCheckout(session, input, { ...facts(session), currentQuote: quote(session, 20000, 4000) }, policy), "VERSION_CONFLICT");
    code(() => claimCheckout(session, { ...input, expectedVersion: version(99) }, facts(session), policy), "VERSION_CONFLICT");
  });
});

describe("total-price authorization", () => {
  it("detects an increase caused by fees even if ticket subtotal decreases", () => {
    const session = fresh();
    const changed = refreshCheckoutQuote(session, quote(session, 18000, 6000), session.version, NOW);
    expect(changed.session.status).toBe("PRICE_REVIEW");
    expect(changed.session.acceptedTotal).toBe(22800);
    expect(changed.session.acknowledgedQuoteVersion).toBeUndefined();
    code(() => claim(changed.session), "QUOTE_ACCEPTANCE_REQUIRED");
    code(() => acceptCheckoutQuote(changed.session, { expectedVersion: changed.session.version, quoteVersion: session.quote.version }, facts(changed.session)), "QUOTE_ACCEPTANCE_REQUIRED");
    const accepted = acceptCheckoutQuote(changed.session, { expectedVersion: changed.session.version, quoteVersion: changed.session.quote.version }, facts(changed.session));
    expect(claim(accepted.session).status).toBe("PROCESSING");
    expect(accepted.session.reservationExpiresAt).toBe(session.reservationExpiresAt);
  });
  it("auto-applies lower total and emits good news, independent of fee direction", () => {
    const session = fresh();
    const changed = refreshCheckoutQuote(session, quote(session, 17000, 5000), session.version, NOW);
    expect(changed.events).toContain("price_decreased");
    expect(changed.session).toMatchObject({ status: "ACTIVE", acceptedTotal: 22000, acknowledgedQuoteVersion: 2 });
    expect(claim(changed.session).status).toBe("PROCESSING");
  });
  it("does not authorize a decreased pending increase that still exceeds accepted total", () => {
    const session = fresh();
    const higher = refreshCheckoutQuote(session, quote(session, 20000, 6000), session.version, NOW).session;
    const lower = refreshCheckoutQuote(higher, quote(higher, 20000, 4000), higher.version, NOW);
    expect(lower.events).toContain("price_decreased");
    expect(lower.session).toMatchObject({ status: "PRICE_REVIEW", acceptedTotal: 22800 });
    code(() => claim(lower.session), "QUOTE_ACCEPTANCE_REQUIRED");
  });
  it("advances equal-total quote versions without accepting a pending increase", () => {
    const session = fresh();
    const equal = refreshCheckoutQuote(session, quote(session, 18000, 4800), session.version, NOW).session;
    expect(equal).toMatchObject({ status: "ACTIVE", acknowledgedQuoteVersion: 2 });
    const review = refreshCheckoutQuote(equal, quote(equal, 20000, 4800), equal.version, NOW).session;
    expect(refreshCheckoutQuote(review, quote(review, 21000, 3800), review.version, NOW).session.status).toBe("PRICE_REVIEW");
    code(() => acceptCheckoutQuote(equal, { expectedVersion: equal.version, quoteVersion: equal.quote.version }, { ...facts(equal), currentQuote: quote(equal, 22000, 4000) }), "VERSION_CONFLICT");
  });
  it("rejects malformed quote arithmetic, nonmonotonic versions and processing repricing", () => {
    const session = fresh();
    code(() => validateQuote({ ...session.quote, total: cents(1) }), "INVALID_QUOTE");
    code(() => refreshCheckoutQuote(session, { ...session.quote, fees: cents(4000), total: cents(23000) }, session.version, NOW), "VERSION_CONFLICT");
    const processing = claim(session);
    code(() => refreshCheckoutQuote(processing, quote(processing, 1000, 100), processing.version, NOW), "PROCESSING_IN_PROGRESS");
  });
});

describe("payment resolution", () => {
  it("allows only three total confirmed transient attempts", () => {
    let session = fresh();
    for (let attempt = 1; attempt <= 3; attempt++) {
      session = claim(session);
      if (session.status !== "PROCESSING") throw new Error();
      const outcome = settleCheckout(session, { attemptId: session.attemptId, outcome: { kind: "TRANSIENT_FAILURE" }, orderId: "unused" }, NOW);
      session = outcome.session;
      expect(session.status).toBe(attempt === 3 ? "PAYMENT_FAILED" : "PAYMENT_RETRYABLE");
      expect(session.paymentAttemptCount).toBe(attempt);
      expect(session).not.toHaveProperty("processingDeadlineAt");
    }
    expect(session).toMatchObject({ failureCode: "ATTEMPTS_EXHAUSTED" });
  });
  it("never retries unknown results; decline is terminal", () => {
    const processing = claim(fresh());
    if (processing.status !== "PROCESSING") throw new Error();
    const input = { attemptId: processing.attemptId, orderId: "unused" };
    expect(settleCheckout(processing, { ...input, outcome: { kind: "UNKNOWN" } }, NOW).session).toEqual(processing);
    expect(settleCheckout(processing, { ...input, outcome: { kind: "DECLINED" } }, NOW).session).toMatchObject({ status: "PAYMENT_FAILED", failureCode: "DECLINED" });
    code(() => settleCheckout(processing, { ...input, attemptId: "stale", outcome: { kind: "SUCCEEDED", reference: "ok" } }, NOW), "VERSION_CONFLICT");
  });
  it("restores only the original business hold after transient non-capture", () => {
    const session = fresh(); const processing = claim(session, after(NOW, 599_999));
    if (processing.status !== "PROCESSING") throw new Error();
    const settled = settleCheckout(processing, { attemptId: processing.attemptId, outcome: { kind: "TRANSIENT_FAILURE" }, orderId: "unused" }, session.reservationExpiresAt);
    expect(settled.session.status).toBe("EXPIRED");
    const earlier = claim(session);
    if (earlier.status !== "PROCESSING") throw new Error();
    const retry = settleCheckout(earlier, { attemptId: earlier.attemptId, outcome: { kind: "TRANSIENT_FAILURE" }, orderId: "unused" }, NOW).session;
    const review = refreshCheckoutQuote(retry, quote(retry, 25000, 5000), retry.version, NOW).session;
    const accepted = acceptCheckoutQuote(review, { expectedVersion: review.version, quoteVersion: review.quote.version }, facts(review)).session;
    expect(accepted).toMatchObject({ status: "PAYMENT_RETRYABLE", paymentAttemptCount: 1, reservationExpiresAt: session.reservationExpiresAt });
  });
  it("requires authorization for explicit deadline change and never revives expired state", () => {
    const session = fresh(); const input = { expectedVersion: session.version, expiresAt: after(NOW, 900_000), authorized: true };
    code(() => changeCheckoutDeadline(session, { ...input, authorized: false }, NOW, policy), "UNAUTHORIZED");
    expect(changeCheckoutDeadline(session, input, NOW, policy).session.reservationExpiresAt).toBe(input.expiresAt);
    const expired = reconcileCheckout(session, session.reservationExpiresAt).session;
    code(() => changeCheckoutDeadline(expired, { ...input, expectedVersion: expired.version }, session.reservationExpiresAt, policy), "RESERVATION_EXPIRED");
  });
  it("recovers with fresh IDs, current quote, zero attempts and fresh retention", () => {
    const expired = reconcileCheckout(fresh(), fresh().reservationExpiresAt).session;
    const nextListing = { ...listing, unitPrice: cents(10000), version: version(2) };
    const input = { id: "new-session", reservationId: "new-hold", listing: nextListing, allocation };
    const recovered = recoverCheckout(expired, input, expired.reservationExpiresAt, policy).session;
    expect(recovered).toMatchObject({ status: "ACTIVE", paymentAttemptCount: 0, acknowledgedQuoteVersion: 2, acceptedTotal: 23800 });
    expect(recovered.createdAt).toBe(expired.reservationExpiresAt);
    code(() => recoverCheckout(expired, { ...input, id: expired.id }, expired.reservationExpiresAt, policy), "INVALID_SELECTION");
    code(() => recoverCheckout(expired, input, expired.recoveryRetainUntil, policy), "NOT_FOUND");
  });
});
