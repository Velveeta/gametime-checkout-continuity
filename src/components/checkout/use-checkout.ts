'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CheckoutSnapshot } from '@/application/checkout-service';
import { terminal } from '@/lib/ui/presentation';
import {
  request,
  readCheckout,
  RequestError,
  rememberAttempt,
  savedAttempt,
  type LiveSnapshot,
  type PaymentResponse,
  type SavedAttempt,
} from '@/lib/ui/http';

const definitiveRejections = new Set([
  'VERSION_CONFLICT',
  'QUOTE_ACCEPTANCE_REQUIRED',
  'RESERVATION_EXPIRED',
  'IDEMPOTENCY_CONFLICT',
  'TERMINAL_SESSION',
  'NOT_FOUND',
  'INVALID_INPUT',
]);

/** Coordinates transport and device-bound retries; all business decisions remain server-owned. */
export function useCheckout(initial: CheckoutSnapshot) {
  const id = initial.session.id;
  const router = useRouter();
  const cache = useQueryClient();
  const key = ['checkout', id];
  const pending = useRef<SavedAttempt | null>(null);
  const terminalChecked = useRef(false);
  const confirmedHere = useRef(false);
  const submitting = useRef(false);
  const query = useQuery<LiveSnapshot>({
    queryKey: key,
    queryFn: ({ signal }) => readCheckout(id, signal),
    initialData: initial,
    refetchOnMount: 'always',
    refetchInterval: (q) =>
      terminal(q.state.data?.session.status ?? '') ? false : 2000,
    refetchOnWindowFocus: (q) => !terminal(q.state.data?.session.status ?? ''),
    refetchOnReconnect: true,
  });
  const { session } = query.data;

  const clearAttempt = () => {
    pending.current = null;
    rememberAttempt(id, null);
  };

  const update = (snapshot: CheckoutSnapshot) =>
    cache.setQueryData<LiveSnapshot>(key, {
      ...snapshot,
      sample: {
        serverMs: Date.parse(snapshot.serverNow),
        mono: performance.now(),
      },
    });
  const payment = useMutation({
    mutationFn: (attempt: SavedAttempt) =>
      request<PaymentResponse>(`/api/checkouts/${id}/complete`, {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.key },
        body: JSON.stringify({
          expectedVersion: attempt.expectedVersion,
          quoteVersion: attempt.quoteVersion,
        }),
      }),
    onMutate: () => cache.cancelQueries({ queryKey: key }),
    onSuccess: (result) => {
      if (result.kind === 'COMPLETED') {
        confirmedHere.current = true;
        clearAttempt();
        router.replace(`/orders/${result.orderId}/confirmation`);

        return;
      }

      if (
        result.kind === 'UPDATED' &&
        result.snapshot.session.status !== 'PROCESSING'
      ) {
        clearAttempt();
      }

      update(result.snapshot);
      void cache.invalidateQueries({ queryKey: key });
    },
    onError: async (error) => {
      // A lost response may follow a successful commit. Retain the EXACT key/body
      // until a definitive non-claim response or the original receipt resolves it.
      if (
        error instanceof RequestError &&
        definitiveRejections.has(error.code)
      ) {
        clearAttempt();
      }

      await query.refetch();
    },
    onSettled: () => {
      submitting.current = false;
    },
  });
  const acknowledge = useMutation({
    mutationFn: () =>
      request<CheckoutSnapshot>(`/api/checkouts/${id}/acknowledge-price`, {
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: session.version,
          quoteVersion: session.quote.version,
        }),
      }),
    onMutate: () => cache.cancelQueries({ queryKey: key }),
    onSuccess: (snapshot) => {
      update(snapshot);
      void cache.invalidateQueries({ queryKey: key });
    },
    onError: () => void query.refetch(),
  });
  const mutate = payment.mutate;
  const isPaying = payment.isPending;

  useEffect(() => {
    if (confirmedHere.current) {
      return;
    }

    if (
      query.error instanceof RequestError &&
      query.error.code === 'NOT_FOUND'
    ) {
      router.replace('/');

      return;
    }

    if (session.status === 'EXPIRED') {
      router.replace(`/events/${session.eventId}`);

      return;
    }

    if (session.status !== 'COMPLETED') {
      return;
    }

    // Only this tab's stored request can obtain a completion capability. A losing
    // device may have a pending key too; the server rejects it and redirects home.
    const own = pending.current ?? savedAttempt(id);

    if (!own) {
      if (!isPaying) {
        router.replace('/');
      }

      return;
    }

    if (!isPaying && !terminalChecked.current) {
      terminalChecked.current = true;
      submitting.current = true;
      pending.current = own;
      mutate(own);
    }
  }, [
    id,
    session.status,
    session.eventId,
    query.error,
    isPaying,
    mutate,
    router,
  ]);
  const refetch = query.refetch;
  const confirmDeadline = useCallback(() => {
    void refetch();
  }, [refetch]);

  function pay() {
    if (submitting.current || payment.isPending) {
      return;
    }

    submitting.current = true;
    const attempt = pending.current ??
      savedAttempt(id) ?? {
        key: crypto.randomUUID(),
        expectedVersion: session.version,
        quoteVersion: session.quote.version,
      };

    pending.current = attempt;
    rememberAttempt(id, attempt);
    payment.mutate(attempt);
  }

  const unknownFailure =
    payment.error &&
    (!(payment.error instanceof RequestError) ||
      !definitiveRejections.has(payment.error.code));

  return {
    query,
    payment,
    acknowledge,
    session,
    pay,
    confirmDeadline,
    unknownFailure,
  };
}
