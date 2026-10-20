import { expectTypeOf, it } from 'vitest';
import type { CheckoutSession, CompletionCapability } from './models';
import type { Instant, Version } from './values';

it('narrows processing, completion and retry contracts by status', () => {
  type Processing = Extract<CheckoutSession, { status: 'PROCESSING' }>;
  type Completed = Extract<CheckoutSession, { status: 'COMPLETED' }>;
  type Retryable = Extract<CheckoutSession, { status: 'PAYMENT_RETRYABLE' }>;
  expectTypeOf<Processing['processingDeadlineAt']>().toEqualTypeOf<Instant>();
  expectTypeOf<Completed['orderId']>().toEqualTypeOf<string>();
  expectTypeOf<Retryable['paymentAttemptCount']>().toEqualTypeOf<1 | 2>();
  expectTypeOf<CheckoutSession['version']>().toEqualTypeOf<Version>();
  expectTypeOf<CompletionCapability>().not.toEqualTypeOf<string>();
});

// Compile-time negative assertions are exercised by npm run typecheck.
function assertContracts(session: CheckoutSession) {
  if (session.status === 'COMPLETED') {
    // @ts-expect-error completed sessions cannot carry a processing deadline
    const deadline: Instant = session.processingDeadlineAt;

    void deadline;
  }

  if (session.status === 'PAYMENT_RETRYABLE') {
    // @ts-expect-error a third confirmed transient failure cannot be retryable
    const exhausted: 3 = session.paymentAttemptCount;

    void exhausted;
  }

  // @ts-expect-error a public session id is not a completion capability
  const capability: CompletionCapability = session.id;

  void capability;
}

void assertContracts;
