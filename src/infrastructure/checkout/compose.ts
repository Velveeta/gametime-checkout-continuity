import { randomUUID } from 'node:crypto';
import { CheckoutApplication } from '../../application/checkout';
import type { Analytics, Payment } from '../../application/ports';
import type { CheckoutPolicy } from '../../domain/checkout';
import { instant } from '../../domain/values';
import { FixtureCatalog } from '../catalog/catalog';
import { CheckoutHttpApi } from '../http/api';
import { CallerCookies } from '../http/cookies';
import { SimulatedPayment } from '../payment/simulator';
import { RedisCheckoutStore } from '../redis/checkout-store';
import type { RedisScriptExecutor } from '../redis/inventory';
import { HmacCompletionAuthority } from './completion-authority';

/** Server composition shared by production and real-Redis integration tests. */
export async function composeCheckout(options: {
  redis: RedisScriptExecutor;
  namespace: string;
  callerSecret: string;
  completionSecret: string;
  secureCookies: boolean;
  payment?: Payment;
  policy?: CheckoutPolicy;
  analytics?: Analytics;
  replayRetentionMs?: number;
}) {
  const seeds = new FixtureCatalog();
  const store = new RedisCheckoutStore(
    options.redis,
    seeds,
    options.namespace,
    options.replayRetentionMs === undefined
      ? undefined
      : { replayMs: options.replayRetentionMs },
  );
  await store.initialize();
  const catalog = {
    getEvent: seeds.getEvent.bind(seeds),
    listEvents: seeds.listEvents.bind(seeds),
    getListing: store.getListing.bind(store),
    listListings: store.listListings.bind(store),
  };
  const checkout = new CheckoutApplication({
    repository: store,
    orders: store,
    inventory: store,
    catalog,
    payment: options.payment ?? new SimulatedPayment(),
    clock: { now: () => instant(new Date().toISOString()) },
    ids: { next: () => randomUUID() },
    completion: new HmacCompletionAuthority(options.completionSecret),
    ...(options.policy ? { policy: options.policy } : {}),
    analytics: options.analytics ?? {
      record: async (event) => {
        console.info(JSON.stringify({ type: 'checkout_event', ...event }));
      },
    },
  });
  const api = new CheckoutHttpApi({
    checkout,
    catalog,
    inventory: store,
    cookies: new CallerCookies(options.callerSecret, options.secureCookies),
  });
  return { checkout, api, store, catalog };
}
