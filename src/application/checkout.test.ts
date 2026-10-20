import { describe, expect, it, vi } from 'vitest';
import { CheckoutApplication } from './checkout';
import type {
  CompleteCheckoutInput,
  CheckoutSnapshot,
} from './checkout-service';
import type { AnalyticsEvent, Payment } from './ports';
import { after } from '../domain/checkout';
import type { Result } from '../domain/errors';
import type { CompletionCapability } from '../domain/models';
import { cents, instant, version } from '../domain/values';
import { CheckoutModel } from '../../tests/support/checkout-model';
import { allocation, NOW } from '../../tests/support/checkout-fixtures';
// Concrete simulator/token utilities are exercised separately under infrastructure.

function success<T>(result: Result<T>): T {
  expect(result.ok).toBe(true);

  if (!result.ok) {
    throw result.error;
  }

  return result.value;
}

function errorCode<T>(result: Result<T>) {
  return result.ok ? undefined : result.error.code;
}

function setup(payment?: Payment) {
  let now = NOW;
  let sequence = 0;
  const clock = { now: () => now };
  const model = new CheckoutModel(clock);
  const analytics: AnalyticsEvent[] = [];
  const paymentMock: Payment = payment ?? {
    attempt: vi.fn(async () => ({
      kind: 'SUCCEEDED' as const,
      reference: 'simulated',
    })),
  };
  const completion = {
    issue: ({
      sessionId,
      callerId,
      idempotencyKey,
    }: {
      sessionId: string;
      callerId: string;
      idempotencyKey: string;
    }) => {
      // Test-only deterministic authority. Production HMAC implementation has separate tests.
      const capability = JSON.stringify([
        sessionId,
        callerId,
        idempotencyKey,
      ]) as CompletionCapability;

      return { capability, digest: testDigest(capability) };
    },
  };
  const deps = {
    repository: model,
    orders: model,
    catalog: model.catalog,
    inventory: model,
    payment: paymentMock,
    clock: { now: () => instant('2099-01-01T00:00:00.000Z') },
    analytics: {
      record: vi.fn(async (event: AnalyticsEvent) => {
        analytics.push(event);
      }),
    },
    ids: { next: (kind: string) => `${kind}-${++sequence}` },
    completion,
  };
  const app = new CheckoutApplication(deps);

  return {
    app,
    deps,
    model,
    analytics,
    payment: paymentMock,
    setNow: (time: typeof NOW) => {
      now = time;
    },
    async create() {
      return success(
        await app.create({
          listingId: 'listing',
          allocation,
          expectedListingVersion: model.listing.version,
        }),
      );
    },
  };
}

// Node crypto belongs to tests/support, never to application production imports.
import { createHash } from 'node:crypto';

