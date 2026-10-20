import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  CatalogRepository,
  CheckoutCommand,
  CheckoutMutation,
  CheckoutRepository,
  OrderRepository,
} from '../../application/ports';
import type { ListingAvailability } from '../../application/inventory-contracts';
import {
  acceptCheckoutQuote,
  claimCheckout,
  createCheckout,
  reconcileCheckout,
  recoverCheckout,
  refreshCheckoutQuote,
  settleCheckout,
  validateCheckoutPolicy,
  type CheckoutDecision,
  type CheckoutEventName,
  type CheckoutPolicy,
} from '../../domain/checkout';
import {
  DomainError,
  type DomainErrorCode,
  type Result,
} from '../../domain/errors';
import {
  allocationQuantity,
  quoteSelection,
  validateAllocation,
  validateSelection,
} from '../../domain/inventory';
import type {
  CheckoutSession,
  CompletionCapability,
  Order,
  SeatAllocation,
} from '../../domain/models';
import { instant, version } from '../../domain/values';
import { validateCatalog } from '../catalog/catalog';
import type { RedisScriptExecutor } from './inventory';
import { COMMIT_LUA, SNAPSHOT_LUA, SEED_LUA } from './transactions';
import {
  emptyWorkingSet,
  fingerprint,
  get,
  identifierSchema,
  ledgerKey,
  session,
  wire,
  REPLAY_RETENTION_MS,
  type CompletionReceipt,
  type OrderDocument,
  type SessionDocument,
  type CheckoutWorkingSet,
  type InventoryDocument,
} from './checkout-data';

interface Scope {
  sessionId?: string;
  listingId?: string;
  successorId?: string;
  orderId?: string;
}
interface Snapshot {
  keys: string[];
  raw: string[];
  nowMs: number;
  index: CheckoutWorkingSet;
  inventories: InventoryDocument[];
  documents: Map<
    string,
    SessionDocument | CompletionReceipt | OrderDocument | InventoryDocument
  >;
  baseline: Map<string, string>;
}
interface Relative {
  inventoryKeyIndex: number;
  sessionKeyIndex: number;
  mode: 'CREATE' | 'PROTECT';
  holdMs?: number;
  retentionMs?: number;
  processingMs?: number;
}
type TransactionValue = CheckoutMutation | ListingAvailability;
interface Plan {
  relative: Relative[];
  newOrderId?: string;
  finalLedgerKey?: string;
  replayLedgerKey?: string;
  response: Result<TransactionValue>;
}
const pass = <T>(value: T): Result<T> => ({ ok: true, value });
function fail(code: DomainErrorCode): never {
  throw new DomainError(code, code);
}
function parse<T>(value: T | string): T {
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}
function allocationKey(a: SeatAllocation) {
  return JSON.stringify(
    a.kind === 'ASSIGNED'
      ? [a.kind, a.section, a.row, a.seats]
      : [a.kind, a.section, a.quantity],
  );
}
function seatKey(
  a: Extract<SeatAllocation, { kind: 'ASSIGNED' }>,
  seat: number,
) {
  return JSON.stringify([a.section, a.row, seat]);
}

/** All business decisions use the domain functions. Lua validates the ENTIRE read
 * set and temporal validity interval, then publishes with one MSET. No local locks.
 */
export class RedisCheckoutStore implements CheckoutRepository, OrderRepository {
  readonly prefix: string;
  constructor(
    private readonly redis: RedisScriptExecutor,
    private readonly seeds: CatalogRepository,
    namespace: string,
    private readonly retention = { replayMs: REPLAY_RETENTION_MS },
  ) {
    identifierSchema.parse(namespace);
    if (!Number.isSafeInteger(retention.replayMs) || retention.replayMs <= 0)
      throw new RangeError('Invalid replay retention');
    this.prefix = `checkout:{${namespace}}:`;
  }
  sessionKey(id: string) {
    return this.prefix + 'session:v2:' + identifierSchema.parse(id);
  }
  receiptKey(id: string) {
    return this.prefix + 'completed:v2:' + identifierSchema.parse(id);
  }
  orderKey(id: string) {
    return this.prefix + 'order:v2:' + identifierSchema.parse(id);
  }
  inventoryKey(id: string) {
    return this.prefix + 'inventory:v2:' + identifierSchema.parse(id);
  }

