'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  CreditCard,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { CheckoutSnapshot } from '@/application/checkout-service';
import { Button } from '@/components/ui/button';
import { PriceBreakdown } from '@/components/marketplace/ticket-summary';
import { Assurance } from '@/components/marketplace/chrome';
import { Countdown } from './countdown';
import { ShareCheckout } from './share-checkout';
import { useCheckout } from './use-checkout';
import { money } from '@/lib/ui/presentation';

export function CheckoutExperience({
  initial,
  summary,
}: {
  initial: CheckoutSnapshot;
  summary: ReactNode;
}) {
  const id = initial.session.id;
  const {
    query,
    payment,
    acknowledge,
    session,
    pay,
    confirmDeadline,
    unknownFailure,
  } = useCheckout(initial);
  const [priceNotice, setPriceNotice] = useState({
    version: initial.session.quote.version,
    total: initial.session.quote.total,
    saved: 0,
  });

  if (session.quote.version !== priceNotice.version) {
    setPriceNotice({
      version: session.quote.version,
      total: session.quote.total,
      saved: Math.max(0, priceNotice.total - session.quote.total),
    });
  }

  const quantity =
    session.allocation.kind === 'ASSIGNED'
      ? session.allocation.seats.length
      : session.allocation.quantity;
  const processing = session.status === 'PROCESSING' || payment.isPending;
  const failed = session.status === 'PAYMENT_FAILED';
  const completed = session.status === 'COMPLETED';
  const needsReview = session.status === 'PRICE_REVIEW';
  const canPay =
    query.isFetchedAfterMount &&
    !query.isError &&
    !processing &&
    !failed &&
    !needsReview &&
    session.status !== 'EXPIRED';

  return (
    <div className="page-width checkout-page">
      <Link href={`/events/${session.eventId}`} className="back-link">
        <ArrowLeft size={16} aria-hidden="true" />
        Back to event
      </Link>
      <div className="checkout-heading">
        <div>
          <span className="eyebrow">YOU&apos;RE ALMOST THERE</span>
          <h1>Make it a great night.</h1>
        </div>
        <span>
          <LockKeyhole size={16} aria-hidden="true" />
          Secure checkout
        </span>
      </div>
      <div className="checkout-grid">
        <section className="checkout-actions" aria-label="Checkout actions">
          {processing ? (
            <div className="processing-banner" role="status">
              <LoaderCircle className="spin" size={23} aria-hidden="true" />
              <div>
                <strong>
                  {session.status === 'PROCESSING'
                    ? "We're confirming your purchase."
                    : 'Submitting your purchase…'}
                </strong>
                <p>
                  {session.status === 'PROCESSING'
                    ? 'Your tickets are protected while payment is processing.'
                    : 'Checking your tickets and payment. Please keep this page open.'}
                </p>
              </div>
            </div>
          ) : (
            !failed &&
            !completed && (
              <Countdown snapshot={query.data} onZero={confirmDeadline} />
            )
          )}
          <div className="checkout-step">
            <span className="step-icon">
              <Check size={16} aria-hidden="true" />
            </span>
            <div>
              <h2>Great seats. Good choice.</h2>
              <p>Your selection is reserved exclusively for this checkout.</p>
            </div>
            <span className="step-complete">Selected</span>
          </div>
          <section className="payment-panel" aria-labelledby="payment-heading">
            <div className="payment-heading">
              <span className="step-number">2</span>
              <div>
                <h2 id="payment-heading">Payment</h2>
                <p>One last step to your next great moment.</p>
              </div>
            </div>
            <div className="payment-method">
              <CreditCard size={25} aria-hidden="true" />
              <div>
                <strong>Simulated payment</strong>
                <span>No card details needed. No money will be charged.</span>
              </div>
              <Check size={19} aria-hidden="true" />
            </div>
            <p className="simulation-detail">
              This is a fictional booking experience. Use the button below to
              try the checkout.
            </p>
            {priceNotice.saved > 0 && (
              <div className="notice positive" role="status">
                <Sparkles size={21} aria-hidden="true" />
                <div>
                  <strong>Your tickets just got cheaper!</strong>
                  <p>
                    You&apos;re saving {money(priceNotice.saved)}. We&apos;ve
                    already applied your new total.
                  </p>
                </div>
              </div>
            )}
            {needsReview && (
              <div className="notice warning" role="alert">
                <strong>Your ticket price has changed.</strong>
                <p>
                  The new total, including fees, is{' '}
                  <b>{money(session.quote.total)}</b>. Review and accept it
                  before continuing.
                </p>
                <Button
                  disabled={acknowledge.isPending || query.isError}
                  onClick={() => acknowledge.mutate()}
                >
                  {acknowledge.isPending
                    ? 'Updating…'
                    : `Accept new total · ${money(session.quote.total)}`}
                </Button>
              </div>
            )}
            {session.status === 'PAYMENT_RETRYABLE' && (
              <div className="notice warning" role="status">
                <strong>
                  That attempt timed out. You weren&apos;t charged.
                </strong>
                <p>
                  Your tickets are still held until the original countdown ends.
                  You can try again ({session.paymentAttemptCount} of 3 attempts
                  used).
                </p>
              </div>
            )}
            {failed && (
              <div className="notice warning" role="alert">
                <strong>
                  {session.failureCode === 'DECLINED'
                    ? 'Payment declined'
                    : session.failureCode === 'ATTEMPTS_EXHAUSTED'
                      ? 'Payment attempts exhausted'
                      : 'The payment couldn’t be confirmed'}
                </strong>
                <p>
                  {session.failureCode === 'DECLINED'
                    ? 'This simulated payment was declined.'
                    : session.failureCode === 'ATTEMPTS_EXHAUSTED'
                      ? 'All three payment attempts have been used.'
                      : 'The processing window ended safely without completing a purchase.'}{' '}
                  Your tickets have been released.
                </p>
                <Link href={`/events/${session.eventId}`} className="text-link">
                  Choose tickets again{' '}
                  <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </div>
            )}
            {query.isError && (
              <div className="notice warning" role="alert">
                <strong>Let&apos;s reconnect.</strong>
                <p>
                  We couldn&apos;t check the latest reservation status.
                  We&apos;ll confirm it before you continue.
                </p>
                <Button variant="outline" onClick={() => query.refetch()}>
                  Refresh status
                </Button>
              </div>
            )}
            {payment.error && !failed && (
              <p className="inline-error" role="alert">
                {unknownFailure
                  ? 'We couldn’t confirm the response. Check payment status using the same request; we won’t create a second purchase.'
                  : 'Your checkout has changed. We’ve refreshed its status; review the latest details before continuing.'}
              </p>
            )}
            {acknowledge.error && (
              <p className="inline-error" role="alert">
                The price may have changed again. Review the latest total and
                try accepting it again.
              </p>
            )}
            {!failed && (
              <>
                <Button className="pay-button" disabled={!canPay} onClick={pay}>
                  {processing ? (
                    <>
                      <LoaderCircle
                        className="spin"
                        size={18}
                        aria-hidden="true"
                      />
                      Processing payment…
                    </>
                  ) : completed || unknownFailure ? (
                    'Check payment status'
                  ) : (
                    <>
                      {session.status === 'PAYMENT_RETRYABLE'
                        ? 'Try payment again'
                        : 'Complete simulated purchase'}
                      <span>
                        {money(session.quote.total)}{' '}
                        <ArrowRight size={18} aria-hidden="true" />
                      </span>
                    </>
                  )}
                </Button>
                <p className="payment-disclaimer">
                  By continuing, you&apos;re making a simulated purchase.
                  <br />
                  All prices include fees. No real payment is collected.
                </p>
              </>
            )}
            <Assurance />
          </section>
          {!failed && !completed && <ShareCheckout id={id} />}
        </section>
        <aside className="order-summary" aria-label="Order summary">
          {summary}
          <PriceBreakdown quote={session.quote} quantity={quantity} />
          <div className="summary-guarantee">
            <ShieldCheck size={21} aria-hidden="true" />
            <p>
              <strong>One checkout, every device.</strong>
              <br />
              Your tickets and price stay in sync.
            </p>
            <ChevronRight size={16} aria-hidden="true" />
          </div>
        </aside>
      </div>
    </div>
  );
}
