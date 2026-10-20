import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowRight, Check, Ticket } from 'lucide-react';
import { Header, Footer } from '@/components/marketplace/chrome';
import {
  PriceBreakdown,
  TicketSummary,
} from '@/components/marketplace/ticket-summary';
import { confirmationCookie } from '@/infrastructure/http/cookies';
import { identifierSchema } from '@/infrastructure/redis/checkout-data';
import { checkoutRuntime } from '@/lib/checkout-runtime';
import type { CompletionCapability } from '@/domain/models';

export const dynamic = 'force-dynamic';

export default async function ConfirmationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!identifierSchema.safeParse(id).success) {
    redirect('/');
  }

  const capability = (await cookies()).get(confirmationCookie(id))?.value;

  if (!capability || !/^[A-Za-z0-9_-]{43}$/.test(capability)) {
    redirect('/');
  }

  const { checkout, catalog } = await checkoutRuntime();
  const result = await checkout.confirm({
    orderId: id,
    capability: capability as CompletionCapability,
  });

  if (!result.ok) {
    redirect('/');
  }

  const order = result.value;
  const event = await catalog.getEvent(order.eventId);

  if (!event) {
    redirect('/');
  }

  const quantity =
    order.allocation.kind === 'ASSIGNED'
      ? order.allocation.seats.length
      : order.allocation.quantity;

  return (
    <>
      <Header />
      <main id="main" className="confirmation-page page-width">
        <div className="confirmation-heading">
          <span className="success-icon">
            <Check size={32} aria-hidden="true" />
          </span>
          <span className="eyebrow">
            THE COUNTDOWN TO A GREAT TIME STARTS NOW
          </span>
          <h1>You&apos;re going.</h1>
          <p>
            Your simulated booking is confirmed. Let the anticipation begin.
          </p>
        </div>
        <div className="confirmation-card">
          <TicketSummary event={event} allocation={order.allocation} />
          <PriceBreakdown quote={order.quote} quantity={quantity} />
          <div className="booking-reference">
            <Ticket size={20} aria-hidden="true" />
            <div>
              <strong>Booking reference</strong>
              <code>{order.id}</code>
            </div>
          </div>
        </div>
        <p className="confirmation-note">
          Keep this page handy. You can refresh it on this device.
          <br />
          This is a simulated booking, not an admission ticket. No payment was
          collected.
        </p>
        <Link href="/" className="hero-cta dark-cta">
          Find your next moment <ArrowRight size={18} aria-hidden="true" />
        </Link>
      </main>
      <Footer />
    </>
  );
}
