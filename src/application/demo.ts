import type { Analytics } from './ports';
import { recordEvents } from './telemetry';
import type { CheckoutSnapshot } from './checkout-service';
import type { CheckoutPolicy } from '../domain/checkout';
import { DomainError } from '../domain/errors';

export type DemoPayment =
  'DEFAULT' | 'SUCCESS' | 'TRANSIENT_FAILURE' | 'DECLINED';
export interface DemoConfiguration {
  nextPayment: DemoPayment;
  price?: { unitPrice: number; feePerTicket: number; version: number };
}
export type DemoMutation = { sessionId: string; expectedVersion: number } & (
  | { action: 'PRICE'; direction: 'INCREASE' | 'DECREASE' }
  | { action: 'DEADLINE'; minutes: number }
  | { action: 'EXPIRE' }
  | { action: 'PAYMENT'; scenario: DemoPayment }
);
export interface DemoSnapshot {
  checkout: CheckoutSnapshot;
  configuration: DemoConfiguration;
}
export interface DemoRepository {
  readDemo(id: string): Promise<DemoSnapshot>;
  mutateDemo(
    input: DemoMutation,
    policy: CheckoutPolicy,
  ): Promise<CheckoutSnapshot>;
  resetDemo(): Promise<void>;
}

/** Framework-independent, explicitly enabled application boundary. HTTP must also
 * authenticate a session-scoped capability before invoking any of these methods.
 */
export class DemoService {
  constructor(
    private readonly repository: DemoRepository,
    private readonly policy: CheckoutPolicy,
    private readonly enabled: boolean,
    private readonly analytics?: Analytics,
  ) {}
  private guard() {
    if (!this.enabled) {
      throw new DomainError('UNAUTHORIZED', 'Demo controls are disabled');
    }
  }
  read(id: string) {
    this.guard();

    return this.repository.readDemo(id);
  }
  async mutate(input: DemoMutation) {
    this.guard();

    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1 ||
      (input.action === 'DEADLINE' &&
        (!Number.isInteger(input.minutes) ||
          input.minutes < 1 ||
          input.minutes > 30)) ||
      (input.action === 'PRICE' &&
        !['INCREASE', 'DECREASE'].includes(input.direction)) ||
      (input.action === 'PAYMENT' &&
        !['DEFAULT', 'SUCCESS', 'TRANSIENT_FAILURE', 'DECLINED'].includes(
          input.scenario,
        ))
    ) {
      throw new DomainError('INVALID_SELECTION', 'Invalid demo mutation');
    }

    const result = await this.repository.mutateDemo(input, this.policy);

    if (this.analytics) {
      recordEvents(
        this.analytics,
        result,
        input.action === 'PRICE'
          ? ['quote_changed']
          : input.action === 'EXPIRE'
            ? ['checkout_expired']
            : [],
        'demo',
      );
    }

    return result;
  }
  async reset(confirmation: string) {
    this.guard();

    if (confirmation !== 'RESET DEMO DATA') {
      throw new DomainError(
        'UNAUTHORIZED',
        'Explicit reset confirmation required',
      );
    }

    await this.repository.resetDemo();

    return { reset: true as const };
  }
}
