'use client';
import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowUpRight, MapPin } from 'lucide-react';
import type { Event } from '@/domain/models';
import { eventArt, eventDate, eventTitle, money } from '@/lib/ui/presentation';

export function EventDiscovery({
  events,
}: {
  events: { event: Event; startingPrice: number }[];
}) {
  const [category, setCategory] = useState('All events');
  const categories = [
    'All events',
    'Concerts',
    'Football',
    'Basketball',
    'Baseball',
  ];
  const visible = events.filter(
    ({ event }) =>
      category === 'All events' || eventArt[event.id]?.category === category,
  );
  return (
    <section id="events" className="discovery">
      <div className="section-heading">
        <div>
          <span className="eyebrow">LESS PLANNING. MORE LIVING.</span>
          <h2>Find your kind of unforgettable.</h2>
        </div>
        <span className="muted">A few good reasons to go out.</span>
      </div>
      <div className="category-tabs" role="group" aria-label="Filter events">
        {categories.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={item === category}
            onClick={() => setCategory(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="event-grid">
        {visible.map(({ event, startingPrice }) => (
          <Link
            href={`/events/${event.id}`}
            className="event-card"
            key={event.id}
          >
            <div className="event-card-photo">
              <Image
                src={`/images/${eventArt[event.id]?.image}.jpg`}
                alt={`${eventArt[event.id]?.category} atmosphere`}
                fill
                sizes="(max-width: 600px) 100vw, (max-width: 1000px) 50vw, 25vw"
              />
              <span className="event-category">
                {eventArt[event.id]?.category}
              </span>
              <span className="card-arrow">
                <ArrowUpRight size={20} aria-hidden="true" />
              </span>
            </div>
            <div className="event-card-body">
              <p className="event-date">{eventDate(event)} · 2027</p>
              <h3>{eventTitle(event)}</h3>
              <p className="venue">
                <MapPin size={14} aria-hidden="true" />
                {event.venue.split(' · ')[0]}
              </p>
              <div className="card-price">
                <span>
                  From <strong>{money(startingPrice)}</strong>
                </span>
                <small>incl. fees / ticket</small>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
