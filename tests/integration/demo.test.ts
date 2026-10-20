import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { RedisHarness } from './redis-harness';
import { composeCheckout } from '../../src/infrastructure/checkout/compose';
import { listings } from '../../src/infrastructure/catalog/fixtures';
import { version } from '../../src/domain/values';
import type { Result } from '../../src/domain/errors';
import type { Payment } from '../../src/application/ports';
import type { CheckoutSnapshot } from '../../src/application/checkout-service';
import type { DemoPayment } from '../../src/application/demo';

const redis = new RedisHarness();
let namespace: string;
const listing = listings[0]!;
const allocation =
  listing.allocation.kind === 'ASSIGNED'
    ? { ...listing.allocation, seats: [9, 10] as [number, number] }
    : listing.allocation;
const secret = 'only-demo-operators-know-this-'.repeat(3);
const options = () => ({
  redis,
  namespace,
  callerSecret: 'caller-'.repeat(7),
  completionSecret: 'completion-'.repeat(5),
  secureCookies: true,
  demoEnabled: true,
  demoSecret: secret,
  analytics: { record: async () => {} },
});
const instance = () => composeCheckout(options());
let a: Awaited<ReturnType<typeof instance>>;

function val<T>(result: Result<T>) {
  if (!result.ok) {
    throw result.error;
  }

  return result.value;
}

async function create(runtime = a) {
  return val(
    await runtime.checkout.create({
      listingId: listing.id,
      allocation,
      expectedListingVersion: version(1),
    }),
  );
}

function completion(s: CheckoutSnapshot, key = randomUUID()) {
  return {
    sessionId: s.session.id,
    expectedVersion: s.session.version,
    quoteVersion: s.session.quote.version,
    callerId: 'device-a',
    idempotencyKey: key,
  };
}

