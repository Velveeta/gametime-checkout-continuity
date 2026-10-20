import type { DemoConfiguration, DemoPayment } from '../../application/demo';
import { z } from 'zod';
import type {
  CheckoutCommand,
  CheckoutMutation,
} from '../../application/ports';
import type {
  CheckoutSession,
  Order,
  Listing,
  SeatAllocation,
} from '../../domain/models';
import { instant } from '../../domain/values';

export const identifierSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const allocationSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('ASSIGNED'),
        section: z.string().trim().min(1).max(120),
        row: z.string().trim().min(1).max(40),
        seats: z.array(z.number().int().min(1).max(10000)).min(1).max(100),
      })
      .strict(),
    z
      .object({
        kind: z.literal('GENERAL_ADMISSION'),
        section: z.string().trim().min(1).max(120),
        quantity: z.number().int().min(1).max(1000),
      })
      .strict(),
  ])
  .transform((value) => value as SeatAllocation);
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.string().refine((v) => {
  try {
    instant(v);

    return true;
  } catch {
    return false;
  }
});
const quote = z
  .object({
    ticketSubtotal: money,
    fees: money,
    total: money,
    currency: z.literal('USD'),
    version: positive,
  })
  .strict();
const base = z.object({
  id: identifierSchema,
  eventId: identifierSchema,
  listingId: identifierSchema,
  reservationId: identifierSchema,
  allocation: allocationSchema,
  quote,
  acceptedTotal: money,
  version: positive,
  acknowledgedQuoteVersion: positive.optional(),
  createdAt: timestamp,
  reservationExpiresAt: timestamp,
  recoveryRetainUntil: timestamp,
});
const idleCount = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const attemptCount = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const sessionSchema = z.discriminatedUnion('status', [
  base
    .extend({ status: z.literal('ACTIVE'), paymentAttemptCount: idleCount })
    .strict(),
  base
    .extend({
      status: z.literal('PRICE_REVIEW'),
      paymentAttemptCount: idleCount,
    })
    .strict(),
  base
    .extend({
      status: z.literal('PROCESSING'),
      paymentAttemptCount: attemptCount,
      attemptId: identifierSchema,
      processingDeadlineAt: timestamp,
    })
    .strict(),
  base
    .extend({
      status: z.literal('PAYMENT_RETRYABLE'),
      paymentAttemptCount: z.union([z.literal(1), z.literal(2)]),
      failureCode: z.literal('TRANSIENT'),
    })
    .strict(),
  base
    .extend({
      status: z.literal('PAYMENT_FAILED'),
      paymentAttemptCount: attemptCount,
      failureCode: z.enum([
        'DECLINED',
        'ATTEMPTS_EXHAUSTED',
        'PROCESSING_TIMEOUT',
      ]),
    })
    .strict(),
  base
    .extend({
      status: z.literal('COMPLETED'),
      paymentAttemptCount: attemptCount,
      orderId: identifierSchema,
    })
    .strict(),
  base
    .extend({
      status: z.literal('EXPIRED'),
      paymentAttemptCount: z.union([idleCount, z.literal(3)]),
      successorSessionId: identifierSchema.optional(),
    })
    .strict(),
]);
export const demoConfigurationSchema = z
  .object({
    nextPayment: z.enum([
      'DEFAULT',
      'SUCCESS',
      'TRANSIENT_FAILURE',
      'DECLINED',
    ]),
    price: z
      .object({ unitPrice: money, feePerTicket: money, version: positive })
      .strict()
      .optional(),
  })
  .strict()
  .transform(({ nextPayment, price }) => ({
    nextPayment,
    ...(price ? { price } : {}),
  }));

export interface StoredHold {
  id: string;
  sessionId: string;
  listingId: string;
  listingVersion: number;
  selection: { kind: 'EXACT'; allocation: SeatAllocation };
  allocation: SeatAllocation;
  status: 'HELD' | 'EXPIRED' | 'RELEASED' | 'SOLD';
  createdAtMs: number;
  expiresAtMs: number;
  processingDeadlineMs?: number;
  attemptId?: string;
  orderId?: string;
}
export interface InventoryDocument {
  schemaVersion: 2;
  eventId: string;
  version: number;
  listings: Record<string, Listing>;
  reservations: Record<string, StoredHold>;
  soldQuantity: number;
  soldSeats: number[];
}
export interface AttemptRecord {
  sessionId: string;
  callerId: string;
  key: string;
  status:
    'PROCESSING' | 'FENCED' | 'SUCCEEDED' | 'TRANSIENT_FAILURE' | 'DECLINED';
  ordinal: number;
  simulation?: Exclude<DemoPayment, 'DEFAULT'>;
}
export interface LedgerEntry {
  callerId: string;
  fingerprint: string;
  attemptId: string;
  final?: CheckoutMutation;
}
/** An ephemeral transaction working set, never a persisted namespace aggregate. */
export interface CheckoutWorkingSet {
  sessions: Record<string, CheckoutSession>;
  demo: Record<string, DemoConfiguration>;
  orders: Record<string, Order>;
  orderBySession: Record<string, string>;
  digests: Record<string, string>;
  attempts: Record<string, AttemptRecord>;
  ledger: Record<string, LedgerEntry>;
}

export function emptyWorkingSet(): CheckoutWorkingSet {
  return {
    sessions: {},
    demo: {},
    orders: {},
    orderBySession: {},
    digests: {},
    attempts: {},
    ledger: {},
  };
}

export const REPLAY_RETENTION_MS = 24 * 60 * 60_000;
/** At most three attempts/ledger entries; TTL never authorizes releasing stock. */
export interface SessionDocument {
  schemaVersion: 2;
  session: CheckoutSession;
  demo?: DemoConfiguration;
  attempts: Record<string, AttemptRecord>;
  ledger: Record<string, LedgerEntry>;
}
/** Permanent per-purchase fence and original authorized completion response. */
export interface CompletionReceipt {
  schemaVersion: 2;
  sessionId: string;
  listingId: string;
  orderId: string;
  ledgerKey: string;
  entry: LedgerEntry;
}
export interface OrderDocument {
  schemaVersion: 2;
  order: Order;
  digest: string;
}
const dateKeys = new Set([
  'createdAt',
  'reservationExpiresAt',
  'recoveryRetainUntil',
  'processingDeadlineAt',
  'serverNow',
]);

/** Internal wire uses milliseconds, allowing commit-time deadlines inside Lua. */
export function wire(value: unknown, decode = false, key = ''): unknown {
  if (dateKeys.has(key)) {
    if (decode && typeof value === 'number') {
      return instant(new Date(value).toISOString());
    }

    if (!decode && typeof value === 'string') {
      return Date.parse(instant(value));
    }
  }

  if (Array.isArray(value)) {
    return value.map((v) => wire(v, decode));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, wire(v, decode, k)]),
    );
  }

  return value;
}

export function session(value: unknown): CheckoutSession {
  return sessionSchema.parse(value) as CheckoutSession;
}

export function get<T>(record: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(record, id) ? record[id] : undefined;
}

export function ledgerKey(sessionId: string, key: string) {
  return JSON.stringify([sessionId, key]);
}

export function fingerprint(
  command: Extract<CheckoutCommand, { kind: 'CLAIM_COMPLETION' }>,
) {
  return JSON.stringify([command.expectedVersion, command.quoteVersion]);
}