function testDigest(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function request(
  snapshot: CheckoutSnapshot,
  key = 'purchase',
  callerId = 'device-a',
): CompleteCheckoutInput {
  return {
    sessionId: snapshot.session.id,
    expectedVersion: snapshot.session.version,
    quoteVersion: snapshot.session.quote.version,
    idempotencyKey: key,
    callerId,
  };
}

function deferredPayment() {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attempt = vi.fn(async () => {
    entered();
    await gate;

    return { kind: 'SUCCEEDED' as const, reference: 'simulated' };
  });

  return { payment: { attempt }, started, release };
}

async function conserved(model: CheckoutModel) {
  const view = await model.getAvailability('listing');

  expect(view.counts.available + view.counts.held + view.counts.sold).toBe(
    view.counts.total,
  );
  expect(Object.values(view.counts).every((quantity) => quantity >= 0)).toBe(
    true,
  );

  return view.counts;
}

describe('checkout orchestration against TEST-ONLY atomic-port reference', () => {
  it('creates atomically at server time, ignoring a skewed application clock', async () => {
    const test = setup();
    const created = await test.create();

    expect(created.serverNow).toBe(NOW);
    expect(created.session.reservationExpiresAt).toBe(after(NOW, 600_000));
    expect(test.analytics[0]).toMatchObject({
      at: NOW,
      observedAt: '2099-01-01T00:00:00.000Z',
    });
    expect(await conserved(test.model)).toEqual({
      total: 4,
      held: 2,
      sold: 0,
      available: 2,
    });
    expect(
      errorCode(
        await test.app.create({
          listingId: 'listing',
          allocation,
          expectedListingVersion: version(1),
        }),
      ),
    ).toBe('INVENTORY_UNAVAILABLE');
  });
  it('constructs trusted commands explicitly instead of spreading extra request properties', async () => {
    const test = setup();
    const input = {
      listingId: 'listing',
      allocation,
      expectedListingVersion: version(1),
      kind: 'CHANGE_DEADLINE',
      sessionId: 'client-chosen',
      reservationId: 'client-hold',
    };
    const view = success(await test.app.create(input));

    expect(view.session.id).not.toBe(input.sessionId);
    expect(view.session.reservationId).not.toBe(input.reservationId);
    const completionInput = { ...request(view), kind: 'RESERVE' };

    expect(success(await test.app.complete(completionInput)).kind).toBe(
      'COMPLETED',
    );
  });
  it('correlates fresh navigation telemetry without polling writes or hold extension', async () => {
    const test = setup();
    const view = await test.create();
    const app = new CheckoutApplication({
      ...test.deps,
      telemetrySurface: 'ssr',
    });
    const commandCount = test.model.commands.length;
    const entered = success(
      await app.enter({
        sessionId: view.session.id,
        intent: 'FRESH_NAVIGATION',
        recoveryIdempotencyKey: 'navigation',
      }),
    );

    expect(entered.kind).toBe('RENDER');
    expect(test.analytics.filter((e) => e.name === 'checkout_resumed')).toEqual(
      [
        expect.objectContaining({
          sessionId: view.session.id,
          surface: 'ssr',
          at: view.serverNow,
        }),
      ],
    );
    await app.read(view.session.id);
    await app.enter({
      sessionId: view.session.id,
      intent: 'MOUNTED_REFRESH',
      recoveryIdempotencyKey: 'poll',
    });
    expect(
      test.analytics.filter((e) => e.name === 'checkout_resumed'),
    ).toHaveLength(1);
    expect(test.model.commands).toHaveLength(commandCount);
    expect(
      success(await app.read(view.session.id)).session.reservationExpiresAt,
    ).toBe(view.session.reservationExpiresAt);
  });
  it('getSession/read project expiry without writes, recovery or hold extension', async () => {
    const test = setup();
    const created = await test.create();
    const stored = structuredClone(test.model.sessions.get(created.session.id));
    const commands = test.model.commands.length;

    test.setNow(created.session.reservationExpiresAt);
    expect(
      success(await test.app.getSession(created.session.id)).session.status,
    ).toBe('EXPIRED');
    expect(
      success(await test.app.read(created.session.id)).session.status,
    ).toBe('EXPIRED');
    expect(test.model.commands).toHaveLength(commands);
    expect(test.model.sessions.get(created.session.id)).toEqual(stored);
    expect(test.model.sessions.size).toBe(1);
  });
  it('refreshes fee-inclusive pricing, rejects stale acceptance and never extends a hold', async () => {
    const test = setup();
    let view = await test.create();
    const original = view;

    test.model.listing = {
      ...test.model.listing,
      unitPrice: cents(9000),
      feePerTicket: cents(3000),
      version: version(2),
    };
    view = success(
      await test.app.refreshQuote({
        sessionId: view.session.id,
        expectedVersion: view.session.version,
      }),
    );
    expect(view.session.status).toBe('PRICE_REVIEW');
    expect(errorCode(await test.app.complete(request(view)))).toBe(
      'QUOTE_ACCEPTANCE_REQUIRED',
    );
    expect(
      errorCode(
        await test.app.acceptQuote({
          sessionId: view.session.id,
          expectedVersion: view.session.version,
          quoteVersion: version(1),
        }),
      ),
    ).toBe('QUOTE_ACCEPTANCE_REQUIRED');
    view = success(
      await test.app.acceptQuote({
        sessionId: view.session.id,
        expectedVersion: view.session.version,
        quoteVersion: view.session.quote.version,
      }),
    );
    expect(view.session.reservationExpiresAt).toBe(
      original.session.reservationExpiresAt,
    );
    expect(success(await test.app.complete(request(view))).kind).toBe(
      'COMPLETED',
    );
    expect([...test.model.orders.values()][0]!.quote.total).toBe(24000);
  });
  it('blocks acceptance and completion if persisted live quote changed without a refresh', async () => {
    const test = setup();
    const view = await test.create();

    test.model.listing = {
      ...test.model.listing,
      feePerTicket: cents(3000),
      version: version(2),
    };
    expect(
      errorCode(
        await test.app.acceptQuote({
          sessionId: view.session.id,
          expectedVersion: view.session.version,
          quoteVersion: view.session.quote.version,
        }),
      ),
    ).toBe('VERSION_CONFLICT');
    expect(errorCode(await test.app.complete(request(view)))).toBe(
      'VERSION_CONFLICT',
    );
    expect(test.model.orders.size).toBe(0);
  });
  it('automatically applies decreases and emits positive analytics without changing deadlines', async () => {
    const test = setup();
    const old = await test.create();

    test.model.listing = {
      ...test.model.listing,
      unitPrice: cents(8000),
      version: version(2),
    };
    const view = success(
      await test.app.refreshQuote({
        sessionId: old.session.id,
        expectedVersion: old.session.version,
      }),
    );

    expect(view.session.status).toBe('ACTIVE');
    expect(view.session.quote.total).toBe(19800);
    expect(view.session.reservationExpiresAt).toBe(
      old.session.reservationExpiresAt,
    );
    expect(
      test.analytics.some((event) => event.name === 'price_decreased'),
    ).toBe(true);
    success(await test.app.complete(request(view)));
    expect([...test.model.orders.values()][0]!.quote.total).toBe(19800);
  });
  it('allows one claim/payment/order among competing keys, with stable same-caller replay', async () => {
    const pending = deferredPayment();
    const test = setup(pending.payment);
    const view = await test.create();
    const original = request(view);
    const initiating = test.app.complete(original);

    await pending.started;
    const competitors = await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        test.app.complete(request(view, `competing-${n}`, `other-${n}`)),
      ),
    );

    expect(
      competitors.every(
        (result) => result.ok && result.value.kind === 'IN_PROGRESS',
      ),
    ).toBe(true);
    expect(success(await test.app.complete(original)).kind).toBe('IN_PROGRESS');
    expect(pending.payment.attempt).toHaveBeenCalledTimes(1);
    pending.release();
    const complete = success(await initiating);

    expect(complete.kind).toBe('COMPLETED');
    expect(success(await test.app.complete(original))).toEqual(complete);
    expect(
      errorCode(
        await test.app.complete({ ...original, callerId: 'other-device' }),
      ),
    ).toBe('IDEMPOTENCY_CONFLICT');
    expect(
      errorCode(
        await test.app.complete({ ...original, quoteVersion: version(99) }),
      ),
    ).toBe('IDEMPOTENCY_CONFLICT');
    expect(
      errorCode(await test.app.complete(request(view, 'different-final-key'))),
    ).toBe('TERMINAL_SESSION');
    expect(test.model.orders.size).toBe(1);
    expect(await conserved(test.model)).toEqual({
      total: 4,
      held: 0,
      sold: 2,
      available: 2,
    });
    expect(
      test.analytics.filter((event) => event.name === 'checkout_completed'),
    ).toHaveLength(1);
  });
  it('confirmation is refreshable only with the capability, absent from shared reads', async () => {
    const test = setup();
    const view = await test.create();
    const result = success(await test.app.complete(request(view)));

    if (result.kind !== 'COMPLETED') {
      throw new Error();
    }

    expect(success(await test.app.confirm(result)).id).toBe(result.orderId);
    expect(success(await test.app.confirm(result)).id).toBe(result.orderId);
    expect(
      errorCode(
        await test.app.confirm({
          orderId: result.orderId,
          capability: view.session.id as CompletionCapability,
        }),
      ),
    ).toBe('INVALID_COMPLETION_CAPABILITY');
    expect(JSON.stringify(await test.app.read(view.session.id))).not.toContain(
      result.capability,
    );
    expect(JSON.stringify(test.analytics)).not.toContain(result.capability);
    expect(
      success(
        await test.app.enter({
          sessionId: view.session.id,
          intent: 'FRESH_NAVIGATION',
          recoveryIdempotencyKey: 'other',
        }),
      ).kind,
    ).toBe('REDIRECT_HOME');
    test.setNow(view.session.recoveryRetainUntil);
    expect(errorCode(await test.app.read(view.session.id))).toBe('NOT_FOUND');
    expect(success(await test.app.confirm(result)).id).toBe(result.orderId);
  });
  it('uses fresh keys for confirmed transient retries and caps attempts at three', async () => {
    const payment = {
      attempt: vi.fn(async () => ({ kind: 'TRANSIENT_FAILURE' as const })),
    };
    const test = setup(payment);
    let view = await test.create();
    const expiry = view.session.reservationExpiresAt;

    for (let n = 1; n <= 3; n++) {
      const input = request(view, `try-${n}`);
      const result = success(await test.app.complete(input));

      expect(result.kind).toBe('UPDATED');
      expect(success(await test.app.complete(input))).toEqual(result);
      view = success(await test.app.read(view.session.id));
      expect(view.session.paymentAttemptCount).toBe(n);
      expect(view.session.reservationExpiresAt).toBe(expiry);
    }

    expect(view.session).toMatchObject({
      status: 'PAYMENT_FAILED',
      failureCode: 'ATTEMPTS_EXHAUSTED',
    });
    expect(payment.attempt).toHaveBeenCalledTimes(3);
    expect(errorCode(await test.app.complete(request(view, 'fourth')))).toBe(
      'TERMINAL_SESSION',
    );
    expect(await conserved(test.model)).toEqual({
      total: 4,
      held: 0,
      sold: 0,
      available: 4,
    });
  });
  it('retries a conclusively noncaptured first attempt, then succeeds once', async () => {
    const payment: Payment = {
      attempt: vi.fn<Payment['attempt']>(async (input) =>
        input.attemptNumber === 1
          ? { kind: 'TRANSIENT_FAILURE' }
          : { kind: 'SUCCEEDED', reference: input.attemptId },
      ),
    };
    const test = setup(payment);
    let view = await test.create();

    success(await test.app.complete(request(view, 'first')));
    view = success(await test.app.read(view.session.id));
    expect(view.session.status).toBe('PAYMENT_RETRYABLE');
    expect(success(await test.app.complete(request(view, 'second'))).kind).toBe(
      'COMPLETED',
    );
    expect(test.model.orders.size).toBe(1);
    expect(payment.attempt).toHaveBeenCalledTimes(2);
  });
  it('decline is terminal and releases inventory without retry', async () => {
    const payment = {
      attempt: vi.fn(async () => ({ kind: 'DECLINED' as const })),
    };
    const test = setup(payment);
    const view = await test.create();

    success(await test.app.complete(request(view)));
    const declined = success(await test.app.read(view.session.id));

    expect(declined.session).toMatchObject({
      status: 'PAYMENT_FAILED',
      failureCode: 'DECLINED',
      paymentAttemptCount: 1,
    });
    expect(
      errorCode(await test.app.complete(request(declined, 'retry-decline'))),
    ).toBe('TERMINAL_SESSION');
    expect(payment.attempt).toHaveBeenCalledTimes(1);
    expect((await conserved(test.model)).available).toBe(4);
  });
  it.each(['UNKNOWN', 'THROWS'])(
    'never retries ambiguous payment %s, and fences on processing timeout',
    async (mode) => {
      const payment: Payment = {
        attempt: vi.fn(async () => {
          if (mode === 'THROWS') {
            throw new Error('transport lost');
          }

          return { kind: 'UNKNOWN' as const };
        }),
      };
      const test = setup(payment);
      const view = await test.create();

      expect(success(await test.app.complete(request(view))).kind).toBe(
        'IN_PROGRESS',
      );
      expect(
        success(await test.app.complete(request(view, 'other'))).kind,
      ).toBe('IN_PROGRESS');
      const processing = success(await test.app.read(view.session.id)).session;

      if (processing.status !== 'PROCESSING') {
        throw new Error();
      }

      test.setNow(processing.processingDeadlineAt);
      expect(success(await test.app.read(view.session.id)).session.status).toBe(
        'PAYMENT_FAILED',
      );
      expect(test.model.fences.size).toBe(0); // read projection did not write
      success(await test.app.reconcile(view.session.id));
      expect(test.model.fences.has(processing.attemptId)).toBe(true);
      expect(payment.attempt).toHaveBeenCalledTimes(1);
      expect((await conserved(test.model)).available).toBe(4);
    },
  );
  it('claim-before-expiry protects inventory while pending, then sells after business expiry', async () => {
    const pending = deferredPayment();
    const test = setup(pending.payment);
    const view = await test.create();

    test.setNow(after(view.session.reservationExpiresAt, -1));
    const purchase = test.app.complete(request(view));

    await pending.started;
    test.setNow(view.session.reservationExpiresAt);
    expect(success(await test.app.read(view.session.id)).session.status).toBe(
      'PROCESSING',
    );
    expect((await conserved(test.model)).held).toBe(2);
    expect(
      errorCode(
        await test.app.create({
          listingId: 'listing',
          allocation,
          expectedListingVersion: version(1),
        }),
      ),
    ).toBe('INVENTORY_UNAVAILABLE');
    pending.release();
    expect(success(await purchase).kind).toBe('COMPLETED');
    expect((await conserved(test.model)).sold).toBe(2);
  });
  it('expiry-before-claim cannot start payment; a timed-out late success cannot sell', async () => {
    const test = setup();
    const view = await test.create();

    test.setNow(view.session.reservationExpiresAt);
    expect(errorCode(await test.app.complete(request(view)))).toBe(
      'RESERVATION_EXPIRED',
    );
    expect(test.payment.attempt).not.toHaveBeenCalled();
    expect((await conserved(test.model)).available).toBe(4);
    const pending = deferredPayment();
    const second = setup(pending.payment);
    const next = await second.create();
    const purchase = second.app.complete(request(next));

    await pending.started;
    const processing = success(await second.app.read(next.session.id)).session;

    if (processing.status !== 'PROCESSING') {
      throw new Error();
    }

    second.setNow(processing.processingDeadlineAt);
    success(await second.app.reconcile(next.session.id));
    const replacement = await second.create();

    pending.release();
    const result = success(await purchase);

    expect(result.kind).toBe('UPDATED');
    expect(second.model.orders.size).toBe(0);
    expect((await conserved(second.model)).held).toBe(2);
    expect(replacement.session.id).not.toBe(next.session.id);
  });
  it('mounted expiry goes to event without recovery; concurrent fresh recovery creates one successor', async () => {
    const test = setup();
    const view = await test.create();

    test.setNow(view.session.reservationExpiresAt);
    const mounted = success(
      await test.app.enter({
        sessionId: view.session.id,
        intent: 'MOUNTED_REFRESH',
        recoveryIdempotencyKey: 'unused',
      }),
    );

    expect(mounted).toEqual({ kind: 'REDIRECT_EVENT', eventId: 'event' });
    expect(test.model.sessions.size).toBe(1);
    test.model.listing = {
      ...test.model.listing,
      unitPrice: cents(10000),
      version: version(2),
    };
    const recoveries = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        test.app.enter({
          sessionId: view.session.id,
          intent: 'FRESH_NAVIGATION',
          recoveryIdempotencyKey: `recovery-${i}`,
        }),
      ),
    );
    const targets = recoveries.map((result) => {
      const entry = success(result);

      if (entry.kind !== 'REDIRECT_CHECKOUT') {
        throw new Error();
      }

      return entry.sessionId;
    });

    expect(new Set(targets).size).toBe(1);
    expect(test.model.sessions.size).toBe(2);
    const recovered = success(await test.app.read(targets[0]!)).session;

    expect(recovered).toMatchObject({
      status: 'ACTIVE',
      paymentAttemptCount: 0,
      acknowledgedQuoteVersion: 2,
      acceptedTotal: 23800,
    });
    expect(recovered.reservationId).not.toBe(view.session.reservationId);
    expect(recovered.createdAt).toBe(view.session.reservationExpiresAt);
    expect((await conserved(test.model)).held).toBe(2);
  });
  it('unavailable recovery falls back to event, missing event/metadata to home', async () => {
    const test = setup();
    const view = await test.create();

    test.setNow(view.session.reservationExpiresAt);
    await test.create(); // another shopper takes the seats
    expect(
      success(
        await test.app.recoverExpiredSession({
          sessionId: view.session.id,
          intent: 'FRESH_NAVIGATION',
          idempotencyKey: 'recover',
        }),
      ),
    ).toEqual({ kind: 'REDIRECT_EVENT', eventId: 'event' });
    test.model.eventExists = false;
    expect(
      success(
        await test.app.enter({
          sessionId: view.session.id,
          intent: 'MOUNTED_REFRESH',
          recoveryIdempotencyKey: 'unused',
        }),
      ).kind,
    ).toBe('REDIRECT_HOME');
    test.setNow(view.session.recoveryRetainUntil);
    expect(
      success(
        await test.app.enter({
          sessionId: view.session.id,
          intent: 'FRESH_NAVIGATION',
          recoveryIdempotencyKey: 'expired',
        }),
      ).kind,
    ).toBe('REDIRECT_HOME');
    expect(
      success(
        await test.app.enter({
          sessionId: 'missing',
          intent: 'FRESH_NAVIGATION',
          recoveryIdempotencyKey: 'missing',
        }),
      ).kind,
    ).toBe('REDIRECT_HOME');
  });
  it('recovery clears old quote acknowledgement and attempts', async () => {
    const test = setup({
      attempt: async () => ({ kind: 'TRANSIENT_FAILURE' }),
    });
    let view = await test.create();

    success(await test.app.complete(request(view)));
    view = success(await test.app.read(view.session.id));
    test.model.listing = {
      ...test.model.listing,
      unitPrice: cents(11000),
      version: version(2),
    };
    view = success(
      await test.app.refreshQuote({
        sessionId: view.session.id,
        expectedVersion: view.session.version,
      }),
    );
    expect(view.session.status).toBe('PRICE_REVIEW');
    test.setNow(view.session.reservationExpiresAt);
    const entry = success(
      await test.app.recoverExpiredSession({
        sessionId: view.session.id,
        intent: 'FRESH_NAVIGATION',
        idempotencyKey: 'fresh',
      }),
    );

    if (entry.kind !== 'REDIRECT_CHECKOUT') {
      throw new Error();
    }

    expect(success(await test.app.read(entry.sessionId)).session).toMatchObject(
      { status: 'ACTIVE', paymentAttemptCount: 0, acknowledgedQuoteVersion: 2 },
    );
  });
  it('nonresponsive analytics cannot block or fail purchase', async () => {
    const test = setup();
    const app = new CheckoutApplication({
      ...test.deps,
      analytics: { record: () => new Promise(() => {}) },
    });
    const view = success(
      await app.create({
        listingId: 'listing',
        allocation,
        expectedListingVersion: version(1),
      }),
    );

    expect(success(await app.complete(request(view))).kind).toBe('COMPLETED');
    const failing = new CheckoutApplication({
      ...test.deps,
      analytics: {
        record: async () => {
          throw new Error('offline');
        },
      },
    });

    expect(success(await failing.complete(request(view))).kind).toBe(
      'COMPLETED',
    );
  });
  it('conserves GA units across transient failure, expiry and recovery', async () => {
    const test = setup({
      attempt: async () => ({ kind: 'TRANSIENT_FAILURE' }),
    });

    test.model.listing = {
      ...test.model.listing,
      allocation: { kind: 'GENERAL_ADMISSION', section: 'GA', quantity: 4 },
    };
    const view = success(
      await test.app.create({
        listingId: 'listing',
        allocation: { kind: 'GENERAL_ADMISSION', section: 'GA', quantity: 2 },
        expectedListingVersion: version(1),
      }),
    );

    success(await test.app.complete(request(view)));
    expect((await conserved(test.model)).held).toBe(2);
    test.setNow(view.session.reservationExpiresAt);
    const entry = success(
      await test.app.recoverExpiredSession({
        sessionId: view.session.id,
        intent: 'FRESH_NAVIGATION',
        idempotencyKey: 'ga-recovery',
      }),
    );

    expect(entry.kind).toBe('REDIRECT_CHECKOUT');
    expect(await conserved(test.model)).toEqual({
      total: 4,
      held: 2,
      sold: 0,
      available: 2,
    });
  });
  it('rejects missing idempotency/caller identity before claiming', async () => {
    const test = setup();
    const view = await test.create();

    expect(
      errorCode(await test.app.complete({ ...request(view), callerId: '' })),
    ).toBe('IDEMPOTENCY_CONFLICT');
    expect(
      errorCode(
        await test.app.complete({ ...request(view), idempotencyKey: '' }),
      ),
    ).toBe('IDEMPOTENCY_CONFLICT');
    expect(test.payment.attempt).not.toHaveBeenCalled();
  });
});
