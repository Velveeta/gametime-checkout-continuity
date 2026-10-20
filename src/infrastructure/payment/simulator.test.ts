import { expect, it } from 'vitest';
import { SimulatedPayment, type PaymentScenario } from './simulator';
import { createCheckout, DEFAULT_CHECKOUT_POLICY } from '../../domain/checkout';
import {
  allocation,
  listing,
  NOW,
} from '../../../tests/support/checkout-fixtures';
const quote = createCheckout(
  { id: 'session', reservationId: 'hold', listing, allocation },
  NOW,
  DEFAULT_CHECKOUT_POLICY,
).session.quote;
it.each([
  ['SUCCESS', 1, 'SUCCEEDED'],
  ['TRANSIENT_THEN_SUCCESS', 1, 'TRANSIENT_FAILURE'],
  ['TRANSIENT_THEN_SUCCESS', 2, 'SUCCEEDED'],
  ['ALWAYS_TRANSIENT', 3, 'TRANSIENT_FAILURE'],
  ['DECLINE', 1, 'DECLINED'],
  ['UNKNOWN', 1, 'UNKNOWN'],
] as const)(
  '%s attempt %i deterministically resolves %s',
  async (scenario, attemptNumber, kind) => {
    const payment = new SimulatedPayment(
      scenario as PaymentScenario,
      0,
      async () => {},
    );
    const input = {
      sessionId: 'session',
      attemptId: `attempt-${attemptNumber}`,
      attemptNumber,
      quote,
    };
    expect((await payment.attempt(input)).kind).toBe(kind);
    expect(await payment.attempt(input)).toEqual(await payment.attempt(input));
  },
);
it('bounds simulator latency independently of business deadlines', () => {
  expect(() => new SimulatedPayment('SUCCESS', 2001)).toThrow();
  expect(() => new SimulatedPayment('SUCCESS', -1)).toThrow();
  expect(() => new SimulatedPayment('invalid' as PaymentScenario)).toThrow();
});
