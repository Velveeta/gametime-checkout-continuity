'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Code2, EllipsisVertical, LoaderCircle } from 'lucide-react';
import type { CheckoutSnapshot } from '@/application/checkout-service';
import type { DemoMutation, DemoSnapshot } from '@/application/demo';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { request, RequestError } from '@/lib/ui/http';
import { terminal } from '@/lib/ui/presentation';

type Action = DemoMutation extends infer M
  ? M extends DemoMutation
    ? Omit<M, 'sessionId' | 'expectedVersion'>
    : never
  : never;

export function DeveloperMenu({ snapshot }: { snapshot: CheckoutSnapshot }) {
  const [desktop, setDesktop] = useState(false);
  const [mobile, setMobile] = useState(false);
  const content = <DeveloperControls snapshot={snapshot} />;

  return (
    <div
      className="developer-menu"
      data-session-version={snapshot.session.version}
    >
      <Popover open={desktop} onOpenChange={setDesktop}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="developer-desktop"
            aria-label="Developer menu"
          >
            <Code2 size={17} aria-hidden="true" />
            Developer menu<span className="demo-badge">DEMO</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Developer menu">{content}</PopoverContent>
      </Popover>
      <Sheet open={mobile} onOpenChange={setMobile}>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            className="developer-mobile"
            aria-label="Developer menu"
          >
            <EllipsisVertical size={22} aria-hidden="true" />
            <span className="demo-badge">DEMO</span>
          </Button>
        </SheetTrigger>
        <SheetContent>
          <SheetTitle>Developer menu</SheetTitle>
          <SheetDescription>
            Simulation tools for this checkout. Changes are shared across
            devices.
          </SheetDescription>
          {content}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function DeveloperControls({ snapshot }: { snapshot: CheckoutSnapshot }) {
  const { session } = snapshot;
  const base = `/api/demo/checkouts/${session.id}`;
  const cache = useQueryClient();
  const router = useRouter();
  const [secret, setSecret] = useState('');
  const [minutes, setMinutes] = useState(5);
  const [confirmation, setConfirmation] = useState('');
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState('');
  const status = useQuery({
    queryKey: ['demo', session.id],
    queryFn: () => request<DemoSnapshot>(base),
    refetchInterval: (q) =>
      q.state.error || terminal(session.status) ? false : 2000,
    retry: false,
  });
  const unlock = useMutation({
    mutationFn: () =>
      request(base + '/authorize', {
        method: 'POST',
        body: JSON.stringify({ secret }),
      }),
    onSuccess: () => {
      setSecret('');
      void status.refetch();
      setNotice('Developer controls unlocked for this checkout.');
    },
  });
  const mutation = useMutation({
    mutationFn: (action: Action) =>
      request<CheckoutSnapshot>(base, {
        method: 'POST',
        body: JSON.stringify({ ...action, expectedVersion: session.version }),
      }),
    onMutate: () => cache.cancelQueries({ queryKey: ['checkout', session.id] }),
    onSuccess: (updated) => {
      cache.setQueryData(['checkout', session.id], {
        ...updated,
        sample: {
          serverMs: Date.parse(updated.serverNow),
          mono: performance.now(),
        },
      });
      setNotice(
        'Scenario updated on the server. Other devices will sync shortly.',
      );
    },
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: ['checkout', session.id] });
      void cache.invalidateQueries({ queryKey: ['demo', session.id] });
      void cache.invalidateQueries({ queryKey: ['listings'] });
    },
  });
  const reset = useMutation({
    mutationFn: () =>
      request(base + '/reset', {
        method: 'POST',
        body: JSON.stringify({ confirmation }),
      }),
    onSuccess: () => {
      void cache.invalidateQueries();
      router.replace('/');
    },
    onError: () => {
      void cache.invalidateQueries();
    },
  });
  const editable = ['ACTIVE', 'PRICE_REVIEW', 'PAYMENT_RETRYABLE'].includes(
    session.status,
  );
  const busy = mutation.isPending || reset.isPending;
  const error = mutation.error ?? reset.error ?? unlock.error;
  const locked =
    status.error instanceof RequestError && status.error.status === 403;

  return (
    <div className="developer-controls">
      <div className="developer-intro">
        <span className="demo-badge">SIMULATION / DEBUGGING</span>
        <p>Real server changes, scoped to this checkout. No real charges.</p>
      </div>
      {status.isPending ? (
        <p role="status">
          <LoaderCircle size={16} className="spin" />
          Checking developer access…
        </p>
      ) : locked ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            unlock.mutate();
          }}
        >
          <label htmlFor={`demo-secret-${session.id}`}>Demo secret</label>
          <input
            id={`demo-secret-${session.id}`}
            type="password"
            autoComplete="off"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
          <p className="developer-help">
            Use the server&apos;s DEMO_SECRET. It is never bundled or saved in
            browser storage.
          </p>
          <Button
            type="submit"
            disabled={unlock.isPending || secret.length < 32}
          >
            Unlock controls
          </Button>
        </form>
      ) : status.isError ? (
        <>
          <p role="alert">Developer controls are unavailable.</p>
          <Button onClick={() => void status.refetch()}>Try again</Button>
        </>
      ) : (
        <>
          <p className="developer-shared">
            Next payment:{' '}
            <strong>
              {status.data.configuration.nextPayment === 'DEFAULT'
                ? 'Default scenario'
                : status.data.configuration.nextPayment
                    .replaceAll('_', ' ')
                    .toLowerCase()}
            </strong>
            <br />
            Attempts used: {session.paymentAttemptCount} / 3
          </p>
          {!editable && (
            <p className="developer-help">
              Checkout changes are disabled during processing and after a
              terminal state. Reset remains a separate destructive action.
            </p>
          )}
          <fieldset disabled={!editable || busy || status.isError}>
            <legend>Ticket price · all-in total recalculated</legend>
            <div className="developer-button-row">
              <Button
                variant="outline"
                onClick={() =>
                  mutation.mutate({ action: 'PRICE', direction: 'DECREASE' })
                }
              >
                Decrease price 10%
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  mutation.mutate({ action: 'PRICE', direction: 'INCREASE' })
                }
              >
                Increase price 10%
              </Button>
            </div>
            <p className="developer-help">
              Per-ticket change, minimum $1, floor $0. Fees remain included.
            </p>
          </fieldset>
          <fieldset disabled={!editable || busy}>
            <legend>Reservation deadline</legend>
            <label htmlFor={`demo-duration-${session.id}`}>
              Hold for {minutes} {minutes === 1 ? 'minute' : 'minutes'} from
              server now
            </label>
            <input
              id={`demo-duration-${session.id}`}
              type="range"
              min={1}
              max={30}
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
            />
            <div className="developer-button-row">
              <Button
                variant="outline"
                onClick={() => mutation.mutate({ action: 'DEADLINE', minutes })}
              >
                Apply duration
              </Button>
              <Button
                variant="outline"
                onClick={() => mutation.mutate({ action: 'EXPIRE' })}
              >
                Expire now
              </Button>
            </div>
            <p className="developer-help">
              Server deadline:{' '}
              <time dateTime={session.reservationExpiresAt}>
                {session.reservationExpiresAt}
              </time>
            </p>
          </fieldset>
          <fieldset disabled={!editable || busy}>
            <legend>Next payment attempt</legend>
            <div className="developer-button-grid">
              <Button
                variant="outline"
                onClick={() =>
                  mutation.mutate({ action: 'PAYMENT', scenario: 'SUCCESS' })
                }
              >
                Success
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  mutation.mutate({
                    action: 'PAYMENT',
                    scenario: 'TRANSIENT_FAILURE',
                  })
                }
              >
                Transient timeout
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  mutation.mutate({ action: 'PAYMENT', scenario: 'DECLINED' })
                }
              >
                Definitive decline
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  mutation.mutate({ action: 'PAYMENT', scenario: 'DEFAULT' })
                }
              >
                Clear simulation
              </Button>
            </div>
            <p className="developer-help">
              Consumed once when the server claims an attempt. Clearing never
              resets attempts.
            </p>
          </fieldset>
          <div className="developer-reset">
            <Button
              variant="outline"
              onClick={() => setResetting(!resetting)}
              disabled={busy}
            >
              Reset demo data…
            </Button>
            {resetting && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  reset.mutate();
                }}
              >
                <p>
                  This resets the entire configured demo namespace, invalidating
                  every checkout and confirmation. Other shoppers lose their
                  holds.
                </p>
                <label htmlFor={`demo-reset-${session.id}`}>
                  Type RESET DEMO DATA to confirm
                </label>
                <input
                  id={`demo-reset-${session.id}`}
                  autoComplete="off"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                />
                <Button
                  type="submit"
                  disabled={confirmation !== 'RESET DEMO DATA' || busy}
                >
                  Confirm reset
                </Button>
              </form>
            )}
          </div>
        </>
      )}
      {error && (
        <p role="alert">
          {error.message} Refresh the shared state before trying again.
        </p>
      )}
      <p role="status" aria-live="polite" className="developer-feedback">
        {busy ? 'Applying server change…' : notice}
      </p>
    </div>
  );
}
