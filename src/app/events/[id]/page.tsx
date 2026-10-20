import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CalendarDays, MapPin, ShieldCheck } from 'lucide-react';
import { Header, Footer } from '@/components/marketplace/chrome';
import { Listings, type ListingRow } from '@/components/marketplace/listings';
import { FixtureCatalog } from '@/infrastructure/catalog/catalog';
import { checkoutRuntime } from '@/lib/checkout-runtime';
import {
  eventArt,
  eventTitle,
  eventDate,
  eventTime,
} from '@/lib/ui/presentation';
export const dynamic = 'force-dynamic';
export default async function EventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const event = await new FixtureCatalog().getEvent(id);
  if (!event) notFound();
  let initial: ListingRow[] | null = null;
  try {
    const { catalog, store } = await checkoutRuntime();
    initial = await Promise.all(
      (await catalog.listListings(id)).map(async (listing) => ({
        listing,
        availability: await store.getAvailability(listing.id),
      })),
    );
  } catch {}
  return (
    <>
      <Header />
      <main id="main">
        <section className="event-hero">
          <Image
            src={`/images/${eventArt[id]?.image}.jpg`}
            alt={`${eventArt[id]?.category} atmosphere; illustrative, not a view of your seats`}
            fill
            priority
            sizes="100vw"
          />
          <div className="hero-shade" />
          <div className="page-width event-hero-content">
            <Link href="/#events" className="back-link">
              <ArrowLeft size={16} aria-hidden="true" />
              All events
            </Link>
            <span className="event-category">
              {eventArt[id]?.category} · Simulated event
            </span>
            <h1>{eventTitle(event)}</h1>
            <p>
              <CalendarDays size={18} aria-hidden="true" />
              {eventDate(event, true)} · {eventTime(event)}
            </p>
            <p>
              <MapPin size={18} aria-hidden="true" />
              {event.venue}
            </p>
          </div>
        </section>
        <div className="page-width event-layout">
          <Listings eventId={id} initial={initial} />
          <aside className="venue-aside">
            <div className="venue-map" aria-hidden="true">
              <div className="map-ring ring-outer" />
              <div className="map-ring ring-middle" />
              <div className="map-ring ring-inner" />
              <div className="map-field">
                {eventArt[id]?.category === 'Concerts'
                  ? 'STAGE'
                  : 'FIELD / COURT'}
              </div>
              <span className="map-north">N</span>
            </div>
            <p className="map-caption">
              Illustrative venue layout · Not a seat map
            </p>
            <h3>A good spot. A great time.</h3>
            <p>
              Pick your section, choose your tickets, and we&apos;ll hold them
              while you check out.
            </p>
            <div className="venue-guarantee">
              <ShieldCheck size={24} aria-hidden="true" />
              <div>
                <strong>Your tickets, held for you.</strong>
                <p>
                  One reservation. Open it on any device without losing your
                  place.
                </p>
              </div>
            </div>
          </aside>
        </div>
      </main>
      <Footer />
    </>
  );
}
