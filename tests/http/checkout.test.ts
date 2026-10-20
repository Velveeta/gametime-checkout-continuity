/** Built production handlers + actual SDK/TLS bridge + real local Redis. */
import { beforeAll, afterAll, expect, it } from 'vitest';
import { startHttpEnvironment } from '../support/http-environment';
import { composeCheckout } from '../../src/infrastructure/checkout/compose';
import { DEFAULT_CHECKOUT_POLICY } from '../../src/domain/checkout';
import { listings } from '../../src/infrastructure/catalog/fixtures';
import { version } from '../../src/domain/values';
let environment: Awaited<ReturnType<typeof startHttpEnvironment>>;
let redis: Awaited<ReturnType<typeof startHttpEnvironment>>['redis'];
let bases: string[],
  namespace: string,
  callerSecret: string,
  completionSecret: string;
beforeAll(async () => {
  environment = await startHttpEnvironment();
  ({ redis, bases, namespace, callerSecret, completionSecret } = environment);
});
afterAll(async () => {
  await environment?.stop();
});
it('serves real Route Handlers through two Next instances, SDK/TLS, Redis, and SSR redirects', async () => {
  const [a, b] = bases;
  const listing = listings[0]!;
  if (listing.allocation.kind !== 'ASSIGNED') throw new Error();
  const allocation = {
    ...listing.allocation,
    seats: [9, 10] as [number, number],
  };
  const posted = await fetch(a + '/api/checkouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId: listing.eventId,
      listingId: listing.id,
      allocation,
      expectedListingVersion: 1,
    }),
  });
  const postedBody = await posted.json();
  expect(posted.status, JSON.stringify(postedBody)).toBe(201);
  const s = postedBody.data;
  const caller = posted.headers.getSetCookie()[0]!.split(';')[0]!;
  const page = await fetch(b + `/checkout/${s.session.id}`, {
    redirect: 'manual',
  });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('Dallas Cowboys');
  expect(html).toContain('Service fees');
  expect(html).toContain('443');
  expect(page.headers.get('cache-control')).toContain('no-store');
  const input = {
    expectedVersion: s.session.version,
    quoteVersion: s.session.quote.version,
  };
  const purchase = await fetch(b + `/api/checkouts/${s.session.id}/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'purchase',
      Cookie: caller,
    },
    body: JSON.stringify(input),
  });
  const completed = await purchase.json();
  expect(purchase.status, JSON.stringify(completed)).toBe(200);
  expect(completed.data.kind).toBe('COMPLETED');
  expect(completed.data.capability).toBeUndefined();
  const confirmationCookie = purchase.headers.getSetCookie()[0]!.split(';')[0]!;
  const confirmed = await fetch(a + completed.data.confirmationUrl, {
    headers: { Cookie: confirmationCookie },
  });
  expect(confirmed.status).toBe(200);
  expect((await confirmed.json()).data.id).toBe(completed.data.orderId);
  const replay = await fetch(a + `/api/checkouts/${s.session.id}/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'purchase',
      Cookie: caller,
    },
    body: JSON.stringify(input),
  });
  expect(await replay.json()).toEqual(completed);
  const terminalPage = await fetch(a + `/checkout/${s.session.id}`, {
    redirect: 'manual',
  });
  expect([303, 307]).toContain(terminalPage.status);
  expect(terminalPage.headers.get('location')).toBe('/');
  const malformed = await fetch(a + '/api/checkouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  expect(malformed.status).toBe(400);
  // Prepare an expired checkout without exposing developer operations over HTTP.
  const setup = await composeCheckout({
    redis,
    namespace,
    callerSecret,
    completionSecret,
    secureCookies: true,
    policy: { ...DEFAULT_CHECKOUT_POLICY, holdMs: 120 },
    analytics: { record: async () => {} },
  });
  const short = await setup.checkout.create({
    listingId: listing.id,
    allocation: { ...allocation, seats: [11, 12] },
    expectedListingVersion: version(1),
  });
  if (!short.ok) throw short.error;
  await redis.after(short.value.session.reservationExpiresAt);
  const expiredJson = await fetch(
    b + `/api/checkouts/${short.value.session.id}`,
  );
  expect(expiredJson.status).toBe(410);
  const stalePage = await fetch(a + `/checkout/${short.value.session.id}`, {
    redirect: 'manual',
  });
  expect([303, 307]).toContain(stalePage.status);
  expect(stalePage.headers.get('location')).toMatch(/^\/checkout\//);
  expect(stalePage.headers.get('location')).not.toBe(
    `/checkout/${short.value.session.id}`,
  );
});
