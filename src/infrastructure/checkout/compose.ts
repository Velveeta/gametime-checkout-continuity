import { ConsoleAnalytics } from './analytics';
import { DemoService } from '../../application/demo';
import { DEFAULT_CHECKOUT_POLICY } from '../../domain/checkout';
import { DemoHttpApi } from '../http/demo-api';
import { SNAPSHOT_LUA } from '../redis/transactions';
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
  telemetrySurface?: 'application' | 'http' | 'ssr' | 'demo';
  replayRetentionMs?: number;
  demoEnabled?: boolean;
  demoSecret?: string;
}) {
  const generationKey = `checkout:{${options.namespace}}:generation:v1`;
  const raw = await options.redis.eval<{ raw: string[] } | string>(
    SNAPSHOT_LUA,
    [generationKey],
    [],
  );
  const observed =
    typeof raw === 'string' ? (JSON.parse(raw) as { raw: string[] }) : raw;
  const generation = observed.raw[0] || 'base';
  const seeds = new FixtureCatalog();
  const store = new RedisCheckoutStore(
    options.redis,
    seeds,
    options.namespace,
    options.replayRetentionMs === undefined
      ? undefined
      : { replayMs: options.replayRetentionMs },
    { key: generationKey, generation },
  );

  await store.initialize();
  const catalog = {
    getEvent: seeds.getEvent.bind(seeds),
    listEvents: seeds.listEvents.bind(seeds),
    getListing: store.getListing.bind(store),
    listListings: store.listListings.bind(store),
  };
  const analytics = options.analytics ?? new ConsoleAnalytics();
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
    analytics,
    telemetrySurface: options.telemetrySurface ?? 'application',
  });
  const api = new CheckoutHttpApi({
    checkout,
    catalog,
    inventory: store,
    cookies: new CallerCookies(options.callerSecret, options.secureCookies),
  });

  const demo = new DemoService(
    store,
    options.policy ?? DEFAULT_CHECKOUT_POLICY,
    options.demoEnabled ?? false,
    analytics,
  );
  const demoApi = new DemoHttpApi(demo, api, {
    enabled: options.demoEnabled ?? false,
    secret: options.demoSecret ?? '',
    secure: options.secureCookies,
    scope: store.prefix,
  });

  return { checkout, api, store, catalog, demo, demoApi };
}