function req(
  id: string,
  body?: unknown,
  cookie?: string,
  origin = 'https://demo.example',
) {
  return new Request('https://demo.example/api/demo/checkouts/' + id, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      origin,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function authorize(id: string) {
  const r = await a.demoApi.dispatch(req(id, { secret }), id, 'authorize');

  expect(r.status).toBe(200);
  expect(r.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');

  return r.headers.get('set-cookie')!.split(';')[0]!;
}

beforeAll(() => redis.start());
afterAll(() => redis.stop());
beforeEach(async () => {
  namespace = 'demo-' + randomUUID();
  a = await instance();
});

describe('guarded scenarios against real Redis', () => {
  it('requires mode, secret, exact session capability, same-origin JSON and valid inputs', async () => {
    const s = await create();
    const id = s.session.id;
    const off = await composeCheckout({ ...options(), demoEnabled: false });

    expect((await off.demoApi.dispatch(req(id), id, 'status')).status).toBe(
      404,
    );
    await expect(async () => off.demo.read(id)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect((await a.demoApi.dispatch(req(id), id, 'status')).status).toBe(403);
    expect(
      (
        await a.demoApi.dispatch(
          req(id, { secret: 'wrong'.repeat(10) }),
          id,
          'authorize',
        )
      ).status,
    ).toBe(403);
    const cookie = await authorize(id);

    expect(
      (
        await a.demoApi.dispatch(
          req(id, undefined, cookie.replace(/=\d+\./, '=1.')),
          id,
          'status',
        )
      ).status,
    ).toBe(403);

    expect(
      (
        await a.demoApi.dispatch(
          req('unrelated', undefined, cookie),
          'unrelated',
          'status',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await a.demoApi.dispatch(
          req(
            id,
            { expectedVersion: 1, action: 'EXPIRE' },
            cookie,
            'https://evil.example',
          ),
          id,
          'mutate',
        )
      ).status,
    ).toBe(403);

    for (const body of [
      { action: 'DEADLINE', minutes: 0, expectedVersion: 1 },
      { action: 'DEADLINE', minutes: 31, expectedVersion: 1 },
      { action: 'PAYMENT', scenario: 'made-up', expectedVersion: 1 },
      { action: 'EXPIRE', expectedVersion: 1, authorized: true },
    ]) {
      expect(
        (await a.demoApi.dispatch(req(id, body, cookie), id, 'mutate')).status,
      ).toBe(400);
    }

    expect(
      (
        await a.demoApi.dispatch(
          req(id, { confirmation: 'yes' }, cookie),
          id,
          'reset',
        )
      ).status,
    ).toBe(400);
    expect((await a.checkout.read(id)).ok).toBe(true);
  });
  it('persists session-only full-total pricing and invalidates stale acknowledgements', async () => {
    const s = await create();
    const b = await instance();
    const higher = await a.demo.mutate({
      action: 'PRICE',
      direction: 'INCREASE',
      sessionId: s.session.id,
      expectedVersion: s.session.version,
    });

    expect(higher.session.status).toBe('PRICE_REVIEW');
    expect(higher.session.quote.total).toBe(
      higher.session.quote.ticketSubtotal + higher.session.quote.fees,
    );
    expect(higher.session.quote.fees).toBe(s.session.quote.fees);
    expect((await b.demo.read(s.session.id)).checkout.session.quote).toEqual(
      higher.session.quote,
    );
    expect((await b.store.getListing(listing.id))!.unitPrice).toBe(
      listing.unitPrice,
    );
    const accepted = val(
      await b.checkout.acceptQuote({
        sessionId: s.session.id,
        expectedVersion: higher.session.version,
        quoteVersion: higher.session.quote.version,
      }),
    );
    const again = await a.demo.mutate({
      action: 'PRICE',
      direction: 'INCREASE',
      sessionId: s.session.id,
      expectedVersion: accepted.session.version,
    });
    const stale = await b.checkout.complete(completion(accepted));

    expect(stale.ok).toBe(false);
    const lower = await a.demo.mutate({
      action: 'PRICE',
      direction: 'DECREASE',
      sessionId: s.session.id,
      expectedVersion: again.session.version,
    });

    expect(lower.session.quote.total).toBeLessThan(again.session.quote.total);
    expect(lower.session.acknowledgedQuoteVersion).toBe(
      lower.session.quote.version,
    );
  });
  it('updates the existing deadline relative to commit-time server now without resetting attempts', async () => {
    const s = await create();
    const b = await instance();
    const updated = await a.demo.mutate({
      action: 'DEADLINE',
      minutes: 30,
      sessionId: s.session.id,
      expectedVersion: s.session.version,
    });

    expect(
      Date.parse(updated.session.reservationExpiresAt) -
        Date.parse(updated.serverNow),
    ).toBe(30 * 60_000);
    expect(updated.session.reservationId).toBe(s.session.reservationId);
    expect(updated.session.paymentAttemptCount).toBe(0);
    expect(
      (await b.demo.read(s.session.id)).checkout.session.reservationExpiresAt,
    ).toBe(updated.session.reservationExpiresAt);
    const raw = JSON.parse(
      await redis.command('GET', a.store.inventoryKey(listing.id)),
    );

    expect(raw.reservations[s.session.reservationId].expiresAtMs).toBe(
      Date.parse(updated.session.reservationExpiresAt),
    );
    expect(
      val(await b.checkout.read(s.session.id)).session.reservationExpiresAt,
    ).toBe(updated.session.reservationExpiresAt);
  });
  it('expires and releases atomically; cannot revive an expired reservation', async () => {
    const s = await create();
    const expired = await a.demo.mutate({
      action: 'EXPIRE',
      sessionId: s.session.id,
      expectedVersion: s.session.version,
    });

    expect(expired.session.status).toBe('EXPIRED');
    const stock = await a.store.getAvailability(listing.id);

    expect(stock.available).toEqual([listing.allocation]);
    await expect(
      a.demo.mutate({
        action: 'DEADLINE',
        minutes: 2,
        sessionId: s.session.id,
        expectedVersion: expired.session.version,
      }),
    ).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });
    expect(val(await a.checkout.read(s.session.id)).session.status).toBe(
      'EXPIRED',
    );
  });
  it.each<DemoPayment>(['SUCCESS', 'TRANSIENT_FAILURE', 'DECLINED'])(
    'consumes %s once at claim and drives actual completion across instances',
    async (scenario) => {
      const s = await create();
      const configured = await a.demo.mutate({
        action: 'PAYMENT',
        scenario,
        sessionId: s.session.id,
        expectedVersion: s.session.version,
      });
      const b = await instance();

      expect((await b.demo.read(s.session.id)).configuration.nextPayment).toBe(
        scenario,
      );
      const result = val(await b.checkout.complete(completion(configured)));

      expect((await a.demo.read(s.session.id)).configuration.nextPayment).toBe(
        'DEFAULT',
      );

      if (scenario === 'SUCCESS') {
        expect(result.kind).toBe('COMPLETED');
      } else {
        expect(result.kind).toBe('UPDATED');

        if (result.kind === 'UPDATED') {
          expect(result.snapshot.session.status).toBe(
            scenario === 'DECLINED' ? 'PAYMENT_FAILED' : 'PAYMENT_RETRYABLE',
          );
        }
      }

      const doc = JSON.parse(
        await redis.command('GET', a.store.sessionKey(s.session.id)),
      );

      expect(Object.values(doc.attempts)[0]).toMatchObject({
        simulation: scenario,
        ordinal: 1,
      });
    },
  );
  it('clears selection without resetting the three-attempt limit and rejects terminal edits', async () => {
    let s = await create();

    for (let attempt = 1; attempt <= 3; attempt++) {
      s = await a.demo.mutate({
        action: 'PAYMENT',
        scenario: 'TRANSIENT_FAILURE',
        sessionId: s.session.id,
        expectedVersion: s.session.version,
      });
      const result = val(await a.checkout.complete(completion(s)));

      if (result.kind !== 'UPDATED') {
        throw new Error('Expected transient result');
      }

      s = result.snapshot;
      expect(s.session.paymentAttemptCount).toBe(attempt);

      if (attempt === 1) {
        s = await a.demo.mutate({
          action: 'DEADLINE',
          minutes: 1,
          sessionId: s.session.id,
          expectedVersion: s.session.version,
        });
        expect(s.session.paymentAttemptCount).toBe(1);
        expect(s.session.status).toBe('PAYMENT_RETRYABLE');
      }
    }

    expect(s.session.status).toBe('PAYMENT_FAILED');
    await expect(
      a.demo.mutate({
        action: 'PAYMENT',
        scenario: 'DEFAULT',
        sessionId: s.session.id,
        expectedVersion: s.session.version,
      }),
    ).rejects.toMatchObject({ code: 'TERMINAL_SESSION' });
    expect((await a.checkout.complete(completion(s))).ok).toBe(false);
    expect((await a.store.getAvailability(listing.id)).available).toEqual([
      listing.allocation,
    ]);
  });
  it('clear simulation uses default success and leaves attempts/deadline untouched', async () => {
    let s = await create();
    const deadline = s.session.reservationExpiresAt;

    s = await a.demo.mutate({
      action: 'PAYMENT',
      scenario: 'DECLINED',
      sessionId: s.session.id,
      expectedVersion: s.session.version,
    });
    s = await a.demo.mutate({
      action: 'PAYMENT',
      scenario: 'DEFAULT',
      sessionId: s.session.id,
      expectedVersion: s.session.version,
    });
    expect(s.session.reservationExpiresAt).toBe(deadline);
    expect(s.session.paymentAttemptCount).toBe(0);
    expect(val(await a.checkout.complete(completion(s))).kind).toBe(
      'COMPLETED',
    );
  });
  it('serializes concurrent edits and completion; never ignores price/version guards', async () => {
    const s = await create();
    const b = await instance();
    const [price, complete] = await Promise.allSettled([
      a.demo.mutate({
        action: 'PRICE',
        direction: 'INCREASE',
        sessionId: s.session.id,
        expectedVersion: s.session.version,
      }),
      b.checkout.complete(completion(s)),
    ]);

    if (price.status === 'fulfilled') {
      expect(complete.status === 'fulfilled' && complete.value.ok).toBe(false);
    } else {
      expect(complete.status === 'fulfilled' && complete.value.ok).toBe(true);
    }
  });
  it('protects processing inventory and prevents scenario/deadline changes during an attempt', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const payment: Payment = {
      attempt: async (input) => {
        expect(input.simulation).toBe('SUCCESS');
        entered();
        await pause;

        return { kind: 'SUCCEEDED', reference: 'simulated' };
      },
    };
    const b = await composeCheckout({ ...options(), payment });
    let s = await create();

    s = await a.demo.mutate({
      action: 'PAYMENT',
      scenario: 'SUCCESS',
      sessionId: s.session.id,
      expectedVersion: s.session.version,
    });
    const pending = b.checkout.complete(completion(s));

    await started;
    const processing = val(await a.checkout.read(s.session.id));

    expect(processing.session.status).toBe('PROCESSING');

    for (const action of [
      { action: 'EXPIRE' as const },
      { action: 'PAYMENT' as const, scenario: 'DECLINED' as const },
      { action: 'DEADLINE' as const, minutes: 1 },
    ]) {
      await expect(
        a.demo.mutate({
          ...action,
          sessionId: s.session.id,
          expectedVersion: processing.session.version,
        }),
      ).rejects.toMatchObject({ code: 'PROCESSING_IN_PROGRESS' });
    }

    expect((await a.store.getAvailability(listing.id)).available).not.toEqual([
      listing.allocation,
    ]);
    release();
    expect(val(await pending).kind).toBe('COMPLETED');
  });
  it('resets held/sold inventory, fences old instances, cleans retired keys and isolates namespaces', async () => {
    const sold = await create();

    expect(val(await a.checkout.complete(completion(sold))).kind).toBe(
      'COMPLETED',
    );
    const otherListing = listings[1]!;

    val(
      await a.checkout.create({
        listingId: otherListing.id,
        allocation:
          otherListing.allocation.kind === 'ASSIGNED'
            ? {
                ...otherListing.allocation,
                seats: otherListing.allocation.seats.slice(
                  0,
                  otherListing.quantityRules.min,
                ) as [number, ...number[]],
              }
            : {
                ...otherListing.allocation,
                quantity: otherListing.quantityRules.min,
              },
        expectedListingVersion: version(1),
      }),
    );
    const other = await composeCheckout({
      ...options(),
      namespace: namespace + '-other',
    });
    const preserved = await create(other);

    await expect(a.demo.reset('yes')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await a.demo.reset('RESET DEMO DATA');
    await expect(a.store.read(sold.session.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const fresh = await instance();

    expect((await fresh.checkout.read(sold.session.id)).ok).toBe(false);
    expect((await fresh.store.getAvailability(listing.id)).available).toEqual([
      listing.allocation,
    ]);
    expect(
      (await fresh.store.getAvailability(otherListing.id)).available,
    ).toEqual([otherListing.allocation]);
    expect(
      await redis.command(
        'EXISTS',
        a.store.sessionKey(sold.session.id),
        a.store.receiptKey(sold.session.id),
        a.store.inventoryKey(listing.id),
      ),
    ).toBe('0');
    expect(
      val(await other.checkout.read(preserved.session.id)).session.id,
    ).toBe(preserved.session.id);
    expect((await create(fresh)).session.quote.total).toBe(
      sold.session.quote.total,
    );
  });
  it('allows only one concurrent reset and fences a payment settlement across reset', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const pause = new Promise<void>((r) => {
      release = r;
    });
    const b = await composeCheckout({
      ...options(),
      payment: {
        attempt: async () => {
          entered();
          await pause;

          return { kind: 'SUCCEEDED', reference: 'simulated' };
        },
      },
    });
    const s = await create();
    const pending = b.checkout.complete(completion(s));

    await started;
    const resets = await Promise.allSettled([
      a.demo.reset('RESET DEMO DATA'),
      a.demo.reset('RESET DEMO DATA'),
    ]);

    expect(resets.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    release();
    await expect(pending).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      (await (await instance()).store.getAvailability(listing.id)).available,
    ).toEqual([listing.allocation]);
  });
  it('keeps fresh-generation holds intact while retired base keys are being reclaimed', async () => {
    const old = await create();
    let entered!: () => void;
    let release!: () => void;
    const scanning = new Promise<void>((r) => {
      entered = r;
    });
    const pause = new Promise<void>((r) => {
      release = r;
    });
    const executor = {
      eval: async <T>(
        script: string,
        keys: string[],
        args: (string | number)[],
      ): Promise<T> => {
        if (script.includes("redis.call('SCAN'")) {
          entered();
          await pause;
        }

        return redis.eval<T>(script, keys, args);
      },
    };
    const resetting = await composeCheckout({ ...options(), redis: executor });
    const pending = resetting.demo.reset('RESET DEMO DATA');

    await scanning;
    const fresh = await instance();
    const held = await create(fresh);

    release();
    await pending;
    expect(
      val(await fresh.checkout.read(held.session.id)).session.reservationId,
    ).toBe(held.session.reservationId);
    expect(
      await redis.command(
        'EXISTS',
        fresh.store.inventoryKey(listing.id),
        fresh.store.sessionKey(held.session.id),
      ),
    ).toBe('2');
    expect(
      await redis.command('EXISTS', a.store.sessionKey(old.session.id)),
    ).toBe('0');
    expect((await fresh.store.getAvailability(listing.id)).counts.held).toBe(2);
  });
});
