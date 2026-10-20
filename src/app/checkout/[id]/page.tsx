import { parseServerEnv } from '@/lib/env';
import { randomUUID } from 'node:crypto';
import { redirect, notFound } from 'next/navigation';
import { checkoutRuntime } from '@/lib/checkout-runtime';
import { identifierSchema } from '@/infrastructure/redis/checkout-data';
import { Header, Footer } from '@/components/marketplace/chrome';
import { TicketSummary } from '@/components/marketplace/ticket-summary';
import { CheckoutExperience } from '@/components/checkout/checkout-experience';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!identifierSchema.safeParse(id).success) {
    redirect('/');
  }

  const { checkout, catalog } = await checkoutRuntime();
  const result = await checkout.enter({
    sessionId: id,
    intent: 'FRESH_NAVIGATION',
    recoveryIdempotencyKey: randomUUID(),
  });

  if (!result.ok) {
    throw new Error('Checkout is temporarily unavailable');
  }

  const entry = result.value;

  if (entry.kind === 'REDIRECT_HOME') {
    redirect('/');
  }

  if (entry.kind === 'REDIRECT_EVENT') {
    redirect(`/events/${entry.eventId}`);
  }

  if (entry.kind === 'REDIRECT_CHECKOUT') {
    redirect(`/checkout/${entry.sessionId}`);
  }

  const { session } = entry.snapshot;
  const event = await catalog.getEvent(session.eventId);

  if (!event) {
    notFound();
  }

  return (
    <>
      <Header />
      <main id="main">
        <CheckoutExperience
          key={id}
          initial={entry.snapshot}
          demoEnabled={parseServerEnv(process.env).DEMO_MODE}
          summary={
            <TicketSummary event={event} allocation={session.allocation} />
          }
        />
      </main>
      <Footer />
    </>
  );
}
