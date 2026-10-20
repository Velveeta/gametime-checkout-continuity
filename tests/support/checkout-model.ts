/** TEST-ONLY executable atomic-port reference. Each command is synchronous and
 * serial within this JS process. This does NOT implement/test Redis atomicity,
 * durability, HTTP caller authentication, crashes or multi-process races.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  acceptCheckoutQuote,
  changeCheckoutDeadline,
  claimCheckout,
  createCheckout,
  reconcileCheckout,
  recoverCheckout,
  refreshCheckoutQuote,
  settleCheckout,
  type CheckoutDecision,
  type CheckoutPolicy,
} from '../../src/domain/checkout';
import { DomainError, type Result } from '../../src/domain/errors';
import { allocationQuantity, quoteSelection } from '../../src/domain/inventory';
import type {
  CheckoutSession,
  CompletionCapability,
  Listing,
  Order,
  SeatAllocation,
} from '../../src/domain/models';
import { version, type Instant } from '../../src/domain/values';
import type {
  CatalogRepository,
  CheckoutCommand,
  CheckoutMutation,
  CheckoutRepository,
  Clock,
  Inventory,
  OrderRepository,
} from '../../src/application/ports';
import { event, listing as originalListing } from './checkout-fixtures';

type Hold = {
  id: string;
  owner: string;
  allocation: SeatAllocation;
  until: Instant;
  status: 'HELD' | 'RELEASED' | 'SOLD';
};
type Claim = Extract<CheckoutCommand, { kind: 'CLAIM_COMPLETION' }>;
type Ledger = {
  callerId: string;
  fingerprint: string;
  attemptId: string;
  final?: CheckoutMutation;
};
const success = <T>(value: T): Result<T> => ({ ok: true, value });

function error(code: ConstructorParameters<typeof DomainError>[0]): never {
  throw new DomainError(code, code);
}

function units(a: SeatAllocation) {
  return a.kind === 'ASSIGNED'
    ? a.seats.map((seat) => `${a.section}/${a.row}/${seat}`)
    : [];
}

type CheckoutModelContracts = CheckoutRepository & OrderRepository & Inventory;

export class CheckoutModel implements CheckoutModelContracts {
  readonly sessions = new Map<string, CheckoutSession>();
  readonly holds = new Map<string, Hold>();
  readonly orders = new Map<string, Order>();
  readonly digests = new Map<string, string>();
  readonly ledger = new Map<string, Ledger>();
  readonly fences = new Set<string>();
  readonly commands: CheckoutCommand[] = [];
  listing: Listing = structuredClone(originalListing);
  eventExists = true;
  readonly catalog: CatalogRepository = {
    listEvents: async () => (this.eventExists ? [event] : []),
    listListings: async (id) => (id === event.id ? [this.listing] : []),
    getEvent: async (id) =>
      this.eventExists && id === event.id ? event : null,
    getListing: async (id) => (id === this.listing.id ? this.listing : null),
  };
  constructor(readonly clock: Clock) {}
  async read(id: string) {
    const session = this.sessions.get(id);
    const serverNow = this.clock.now();

    return !session ||
      Date.parse(serverNow) >= Date.parse(session.recoveryRetainUntil)
      ? null
      : { session: structuredClone(session), serverNow };
  }
  private mutation(
    decision: CheckoutDecision,
    now: Instant,
    kind: 'UPDATED' = 'UPDATED',
  ): CheckoutMutation {
    return {
      kind,
      session: structuredClone(decision.session),
      serverNow: now,
      events: decision.events,
    };
  }
  private live(hold: Hold, now: Instant) {
    return (
      hold.status === 'SOLD' ||
      (hold.status === 'HELD' && Date.parse(now) < Date.parse(hold.until))
    );
  }
  private apply(decision: CheckoutDecision, now: Instant) {
    // Stage all validation/effects before committing the test transaction.
    const holds = new Map(
      [...this.holds].map(([id, hold]) => [id, structuredClone(hold)]),
    );
    const fenced = new Set(this.fences);

    for (const effect of decision.effects) {
      if (effect.kind === 'FENCE_ATTEMPT') {
        fenced.add(effect.attemptId);
        continue;
      }

      if (effect.kind === 'RESERVE') {
        const blocking = [...holds.values()].filter((hold) =>
          this.live(hold, now),
        );

        if (effect.allocation.kind === 'ASSIGNED') {
          const selected = units(effect.allocation);

          if (
            blocking.some((hold) =>
              units(hold.allocation).some((unit) => selected.includes(unit)),
            )
          ) {
            error('INVENTORY_UNAVAILABLE');
          }
        } else {
          const used = blocking.reduce(
            (sum, hold) => sum + allocationQuantity(hold.allocation),
            0,
          );

          if (
            used + effect.allocation.quantity >
            allocationQuantity(this.listing.allocation)
          ) {
            error('INVENTORY_UNAVAILABLE');
          }
        }

        if (holds.has(effect.reservationId)) {
          error('RESERVATION_CONFLICT');
        }

        holds.set(effect.reservationId, {
          id: effect.reservationId,
          owner: decision.session.id,
          allocation: effect.allocation,
          until: effect.until,
          status: 'HELD',
        });
      } else {
        const hold = holds.get(effect.reservationId);

        if (!hold || hold.owner !== decision.session.id) {
          error('RESERVATION_CONFLICT');
        }

        if (effect.kind === 'RELEASE') {
          hold.status = 'RELEASED';
        }

        if (
          effect.kind === 'PROTECT' ||
          effect.kind === 'RESTORE_BUSINESS_HOLD'
        ) {
          hold.until = effect.until;
        }

        if (effect.kind === 'SELL') {
          if (hold.status !== 'HELD' || !this.live(hold, now)) {
            error('RESERVATION_EXPIRED');
          }

          hold.status = 'SOLD';
        }
      }
    }

    if (
      decision.order &&
      (this.orders.has(decision.order.id) ||
        [...this.orders.values()].some(
          (order) => order.checkoutSessionId === decision.session.id,
        ))
    ) {
      error('TERMINAL_SESSION');
    }

    this.holds.clear();

    for (const [id, hold] of holds) {
      this.holds.set(id, hold);
    }

    this.fences.clear();

    for (const id of fenced) {
      this.fences.add(id);
    }

    this.sessions.set(decision.session.id, structuredClone(decision.session));

    if (decision.order) {
      this.orders.set(decision.order.id, structuredClone(decision.order));
    }
  }
  private reconcile(id: string, now: Instant) {
    const session = this.sessions.get(id);

    if (
      !session ||
      Date.parse(now) >= Date.parse(session.recoveryRetainUntil)
    ) {
      error('NOT_FOUND');
    }

    const decision = reconcileCheckout(session, now);

    this.apply(decision, now);

    return decision;
  }
  private replay(
    entry: Ledger,
    now: Instant,
    session: CheckoutSession,
  ): CheckoutMutation {
    if (entry.final) {
      const cached = structuredClone(entry.final);

      if (cached.kind === 'COMPLETED' || cached.kind === 'REPLAY_COMPLETED') {
        return { ...cached, kind: 'REPLAY_COMPLETED', events: [] };
      }

      return { ...cached, kind: 'REPLAY', events: [] };
    }

    return {
      kind: 'IN_PROGRESS',
      session: structuredClone(session),
      serverNow: now,
      events: [],
    };
  }
  private claim(
    command: Claim,
    session: CheckoutSession,
    now: Instant,
    policy: CheckoutPolicy,
  ): CheckoutMutation {
    const key = JSON.stringify([session.id, command.idempotencyKey]);
    const fingerprint = JSON.stringify([
      command.expectedVersion,
      command.quoteVersion,
    ]);
    const prior = this.ledger.get(key);

    if (prior) {
      if (
        prior.callerId !== command.callerId ||
        prior.fingerprint !== fingerprint
      ) {
        error('IDEMPOTENCY_CONFLICT');
      }

      return this.replay(prior, now, session);
    }

    if (session.status === 'PROCESSING') {
      return { kind: 'IN_PROGRESS', session, serverNow: now, events: [] };
    }

    const hold = this.holds.get(session.reservationId);
    const decision = claimCheckout(
      session,
      command,
      {
        now,
        currentQuote: quoteSelection(
          this.listing,
          allocationQuantity(session.allocation),
        ),
        ownsReservation:
          !!hold &&
          hold.owner === session.id &&
          hold.status === 'HELD' &&
          this.live(hold, now),
        orderExists: [...this.orders.values()].some(
          (order) => order.checkoutSessionId === session.id,
        ),
      },
      policy,
    );

    this.apply(decision, now);
    this.ledger.set(key, {
      callerId: command.callerId,
      fingerprint,
      attemptId: command.attemptId,
    });

    if (decision.session.status !== 'PROCESSING') {
      throw new Error('Invalid claim result');
    }

    return {
      kind: 'CLAIMED',
      session: decision.session,
      serverNow: now,
      events: decision.events,
    };
  }
  async execute(
    command: CheckoutCommand,
    policy: CheckoutPolicy,
  ): Promise<Result<CheckoutMutation>> {
    this.commands.push(command);
    const now = this.clock.now();

    try {
      const targetId =
        command.kind === 'RECOVER'
          ? command.expiredSessionId
          : command.sessionId;

      for (const other of this.sessions.values()) {
        if (other.id === targetId) {
          continue;
        }

        const due = reconcileCheckout(other, now);

        if (due.effects.length) {
          this.apply(due, now);
        }
      }

      if (command.kind === 'RESERVE') {
        if (command.listingId !== this.listing.id) {
          error('NOT_FOUND');
        }

        if (command.expectedListingVersion !== this.listing.version) {
          error('VERSION_CONFLICT');
        }

        if (this.sessions.has(command.sessionId)) {
          error('RESERVATION_CONFLICT');
        }

        const decision = createCheckout(
          {
            id: command.sessionId,
            reservationId: command.reservationId,
            listing: this.listing,
            allocation: command.allocation,
          },
          now,
          policy,
        );

        this.apply(decision, now);

        return success(this.mutation(decision, now));
      }

      const id =
        command.kind === 'RECOVER'
          ? command.expiredSessionId
          : command.sessionId;
      const reconciled = this.reconcile(id, now);
      const session = reconciled.session;

      if (command.kind === 'CLAIM_COMPLETION') {
        return success(this.claim(command, session, now, policy));
      }

      if (command.kind === 'SETTLE_PAYMENT') {
        const entry = this.ledger.get(
          JSON.stringify([id, command.idempotencyKey]),
        );

        if (
          !entry ||
          entry.callerId !== command.callerId ||
          entry.attemptId !== command.attemptId
        ) {
          error('IDEMPOTENCY_CONFLICT');
        }

        if (entry.final) {
          return success(this.replay(entry, now, session));
        }

        if (this.fences.has(command.attemptId)) {
          const terminal = this.mutation(reconciled, now);

          entry.final = terminal;

          return success(terminal);
        }

        const decision = settleCheckout(session, command, now);

        this.apply(decision, now);
        let result: CheckoutMutation = this.mutation(decision, now);

        if (decision.order) {
          if (decision.session.status !== 'COMPLETED') {
            throw new Error('Order requires completed session');
          }

          this.digests.set(decision.order.id, command.capabilityDigest);
          result = {
            ...result,
            session: decision.session,
            kind: 'COMPLETED',
            completion: { orderId: decision.order.id },
          };
        }

        if (decision.session.status !== 'PROCESSING') {
          entry.final = result;
        }

        return success(result);
      }

      if (command.kind === 'RECOVER') {
        if (session.status !== 'EXPIRED') {
          error('TERMINAL_SESSION');
        }

        if (session.successorSessionId) {
          const successor = this.sessions.get(session.successorSessionId)!;

          return success({
            kind: 'UPDATED',
            session: structuredClone(successor),
            serverNow: now,
            events: [],
          });
        }

        const decision = recoverCheckout(
          session,
          {
            id: command.successorId,
            reservationId: command.reservationId,
            listing: this.listing,
            allocation: session.allocation,
          },
          now,
          policy,
        );

        this.apply(decision, now);
        this.sessions.set(session.id, {
          ...session,
          successorSessionId: decision.session.id,
          version: version(session.version + 1),
        });

        return success(this.mutation(decision, now));
      }

      if (command.kind === 'EXPIRE_IF_DUE') {
        return success(this.mutation(reconciled, now));
      }

      const decision =
        command.kind === 'REFRESH_QUOTE'
          ? refreshCheckoutQuote(
              session,
              quoteSelection(
                this.listing,
                allocationQuantity(session.allocation),
              ),
              command.expectedVersion,
              now,
            )
          : command.kind === 'ACCEPT_QUOTE'
            ? acceptCheckoutQuote(session, command, {
                now,
                currentQuote: quoteSelection(
                  this.listing,
                  allocationQuantity(session.allocation),
                ),
              })
            : changeCheckoutDeadline(
                session,
                {
                  ...command,
                  authorized: command.authorization === 'test-authorized',
                },
                now,
                policy,
              );

      this.apply(decision, now);

      return success(this.mutation(decision, now));
    } catch (error) {
      if (error instanceof DomainError) {
        return { ok: false, error };
      }

      throw error;
    }
  }
  async getConfirmation(
    orderId: string,
    capability: CompletionCapability,
  ): Promise<Result<Order>> {
    const order = this.orders.get(orderId);
    const digest = createHash('sha256').update(capability).digest('hex');
    const stored = this.digests.get(orderId);

    return order &&
      stored &&
      timingSafeEqual(Buffer.from(digest), Buffer.from(stored))
      ? success(structuredClone(order))
      : {
          ok: false,
          error: new DomainError(
            'INVALID_COMPLETION_CAPABILITY',
            'Confirmation capability required',
          ),
        };
  }
  async getAvailability(listingId: string) {
    const now = this.clock.now();

    // Test inventory reads model the FUTURE joint reconciliation requirement.
    for (const session of this.sessions.values()) {
      const decision = reconcileCheckout(session, now);

      if (decision.effects.length) {
        this.apply(decision, now);
      }
    }

    if (listingId !== this.listing.id) {
      error('NOT_FOUND');
    }

    const live = [...this.holds.values()].filter((hold) =>
      this.live(hold, now),
    );
    const held = live
      .filter((hold) => hold.status === 'HELD')
      .reduce((sum, hold) => sum + allocationQuantity(hold.allocation), 0);
    const sold = live
      .filter((hold) => hold.status === 'SOLD')
      .reduce((sum, hold) => sum + allocationQuantity(hold.allocation), 0);
    const capacity = allocationQuantity(this.listing.allocation);
    const available: SeatAllocation[] = [];

    if (this.listing.allocation.kind === 'GENERAL_ADMISSION') {
      if (capacity > held + sold) {
        available.push({
          ...this.listing.allocation,
          quantity: capacity - held - sold,
        });
      }
    } else {
      const blocked = new Set(live.flatMap((hold) => units(hold.allocation)));
      let run: number[] = [];

      for (const seat of this.listing.allocation.seats) {
        const key = units({ ...this.listing.allocation, seats: [seat] })[0]!;

        if (blocked.has(key)) {
          run = [];
          continue;
        }

        if (!run.length) {
          run = [seat];
          available.push({
            ...this.listing.allocation,
            seats: run as [number, ...number[]],
          });
        } else {
          run.push(seat);
        }
      }
    }

    return {
      available,
      serverNow: now,
      version: version(1),
      counts: {
        total: capacity,
        held,
        sold,
        available: capacity - held - sold,
      },
    };
  }
}
