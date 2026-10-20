import 'server-only';
import { upstashRedis } from '../infrastructure/redis/upstash';
import { composeCheckout } from '../infrastructure/checkout/compose';
import { SimulatedPayment } from '../infrastructure/payment/simulator';
import { apiFailure, type CheckoutHttpApi } from '../infrastructure/http/api';
import { requireCheckoutEnv } from './env';

/** Fresh composition per invocation; Redis alone owns persistent state. */
export async function checkoutRuntime() {
  const env = requireCheckoutEnv(process.env);
  const redis = upstashRedis({ url: env.url, token: env.token });

  return composeCheckout({
    redis,
    namespace: env.CHECKOUT_NAMESPACE,
    callerSecret: env.callerSecret,
    completionSecret: env.completionSecret,
    secureCookies: process.env.NODE_ENV === 'production',
    payment: new SimulatedPayment(env.PAYMENT_SCENARIO),
  });
}

export async function withCheckoutApi(
  action: (api: CheckoutHttpApi) => Promise<Response>,
) {
  try {
    return await action((await checkoutRuntime()).api);
  } catch {
    return apiFailure(
      'SERVICE_UNAVAILABLE',
      'Checkout service is temporarily unavailable',
    );
  }
}
