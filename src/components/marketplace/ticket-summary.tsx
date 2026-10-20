import Image from 'next/image';
import { CalendarDays, MapPin, Ticket } from 'lucide-react';
import type { Event, SeatAllocation, PriceQuote } from '@/domain/models';
import {
  eventArt,
  eventTitle,
  eventDate,
  eventTime,
  money,
  seatLabel,
} from '@/lib/ui/presentation';

/** Rendered by the route's Server Component, passed through the client island. */
export function TicketSummary({
  event,
  allocation,
}: {
  event: Event;
  allocation: SeatAllocation;
}) {
  const quantity =
    allocation.kind === 'ASSIGNED'
      ? allocation.seats.length
      : allocation.quantity;
  return (
    <>
      <div className="summary-photo">
        <Image
          src={`/images/${eventArt[event.id]?.image ?? 'concert'}.jpg`}
          alt={`${eventArt[event.id]?.category ?? 'Live event'} atmosphere`}
          fill
          sizes="(max-width: 760px) 100vw, 460px"
        />
        <span className="photo-label">You&apos;re going to love this.</span>
      </div>
      <div className="summary-event">
        <span className="eyebrow">YOUR TICKETS</span>
        <h2>{eventTitle(event)}</h2>
        <p>
          <CalendarDays size={16} aria-hidden="true" />
          {eventDate(event)} · {eventTime(event)}
        </p>
        <p>
          <MapPin size={16} aria-hidden="true" />
          {event.venue}
        </p>
        <div className="seat-summary">
          <Ticket size={21} aria-hidden="true" />
          <div>
            <strong>{allocation.section}</strong>
            <span>{seatLabel(allocation)}</span>
            <span>
              {quantity} {quantity === 1 ? 'ticket' : 'tickets'} ·{' '}
              {allocation.kind === 'ASSIGNED'
                ? 'Seats together'
                : 'Unassigned admission'}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
export function PriceBreakdown({
  quote,
  quantity,
}: {
  quote: PriceQuote;
  quantity: number;
}) {
  return (
    <div className="price-breakdown" aria-label="Order pricing">
      <div>
        <span>
          {quantity} {quantity === 1 ? 'ticket' : 'tickets'}
        </span>
        <span>{money(quote.ticketSubtotal)}</span>
      </div>
      <div>
        <span>Service fees</span>
        <span>{money(quote.fees)}</span>
      </div>
      <div className="total-row">
        <strong>
          Total <small>USD</small>
        </strong>
        <strong data-testid="order-total">{money(quote.total)}</strong>
      </div>
      <p>No surprises. All fees included.</p>
    </div>
  );
}