  /** Discover immutable routing references, then reread the entire scoped set in
   * ONE snapshot. CAS includes absent keys and every discovery dependency.
   * Only due hold owners join inventory reconciliation; unrelated live sessions
   * and listings are neither read nor compared by a purchase transaction.
   */
  private async snapshot(scope: Scope): Promise<Snapshot> {
    const needed = new Set<string>();
    const addSession = (id: string) => {
      needed.add(this.sessionKey(id));
      needed.add(this.receiptKey(id));
    };
    if (scope.sessionId) addSession(scope.sessionId);
    if (scope.successorId) addSession(scope.successorId);
    if (scope.listingId) needed.add(this.inventoryKey(scope.listingId));
    if (scope.orderId) needed.add(this.orderKey(scope.orderId));
    for (let pass = 0; pass < 64; pass++) {
      const keys = [...needed].sort();
      const value = parse(
        await this.redis.eval<{ raw: string[]; nowMs: number } | string>(
          SNAPSHOT_LUA,
          keys,
          [],
        ),
      );
      const index = emptyWorkingSet();
      const documents: Snapshot['documents'] = new Map();
      const inventories: InventoryDocument[] = [];
      for (const [i, key] of keys.entries()) {
        if (!value.raw[i]) continue;
        const document = wire(JSON.parse(value.raw[i]!), true) as
          | SessionDocument
          | CompletionReceipt
          | OrderDocument
          | InventoryDocument;
        if (document.schemaVersion !== 2)
          throw new Error('Unsupported persistence schema');
        documents.set(key, document);
        if ('session' in document) {
          const checkout = session(document.session);
          validateAllocation(checkout.allocation);
          if (
            key !== this.sessionKey(checkout.id) ||
            Object.keys(document.attempts).length > 3 ||
            Object.keys(document.ledger).length > 3
          )
            throw new Error('Invalid checkout document');
          index.sessions[checkout.id] = checkout;
          Object.assign(index.attempts, document.attempts);
          Object.assign(index.ledger, document.ledger);
          needed.add(this.inventoryKey(checkout.listingId));
          if (
            checkout.id === scope.sessionId &&
            checkout.status === 'EXPIRED' &&
            checkout.successorSessionId
          )
            addSession(checkout.successorSessionId);
        } else if ('entry' in document) {
          const completed = session(document.entry.final?.session);
          if (
            key !== this.receiptKey(document.sessionId) ||
            completed.status !== 'COMPLETED' ||
            completed.id !== document.sessionId ||
            completed.orderId !== document.orderId ||
            completed.listingId !== document.listingId
          )
            throw new Error('Invalid completion receipt');
          index.orderBySession[document.sessionId] = document.orderId;
          index.ledger[document.ledgerKey] = document.entry;
          needed.add(this.inventoryKey(document.listingId));
        } else if ('order' in document) {
          if (key !== this.orderKey(document.order.id))
            throw new Error('Invalid order document');
          index.orders[document.order.id] = document.order;
          index.digests[document.order.id] = document.digest;
        } else {
          // Redis cjson emits an empty Lua table as {}, even for JSON arrays.
          if (
            !Array.isArray(document.soldSeats) &&
            document.soldSeats &&
            Object.keys(document.soldSeats).length === 0
          )
            document.soldSeats = [];
          const listing = Object.values(document.listings)[0];
          if (
            !listing ||
            Object.keys(document.listings).length !== 1 ||
            key !== this.inventoryKey(listing.id) ||
            document.eventId !== listing.eventId ||
            !document.reservations ||
            !Number.isSafeInteger(document.soldQuantity) ||
            document.soldQuantity < 0 ||
            !Array.isArray(document.soldSeats)
          )
            throw new Error('Invalid inventory document');
          validateAllocation(listing.allocation);
          inventories.push(document);
          for (const hold of Object.values(document.reservations)) {
            if (
              hold.status === 'HELD' &&
              (hold.processingDeadlineMs ?? hold.expiresAtMs) <= value.nowMs
            )
              addSession(hold.sessionId);
          }
        }
      }
      if (needed.size !== keys.length) continue;
      // Receipt remains usable after temporary session metadata has been collected.
      for (const document of documents.values())
        if ('entry' in document && !get(index.sessions, document.sessionId)) {
          index.sessions[document.sessionId] = document.entry.final!.session;
        }
      return {
        ...value,
        keys,
        index,
        inventories,
        documents,
        baseline: new Map(
          [...documents].map(([key, doc]) => [key, canonical(wire(doc))]),
        ),
      };
    }
    throw new Error('Persistence routing changed repeatedly');
  }
  private find(s: Snapshot, listingId: string) {
    for (const inventory of s.inventories) {
      const listing = get(inventory.listings, listingId);
      if (listing) return { inventory, listing };
    }
    return fail('NOT_FOUND');
  }
  private now(s: Snapshot) {
    return instant(new Date(s.nowMs).toISOString());
  }
  private hold(s: Snapshot, checkout: CheckoutSession) {
    return get(
      this.find(s, checkout.listingId).inventory.reservations,
      checkout.reservationId,
    );
  }
  private apply(s: Snapshot, decision: CheckoutDecision) {
    const checkout = decision.session;
    const { inventory, listing } = this.find(s, checkout.listingId);
    // Validate effects before mutating the candidate; it is committed only by CAS.
    for (const effect of decision.effects) {
      if (effect.kind === 'RESERVE') {
        validateSelection(listing, {
          kind: 'EXACT',
          allocation: effect.allocation,
        });
        if (get(inventory.reservations, effect.reservationId))
          fail('RESERVATION_CONFLICT');
        const availability = this.availability(s, listing.id);
        if (effect.allocation.kind === 'GENERAL_ADMISSION') {
          if (availability.counts.available < effect.allocation.quantity)
            fail('INVENTORY_UNAVAILABLE');
        } else {
          const selected = effect.allocation;
          if (
            !availability.available.some(
              (a) =>
                a.kind === 'ASSIGNED' &&
                a.section === selected.section &&
                a.row === selected.row &&
                selected.seats.every((n) => a.seats.includes(n)),
            )
          )
            fail('INVENTORY_UNAVAILABLE');
        }
      } else if (effect.kind !== 'FENCE_ATTEMPT') {
        const hold = get(inventory.reservations, effect.reservationId);
        if (
          (!hold && effect.kind !== 'RELEASE') ||
          (hold && hold.sessionId !== checkout.id)
        )
          fail('RESERVATION_CONFLICT');
        if (
          effect.kind === 'SELL' &&
          (!hold ||
            hold.status !== 'HELD' ||
            (hold.processingDeadlineMs ?? hold.expiresAtMs) <= s.nowMs)
        )
          fail('RESERVATION_EXPIRED');
      }
    }
    if (
      decision.order &&
      (get(s.index.orderBySession, checkout.id) ||
        get(s.index.orders, decision.order.id))
    )
      fail('TERMINAL_SESSION');
    for (const effect of decision.effects) {
      if (effect.kind === 'FENCE_ATTEMPT') {
        const attempt = get(s.index.attempts, effect.attemptId);
        if (attempt) attempt.status = 'FENCED';
        continue;
      }
      if (effect.kind === 'RESERVE') {
        inventory.reservations[effect.reservationId] = {
          id: effect.reservationId,
          sessionId: checkout.id,
          listingId: listing.id,
          listingVersion: listing.version,
          selection: { kind: 'EXACT', allocation: effect.allocation },
          allocation: effect.allocation,
          status: 'HELD',
          createdAtMs: s.nowMs,
          expiresAtMs: Date.parse(effect.until),
        };
      } else {
        const hold = inventory.reservations[effect.reservationId];
        if (!hold) continue;
        if (effect.kind === 'PROTECT') {
          hold.processingDeadlineMs = Date.parse(effect.until);
          hold.attemptId = effect.attemptId;
        }
        if (effect.kind === 'RESTORE_BUSINESS_HOLD') {
          delete hold.processingDeadlineMs;
          delete hold.attemptId;
          hold.expiresAtMs = Date.parse(effect.until);
        }
        if (effect.kind === 'RELEASE') hold.status = 'RELEASED';
        if (effect.kind === 'SELL') {
          hold.status = 'SOLD';
          hold.orderId = effect.orderId;
        }
      }
      inventory.version++;
    }
    s.index.sessions[checkout.id] = checkout;
    if (decision.order) {
      s.index.orders[decision.order.id] = decision.order;
      s.index.orderBySession[checkout.id] = decision.order.id;
    }
  }
  private reconcile(s: Snapshot) {
    const now = this.now(s);
    // Fence processing and release its inventory TOGETHER, before availability.
    for (const checkout of Object.values(s.index.sessions)) {
      const decision = reconcileCheckout(checkout, now);
      if (decision.session !== checkout) this.apply(s, decision);
    }
    for (const inventory of s.inventories)
      for (const hold of Object.values(inventory.reservations)) {
        if (
          hold.status === 'HELD' &&
          (hold.processingDeadlineMs ?? hold.expiresAtMs) <= s.nowMs
        ) {
          hold.status = 'EXPIRED';
          inventory.version++;
          const attempt =
            hold.attemptId && get(s.index.attempts, hold.attemptId);
          if (attempt) attempt.status = 'FENCED';
        }
      }
  }
  private projectQuote(s: Snapshot, checkout: CheckoutSession) {
    const effective = reconcileCheckout(checkout, this.now(s)).session;
    if (
      !['ACTIVE', 'PRICE_REVIEW', 'PAYMENT_RETRYABLE'].includes(
        effective.status,
      )
    )
      return {
        session: effective,
        effects: [],
        events: [],
      } as CheckoutDecision;
    const listing = this.find(s, effective.listingId).listing;
    return refreshCheckoutQuote(
      effective,
      quoteSelection(listing, allocationQuantity(effective.allocation)),
      effective.version,
      this.now(s),
    );
  }
  private boundary(s: Snapshot): number | undefined {
    const values: number[] = [];
    for (const checkout of Object.values(s.index.sessions)) {
      values.push(Date.parse(checkout.recoveryRetainUntil));
      if (checkout.status === 'PROCESSING')
        values.push(Date.parse(checkout.processingDeadlineAt));
      else if (
        ['ACTIVE', 'PRICE_REVIEW', 'PAYMENT_RETRYABLE'].includes(
          checkout.status,
        )
      )
        values.push(Date.parse(checkout.reservationExpiresAt));
    }
    for (const inventory of s.inventories)
      for (const hold of Object.values(inventory.reservations)) {
        if (hold.status === 'HELD')
          values.push(hold.processingDeadlineMs ?? hold.expiresAtMs);
      }
    const future = values.filter((n) => n > s.nowMs);
    return future.length ? Math.min(...future) : undefined;
  }
  private async transaction(
    scope: Scope,
    make: (s: Snapshot) => Plan,
  ): Promise<Result<TransactionValue>> {
    for (let retry = 0; retry < 64; retry++) {
      const s = await this.snapshot(scope);
      const validBefore = this.boundary(s);
      this.reconcile(s);
      const plan = make(s);
      const values = new Map<string, unknown>();
      for (const inventory of s.inventories) {
        // Only live holds remain in inventory. Sales become a bounded occupancy
        // summary; their order and permanent completion fence live separately.
        for (const [id, hold] of Object.entries(inventory.reservations)) {
          if (hold.status === 'SOLD') {
            inventory.soldQuantity += allocationQuantity(hold.allocation);
            if (hold.allocation.kind === 'ASSIGNED')
              inventory.soldSeats.push(...hold.allocation.seats);
          }
          if (hold.status !== 'HELD') delete inventory.reservations[id];
        }
        values.set(
          this.inventoryKey(Object.values(inventory.listings)[0]!.id),
          inventory,
        );
      }
      for (const checkout of Object.values(s.index.sessions)) {
        // Never recreate temporary metadata from a permanent receipt.
        if (
          s.documents.has(this.receiptKey(checkout.id)) &&
          !s.documents.has(this.sessionKey(checkout.id))
        )
          continue;
        const attempts = Object.fromEntries(
          Object.entries(s.index.attempts).filter(
            ([, a]) => a.sessionId === checkout.id,
          ),
        );
        const ledger = Object.fromEntries(
          Object.entries(s.index.ledger).filter(
            ([key]) => JSON.parse(key)[0] === checkout.id,
          ),
        );
        if (Object.keys(attempts).length > 3 || Object.keys(ledger).length > 3)
          throw new Error('Payment history exceeds attempt bound');
        values.set(this.sessionKey(checkout.id), {
          schemaVersion: 2,
          session: checkout,
          attempts,
          ledger,
        } satisfies SessionDocument);
      }
      if (plan.newOrderId) {
        const order = s.index.orders[plan.newOrderId]!;
        values.set(this.orderKey(order.id), {
          schemaVersion: 2,
          order,
          digest: s.index.digests[order.id]!,
        } satisfies OrderDocument);
        const entry = s.index.ledger[plan.finalLedgerKey!]!;
        values.set(this.receiptKey(order.checkoutSessionId), {
          schemaVersion: 2,
          sessionId: order.checkoutSessionId,
          listingId: order.listingId,
          orderId: order.id,
          ledgerKey: plan.finalLedgerKey!,
          entry,
        } satisfies CompletionReceipt);
      }
      const response = plan.response.ok
        ? plan.response
        : {
            ok: false,
            code: plan.response.error.code,
            message: plan.response.error.message,
          };
      const proposal = {
        expected: s.raw,
        observedAt: s.nowMs,
        validBefore,
        values: s.keys.map((key) => values.get(key) ?? null),
        changed: s.keys.map(
          (key) =>
            values.has(key) &&
            canonical(wire(values.get(key))) !== s.baseline.get(key),
        ),
        relative: plan.relative,
        orderKeyIndex: plan.newOrderId
          ? s.keys.indexOf(this.orderKey(plan.newOrderId)) + 1
          : undefined,
        responseSessionIndex:
          plan.response.ok && 'session' in plan.response.value
            ? s.keys.indexOf(this.sessionKey(plan.response.value.session.id)) +
              1
            : undefined,
        replay: !!plan.replayLedgerKey,
        finalLedgerKey: plan.finalLedgerKey,
        receiptKeyIndex: plan.newOrderId
          ? s.keys.indexOf(
              this.receiptKey(
                s.index.orders[plan.newOrderId]!.checkoutSessionId,
              ),
            ) + 1
          : undefined,
        replayMs: this.retention.replayMs,
        response,
      };
      const result = parse(
        await this.redis.eval<
          { committed: boolean; response?: unknown } | string
        >(COMMIT_LUA, s.keys, [JSON.stringify(wire(proposal))]),
      );
      if (!result.committed) continue;
      const decoded = wire(result.response, true) as
        | { ok: true; value: TransactionValue }
        | { ok: false; code: DomainErrorCode; message?: string };
      if (!decoded.ok)
        return {
          ok: false,
          error: new DomainError(decoded.code, decoded.message ?? decoded.code),
        };
      const value = decoded.value;
      if ('session' in value) {
        if (!Array.isArray(value.events)) Object.assign(value, { events: [] });
        session(value.session);
      } else {
        if (!Array.isArray(value.available))
          Object.assign(value, { available: [] });
        if (!Array.isArray(value.ownReservations))
          Object.assign(value, { ownReservations: [] });
      }
      return pass(value);
    }
    return {
      ok: false,
      error: new DomainError(
        'VERSION_CONFLICT',
        'Inventory is busy; retry with the same request key',
      ),
    };
  }
  async initialize() {
    const events = await this.seeds.listEvents();
    const listings = (
      await Promise.all(
        events.map((event) => this.seeds.listListings(event.id)),
      )
    ).flat();
    validateCatalog(events, listings);
    const legacy = [
      this.prefix + 'checkouts:v1',
      ...events.map((event) => this.prefix + 'inventory:' + event.id),
    ];
    const documents = listings.map((listing): InventoryDocument => ({
      schemaVersion: 2,
      eventId: listing.eventId,
      version: 1,
      listings: { [listing.id]: listing },
      reservations: {},
      soldQuantity: 0,
      soldSeats: [],
    }));
    // Fail closed on v1 data; never silently seed a second sellable inventory.
    const result = parse(
      await this.redis.eval<{ seeded: boolean; error?: string } | string>(
        SEED_LUA,
        [
          ...legacy,
          ...listings.map((listing) => this.inventoryKey(listing.id)),
        ],
        [JSON.stringify({ legacyCount: legacy.length, values: documents })],
      ),
    );
    if (!result.seeded)
      throw new Error(result.error ?? 'Catalog initialization failed');
  }
  async read(id: string) {
    identifierSchema.parse(id);
    const s = await this.snapshot({ sessionId: id });
    const stored = get(s.index.sessions, id);
    if (!stored || Date.parse(stored.recoveryRetainUntil) <= s.nowMs)
      return null;
    return {
      session: this.projectQuote(s, stored).session,
      serverNow: this.now(s),
    };
  }
  async execute(
    command: CheckoutCommand,
    policy: CheckoutPolicy,
  ): Promise<Result<CheckoutMutation>> {
    validateCheckoutPolicy(policy);
    // Deadline edits have no production authorization implementation before Wave 05.
    if (command.kind === 'CHANGE_DEADLINE')
      return {
        ok: false,
        error: new DomainError('UNAUTHORIZED', 'Demo controls are not enabled'),
      };
    const scope: Scope =
      command.kind === 'RESERVE'
        ? { sessionId: command.sessionId, listingId: command.listingId }
        : command.kind === 'RECOVER'
          ? {
              sessionId: command.expiredSessionId,
              successorId: command.successorId,
            }
          : {
              sessionId: command.sessionId,
              ...(command.kind === 'SETTLE_PAYMENT'
                ? { orderId: command.orderId }
                : {}),
            };
    const result = await this.transaction(scope, (s) =>
      this.plan(s, command, policy),
    );
    if (!result.ok) return result;
    if (!('session' in result.value))
      throw new Error('Invalid checkout result');
    return pass(result.value);
  }
  private plan(
    s: Snapshot,
    command: Exclude<CheckoutCommand, { kind: 'CHANGE_DEADLINE' }>,
    policy: CheckoutPolicy,
  ): Plan {
    const plan: Plan = {
      relative: [],
      response: { ok: false, error: new DomainError('NOT_FOUND', 'NOT_FOUND') },
    };
    const now = this.now(s);
    let events: CheckoutEventName[] = [];
    const updated = (
      checkout: CheckoutSession,
      kind: 'UPDATED' | 'IN_PROGRESS' | 'REPLAY' = 'UPDATED',
    ): CheckoutMutation => ({
      kind,
      session: checkout,
      serverNow: now,
      events,
    });
    const relative = (
      checkout: CheckoutSession,
      mode: 'CREATE' | 'PROTECT',
    ) => {
      const i = s.keys.indexOf(this.inventoryKey(checkout.listingId));
      plan.relative.push({
        inventoryKeyIndex: i + 1,
        sessionKeyIndex: s.keys.indexOf(this.sessionKey(checkout.id)) + 1,
        mode,
        holdMs: policy.holdMs,
        retentionMs: policy.retentionAfterExpiryMs,
        processingMs: policy.processingMs,
      });
    };
    try {
      if (command.kind === 'RESERVE') {
        const existing = get(s.index.sessions, command.sessionId);
        if (get(s.index.orderBySession, command.sessionId))
          fail('TERMINAL_SESSION');
        if (existing) {
          if (
            existing.reservationId !== command.reservationId ||
            existing.listingId !== command.listingId ||
            allocationKey(existing.allocation) !==
              allocationKey(command.allocation)
          )
            fail('RESERVATION_CONFLICT');
          plan.response = pass(updated(existing));
          return plan;
        }
        const listing = this.find(s, command.listingId).listing;
        if (listing.version !== command.expectedListingVersion)
          fail('VERSION_CONFLICT');
        const decision = createCheckout(
          {
            id: command.sessionId,
            reservationId: command.reservationId,
            listing,
            allocation: command.allocation,
          },
          now,
          policy,
        );
        this.apply(s, decision);
        events = [...decision.events];
        relative(decision.session, 'CREATE');
        plan.response = pass(updated(decision.session));
        return plan;
      }
      const id =
        command.kind === 'RECOVER'
          ? command.expiredSessionId
          : command.sessionId;
      // Final operation replay outlives the checkout's recovery/read horizon.
      if (
        command.kind === 'CLAIM_COMPLETION' ||
        command.kind === 'SETTLE_PAYMENT'
      ) {
        const key = ledgerKey(id, command.idempotencyKey);
        const cached = get(s.index.ledger, key);
        if (cached?.final) {
          if (
            cached.callerId !== command.callerId ||
            (command.kind === 'CLAIM_COMPLETION'
              ? cached.fingerprint !== fingerprint(command)
              : cached.attemptId !== command.attemptId)
          )
            fail('IDEMPOTENCY_CONFLICT');
          plan.replayLedgerKey = key;
          plan.response = pass(cached.final);
          return plan;
        }
      }
      let current = get(s.index.sessions, id);
      if (
        command.kind === 'CLAIM_COMPLETION' &&
        current?.status === 'COMPLETED' &&
        get(s.index.orderBySession, id)
      )
        fail('TERMINAL_SESSION');
      if (!current || Date.parse(current.recoveryRetainUntil) <= s.nowMs)
        fail('NOT_FOUND');
      const quoted =
        command.kind === 'REFRESH_QUOTE' &&
        command.expectedVersion === current.version
          ? ({ session: current, effects: [], events: [] } as CheckoutDecision)
          : this.projectQuote(s, current);
      if (quoted.session !== current) {
        this.apply(s, quoted);
        current = quoted.session;
        events = [...quoted.events];
      }
      if (command.kind === 'CLAIM_COMPLETION') {
        const key = ledgerKey(id, command.idempotencyKey);
        const entry = get(s.index.ledger, key);
        if (entry) {
          if (
            entry.callerId !== command.callerId ||
            entry.fingerprint !== fingerprint(command)
          )
            fail('IDEMPOTENCY_CONFLICT');
          if (entry.final) {
            plan.replayLedgerKey = key;
            plan.response = pass(entry.final);
            return plan;
          }
          plan.response = pass(updated(current, 'IN_PROGRESS'));
          return plan;
        }
        if (current.status === 'PROCESSING') {
          plan.response = pass(updated(current, 'IN_PROGRESS'));
          return plan;
        }
        const hold = this.hold(s, current);
        const decision = claimCheckout(
          current,
          command,
          {
            now,
            currentQuote: quoteSelection(
              this.find(s, current.listingId).listing,
              allocationQuantity(current.allocation),
            ),
            ownsReservation:
              !!hold &&
              hold.status === 'HELD' &&
              hold.sessionId === id &&
              hold.listingId === current.listingId &&
              allocationKey(hold.allocation) ===
                allocationKey(current.allocation) &&
              hold.expiresAtMs === Date.parse(current.reservationExpiresAt) &&
              (hold.processingDeadlineMs ?? hold.expiresAtMs) > s.nowMs,
            orderExists: !!get(s.index.orderBySession, id),
          },
          policy,
        );
        this.apply(s, decision);
        events.push(...decision.events);
        relative(decision.session, 'PROTECT');
        s.index.ledger[key] = {
          callerId: command.callerId,
          fingerprint: fingerprint(command),
          attemptId: command.attemptId,
        };
        s.index.attempts[command.attemptId] = {
          sessionId: id,
          callerId: command.callerId,
          key,
          status: 'PROCESSING',
          ordinal: decision.session.paymentAttemptCount,
        };
        if (decision.session.status !== 'PROCESSING')
          throw new Error('Invalid claim decision');
        plan.response = pass({
          ...updated(decision.session),
          kind: 'CLAIMED',
          session: decision.session,
        });
        return plan;
      }
      if (command.kind === 'SETTLE_PAYMENT') {
        const key = ledgerKey(id, command.idempotencyKey);
        const entry = get(s.index.ledger, key);
        if (
          !entry ||
          entry.callerId !== command.callerId ||
          entry.attemptId !== command.attemptId
        )
          fail('IDEMPOTENCY_CONFLICT');
        if (entry.final) {
          plan.replayLedgerKey = key;
          plan.response = pass(entry.final);
          return plan;
        }
        const attempt = get(s.index.attempts, command.attemptId);
        if (!attempt) fail('VERSION_CONFLICT');
        let mutation: CheckoutMutation;
        if (attempt.status === 'FENCED') mutation = updated(current);
        else {
          const owned = this.hold(s, current);
          if (
            !owned ||
            owned.status !== 'HELD' ||
            owned.sessionId !== id ||
            owned.attemptId !== command.attemptId
          )
            fail('RESERVATION_CONFLICT');
          const decision = settleCheckout(current, command, now);
          this.apply(s, decision);
          events.push(...decision.events);
          mutation = updated(decision.session);
          if (decision.order) {
            if (decision.session.status !== 'COMPLETED')
              throw new Error('Order must complete checkout');
            s.index.digests[decision.order.id] = command.capabilityDigest;
            mutation = {
              ...mutation,
              kind: 'COMPLETED',
              session: decision.session,
              completion: { orderId: decision.order.id },
            };
            plan.newOrderId = decision.order.id;
            attempt.status = 'SUCCEEDED';
          } else if (
            command.outcome.kind !== 'UNKNOWN' &&
            s.index.attempts[command.attemptId]?.status !== 'FENCED'
          )
            attempt.status = command.outcome.kind;
        }
        if (mutation.session.status !== 'PROCESSING') {
          entry.final = mutation;
          plan.finalLedgerKey = key;
        }
        plan.response = pass(mutation);
        return plan;
      }
      if (command.kind === 'RECOVER') {
        if (current.status !== 'EXPIRED') fail('TERMINAL_SESSION');
        if (current.successorSessionId) {
          const successor = get(s.index.sessions, current.successorSessionId);
          if (!successor) fail('NOT_FOUND');
          plan.response = pass(updated(successor));
          return plan;
        }
        if (get(s.index.sessions, command.successorId))
          fail('RESERVATION_CONFLICT');
        const decision = recoverCheckout(
          current,
          {
            id: command.successorId,
            reservationId: command.reservationId,
            listing: this.find(s, current.listingId).listing,
            allocation: current.allocation,
          },
          now,
          policy,
        );
        this.apply(s, decision);
        relative(decision.session, 'CREATE');
        events.push(...decision.events);
        s.index.sessions[id] = {
          ...current,
          successorSessionId: decision.session.id,
          version: version(current.version + 1),
        };
        plan.response = pass(updated(decision.session));
        return plan;
      }
      if (command.kind === 'EXPIRE_IF_DUE') {
        plan.response = pass(updated(current));
        return plan;
      }
      const quote = quoteSelection(
        this.find(s, current.listingId).listing,
        allocationQuantity(current.allocation),
      );
      const decision =
        command.kind === 'REFRESH_QUOTE'
          ? refreshCheckoutQuote(current, quote, command.expectedVersion, now)
          : acceptCheckoutQuote(current, command, { now, currentQuote: quote });
      this.apply(s, decision);
      events.push(...decision.events);
      plan.response = pass(updated(decision.session));
    } catch (error) {
      if (error instanceof DomainError) plan.response = { ok: false, error };
      else throw error;
    }
    return plan;
  }
  private availability(
    s: Snapshot,
    listingId: string,
    ownerSessionId?: string,
  ): ListingAvailability {
    const { inventory, listing } = this.find(s, listingId);
    const live = Object.values(inventory.reservations).filter(
      (r) =>
        r.listingId === listingId &&
        (r.status === 'SOLD' || r.status === 'HELD'),
    );
    const held = live
      .filter((r) => r.status === 'HELD')
      .reduce((n, r) => n + allocationQuantity(r.allocation), 0);
    const sold =
      inventory.soldQuantity +
      live
        .filter((r) => r.status === 'SOLD')
        .reduce((n, r) => n + allocationQuantity(r.allocation), 0);
    const total = allocationQuantity(listing.allocation);
    const available: SeatAllocation[] = [];
    if (listing.allocation.kind === 'GENERAL_ADMISSION') {
      if (total > held + sold)
        available.push({
          ...listing.allocation,
          quantity: total - held - sold,
        });
    } else {
      const pool = listing.allocation;
      const blocked = new Set([
        ...inventory.soldSeats.map((n) => seatKey(pool, n)),
        ...live.flatMap((r) =>
          r.allocation.kind === 'ASSIGNED'
            ? r.allocation.seats.map((n) =>
                seatKey(
                  r.allocation as Extract<SeatAllocation, { kind: 'ASSIGNED' }>,
                  n,
                ),
              )
            : [],
        ),
      ]);
      let run: number[] = [];
      for (const n of pool.seats) {
        if (blocked.has(seatKey(pool, n))) {
          run = [];
          continue;
        }
        if (!run.length) {
          run = [n];
          available.push({ ...pool, seats: run as [number, ...number[]] });
        } else run.push(n);
      }
    }
    if (held + sold > total) throw new Error('Inventory conservation violated');
    return {
      available,
      counts: { total, available: total - held - sold, held, sold },
      version: version(inventory.version),
      serverNow: this.now(s),
      ownReservations: ownerSessionId
        ? live
            .filter(
              (hold) =>
                hold.status === 'HELD' && hold.sessionId === ownerSessionId,
            )
            .map((hold) => ({
              id: hold.id,
              listingId: hold.listingId,
              sessionId: hold.sessionId,
              allocation: hold.allocation,
              status: 'HELD' as const,
              createdAt: instant(new Date(hold.createdAtMs).toISOString()),
              expiresAt: instant(new Date(hold.expiresAtMs).toISOString()),
            }))
        : [],
    };
  }
  async getAvailability(
    listingId: string,
    ownerSessionId?: string,
  ): Promise<ListingAvailability> {
    // Joint fencing/release is persisted through the same atomic commit protocol.
    const result = await this.transaction({ listingId }, (s) => ({
      relative: [],
      response: pass(this.availability(s, listingId, ownerSessionId)),
    }));
    if (!result.ok) throw result.error;
    if (!('counts' in result.value))
      throw new Error('Invalid availability result');
    return result.value;
  }
  async getConfirmation(
    orderId: string,
    capability: CompletionCapability,
  ): Promise<Result<Order>> {
    const s = await this.snapshot({ orderId });
    const order = get(s.index.orders, orderId);
    const stored = get(s.index.digests, orderId);
    const digest = createHash('sha256').update(capability).digest('hex');
    if (
      !order ||
      !stored ||
      stored.length !== digest.length ||
      !timingSafeEqual(Buffer.from(stored), Buffer.from(digest))
    )
      return {
        ok: false,
        error: new DomainError(
          'INVALID_COMPLETION_CAPABILITY',
          'Confirmation capability required',
        ),
      };
    return pass(order);
  }
  /** Current persisted listing data for catalog/API reads, never stale seed prices. */
  async getListing(id: string) {
    const s = await this.snapshot({ listingId: id });
    try {
      return this.find(s, id).listing;
    } catch (error) {
      if (error instanceof DomainError) return null;
      throw error;
    }
  }
  async listListings(eventId: string) {
    const definitions = await this.seeds.listListings(eventId);
    return (
      await Promise.all(
        definitions.map((listing) => this.getListing(listing.id)),
      )
    ).filter((listing) => listing !== null);
  }
}
