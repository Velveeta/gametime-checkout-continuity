import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { composeCheckout } from '../../src/infrastructure/checkout/compose';
import { upstashRedis } from '../../src/infrastructure/redis/upstash';
import type { RedisScriptExecutor } from '../../src/infrastructure/redis/inventory';
import { listings } from '../../src/infrastructure/catalog/fixtures';
import { version } from '../../src/domain/values';

const namespace = `live-test-${randomUUID()}`;
let client: ReturnType<typeof upstashRedis>;
const touchedKeys = new Set<string>();
let a: Awaited<ReturnType<typeof composeCheckout>>;
let b: Awaited<ReturnType<typeof composeCheckout>>;
let composeOptions: Parameters<typeof composeCheckout>[0];

beforeAll(async () => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      'Live Upstash validation requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN. No hosted guarantees were verified.',
    );
  }

  if (new URL(url).protocol !== 'https:') {
    throw new Error('Use the HTTPS Upstash REST endpoint');
  }

  client = upstashRedis({ url, token });
  const executor: RedisScriptExecutor = {
    eval: async <T>(
      script: string,
      keys: string[],
      args: (string | number)[],
    ): Promise<T> => {
      for (const key of keys) {
        touchedKeys.add(key);
      }

      return (await client.eval(script, keys, args)) as T;
    },
  };
  const options = {
    redis: executor,
    namespace,
    callerSecret: randomUUID() + randomUUID(),
    completionSecret: randomUUID() + randomUUID(),
    secureCookies: true,
    analytics: { record: async () => {} },
  };

  composeOptions = options;
  a = await composeCheckout(options);
  b = await composeCheckout(options);
});
afterAll(async () => {
  if (!client) {
    return;
  }

  const keys = [...touchedKeys];

  if (!keys.length) {
    return;
  }

  if (keys.some((key) => !key.startsWith(`checkout:{${namespace}}:`))) {
    throw new Error('Refusing cleanup outside isolated live-test namespace');
  }

  // Delete exactly this generated test namespace, never scan or flush shared data.
  await client.eval("return redis.call('DEL',unpack(KEYS))", keys, []);
});
it('verifies real hosted SDK/EVAL transport, competing claims, cross-instance completion and replay', async () => {
  const listing = listings[0]!;

  if (listing.allocation.kind !== 'ASSIGNED') {
    throw new Error();
  }

  const input = {
    listingId: listing.id,
    allocation: { ...listing.allocation, seats: [9, 10] as [number, number] },
    expectedListingVersion: version(1),
  };
  const reservations = await Promise.all([
    a.checkout.create(input),
    b.checkout.create(input),
    a.checkout.create(input),
  ]);

  expect(reservations.filter((r) => r.ok)).toHaveLength(1);
  const winner = reservations.find((r) => r.ok);

  if (!winner) {
    throw new Error('No reservation winner');
  }

  const snapshot = winner.value;
  const complete = {
    sessionId: snapshot.session.id,
    expectedVersion: snapshot.session.version,
    quoteVersion: snapshot.session.quote.version,
    callerId: 'live-device',
    idempotencyKey: 'live-purchase',
  };
  const outcomes = await Promise.all([
    a.checkout.complete(complete),
    b.checkout.complete({
      ...complete,
      idempotencyKey: 'competing-key',
      callerId: 'other-device',
    }),
  ]);
  const done = outcomes.find((r) => r.ok && r.value.kind === 'COMPLETED');

  expect(done).toBeDefined();

  if (!done?.ok || done.value.kind !== 'COMPLETED') {
    throw new Error('No completed caller');
  }

  const winningInput =
    outcomes[0]?.ok && outcomes[0].value.kind === 'COMPLETED'
      ? complete
      : {
          ...complete,
          idempotencyKey: 'competing-key',
          callerId: 'other-device',
        };

  expect(await b.checkout.complete(winningInput)).toEqual(done);
  const confirmation = await a.checkout.confirm(done.value);

  expect(confirmation.ok).toBe(true);
  expect((await b.store.getAvailability(listing.id)).counts).toEqual({
    total: 8,
    available: 6,
    held: 0,
    sold: 2,
  });
});

it('verifies hosted demo persistence, commit-time deadlines, one-shot payment and reset fencing/cleanup', async () => {
  const options = {
    ...composeOptions,
    demoEnabled: true,
    demoSecret: randomUUID() + randomUUID(),
  };
  const retired = await composeCheckout(options);

  await retired.demo.reset('RESET DEMO DATA');
  const first = await composeCheckout(options);
  const second = await composeCheckout(options);
  const listing = listings[0]!;

  if (listing.allocation.kind !== 'ASSIGNED') {
    throw new Error();
  }

  const created = await first.checkout.create({
    listingId: listing.id,
    allocation: { ...listing.allocation, seats: [9, 10] },
    expectedListingVersion: version(1),
  });

  if (!created.ok) {
    throw created.error;
  }

  let s = await first.demo.mutate({
    action: 'PRICE',
    direction: 'INCREASE',
    sessionId: created.value.session.id,
    expectedVersion: created.value.session.version,
  });

  expect((await second.demo.read(s.session.id)).checkout.session.status).toBe(
    'PRICE_REVIEW',
  );
  const accepted = await second.checkout.acceptQuote({
    sessionId: s.session.id,
    expectedVersion: s.session.version,
    quoteVersion: s.session.quote.version,
  });

  if (!accepted.ok) {
    throw accepted.error;
  }

  s = await first.demo.mutate({
    action: 'DEADLINE',
    minutes: 1,
    sessionId: s.session.id,
    expectedVersion: accepted.value.session.version,
  });
  expect(
    Date.parse(s.session.reservationExpiresAt) - Date.parse(s.serverNow),
  ).toBe(60_000);
  s = await first.demo.mutate({
    action: 'PAYMENT',
    scenario: 'TRANSIENT_FAILURE',
    sessionId: s.session.id,
    expectedVersion: s.session.version,
  });
  const result = await second.checkout.complete({
    sessionId: s.session.id,
    expectedVersion: s.session.version,
    quoteVersion: s.session.quote.version,
    callerId: 'demo-live-device',
    idempotencyKey: 'demo-transient',
  });

  expect(
    result.ok &&
      result.value.kind === 'UPDATED' &&
      result.value.snapshot.session.status,
  ).toBe('PAYMENT_RETRYABLE');
  expect((await first.demo.read(s.session.id)).configuration.nextPayment).toBe(
    'DEFAULT',
  );
  await first.demo.reset('RESET DEMO DATA');
  await expect(second.store.read(s.session.id)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  const fresh = await composeCheckout(options);

  expect((await fresh.store.getAvailability(listing.id)).available).toEqual([
    listing.allocation,
  ]);
});
