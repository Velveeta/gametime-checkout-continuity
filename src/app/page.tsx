import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, Sparkles } from 'lucide-react';
import { Header, Footer } from '@/components/marketplace/chrome';
import { EventDiscovery } from '@/components/marketplace/event-discovery';
import { FixtureCatalog } from '@/infrastructure/catalog/catalog';
import { checkoutRuntime } from '@/lib/checkout-runtime';
import { eventDate, eventTime, eventTitle } from '@/lib/ui/presentation';

export const dynamic = 'force-dynamic';

export default async function Home() {
  // Discovery remains browsable before credentials are configured. A reservation
  // always requires live persistence; fixture fallback never fabricates stock.
  let catalog: Pick<FixtureCatalog, 'listEvents' | 'listListings'> =
    new FixtureCatalog();

  try {
    catalog = (await checkoutRuntime()).catalog;
  } catch {}

  const events = await Promise.all(
    (await catalog.listEvents()).map(async (event) => ({
      event,
      startingPrice: Math.min(
        ...(await catalog.listListings(event.id)).map(
          (listing) => listing.unitPrice + listing.feePerTicket,
        ),
      ),
    })),
  );
  const featured = events.find(
    ({ event }) => event.id === 'demo-midnight',
  )!.event;

  return (
    <>
      <Header />
      <main id="main">
        <section className="home-hero">
          <Image
            src="/images/concert.jpg"
            alt="A crowd taking in a live concert beneath an open sky"
            fill
            priority
            sizes="100vw"
          />
          <div className="hero-shade" />
          <div className="hero-copy">
            <span className="hero-kicker">
              <span className="live-dot" />
              THE BEST PART IS BEING THERE
            </span>
            <h1>
              Be there.
              <br />
              <em>Feel everything.</em>
            </h1>
            <p>
              The roar of the crowd. Your favorite song.
              <br />A moment that only happens once.
            </p>
            <Link href="#events" className="hero-cta">
              Find your next moment <ArrowRight size={19} aria-hidden="true" />
            </Link>
          </div>
          <Link href={`/events/${featured.id}`} className="hero-feature">
            <span>
              <Sparkles size={16} aria-hidden="true" /> IN THE SPOTLIGHT
            </span>
            <strong>{eventTitle(featured)}</strong>
            <p>Red Rocks Amphitheatre</p>
            <div>
              {eventDate(featured)} · {eventTime(featured)}{' '}
              <ArrowRight size={19} aria-hidden="true" />
            </div>
          </Link>
          <span className="hero-caption">Good nights. Great stories.</span>
        </section>
        <div className="page-width">
          <EventDiscovery events={events} />
          <section className="continuity-banner">
            <span className="eyebrow">
              LIFE MOVES. YOUR TICKETS COME WITH YOU.
            </span>
            <h2>Start here. Finish anywhere.</h2>
            <p>
              Your checkout follows you from laptop to phone.
              <br />
              Same tickets. Same total. Same moment waiting for you.
            </p>
            <Link href="#events">
              Let&apos;s make a plan <ArrowRight size={17} aria-hidden="true" />
            </Link>
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
