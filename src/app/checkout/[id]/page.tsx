import { randomUUID } from 'node:crypto';
import { redirect, notFound } from 'next/navigation';
import { checkoutRuntime } from '@/lib/checkout-runtime';
import { identifierSchema } from '@/infrastructure/redis/checkout-data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** SSR policy boundary only. Responsive checkout interactions belong to Wave 04. */
export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!identifierSchema.safeParse(id).success) notFound();
  const { checkout } = await checkoutRuntime();
  const result = await checkout.enter({
    sessionId: id,
    intent: 'FRESH_NAVIGATION',
    recoveryIdempotencyKey: randomUUID(),
  });
  if (!result.ok) throw new Error('Checkout is temporarily unavailable');
  const entry = result.value;
  if (entry.kind === 'REDIRECT_HOME') redirect('/');
  if (entry.kind === 'REDIRECT_EVENT') redirect(`/events/${entry.eventId}`);
  if (entry.kind === 'REDIRECT_CHECKOUT')
    redirect(`/checkout/${entry.sessionId}`);
  const { session } = entry.snapshot;
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Checkout</h1>
      <p className="mt-4">
        Your simulated reservation is{' '}
        {session.status.toLowerCase().replaceAll('_', ' ')}.
      </p>
      <p className="mt-4">
        Total:{' '}
        {new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: session.quote.currency,
        }).format(session.quote.total / 100)}
      </p>
      <p className="mt-4 text-sm">All inventory and payments are simulated.</p>
    </main>
  );
}
