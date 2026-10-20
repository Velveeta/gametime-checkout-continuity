'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  Check,
  Circle,
  LoaderCircle,
  Radio,
  Ticket,
} from 'lucide-react';
import type { Listing } from '@/domain/models';
import { quoteSelection } from '@/domain/inventory';
import type { ListingAvailability } from '@/application/inventory-contracts';
import type { CheckoutSnapshot } from '@/application/checkout-service';
import { Button } from '@/components/ui/button';
import {
  quantities,
  selections,
  seatLabel,
  selectionKey,
  money,
} from '@/lib/ui/presentation';
import { request } from '@/lib/ui/http';

export interface ListingRow {
  listing: Listing;
  availability: ListingAvailability;
}

function ListingCard({
  row,
  refresh,
  unavailable,
}: {
  row: ListingRow;
  refresh: () => void;
  unavailable: boolean;
}) {
  const { listing, availability } = row;
  const router = useRouter();
  const options = quantities(listing, availability.available);
  const [preferredQuantity, setQuantity] = useState(2);
  const [preferredSeats, setSeats] = useState('');
  const quantity = options.includes(preferredQuantity)
    ? preferredQuantity
    : (options[0] ?? listing.quantityRules.min);
  const choices = selections(listing, availability.available, quantity);
  // Preserve the actual selection when polling inserts/removes earlier options.
  // An array index could silently move the shopper to different seats.
  const selected =
    choices.find((choice) => selectionKey(choice) === preferredSeats) ??
    choices[0];
  const quote = selected ? quoteSelection(listing, quantity) : null;
  const reserve = useMutation({
    mutationFn: () =>
      request<CheckoutSnapshot>('/api/checkouts', {
        method: 'POST',
        body: JSON.stringify({
          eventId: listing.eventId,
          listingId: listing.id,
          allocation: selected,
          expectedListingVersion: listing.version,
        }),
      }),
    onSuccess: (snapshot) => router.push(`/checkout/${snapshot.session.id}`),
    onError: () => refresh(),
  });
  const label =
    availability.counts.available === 0
      ? availability.counts.held > 0
        ? 'Currently reserved'
        : 'Sold out'
      : choices.length
        ? 'Available'
        : 'No matching tickets';

  return (
    <article className="listing-card" aria-label={listing.allocation.section}>
      <div className="listing-top">
        <span className="section-icon">
          <Ticket size={23} aria-hidden="true" />
        </span>
        <div>
          <h3>{listing.allocation.section}</h3>
          <p>
            {listing.allocation.kind === 'ASSIGNED'
              ? `Row ${listing.allocation.row} · Reserved seating`
              : 'General admission · Unassigned'}
          </p>
        </div>
        <div className="listing-price">
          <strong>{money(listing.unitPrice + listing.feePerTicket)}</strong>
          <span>per ticket, incl. fees</span>
        </div>
      </div>
      <div className="inventory-line">
        <span className={choices.length ? 'inventory-available' : 'muted'}>
          <Circle size={7} fill="currentColor" aria-hidden="true" />
          {label}
        </span>
        <span>
          {availability.counts.available} available · {availability.counts.held}{' '}
          reserved · {availability.counts.sold} sold
        </span>
      </div>
      {choices.length > 0 && (
        <div className="selection-controls">
          <label>
            Tickets
            <select
              value={quantity}
              onChange={(e) => {
                setQuantity(Number(e.target.value));
                setSeats('');
              }}
              disabled={reserve.isPending}
            >
              {options.map((n) => (
                <option value={n} key={n}>
                  {n} {n === 1 ? 'ticket' : 'tickets'}
                </option>
              ))}
            </select>
          </label>
          <label>
            {listing.allocation.kind === 'ASSIGNED'
              ? 'Seats together'
              : 'Admission'}
            <select
              value={selected ? selectionKey(selected) : ''}
              onChange={(e) => setSeats(e.target.value)}
              disabled={reserve.isPending}
            >
              {choices.map((choice) => (
                <option value={selectionKey(choice)} key={selectionKey(choice)}>
                  {seatLabel(choice)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <div className="listing-bottom">
        <p>
          {money(listing.unitPrice)} + {money(listing.feePerTicket)} fees /
          ticket
          {quote && (
            <strong>
              {money(quote.total)} total for {quantity}
            </strong>
          )}
        </p>
        <Button
          disabled={unavailable || !selected || reserve.isPending}
          onClick={() => reserve.mutate()}
        >
          {reserve.isPending ? (
            <LoaderCircle className="spin" size={17} aria-hidden="true" />
          ) : null}
          {reserve.isPending
            ? 'Reserving…'
            : selected
              ? 'Reserve tickets'
              : label}
          {selected && !reserve.isPending && (
            <ArrowRight size={16} aria-hidden="true" />
          )}
        </Button>
      </div>
      {reserve.error && (
        <p className="inline-error" role="alert">
          Those tickets may have changed. Availability has been refreshed.
          Please choose again.
        </p>
      )}
    </article>
  );
}

export function Listings({
  eventId,
  initial,
}: {
  eventId: string;
  initial: ListingRow[] | null;
}) {
  const query = useQuery({
    queryKey: ['listings', eventId],
    queryFn: ({ signal }) =>
      request<{ listings: ListingRow[] }>(`/api/events/${eventId}/listings`, {
        signal,
      }),
    ...(initial ? { initialData: { listings: initial } } : {}),
    refetchInterval: 2000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  return (
    <section aria-labelledby="tickets-heading" className="tickets-list">
      <div className="section-heading">
        <div>
          <span className="eyebrow">YOUR WAY IN</span>
          <h2 id="tickets-heading">Find your seats.</h2>
        </div>
        <span className="live-label">
          <Radio size={14} aria-hidden="true" />
          Live availability
        </span>
      </div>
      <p className="listing-intro">
        <Check size={16} aria-hidden="true" /> Every price includes fees. What
        you see is what you pay.
      </p>
      {query.isError && (
        <div role="alert" className="notice warning">
          <strong>We couldn&apos;t refresh ticket availability.</strong>
          <p>
            Please check your connection and try again. Tickets can only be
            reserved when the service is available.
          </p>
          <Button variant="outline" onClick={() => query.refetch()}>
            Try again
          </Button>
        </div>
      )}
      {query.isPending && (
        <div className="skeleton h-52" aria-label="Loading tickets" />
      )}
      {query.data?.listings.map((row) => (
        <ListingCard
          row={row}
          key={row.listing.id}
          refresh={() => void query.refetch()}
          unavailable={query.isError}
        />
      ))}
      {query.data?.listings.length === 0 && (
        <div className="notice">
          <h3>No listings just yet.</h3>
          <p>Check back for another chance to be there.</p>
        </div>
      )}
    </section>
  );
}
