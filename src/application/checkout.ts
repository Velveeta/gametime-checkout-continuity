import { recordEvents } from './telemetry';
import {
  DEFAULT_CHECKOUT_POLICY,
  reconcileCheckout,
  validateCheckoutPolicy,
  type CheckoutPolicy,
} from '../domain/checkout';
import { DomainError, type Result } from '../domain/errors';
import { validateSelection } from '../domain/inventory';
import type { CheckoutSession, CompletionCapability } from '../domain/models';
import type {
  CheckoutService,
  CheckoutEntry,
  CheckoutSnapshot,
  CompletionResult,
  CompleteCheckoutInput,
} from './checkout-service';
import type {
  Analytics,
  CatalogRepository,
  CheckoutCommand,
  CheckoutMutation,
  CheckoutRepository,
  Clock,
  CompletionAuthority,
  Identifiers,
  Inventory,
  OrderRepository,
  Payment,
  PaymentOutcome,
} from './ports';

export interface CheckoutDependencies {
  readonly repository: CheckoutRepository;
  readonly orders: OrderRepository;
  readonly catalog: CatalogRepository;
  /** Read-only inventory access; atomic mutations belong exclusively to repository. */
  readonly inventory: Inventory;
  readonly payment: Payment;
  readonly clock: Clock; // telemetry observation only, never deadline authority
  readonly analytics: Analytics;
  readonly telemetrySurface?: 'application' | 'http' | 'ssr' | 'demo';
  readonly ids: Identifiers;
  readonly completion: CompletionAuthority;
  readonly policy?: CheckoutPolicy;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function failure<T>(
  code: ConstructorParameters<typeof DomainError>[0],
  message: string,
): Result<T> {
  return { ok: false, error: new DomainError(code, message) };
}

function snapshot(mutation: {
  session: CheckoutSession;
  serverNow: CheckoutSnapshot['serverNow'];
}): CheckoutSnapshot {
  return { session: mutation.session, serverNow: mutation.serverNow };
}

/** Framework-independent orchestration over atomic persistence contracts.
 * No process-local lock, mutable session cache or correctness timer.
 */
export class CheckoutApplication implements CheckoutService {
  private readonly policy: CheckoutPolicy;
  constructor(private readonly dependencies: CheckoutDependencies) {
    this.policy = validateCheckoutPolicy(
      dependencies.policy ?? DEFAULT_CHECKOUT_POLICY,
    );
  }
  private async execute(command: CheckoutCommand) {
    const result = await this.dependencies.repository.execute(
      command,
      this.policy,
    );

    if (result.ok) {
      recordEvents(
        this.dependencies.analytics,
        snapshot(result.value),
        result.value.events,
        this.dependencies.telemetrySurface ?? 'application',
        () => this.dependencies.clock.now(),
      );
    }

    return result;
  }
  async create(
    input: Parameters<CheckoutService['create']>[0],
  ): Promise<Result<CheckoutSnapshot>> {
    const listing = await this.dependencies.catalog.getListing(input.listingId);

    if (!listing) {
      return failure('NOT_FOUND', 'Listing not found');
    }

    try {
      validateSelection(listing, {
        kind: 'EXACT',
        allocation: input.allocation,
      });
    } catch (error) {
      if (error instanceof DomainError) {
        return { ok: false, error };
      }

      throw error;
    }

    // An availability preflight would race. Atomic RESERVE rechecks all facts.
    const result = await this.execute({
      kind: 'RESERVE',
      sessionId: this.dependencies.ids.next('session'),
      reservationId: this.dependencies.ids.next('reservation'),
      listingId: input.listingId,
      allocation: input.allocation,
      expectedListingVersion: input.expectedListingVersion,
    });

    return result.ok ? ok(snapshot(result.value)) : result;
  }
  async getSession(sessionId: string): Promise<Result<CheckoutSnapshot>> {
    const value = await this.dependencies.repository.read(sessionId);

    if (
      !value ||
      Date.parse(value.serverNow) >=
        Date.parse(value.session.recoveryRetainUntil)
    ) {
      return failure('NOT_FOUND', 'Checkout metadata not found');
    }

    return ok({
      session: reconcileCheckout(value.session, value.serverNow).session,
      serverNow: value.serverNow,
    });
  }
  read(sessionId: string) {
    return this.getSession(sessionId);
  }
  async reconcile(sessionId: string): Promise<Result<CheckoutSnapshot>> {
    const result = await this.execute({ kind: 'EXPIRE_IF_DUE', sessionId });

    return result.ok ? ok(snapshot(result.value)) : result;
  }
  private async fallback(eventId: string): Promise<CheckoutEntry> {
    return (await this.dependencies.catalog.getEvent(eventId))
      ? { kind: 'REDIRECT_EVENT', eventId }
      : { kind: 'REDIRECT_HOME' };
  }
  async enter(
    input: Parameters<CheckoutService['enter']>[0],
  ): Promise<Result<CheckoutEntry>> {
    const result = await this.getSession(input.sessionId);

    if (!result.ok) {
      return result.error.code === 'NOT_FOUND'
        ? ok({ kind: 'REDIRECT_HOME' })
        : result;
    }

    const session = result.value.session;

    if (session.status === 'COMPLETED' || session.status === 'PAYMENT_FAILED') {
      return ok({ kind: 'REDIRECT_HOME' });
    }

    if (session.status !== 'EXPIRED') {
      if (input.intent === 'FRESH_NAVIGATION') {
        recordEvents(
          this.dependencies.analytics,
          result.value,
          ['checkout_resumed'],
          this.dependencies.telemetrySurface ?? 'application',
          () => this.dependencies.clock.now(),
        );
      }

      return ok({ kind: 'RENDER', snapshot: result.value });
    }

    if (input.intent === 'MOUNTED_REFRESH') {
      return ok(await this.fallback(session.eventId));
    }

    return this.recoverExpiredSession({
      sessionId: input.sessionId,
      intent: 'FRESH_NAVIGATION',
      idempotencyKey: input.recoveryIdempotencyKey,
    });
  }
  async recoverExpiredSession(
    input: Parameters<CheckoutService['recoverExpiredSession']>[0],
  ): Promise<Result<CheckoutEntry>> {
    // Runtime check as well as the literal type: an HTTP adapter must map navigation intent explicitly.
    if (input.intent !== 'FRESH_NAVIGATION') {
      return failure('INVALID_SELECTION', 'Recovery requires fresh navigation');
    }

    const current = await this.getSession(input.sessionId);

    if (!current.ok) {
      return current.error.code === 'NOT_FOUND'
        ? ok({ kind: 'REDIRECT_HOME' })
        : current;
    }

    if (current.value.session.status !== 'EXPIRED') {
      return ok({ kind: 'REDIRECT_HOME' });
    }

    const result = await this.execute({
      kind: 'RECOVER',
      expiredSessionId: input.sessionId,
      successorId: this.dependencies.ids.next('session'),
      reservationId: this.dependencies.ids.next('reservation'),
      idempotencyKey: input.idempotencyKey,
    });

    if (result.ok) {
      return ok({
        kind: 'REDIRECT_CHECKOUT',
        sessionId: result.value.session.id,
      });
    }

    if (result.error.code === 'NOT_FOUND') {
      return ok({ kind: 'REDIRECT_HOME' });
    }

    if (
      [
        'INVENTORY_UNAVAILABLE',
        'INVALID_SELECTION',
        'TERMINAL_SESSION',
        'RESERVATION_EXPIRED',
      ].includes(result.error.code)
    ) {
      return ok(await this.fallback(current.value.session.eventId));
    }

    return result;
  }
  async refreshQuote(
    input: Parameters<CheckoutService['refreshQuote']>[0],
  ): Promise<Result<CheckoutSnapshot>> {
    const result = await this.execute({
      kind: 'REFRESH_QUOTE',
      sessionId: input.sessionId,
      expectedVersion: input.expectedVersion,
    });

    return result.ok ? ok(snapshot(result.value)) : result;
  }
  async acceptQuote(
    input: Parameters<CheckoutService['acceptQuote']>[0],
  ): Promise<Result<CheckoutSnapshot>> {
    const result = await this.execute({
      kind: 'ACCEPT_QUOTE',
      sessionId: input.sessionId,
      expectedVersion: input.expectedVersion,
      quoteVersion: input.quoteVersion,
    });

    return result.ok ? ok(snapshot(result.value)) : result;
  }
  private completionResult(
    mutation: CheckoutMutation,
    input: CompleteCheckoutInput,
  ): Result<CompletionResult> {
    if (mutation.kind === 'COMPLETED' || mutation.kind === 'REPLAY_COMPLETED') {
      return ok({
        kind: 'COMPLETED',
        orderId: mutation.completion.orderId,
        capability: this.dependencies.completion.issue(input).capability,
      });
    }

    return ok({
      kind:
        mutation.session.status === 'PROCESSING' ? 'IN_PROGRESS' : 'UPDATED',
      snapshot: snapshot(mutation),
    });
  }
  async complete(
    input: CompleteCheckoutInput,
  ): Promise<Result<CompletionResult>> {
    if (
      !input.callerId.trim() ||
      !input.idempotencyKey.trim() ||
      input.callerId.length > 128 ||
      input.idempotencyKey.length > 128
    ) {
      return failure(
        'IDEMPOTENCY_CONFLICT',
        'Caller binding and idempotency key are required',
      );
    }

    const claim = await this.execute({
      kind: 'CLAIM_COMPLETION',
      sessionId: input.sessionId,
      expectedVersion: input.expectedVersion,
      quoteVersion: input.quoteVersion,
      callerId: input.callerId,
      idempotencyKey: input.idempotencyKey,
      attemptId: this.dependencies.ids.next('attempt'),
    });

    if (!claim.ok) {
      return claim;
    }

    if (claim.value.kind !== 'CLAIMED') {
      return this.completionResult(claim.value, input);
    }

    const processing = claim.value.session;
    const credentials = this.dependencies.completion.issue(input);
    let outcome: PaymentOutcome;

    try {
      outcome = await this.dependencies.payment.attempt({
        sessionId: processing.id,
        attemptId: processing.attemptId,
        attemptNumber: processing.paymentAttemptCount,
        quote: processing.quote,
        ...(claim.value.simulation
          ? { simulation: claim.value.simulation }
          : {}),
      });
    } catch {
      outcome = { kind: 'UNKNOWN' };
    }

    const settled = await this.execute({
      kind: 'SETTLE_PAYMENT',
      sessionId: processing.id,
      callerId: input.callerId,
      idempotencyKey: input.idempotencyKey,
      attemptId: processing.attemptId,
      outcome,
      orderId: this.dependencies.ids.next('order'),
      capabilityDigest: credentials.digest,
    });

    return settled.ok ? this.completionResult(settled.value, input) : settled;
  }
  confirm(input: { orderId: string; capability: CompletionCapability }) {
    return this.dependencies.orders.getConfirmation(
      input.orderId,
      input.capability,
    );
  }
}
