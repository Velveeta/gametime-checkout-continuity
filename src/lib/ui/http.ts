import type { CheckoutSnapshot } from '@/application/checkout-service';
import type { ApiResponse } from '@/infrastructure/http/api';

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function request<T>(
  url: string,
  options: RequestInit = {},
  allowExpired = false,
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    cache: 'no-store',
    credentials: 'same-origin',
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const body = (await response.json()) as ApiResponse<T>;
  if (!body.ok) {
    if (allowExpired && response.status === 410 && body.data) return body.data;
    throw new RequestError(
      body.error.code,
      body.error.message,
      response.status,
    );
  }
  return body.data;
}
export interface LiveSnapshot extends CheckoutSnapshot {
  sample?: { serverMs: number; mono: number };
}
export async function readCheckout(
  id: string,
  signal?: AbortSignal,
): Promise<LiveSnapshot> {
  const start = performance.now();
  const snapshot = await request<CheckoutSnapshot>(
    `/api/checkouts/${id}`,
    signal ? { signal } : {},
    true,
  );
  const end = performance.now();
  return {
    ...snapshot,
    sample: {
      serverMs: Date.parse(snapshot.serverNow) + (end - start) / 2,
      mono: end,
    },
  };
}
export type PaymentResponse =
  | { kind: 'COMPLETED'; orderId: string; confirmationUrl: string }
  | { kind: 'IN_PROGRESS' | 'UPDATED'; snapshot: CheckoutSnapshot };
export interface SavedAttempt {
  key: string;
  expectedVersion: number;
  quoteVersion: number;
}
const storageKey = (id: string) => `gametime:payment:${id}`;
export function savedAttempt(id: string): SavedAttempt | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(storageKey(id)) ?? 'null',
    ) as SavedAttempt | null;
    return value &&
      typeof value.key === 'string' &&
      /^[A-Za-z0-9-]{1,128}$/.test(value.key) &&
      Number.isSafeInteger(value.expectedVersion) &&
      value.expectedVersion > 0 &&
      Number.isSafeInteger(value.quoteVersion) &&
      value.quoteVersion > 0
      ? value
      : null;
  } catch {
    return null;
  }
}
export function rememberAttempt(id: string, value: SavedAttempt | null) {
  try {
    if (value) sessionStorage.setItem(storageKey(id), JSON.stringify(value));
    else sessionStorage.removeItem(storageKey(id));
  } catch {
    /* In-memory binding still protects this mounted page when storage is unavailable. */
  }
}
